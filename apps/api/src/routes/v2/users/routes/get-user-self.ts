import { GetUserSelfRouteV2 } from '@rctf/types'
import { createToken, TokenKind } from '../../../../lib/tokens'
import { getFullUser } from '../../../../services/full-user'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import { allowedDivisions } from '../../../../util/acl'
import usersGroup from '../group'

usersGroup.route(GetUserSelfRouteV2, async ({ ctx, user, res }) => {
  const view = await getScoreboardView(ctx.var.db, ctx.var.redis, user)
  const [fullUser, teamToken] = await Promise.all([
    getFullUser(ctx.var.db, user, view, true),
    createToken(TokenKind.Team, user.id),
  ])
  const allowedDivs = allowedDivisions({
    email: user.email,
    defaultOnly: false,
  }) as string[]

  return res.goodUserSelfDataV2({
    ...fullUser,
    teamToken: teamToken,
    allowedDivisions: allowedDivs,
    perms: user.perms,
    banned: fullUser.banned ?? false,
    avatarUrl: fullUser.avatarUrl ?? null,
    countryCode: fullUser.countryCode ?? null,
    statusText: fullUser.statusText ?? null,
  })
})
