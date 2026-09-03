import { users } from '@rctf/db'
import { GetCtftimeLeaderboardRoute } from '@rctf/types'
import { sql } from 'drizzle-orm'
import {
  frozenLeaderboardOrderSql,
  leaderboardOrderSql,
  userIsPublicFrozenRankedSql,
  userIsPublicRankedSql,
} from '../../../../cache/leaderboard'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import integrationsGroup from '../group'

integrationsGroup.route(GetCtftimeLeaderboardRoute, async ({ ctx, res }) => {
  const view = await getScoreboardView(
    ctx.var.db,
    ctx.var.redis,
    undefined,
    true
  )
  const leaderboard = await ctx.var.db
    .select({
      name: users.name,
      score: view.frozen ? users.frozenScore : users.score,
    })
    .from(users)
    .where(
      view.frozen && view.ready
        ? userIsPublicFrozenRankedSql
        : view.frozen
          ? sql`false`
          : userIsPublicRankedSql
    )
    .orderBy(view.frozen ? frozenLeaderboardOrderSql : leaderboardOrderSql)

  return res.goodCtftimeLeaderboard({
    standings: leaderboard.map((item, index) => ({
      pos: index + 1,
      team: item.name,
      score: item.score ?? 0,
    })),
  })
})
