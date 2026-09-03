import { GetUserRouteV2 } from '@rctf/types'
import { getFullUserFromId } from '../../../../services/full-user'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import usersGroup from '../group'

usersGroup.route(GetUserRouteV2, async ({ ctx, user, res, params: { id } }) => {
  const view =
    user?.id === id
      ? { frozen: false as const, cutoff: undefined, ready: true as const }
      : await getScoreboardView(ctx.var.db, ctx.var.redis, user)
  const fullUser = await getFullUserFromId(ctx.var.db, id, view)
  if (!fullUser) {
    return res.badUnknownUser()
  }
  return res.goodUserDataV2({
    ...fullUser,
    avatarUrl: fullUser.avatarUrl ?? null,
    countryCode: fullUser.countryCode ?? null,
    statusText: fullUser.statusText ?? null,
  })
})
