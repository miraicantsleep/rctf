import { GetUserRoute } from '@rctf/types'
import { getFullUserFromId } from '../../../../services/full-user'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import usersGroup from '../group'

usersGroup.route(GetUserRoute, async ({ ctx, user, res, params: { id } }) => {
  const view =
    user?.id === id
      ? { frozen: false as const, cutoff: undefined, ready: true as const }
      : await getScoreboardView(ctx.var.db, ctx.var.redis, user)
  const fullUser = await getFullUserFromId(ctx.var.db, id, view)
  if (!fullUser) {
    return res.badUnknownUser()
  }
  return res.goodUserData(fullUser)
})
