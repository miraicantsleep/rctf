import { config } from '@rctf/config'
import {
  challenges,
  createDatabase,
  scoreEvents,
  settings,
  solves,
  users,
} from '@rctf/db'
import {
  BadAlreadySolvedChallenge,
  BadFlag,
  ChallengeScoringKind,
  DynamicScoringTransport,
  GoodChallengeSolvesV2,
  GoodChallengesV2,
  GoodFlag,
  GoodUserDataV2,
  GoodUserSelfDataV2,
  Permissions,
  type Challenge,
} from '@rctf/types'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import {
  frozenSnapshotFingerprint,
  keyFrozenSnapshotFingerprint,
} from '../../../../apps/api/src/cache/leaderboard'
import { getPrivateChallenge } from '../../../../apps/api/src/services/challenges'
import * as bloodbot from '../../../../apps/api/src/services/bloodbot'
import {
  invalidateResolvedSettingsCache,
  updateSettings,
} from '../../../../apps/api/src/services/settings'
import { createRedis } from '../../../../apps/api/src/util/redis'
import { getApp, request } from '../../app'
import {
  expectResponse,
  generateAuthToken,
  generateChallenge,
  generateRealTestUser,
} from '../../util'

const db = createDatabase(config.database.sql).db
let app: Hono<any>
let team: Awaited<ReturnType<typeof generateRealTestUser>>
let challenge: Awaited<ReturnType<typeof generateChallenge>>
let headers: { Authorization: string }
let freezeTime: number
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  app = await getApp()
})

beforeEach(async () => {
  team = await generateRealTestUser()
  challenge = await generateChallenge()
  headers = { Authorization: `Bearer ${await generateAuthToken(team.user.id)}` }
  freezeTime = Date.now() - 60_000
  const timing = {
    startTime: freezeTime - 60_000,
    endTime: freezeTime + 600_000,
    freezeTime,
  }
  const redis = await createRedis()
  await updateSettings(db, timing, redis)
  await redis.set(
    keyFrozenSnapshotFingerprint,
    frozenSnapshotFingerprint(timing)
  )
  await db
    .update(users)
    .set({
      score: 900,
      frozenScore: 500,
      globalRank: 2,
      divisionRank: 2,
      frozenGlobalRank: 1,
      frozenDivisionRank: 1,
      frozenDivision: team.user.division,
    })
    .where(eq(users.id, team.user.id))
  await db
    .update(challenges)
    .set({
      score: 400,
      solveCount: 3,
      frozenScore: 500,
      frozenSolveCount: 0,
    })
    .where(eq(challenges.id, challenge.challenge.id))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await challenge.cleanup()
  await team.cleanup()
  await db.delete(settings).where(eq(settings.id, 'value-0'))
  const redis = await createRedis()
  await invalidateResolvedSettingsCache(redis)
  await redis.del(keyFrozenSnapshotFingerprint)
})

const submit = (flag: string = challenge.challenge.flag) =>
  request(app, `/api/v1/challs/${challenge.challenge.id}/submit`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag }),
  })

const list = async (
  auth: Record<string, string> = headers
): Promise<Challenge[]> => {
  const response = await request(app, '/api/v2/challs', {
    method: 'GET',
    headers: auth,
  })
  return (await expectResponse(response, GoodChallengesV2)).data
}

const listedChallenge = async () =>
  (await list()).find(item => item.id === challenge.challenge.id)!

describe('personal progress during freeze', () => {
  test.each([true, false])(
    'uses the effective freeze state (%p) to mask bloodbot identity',
    async frozen => {
      if (!frozen)
        await updateSettings(db, { freezeEnabled: false }, await createRedis())
      const notified = Promise.withResolvers<void>()
      const shouldNotify = spyOn(
        bloodbot,
        'shouldNotifyBloodbot'
      ).mockReturnValue(true)
      const send = spyOn(bloodbot, 'sendBloodMessage').mockImplementation(
        async () => {
          notified.resolve()
        }
      )
      try {
        await expectResponse(await submit(), GoodFlag)
        await notified.promise
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]![0].id).toBe(team.user.id)
        expect(send.mock.calls[0]![1].name).toBe(challenge.challenge.name)
        expect(send.mock.calls[0]![2]).toBe(1)
        expect(send.mock.calls[0]![3]).toBe(frozen)
      } finally {
        shouldNotify.mockRestore()
        send.mockRestore()
      }
    }
  )

  test.each([1, 2, 3])(
    'hides the post-freeze blood position from the %ith solver',
    async position => {
      for (let index = 1; index < position; index++) {
        const earlier = await generateRealTestUser()
        cleanups.push(earlier.cleanup)
        await db.insert(solves).values({
          id: crypto.randomUUID(),
          userid: earlier.user.id,
          challengeid: challenge.challenge.id,
          createdat: new Date(freezeTime + index).toISOString(),
        })
      }
      await expectResponse(await submit(), GoodFlag)
      const profile = await expectResponse(
        await request(app, '/api/v2/users/me', {
          method: 'GET',
          headers,
        }),
        GoodUserSelfDataV2
      )
      expect(profile.data.solves[0]).toMatchObject({
        points: null,
        bloodIndex: null,
        awardedPoints: null,
      })
      expect(await listedChallenge()).toMatchObject({
        isSolved: true,
        points: 500,
        solves: 0,
      })
      const positions = await expectResponse(
        await request(
          app,
          `/api/v2/challs/${challenge.challenge.id}/solves?limit=10&offset=0`,
          { method: 'GET', headers }
        ),
        GoodChallengeSolvesV2
      )
      expect(positions.data.mySolvePosition).toBeNull()
    }
  )

  test('reports a committed solve immediately, including zero points, without revealing its position', async () => {
    expect(await listedChallenge()).toMatchObject({
      isSolved: false,
      solves: 0,
      points: 500,
    })
    await expectResponse(await submit(), GoodFlag)
    // No leaderboard worker or point recompute is needed to confirm the solve.
    expect(
      (
        await db.select().from(solves).where(eq(solves.userid, team.user.id))
      )[0]!.points
    ).toBe(0)
    const solved = await listedChallenge()
    expect(solved).toMatchObject({ isSolved: true, solves: 0, points: 500 })
    expect(solved.yourScore).toBeUndefined()
    expect(solved.yourPointDelta).toBeUndefined()
    await expectResponse(await submit(), BadAlreadySolvedChallenge)
    expect((await listedChallenge()).isSolved).toBe(true)

    const profile = await expectResponse(
      await request(app, '/api/v2/users/me', {
        method: 'GET',
        headers,
      }),
      GoodUserSelfDataV2
    )
    expect(profile.data).toMatchObject({
      score: 500,
      globalPlace: 1,
      divisionPlace: 1,
    })
    expect(
      profile.data.solves.find((item: { id: string }) => item.id === solved.id)
    ).toMatchObject({
      awardedPoints: null,
      points: null,
      bloodIndex: null,
    })
    const positions = await expectResponse(
      await request(
        app,
        `/api/v2/challs/${solved.id}/solves?limit=10&offset=0`,
        { method: 'GET', headers }
      ),
      GoodChallengeSolvesV2
    )
    expect(positions.data).toMatchObject({
      mySolvePosition: null,
      total: 0,
      solves: [],
    })

    const anonymous = (await list({})).find(item => item.id === solved.id)!
    expect(anonymous.isSolved).toBeUndefined()
    expect(anonymous.yourScore).toBeUndefined()
    const publicProfile = await expectResponse(
      await request(app, `/api/v2/users/${team.user.id}`, {
        method: 'GET',
      }),
      GoodUserDataV2
    )
    expect(publicProfile.data.solves).toHaveLength(0)
  })

  test('keeps a wrong guess unsolved and confines confirmation to the submitting team', async () => {
    await expectResponse(await submit('wrong-flag'), BadFlag)
    expect((await listedChallenge()).isSolved).toBe(false)
    await expectResponse(await submit(), GoodFlag)
    const other = await generateRealTestUser()
    cleanups.push(other.cleanup)
    const otherHeaders = {
      Authorization: `Bearer ${await generateAuthToken(other.user.id)}`,
    }
    expect(
      (await list(otherHeaders)).find(
        item => item.id === challenge.challenge.id
      )!.isSolved
    ).toBe(false)
  })

  test('uses snapshot flag points rather than current decayed points for an earlier solve', async () => {
    await db.insert(solves).values({
      id: crypto.randomUUID(),
      challengeid: challenge.challenge.id,
      userid: team.user.id,
      createdat: new Date(freezeTime - 1).toISOString(),
      points: 400,
    })
    expect(await listedChallenge()).toMatchObject({
      isSolved: true,
      yourScore: 500,
    })
    await db
      .update(challenges)
      .set({ frozenScore: 0 })
      .where(eq(challenges.id, challenge.challenge.id))
    expect(await listedChallenge()).toMatchObject({
      isSolved: true,
      yourScore: 0,
    })
  })

  test('keeps confirmation live when the snapshot is pending without falling back to live numbers', async () => {
    await expectResponse(await submit(), GoodFlag)
    await createRedis().then(redis => redis.del(keyFrozenSnapshotFingerprint))
    const pending = await listedChallenge()
    expect(pending).toMatchObject({ isSolved: true, points: 0, solves: 0 })
    expect(pending.yourScore).toBeUndefined()
    expect(pending.yourPointDelta).toBeUndefined()
    const profile = await expectResponse(
      await request(app, '/api/v2/users/me', {
        method: 'GET',
        headers,
      }),
      GoodUserSelfDataV2
    )
    expect(profile.data).toMatchObject({
      score: 0,
      globalPlace: null,
      divisionPlace: null,
      dynamicScores: [],
    })
    expect(profile.data.solves[0]).toMatchObject({
      awardedPoints: null,
      bloodIndex: null,
    })
  })

  test('keeps staff live access and restores live numbers after unfreezing', async () => {
    await expectResponse(await submit(), GoodFlag)
    await db
      .update(solves)
      .set({ points: 400 })
      .where(eq(solves.userid, team.user.id))
    const staff = await generateRealTestUser(Permissions.leaderboardRead)
    cleanups.push(staff.cleanup)
    const staffHeaders = {
      Authorization: `Bearer ${await generateAuthToken(staff.user.id)}`,
    }
    expect(
      (await list(staffHeaders)).find(
        item => item.id === challenge.challenge.id
      )
    ).toMatchObject({
      points: 400,
      solves: 3,
      isSolved: false,
    })
    const staffView = await expectResponse(
      await request(app, `/api/v2/users/${team.user.id}`, {
        method: 'GET',
        headers: staffHeaders,
      }),
      GoodUserDataV2
    )
    expect(staffView.data).toMatchObject({ score: 900, globalPlace: 2 })

    await updateSettings(db, { freezeEnabled: false }, await createRedis())
    expect(await listedChallenge()).toMatchObject({
      isSolved: true,
      yourScore: 400,
      points: 400,
      solves: 3,
    })
  })

  test('holds personal dynamic totals and deltas at the cutoff even when the live entry disappears', async () => {
    const stored = (await getPrivateChallenge(db, challenge.challenge.id))!
    await db
      .update(challenges)
      .set({
        data: {
          ...stored.data,
          flags: [],
          scoring: {
            kind: ChallengeScoringKind.DYNAMIC,
            source: {
              transport: DynamicScoringTransport.WEBHOOK,
              secret: 'freeze-progress-test',
            },
          },
        },
      })
      .where(eq(challenges.id, stored.id))
    await db.insert(scoreEvents).values([
      {
        id: crypto.randomUUID(),
        challengeid: stored.id,
        userid: team.user.id,
        source: 'feed',
        pointsDelta: 375,
        eventAt: new Date(freezeTime - 1).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        challengeid: stored.id,
        userid: team.user.id,
        source: 'feed',
        pointsDelta: -375,
        eventAt: new Date(freezeTime + 1).toISOString(),
      },
    ])
    expect(await listedChallenge()).toMatchObject({
      isSolved: false,
      yourScore: 375,
      yourPointDelta: 375,
    })
    const profile = await expectResponse(
      await request(app, '/api/v2/users/me', {
        method: 'GET',
        headers,
      }),
      GoodUserSelfDataV2
    )
    expect(profile.data.dynamicScores).toContainEqual({
      id: stored.id,
      points: 375,
      pointDelta: 375,
    })
    await createRedis().then(redis => redis.del(keyFrozenSnapshotFingerprint))
    expect((await listedChallenge()).yourScore).toBeUndefined()
    const pending = await expectResponse(
      await request(app, '/api/v2/users/me', {
        method: 'GET',
        headers,
      }),
      GoodUserSelfDataV2
    )
    expect(pending.data.dynamicScores).toEqual([])
  })
})
