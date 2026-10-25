import { GetUserSelfRoute } from '@rctf/types'
import { createToken, TokenKind } from '../../../../lib/tokens'
import { getFullUser } from '../../../../services/full-user'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import { allowedDivisions } from '../../../../util/acl'
import usersGroup from '../group'

usersGroup.route(GetUserSelfRoute, async ({ ctx, user, res }) => {
  const view = await getScoreboardView(ctx.var.db, ctx.var.redis, user)
  const [fullUser, teamToken] = await Promise.all([
    getFullUser(ctx.var.db, user, view, true),
    createToken(TokenKind.Team, user.id),
  ])
  const allowedDivs = allowedDivisions({
    email: user.email,
    defaultOnly: false,
  }) as string[]

  return res.goodUserSelfData({
    ...fullUser,
    teamToken: teamToken,
    allowedDivisions: allowedDivs,
    perms: user.perms,
  })
})
