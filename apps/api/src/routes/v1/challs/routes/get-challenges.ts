import { GetChallengesRoute } from '@rctf/types'
import { getChallenges } from '../../../../services/challenges'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import challsGroup from '../group'

challsGroup.route(GetChallengesRoute, async ({ res, ctx, user }) => {
  const view = await getScoreboardView(ctx.var.db, ctx.var.redis, user)
  const challenges = await getChallenges(ctx.var.db, undefined, view)

  return res.goodChallenges(
    challenges.map(item => {
      return {
        id: item.id,
        ...item.data,
        points: item.score ?? undefined,
        solves: item.solveCount ?? undefined,
        sortWeight: item.data.sortWeight ?? null,
      }
    })
  )
})
