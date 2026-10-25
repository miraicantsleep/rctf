import { config } from '@rctf/config'
import { settings, type DatabaseClient, type EditableSettings } from '@rctf/db'
import { takeUnique } from '@rctf/db/util'
import { normalizeSponsorIcons } from '@rctf/types'
import { eq } from 'drizzle-orm'
import type { TypedRedis } from '../cache/scripts'

const VALUE_ID = 'value-0'
const RESOLVED_SETTINGS_CACHE_KEY = 'settings:resolved'
const RESOLVED_SETTINGS_CACHE_TTL = 60_000

export type SettingsPatch = {
  [K in keyof EditableSettings]?: EditableSettings[K] | null
}

export type ResolvedSettings = ReturnType<typeof resolveSettings>
export type CompetitionTiming = Pick<
  ResolvedSettings,
  'startTime' | 'endTime' | 'freezeTime'
>

type CachedResolvedSettings = {
  version: 2
  revision: number
  defaultsSignature: string
  resolved: ResolvedSettings
}

const normalizeSettings = (data: EditableSettings): EditableSettings =>
  data.sponsors
    ? { ...data, sponsors: data.sponsors.map(normalizeSponsorIcons) }
    : data

const readSettings = async (db: DatabaseClient) => {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.id, VALUE_ID))
    .then(takeUnique)
  return {
    data: normalizeSettings(row?.data ?? {}),
    revision: row?.revision ?? 0,
  }
}

export async function getSettings(
  db: DatabaseClient
): Promise<EditableSettings> {
  return (await readSettings(db)).data
}

export class InvalidSettingsError extends Error {}

export function patchSettings(
  current: EditableSettings,
  patch: SettingsPatch
): EditableSettings {
  const updated: EditableSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete updated[key as keyof EditableSettings]
    } else if (value !== undefined) {
      ;(updated as Record<string, unknown>)[key] = value
    }
  }

  return updated
}

export async function updateSettingsWithTiming(
  db: DatabaseClient,
  patch: SettingsPatch,
  redis?: TypedRedis
) {
  const result = await db.transaction(async tx => {
    await tx
      .insert(settings)
      .values({ id: VALUE_ID, data: {} })
      .onConflictDoNothing()
    const current = (
      await tx
        .select()
        .from(settings)
        .where(eq(settings.id, VALUE_ID))
        .for('update')
    )[0]!
    const updated = patchSettings(current.data, patch)
    const before = resolveSettings(current.data)
    const after = resolveSettings(updated)
    if (after.freezeEnabled && after.freezeTime === null) {
      throw new InvalidSettingsError(
        'freezeTime is required when freezing is enabled'
      )
    }
    if (
      after.freezeTime !== null &&
      (after.freezeTime < after.startTime || after.freezeTime > after.endTime)
    ) {
      throw new InvalidSettingsError(
        'freezeTime must be between startTime and endTime'
      )
    }
    const revision = current.revision + 1
    await tx
      .update(settings)
      .set({ data: updated, revision })
      .where(eq(settings.id, VALUE_ID))
    return {
      overrides: normalizeSettings(updated),
      revision,
      resolved: after,
      timingChanged:
        before.startTime !== after.startTime ||
        before.endTime !== after.endTime ||
        before.freezeTime !== after.freezeTime,
    }
  })
  if (redis)
    await setCachedResolvedSettings(redis, result.resolved, result.revision)
  return result
}

export async function updateSettings(
  db: DatabaseClient,
  patch: SettingsPatch,
  redis?: TypedRedis
): Promise<EditableSettings> {
  return (await updateSettingsWithTiming(db, patch, redis)).overrides
}

export function getConfigDefaults(): EditableSettings {
  return {
    ctfName: config.ctfName,
    homeContent: config.homeContent,
    startTime: config.startTime,
    endTime: config.endTime,
    freezeTime: config.freezeTime,
    freezeEnabled: config.freezeTime !== undefined,
    sponsors: config.sponsors,
    meta: config.meta,
    faviconUrl: config.faviconUrl,
    logoLightUrl: config.logoLightUrl,
    logoDarkUrl: config.logoDarkUrl,
  }
}

export function resolveSettings(overrides: EditableSettings) {
  const scheduledFreeze = overrides.freezeTime ?? config.freezeTime ?? null
  const freezeEnabled = overrides.freezeEnabled ?? scheduledFreeze !== null
  return {
    ctfName: overrides.ctfName ?? config.ctfName,
    homeContent: overrides.homeContent ?? config.homeContent,
    startTime: overrides.startTime ?? config.startTime,
    endTime: overrides.endTime ?? config.endTime,
    freezeEnabled,
    freezeTime: freezeEnabled ? scheduledFreeze : null,
    sponsors: overrides.sponsors ?? config.sponsors,
    meta: {
      description: overrides.meta?.description ?? config.meta.description,
      imageUrl: overrides.meta?.imageUrl ?? config.meta.imageUrl,
    },
    faviconUrl: overrides.faviconUrl ?? config.faviconUrl ?? null,
    logoLightUrl: (overrides.logoLightUrl ?? config.logoLightUrl) || null,
    logoDarkUrl: (overrides.logoDarkUrl ?? config.logoDarkUrl) || null,
  }
}

const getConfigDefaultsSignature = (): string =>
  JSON.stringify(getConfigDefaults())

const getCachedResolvedSettings = async (
  redis: TypedRedis,
  revision: number
): Promise<ResolvedSettings | undefined> => {
  try {
    const cached = await redis.get(RESOLVED_SETTINGS_CACHE_KEY)
    if (!cached) return undefined
    const entry = JSON.parse(cached) as Partial<CachedResolvedSettings>
    if (
      entry.version === 2 &&
      entry.revision === revision &&
      entry.defaultsSignature === getConfigDefaultsSignature() &&
      entry.resolved
    ) {
      return entry.resolved
    }
  } catch {
    // Redis is an optimization; database timing remains authoritative.
  }
  return undefined
}

const setCachedResolvedSettings = async (
  redis: TypedRedis,
  resolved: ResolvedSettings,
  revision: number
): Promise<void> => {
  const entry: CachedResolvedSettings = {
    version: 2,
    revision,
    defaultsSignature: getConfigDefaultsSignature(),
    resolved,
  }
  try {
    await redis.rctfCacheSettings(
      RESOLVED_SETTINGS_CACHE_KEY,
      String(revision),
      JSON.stringify(entry),
      String(RESOLVED_SETTINGS_CACHE_TTL)
    )
  } catch {
    // A committed settings update must not fail because its cache is unavailable.
  }
}

export const invalidateResolvedSettingsCache = async (
  redis: TypedRedis
): Promise<void> => {
  await redis.del(RESOLVED_SETTINGS_CACHE_KEY)
}

export async function getResolvedSettings(
  db: DatabaseClient,
  redis?: TypedRedis
): Promise<ResolvedSettings> {
  if (redis) {
    // Never trust an expired/evicted cache's revision as the source of truth.
    const row = await db
      .select({ revision: settings.revision })
      .from(settings)
      .where(eq(settings.id, VALUE_ID))
      .then(takeUnique)
    const cached = await getCachedResolvedSettings(redis, row?.revision ?? 0)
    if (cached) return cached
  }
  const snapshot = await readSettings(db)
  const resolved = resolveSettings(snapshot.data)
  if (redis) await setCachedResolvedSettings(redis, resolved, snapshot.revision)
  return resolved
}

export async function getCompetitionTiming(
  db: DatabaseClient,
  redis?: TypedRedis
): Promise<CompetitionTiming> {
  const { startTime, endTime, freezeTime } = await getResolvedSettings(
    db,
    redis
  )
  return { startTime, endTime, freezeTime }
}

export const isScoreboardFrozen = (
  timing: CompetitionTiming,
  now = Date.now()
): timing is CompetitionTiming & { freezeTime: number } =>
  timing.freezeTime !== null && now >= timing.freezeTime
