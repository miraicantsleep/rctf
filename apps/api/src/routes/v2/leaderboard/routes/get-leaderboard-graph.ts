import { config } from '@rctf/config'
import { GetLeaderboardGraphRouteV2 } from '@rctf/types'
import { getGraph } from '../../../../cache/leaderboard'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import leaderboardGroup from '../group'

leaderboardGroup.route(
  GetLeaderboardGraphRouteV2,
  async ({ ctx, user, res, query: { limit, offset, division } }) => {
    // NOTE: Handling manually because the value is loaded from config
    if (
      limit > config.leaderboard.graphMaxTeams ||
      offset > config.leaderboard.maxOffset
    ) {
      return res.badBody({
        reason: 'Invalid limit or offset',
      })
    }

    if (division && !Object.hasOwn(config.divisions, division)) {
      return res.badBody({
        reason: 'Invalid division',
      })
    }

    const view = await getScoreboardView(ctx.var.db, ctx.var.redis, user)
    const graph = await getGraph(
      ctx.var.db,
      ctx.var.redis,
      limit,
      offset,
      division,
      view
    )
    return res.goodLeaderboardGraph({ graph })
  }
)
