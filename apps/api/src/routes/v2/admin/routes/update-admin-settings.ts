import { UpdateAdminSettingsRouteV2 } from '@rctf/types'
import {
  getConfigDefaults,
  getSettings,
  patchSettings,
  resolveSettings,
  updateSettings,
} from '../../../../services/settings'
import { invalidateFrozenSnapshot } from '../../../../cache/leaderboard'
import {
  forceLeaderboardUpdate,
  requestAllChallengesRecompute,
} from '../../../../workers'
import adminGroup from '../group'

adminGroup.route(UpdateAdminSettingsRouteV2, async ({ res, ctx, body }) => {
  const current = await getSettings(ctx.var.db)
  const prospective = resolveSettings(patchSettings(current, body.data))
  if (
    prospective.freezeTime !== null &&
    (prospective.freezeTime < prospective.startTime ||
      prospective.freezeTime > prospective.endTime)
  ) {
    return res.badBody({
      reason: 'freezeTime must be between startTime and endTime',
    })
  }

  const overrides = await updateSettings(ctx.var.db, body.data, ctx.var.redis)
  if (
    'startTime' in body.data ||
    'endTime' in body.data ||
    'freezeTime' in body.data
  ) {
    await invalidateFrozenSnapshot(ctx.var.redis)
    requestAllChallengesRecompute(ctx.var.redis, 'algo-change')
    forceLeaderboardUpdate(ctx.var.redis)
  }
  const defaults = getConfigDefaults()
  return res.goodAdminSettingsUpdate({ overrides, defaults })
})
