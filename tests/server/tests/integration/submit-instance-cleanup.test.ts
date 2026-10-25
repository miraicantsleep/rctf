import { config } from '@rctf/config'
import { challenges, createDatabase, solves, users } from '@rctf/db'
import {
  BadAlreadySolvedChallenge,
  BadFlag,
  BadPerms,
  GoodFlag,
  InstanceStatus,
} from '@rctf/types'
import { withTimeout } from '@rctf/util'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type {
  instanceDetailsOrError,
  InstanceQueryOptions,
  InstancerProvider,
} from '../../../../apps/api/src/providers/instancer/base'
import { instancers } from '../../../../apps/api/src/providers/instances/instancer'
import {
  getPrivateChallenge,
  submitFlag,
} from '../../../../apps/api/src/services/challenges'
import { stopInstanceAfterSolve } from '../../../../apps/api/src/services/instance-lifecycle'
import { createRedis } from '../../../../apps/api/src/util/redis'
import { getApp, request } from '../../app'
import {
  expectResponse,
  generateAuthToken,
  generateChallenge,
  generateRealTestUser,
} from '../../util'

const details = (status: InstanceStatus): instanceDetailsOrError => ({
  kind: 'instancerInstanceDetails',
  status,
  endpoints: null,
  timeLeftMilliseconds: null,
})

const makeProvider = () => ({
  capabilities: { canStop: true, canExtend: true },
  getInstance: mock(async (_options: InstanceQueryOptions) =>
    details(InstanceStatus.RUNNING)
  ),
  deleteInstance: mock(async (_options: InstanceQueryOptions) =>
    details(InstanceStatus.STOPPING)
  ),
})

const db = createDatabase(config.database.sql).db
const providerName = 'solve-cleanup-test'
let app: Hono<any>
let provider: ReturnType<typeof makeProvider>
let challengeData: Awaited<ReturnType<typeof generateChallenge>>
let userData: Awaited<ReturnType<typeof generateRealTestUser>>
let log: Parameters<typeof stopInstanceAfterSolve>[2]

beforeAll(async () => {
  app = await getApp()
})

beforeEach(async () => {
  provider = makeProvider()
  instancers[providerName] = provider as unknown as InstancerProvider
  challengeData = await generateChallenge()
  userData = await generateRealTestUser()
  log = { info: mock(), warn: mock(), error: mock() } as unknown as typeof log
  const challenge = await getPrivateChallenge(db, challengeData.challenge.id)
  await db
    .update(challenges)
    .set({
      data: {
        ...challenge!.data,
        instancerConfig: {
          instancer: providerName,
          challengeIntegrationId: 'provider-challenge-id',
          config: { image: 'test-image' },
          expose: [],
          timeoutMilliseconds: 60_000,
        },
      },
    })
    .where(eq(challenges.id, challengeData.challenge.id))
})

afterEach(async () => {
  delete instancers[providerName]
  await userData.cleanup()
  await challengeData.cleanup()
})

const submit = async (flag: string = challengeData.challenge.flag) => {
  const token = await generateAuthToken(userData.user.id)
  return request(app, `/api/v1/challs/${challengeData.challenge.id}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ flag }),
  })
}

const getChallenge = async () =>
  (await getPrivateChallenge(db, challengeData.challenge.id))!

const getSolves = () =>
  db.select().from(solves).where(eq(solves.userid, userData.user.id))

describe('instance cleanup after an accepted flag', () => {
  test('uses the named provider, integration ID, config, and submitting team only', async () => {
    const otherProvider = makeProvider()
    instancers['other-cleanup-test'] =
      otherProvider as unknown as InstancerProvider
    const deleted = Promise.withResolvers<void>()
    provider.deleteInstance.mockImplementation(async options => {
      // The solve must already be visible when cleanup reaches the provider.
      const committedSolves = await getSolves()
      expect(committedSolves).toHaveLength(1)
      expect(committedSolves[0]!.challengeid).toBe(challengeData.challenge.id)
      expect(options.teamId).toBe(userData.user.id)
      deleted.resolve()
      return details(InstanceStatus.STOPPING)
    })

    try {
      await expectResponse(await submit(), GoodFlag)
      await deleted.promise
      const expected = {
        teamId: userData.user.id,
        challengeIntegrationId: 'provider-challenge-id',
        config: { image: 'test-image' },
      }
      expect(provider.getInstance.mock.calls).toEqual([[expected]])
      expect(provider.deleteInstance.mock.calls).toEqual([[expected]])
      expect(otherProvider.getInstance).not.toHaveBeenCalled()
      expect(otherProvider.deleteInstance).not.toHaveBeenCalled()
    } finally {
      delete instancers['other-cleanup-test']
    }
  })

  test('does not touch a restarted instance on duplicate submission', async () => {
    await expectResponse(await submit(), GoodFlag)
    expect(provider.deleteInstance).toHaveBeenCalledTimes(1)

    // Simulate the participant starting a fresh instance after cleanup.
    provider.getInstance.mockResolvedValue(details(InstanceStatus.RUNNING))
    provider.getInstance.mockClear()
    provider.deleteInstance.mockClear()
    await expectResponse(await submit(), BadAlreadySolvedChallenge)

    expect(provider.getInstance).not.toHaveBeenCalled()
    expect(provider.deleteInstance).not.toHaveBeenCalled()
    expect(await getSolves()).toHaveLength(1)
  })

  test('ignores wrong flags and rejected submissions', async () => {
    await expectResponse(await submit('wrong-flag'), BadFlag)
    await db
      .update(users)
      .set({ banned: true })
      .where(eq(users.id, userData.user.id))
    await expectResponse(await submit(), BadPerms)

    expect(provider.getInstance).not.toHaveBeenCalled()
    expect(provider.deleteInstance).not.toHaveBeenCalled()
    expect(await getSolves()).toHaveLength(0)
  })

  test('does not clean up when the solve transaction rolls back', async () => {
    const failure = new Error('commit failed')
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (run: Parameters<typeof db.transaction>[0]) =>
            target.transaction(async tx => {
              await run(tx)
              throw failure
            })
        }
        return Reflect.get(target, property, receiver)
      },
    })

    await expect(
      submitFlag(
        {} as Parameters<typeof submitFlag>[0],
        failingDb,
        await createRedis(),
        log,
        {
          userId: userData.user.id,
          challengeId: challengeData.challenge.id,
          flag: challengeData.challenge.flag,
          submissionIp: '127.0.0.1',
        }
      )
    ).rejects.toBe(failure)

    expect(provider.getInstance).not.toHaveBeenCalled()
    expect(provider.deleteInstance).not.toHaveBeenCalled()
    expect(await getSolves()).toHaveLength(0)
  })

  test.each(['getInstance', 'deleteInstance'] as const)(
    'responds with the committed solve while %s is still pending',
    async operation => {
      const pending = Promise.withResolvers<instanceDetailsOrError>()
      const finished = Promise.withResolvers<void>()
      provider[operation].mockImplementation(() => pending.promise)
      void pending.promise.then(() => finished.resolve())

      try {
        const response = await withTimeout(submit(), 2000, () => {
          throw new Error('flag response waited for provider cleanup')
        })
        await expectResponse(response, GoodFlag)
        expect(await getSolves()).toHaveLength(1)
      } finally {
        pending.resolve(details(InstanceStatus.STOPPED))
        await finished.promise
      }
    }
  )

  test('keeps the accepted solve when the provider throws', async () => {
    provider.deleteInstance.mockRejectedValue(new Error('provider unavailable'))
    await expectResponse(await submit(), GoodFlag)
    expect(provider.deleteInstance).toHaveBeenCalledTimes(1)
    expect(await getSolves()).toHaveLength(1)
  })

  test('accepts non-instanced challenges without querying a provider', async () => {
    const challenge = await getChallenge()
    delete challenge.data.instancerConfig
    await db
      .update(challenges)
      .set({ data: challenge.data })
      .where(eq(challenges.id, challenge.id))

    await expectResponse(await submit(), GoodFlag)
    expect(provider.getInstance).not.toHaveBeenCalled()
    expect(provider.deleteInstance).not.toHaveBeenCalled()
  })
})

describe('best-effort instance cleanup', () => {
  test.each([
    InstanceStatus.RUNNING,
    InstanceStatus.STARTING,
    InstanceStatus.ERRORED,
  ])('stops a %s instance', async status => {
    provider.getInstance.mockResolvedValue(details(status))
    await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
    expect(provider.deleteInstance).toHaveBeenCalledTimes(1)
  })

  test.each([InstanceStatus.STOPPED, InstanceStatus.STOPPING])(
    'skips a %s or missing instance',
    async status => {
      provider.getInstance.mockResolvedValue(details(status))
      await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
      expect(provider.deleteInstance).not.toHaveBeenCalled()
    }
  )

  test('skips providers that cannot stop instances', async () => {
    provider.capabilities.canStop = false
    await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
    expect(provider.getInstance).not.toHaveBeenCalled()
    expect(provider.deleteInstance).not.toHaveBeenCalled()
  })

  test('falls back to the rCTF challenge ID when no integration ID is configured', async () => {
    const challenge = await getChallenge()
    challenge.data.instancerConfig!.challengeIntegrationId = ''
    await stopInstanceAfterSolve(challenge, userData.user.id, log)
    expect(
      provider.deleteInstance.mock.calls[0]![0].challengeIntegrationId
    ).toBe(challenge.id)
  })

  test.each(['getInstance', 'deleteInstance'] as const)(
    'logs returned %s errors with team and challenge context',
    async operation => {
      provider[operation].mockResolvedValue({
        kind: 'instancerError',
        message: 'provider failed',
      })
      await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({ message: 'provider failed' }),
          teamId: userData.user.id,
          challengeId: challengeData.challenge.id,
          instancerName: providerName,
        }),
        'failed to stop instance after solve'
      )
      if (operation === 'getInstance') {
        expect(provider.deleteInstance).not.toHaveBeenCalled()
      }
    }
  )

  test('logs provider exceptions without rejecting cleanup', async () => {
    const error = new Error('network error')
    provider.deleteInstance.mockRejectedValue(error)
    await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        teamId: userData.user.id,
        challengeId: challengeData.challenge.id,
      }),
      'failed to stop instance after solve'
    )
  })

  test('logs unavailable named providers without rejecting cleanup', async () => {
    delete instancers[providerName]
    await stopInstanceAfterSolve(await getChallenge(), userData.user.id, log)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(provider.deleteInstance).not.toHaveBeenCalled()
  })
})
