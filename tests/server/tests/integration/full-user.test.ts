import { config } from '@rctf/config'
import {
  challenges,
  ChallengeScoringKind,
  createDatabase,
  DynamicScoringTransport,
  solves,
  scoreEvents,
  settings,
  users,
  type ChallengeData,
} from '@rctf/db'
import {
  BadUnknownUser,
  GoodFlag,
  GoodUserData,
  GoodUserDataV2,
  Permissions,
  GoodUserSelfData,
  GoodUserSelfDataV2,
} from '@rctf/types'
import { beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import {
  updateSettings,
  invalidateResolvedSettingsCache,
} from '../../../../apps/api/src/services/settings'
import {
  frozenSnapshotFingerprint,
  keyFrozenSnapshotFingerprint,
} from '../../../../apps/api/src/cache/leaderboard'
import { createRedis } from '../../../../apps/api/src/util/redis'
import { getApp, request } from '../../app'
import {
  expectResponse,
  generateAuthToken,
  generateChallenge,
  generateRealTestUser,
} from '../../util'

let app: Hono<any>
const getDb = () => createDatabase(config.database.sql).db

beforeAll(async () => {
  app = await getApp()
})

describe('full-user service', () => {
  describe('getFullUserFromId', () => {
    test('returns user data for existing user via /api/v1/users/:id', async () => {
      const { user, cleanup } = await generateRealTestUser()

      try {
        const res = await request(app, `/api/v1/users/${user.id}`, {
          method: 'GET',
        })

        const body = await expectResponse(res, GoodUserData)
        expect(body.data.name).toBe(user.name)
        expect(body.data.division).toBe(user.division)
        expect(Array.isArray(body.data.solves)).toBe(true)
      } finally {
        await cleanup()
      }
    })

    test('returns badUnknownUser for non-existent user', async () => {
      const nonExistentId = crypto.randomUUID()

      const res = await request(app, `/api/v1/users/${nonExistentId}`, {
        method: 'GET',
      })

      await expectResponse(res, BadUnknownUser)
    })

    test('returns badUnknownUser for banned public users', async () => {
      const { user, cleanup } = await generateRealTestUser()

      try {
        const db = getDb()
        await db
          .update(users)
          .set({ banned: true })
          .where(eq(users.id, user.id))

        const v1Res = await request(app, `/api/v1/users/${user.id}`, {
          method: 'GET',
        })
        await expectResponse(v1Res, BadUnknownUser)

        const v2Res = await request(app, `/api/v2/users/${user.id}`, {
          method: 'GET',
        })
        await expectResponse(v2Res, BadUnknownUser)
      } finally {
        await cleanup()
      }
    })
  })

  describe('getFullUser with solves', () => {
    test('returns user data with solved challenge info', async () => {
      // Create user and challenge
      const { user, cleanup: userCleanup } = await generateRealTestUser()
      const { challenge, cleanup: challengeCleanup } = await generateChallenge()

      try {
        const authToken = await generateAuthToken(user.id)

        // First, solve the challenge
        const submitRes = await request(
          app,
          `/api/v1/challs/${encodeURIComponent(challenge.id)}/submit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ flag: challenge.flag }),
          }
        )
        await expectResponse(submitRes, GoodFlag)

        // Now get the user profile which should include solves
        const profileRes = await request(app, '/api/v1/users/me', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        })

        const body = await expectResponse(profileRes, GoodUserSelfData)
        expect(body.data.name).toBe(user.name)
        expect(Array.isArray(body.data.solves)).toBe(true)
        expect(body.data.solves.length).toBe(1)

        // Verify solve data structure (covers lines 50-55)
        const solve = body.data.solves[0]
        expect(solve).toHaveProperty('id')
        expect(solve).toHaveProperty('name')
        expect(solve).toHaveProperty('category')
        expect(solve).toHaveProperty('createdAt')
        expect(typeof solve.createdAt).toBe('number')
        expect(solve.id).toBe(challenge.id)
        expect(solve.name).toBe(challenge.name)
        expect(solve.category).toBe(challenge.category)
      } finally {
        await challengeCleanup()
        await userCleanup()
      }
    })

    test('excludes solves from banned self profile', async () => {
      const { user, cleanup: userCleanup } = await generateRealTestUser()
      const { challenge, cleanup: challengeCleanup } = await generateChallenge()

      try {
        const db = getDb()
        const authToken = await generateAuthToken(user.id)

        const submitRes = await request(
          app,
          `/api/v1/challs/${encodeURIComponent(challenge.id)}/submit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ flag: challenge.flag }),
          }
        )
        await expectResponse(submitRes, GoodFlag)

        await db
          .update(users)
          .set({ banned: true })
          .where(eq(users.id, user.id))

        const profileRes = await request(app, '/api/v1/users/me', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        })

        const body = await expectResponse(profileRes, GoodUserSelfData)
        expect(body.data.solves).toHaveLength(0)
      } finally {
        await challengeCleanup()
        await userCleanup()
      }
    })

    test('returns user data via /api/v1/users/:id with solves', async () => {
      // Create user and challenge
      const { user, cleanup: userCleanup } = await generateRealTestUser()
      const { challenge, cleanup: challengeCleanup } = await generateChallenge()

      try {
        const authToken = await generateAuthToken(user.id)

        // Solve the challenge
        const submitRes = await request(
          app,
          `/api/v1/challs/${encodeURIComponent(challenge.id)}/submit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ flag: challenge.flag }),
          }
        )
        await expectResponse(submitRes, GoodFlag)

        // Get user by ID (tests getFullUserFromId with solves)
        const userRes = await request(app, `/api/v1/users/${user.id}`, {
          method: 'GET',
        })

        const body = await expectResponse(userRes, GoodUserData)
        expect(body.data.name).toBe(user.name)
        expect(Array.isArray(body.data.solves)).toBe(true)
        expect(body.data.solves.length).toBe(1)

        // Verify solve contains challenge info
        const solve = body.data.solves[0]
        expect(solve.id).toBe(challenge.id)
      } finally {
        await challengeCleanup()
        await userCleanup()
      }
    })

    test('returns dynamic feed points for profile solves', async () => {
      const { user, cleanup: userCleanup } = await generateRealTestUser()
      const db = getDb()
      const challengeId = crypto.randomUUID()
      const solveId = crypto.randomUUID()
      const dynamicPoints = 375
      const data: ChallengeData = {
        name: crypto.randomUUID(),
        description: '',
        category: 'dynamic',
        author: 'test',
        files: [],
        flags: [],
        tiebreakEligible: true,
        points: { min: 0, max: 0 },
        scoring: {
          kind: ChallengeScoringKind.DYNAMIC,
          source: {
            transport: DynamicScoringTransport.WEBHOOK,
            secret: 'profile-test-secret',
          },
        },
      }

      try {
        await db.insert(challenges).values({ id: challengeId, data })
        await db.insert(solves).values({
          id: solveId,
          challengeid: challengeId,
          userid: user.id,
          createdat: new Date().toISOString(),
          source: 'feed',
          points: dynamicPoints,
          pointsUpdatedAt: new Date().toISOString(),
        })

        const authToken = await generateAuthToken(user.id)
        const profileRes = await request(app, '/api/v2/users/me', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        })

        const body = await expectResponse(profileRes, GoodUserSelfDataV2)
        expect(
          body.data.solves.some(
            (item: { id: string }) => item.id === challengeId
          )
        ).toBe(false)
        const dynamicScore = body.data.dynamicScores.find(
          (item: { id: string }) => item.id === challengeId
        )
        expect(dynamicScore?.points).toBe(dynamicPoints)
      } finally {
        await db.delete(challenges).where(eq(challenges.id, challengeId))
        await userCleanup()
      }
    })
  })
})

test('frozen self profiles keep solves live without exposing live points, ranks, or counts', async () => {
  const db = getDb()
  const redis = await createRedis()
  const team = await generateRealTestUser()
  const staff = await generateRealTestUser(Permissions.leaderboardRead)
  const before = await generateChallenge()
  const after = await generateChallenge()
  const freezeTime = Date.now() - 60_000
  const timing = {
    startTime: freezeTime - 60_000,
    endTime: freezeTime + 120_000,
    freezeTime,
  }
  try {
    await updateSettings(db, timing, redis)
    await db
      .update(users)
      .set({
        score: 900,
        globalRank: 2,
        divisionRank: 2,
        frozenScore: 500,
        frozenGlobalRank: 1,
        frozenDivisionRank: 1,
        frozenDivision: team.user.division,
      })
      .where(eq(users.id, team.user.id))
    await db
      .update(challenges)
      .set({ score: 400, solveCount: 9, frozenScore: 500, frozenSolveCount: 1 })
      .where(eq(challenges.id, before.challenge.id))
    await db
      .update(challenges)
      .set({ score: 400, solveCount: 3, frozenScore: 500, frozenSolveCount: 0 })
      .where(eq(challenges.id, after.challenge.id))
    await db.insert(solves).values(
      [before, after].map((entry, i) => ({
        id: crypto.randomUUID(),
        userid: team.user.id,
        challengeid: entry.challenge.id,
        createdat: new Date(freezeTime + (i ? 1 : -1)).toISOString(),
      }))
    )
    await db.insert(scoreEvents).values({
      id: crypto.randomUUID(),
      userid: team.user.id,
      challengeid: after.challenge.id,
      pointsDelta: 400,
      source: 'flag',
      eventAt: new Date(freezeTime + 1).toISOString(),
    })
    await redis.set(
      keyFrozenSnapshotFingerprint,
      frozenSnapshotFingerprint(timing)
    )
    const auth = {
      Authorization: `Bearer ${await generateAuthToken(team.user.id)}`,
    }
    for (const version of ['v1', 'v2']) {
      for (const id of ['me', team.user.id]) {
        const res = await request(app, `/api/${version}/users/${id}`, {
          method: 'GET',
          headers: auth,
        })
        const body = await expectResponse(
          res,
          version === 'v1'
            ? id === 'me'
              ? GoodUserSelfData
              : GoodUserData
            : id === 'me'
              ? GoodUserSelfDataV2
              : GoodUserDataV2
        )
        expect(body.data).toMatchObject({
          score: 500,
          globalPlace: 1,
          divisionPlace: 1,
        })
        expect(body.data.solves).toHaveLength(2)
        expect(
          body.data.solves.find((s: any) => s.id === before.challenge.id)
        ).toMatchObject({ points: 500, solves: 1 })
        expect(
          body.data.solves.find((s: any) => s.id === after.challenge.id)
        ).toMatchObject({ points: null, solves: 0 })
        if (version === 'v2')
          expect(
            body.data.solves.find((s: any) => s.id === after.challenge.id)
          ).toMatchObject({ awardedPoints: null, bloodIndex: null })
      }
      const publicRes = await request(
        app,
        `/api/${version}/users/${team.user.id}`,
        { method: 'GET' }
      )
      const publicBody = await expectResponse(
        publicRes,
        version === 'v1' ? GoodUserData : GoodUserDataV2
      )
      expect(publicBody.data.score).toBe(500)
      expect(publicBody.data.solves).toHaveLength(1)
      const staffRes = await request(
        app,
        `/api/${version}/users/${team.user.id}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${await generateAuthToken(staff.user.id)}`,
          },
        }
      )
      const staffBody = await expectResponse(
        staffRes,
        version === 'v1' ? GoodUserData : GoodUserDataV2
      )
      expect(staffBody.data).toMatchObject({
        score: 900,
        globalPlace: 2,
        divisionPlace: 2,
      })
    }
    await redis.del(keyFrozenSnapshotFingerprint)
    const pendingRes = await request(app, '/api/v2/users/me', {
      method: 'GET',
      headers: auth,
    })
    const pending = await expectResponse(pendingRes, GoodUserSelfDataV2)
    expect(pending.data).toMatchObject({
      score: 0,
      globalPlace: null,
      divisionPlace: null,
    })
    expect(pending.data.solves).toHaveLength(2)
    for (const solve of pending.data.solves)
      expect(solve).toMatchObject({
        points: null,
        solves: null,
        awardedPoints: null,
        bloodIndex: null,
      })
  } finally {
    await after.cleanup()
    await before.cleanup()
    await staff.cleanup()
    await team.cleanup()
    await db.delete(settings).where(eq(settings.id, 'value-0'))
    await invalidateResolvedSettingsCache(redis)
    await redis.del(keyFrozenSnapshotFingerprint)
  }
})
