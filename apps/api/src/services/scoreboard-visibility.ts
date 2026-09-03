import type { DatabaseClient, User } from '@rctf/db'
import { Permissions } from '@rctf/types'
import { isFrozenSnapshotReady } from '../cache/leaderboard'
import type { TypedRedis } from '../cache/scripts'
import { getCompetitionTiming, isScoreboardFrozen } from './settings'

export type ScoreboardView =
  | { frozen: false; cutoff: undefined; ready: true }
  | { frozen: true; cutoff: number; ready: boolean }

export const canReadLiveScoreboard = (
  user: Pick<User, 'perms'> | undefined
): boolean => Boolean(user && (user.perms & Permissions.leaderboardRead) !== 0)

export const getScoreboardView = async (
  db: DatabaseClient,
  redis: TypedRedis,
  user?: Pick<User, 'perms'>,
  forcePublic = false
): Promise<ScoreboardView> => {
  const timing = await getCompetitionTiming(db, redis)
  if (
    !isScoreboardFrozen(timing) ||
    (!forcePublic && canReadLiveScoreboard(user))
  ) {
    return { frozen: false, cutoff: undefined, ready: true }
  }

  return {
    frozen: true,
    cutoff: timing.freezeTime,
    ready: await isFrozenSnapshotReady(redis, timing),
  }
}
