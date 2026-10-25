import { UpdateAdminSettingsRouteV2 } from '@rctf/types'
import {
  getConfigDefaults,
  InvalidSettingsError,
  updateSettingsWithTiming,
} from '../../../../services/settings'
import { invalidateFrozenSnapshot } from '../../../../cache/leaderboard'
import {
  forceLeaderboardUpdate,
  requestAllChallengesRecompute,
} from '../../../../workers'
import adminGroup from '../group'

adminGroup.route(UpdateAdminSettingsRouteV2, async ({ res, ctx, body }) => {
  let result
  try {
    result = await updateSettingsWithTiming(
      ctx.var.db,
      body.data,
      ctx.var.redis
    )
  } catch (error) {
    if (error instanceof InvalidSettingsError)
      return res.badBody({ reason: error.message })
    throw error
  }
  const { overrides, timingChanged } = result
  if (timingChanged) {
    await invalidateFrozenSnapshot(ctx.var.redis)
    requestAllChallengesRecompute(ctx.var.redis, 'algo-change')
    forceLeaderboardUpdate(ctx.var.redis)
  }
  const defaults = getConfigDefaults()
  return res.goodAdminSettingsUpdate({ overrides, defaults })
})
