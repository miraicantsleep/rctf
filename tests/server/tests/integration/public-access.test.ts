import { config } from '@rctf/config'
import { createDatabase, settings } from '@rctf/db'
import {
  BadToken,
  GoodAdminSettings,
  GoodAdminSettingsUpdate,
  Permissions,
} from '@rctf/types'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { eq } from 'drizzle-orm'
import { ServerConfigSchema } from '../../../../packages/config/src/types'
import { loadFileConfigs } from '../../../../packages/config/src/loader'
import path from 'node:path'
import { invalidateResolvedSettingsCache } from '../../../../apps/api/src/services/settings'
import { createRedis } from '../../../../apps/api/src/util/redis'
import { getApp, request } from '../../app'
import {
  expectResponse,
  generateAuthToken,
  generateChallenge,
  generateRealTestUser,
} from '../../util'

const originalVisibility = {
  hideScoreboard: config.hideScoreboard,
  hideChallenges: config.hideChallenges,
}

let app: Awaited<ReturnType<typeof getApp>>
let admin: Awaited<ReturnType<typeof generateRealTestUser>>
let team: Awaited<ReturnType<typeof generateRealTestUser>>
let challenge: Awaited<ReturnType<typeof generateChallenge>>
let adminHeaders: Record<string, string>
let teamHeaders: Record<string, string>

beforeAll(async () => {
  app = await getApp()
  admin = await generateRealTestUser(
    Permissions.settingsWrite | Permissions.challsRead
  )
  team = await generateRealTestUser()
  challenge = await generateChallenge()
  adminHeaders = {
    Authorization: `Bearer ${await generateAuthToken(admin.user.id)}`,
    'Content-Type': 'application/json',
  }
  teamHeaders = {
    Authorization: `Bearer ${await generateAuthToken(team.user.id)}`,
    'Content-Type': 'application/json',
  }
})

afterEach(async () => {
  Object.assign(config, originalVisibility)
  await createDatabase(config.database.sql)
    .db.delete(settings)
    .where(eq(settings.id, 'value-0'))
  await invalidateResolvedSettingsCache(await createRedis())
})

afterAll(async () => {
  await challenge.cleanup()
  await team.cleanup()
  await admin.cleanup()
})

const patch = (data: Record<string, unknown>, headers = adminHeaders) =>
  request(app, '/api/v2/admin/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ data }),
  })

describe('file-based public access', () => {
  for (const hideScoreboard of [false, true]) {
    for (const hideChallenges of [false, true]) {
      test(`scoreboard hidden=${hideScoreboard}, challenges hidden=${hideChallenges}`, async () => {
        Object.assign(config, { hideScoreboard, hideChallenges })
        const sharedHidden = hideScoreboard || hideChallenges
        const routes: [string, boolean][] = [
          ['/api/v1/challs', hideChallenges],
          ['/api/v2/challs', hideChallenges],
          ...['v1', 'v2'].flatMap(
            version =>
              [
                [
                  `/api/${version}/leaderboard/now?limit=10&offset=0`,
                  hideScoreboard,
                ],
                [
                  `/api/${version}/leaderboard/graph?limit=10&offset=0`,
                  hideScoreboard,
                ],
                [
                  `/api/${version}/challs/${challenge.challenge.id}/solves?limit=10&offset=0`,
                  sharedHidden,
                ],
                [`/api/${version}/users/${team.user.id}`, sharedHidden],
              ] as [string, boolean][]
          ),
          ['/api/v2/leaderboard/with-graph?limit=10&offset=0', hideScoreboard],
          ['/api/v2/leaderboard/challs', hideScoreboard],
          [
            `/api/v2/challs/${challenge.challenge.id}/scores?limit=10&offset=0`,
            sharedHidden,
          ],
        ]
        for (const [path, hidden] of routes) {
          const publicResponse = await request(app, path, { method: 'GET' })
          expect(publicResponse.status, path).toBe(hidden ? 401 : 200)
          if (hidden) await expectResponse(publicResponse, BadToken)
          for (const headers of [teamHeaders, adminHeaders]) {
            const signedInResponse = await request(app, path, { headers })
            expect(signedInResponse.status, `signed in: ${path}`).toBe(200)
          }
        }
        for (const version of ['v1', 'v2']) {
          const response = await request(
            app,
            `/api/${version}/integrations/client/config`,
            {}
          )
          const body = await response.json()
          expect(response.status).toBe(200)
          expect(body.data.hideScoreboard).toBe(hideScoreboard)
          expect(body.data.hideChallenges).toBe(hideChallenges)
        }
        if (!hideScoreboard) {
          const response = await request(app, '/api/v2/leaderboard/challs', {})
          const body = await response.json()
          if (hideChallenges) expect(body.data.challenges).toEqual({})
          else
            expect(body.data.challenges[challenge.challenge.id].name).toBe(
              challenge.challenge.name
            )
        }
        const selfResponse = await request(app, '/api/v2/users/me', {
          headers: teamHeaders,
        })
        expect(selfResponse.status).toBe(200)
        const adminResponse = await request(app, '/api/v2/admin/challs', {
          headers: adminHeaders,
        })
        expect(adminResponse.status).toBe(200)
      })
    }
  }

  test('loads YAML options, defaults to public access, and validates boolean values', () => {
    const layers = loadFileConfigs(
      path.resolve(import.meta.dir, '../../data/public-access')
    )
    const loaded = ServerConfigSchema.parse({ ...config, ...layers[0] })
    expect(loaded.hideChallenges).toBe(true)
    expect(loaded.hideScoreboard).toBe(true)
    const defaults = ServerConfigSchema.parse({
      ...config,
      hideScoreboard: undefined,
      hideChallenges: undefined,
    })
    expect(defaults.hideScoreboard).toBe(false)
    expect(defaults.hideChallenges).toBe(false)
    expect(
      ServerConfigSchema.safeParse({ ...config, hideChallenges: 'true' })
        .success
    ).toBe(false)
    expect(
      ServerConfigSchema.safeParse({ ...config, hideScoreboard: 1 }).success
    ).toBe(false)
  })

  test('admin settings cannot override file-based visibility', async () => {
    config.hideChallenges = true
    config.hideScoreboard = true
    const updated = await expectResponse(
      await patch({ hideChallenges: false, hideScoreboard: false }),
      GoodAdminSettingsUpdate
    )
    expect(updated.data.overrides).not.toHaveProperty('hideChallenges')
    expect(updated.data.overrides).not.toHaveProperty('hideScoreboard')
    const saved = await expectResponse(
      await request(app, '/api/v2/admin/settings', { headers: adminHeaders }),
      GoodAdminSettings
    )
    expect(saved.data.defaults).not.toHaveProperty('hideChallenges')
    expect(saved.data.defaults).not.toHaveProperty('hideScoreboard')
    await expectResponse(await request(app, '/api/v2/challs', {}), BadToken)
    await expectResponse(
      await request(app, '/api/v2/leaderboard/now?limit=10&offset=0', {}),
      BadToken
    )
  })

  test('invalid tokens cannot access hidden data', async () => {
    config.hideChallenges = true
    config.hideScoreboard = true
    for (const path of [
      '/api/v2/challs',
      '/api/v2/leaderboard/now?limit=10&offset=0',
    ]) {
      await expectResponse(
        await request(app, path, {
          headers: { Authorization: 'Bearer invalid' },
        }),
        BadToken
      )
    }
  })
})
