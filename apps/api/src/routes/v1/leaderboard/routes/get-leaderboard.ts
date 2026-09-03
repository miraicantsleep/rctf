import { config } from '@rctf/config'
import { GetLeaderboardRoute } from '@rctf/types'
import { getLeaderboardWithTotal } from '../../../../services/leaderboard-queries'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import leaderboardGroup from '../group'

leaderboardGroup.route(
  GetLeaderboardRoute,
  async ({ ctx, user, res, query: { limit, offset, division } }) => {
    if (
      limit > config.leaderboard.maxLimit ||
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
    const { total, leaderboard } = await getLeaderboardWithTotal(
      ctx.var.db,
      limit,
      offset,
      division,
      view
    )
    return res.goodLeaderboard({ total, leaderboard })
  }
)
