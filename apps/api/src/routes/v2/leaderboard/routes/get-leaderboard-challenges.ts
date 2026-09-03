import { challenges, type DatabaseClient } from '@rctf/db'
import { GetLeaderboardChallengesRouteV2 } from '@rctf/types'
import { sql } from 'drizzle-orm'
import {
  challengeIsPublicSql,
  scoringKindOf,
} from '../../../../services/challenge-queries'
import { getScoreboardView } from '../../../../services/scoreboard-visibility'
import leaderboardGroup from '../group'

const getLeaderboardChallenges = async (
  db: DatabaseClient,
  view: Awaited<ReturnType<typeof getScoreboardView>>
) =>
  await db
    .select({
      id: challenges.id,
      data: challenges.data,
      score: view.frozen ? challenges.frozenScore : challenges.score,
      solveCount: view.frozen
        ? challenges.frozenSolveCount
        : challenges.solveCount,
      firstBloodIds: sql<string[]>`
        COALESCE((
          SELECT ARRAY_AGG(first_blood.userid ORDER BY first_blood.createdat ASC, first_blood.id ASC)
          FROM (
            SELECT solves.userid, solves.createdat, solves.id
            FROM solves
            INNER JOIN "users" ON "users".id = solves.userid
            WHERE solves.challengeid = challenges.id
              AND solves.source = 'flag'
              AND "users".banned = false
              ${view.frozen ? sql`AND solves.createdat <= ${new Date(view.cutoff).toISOString()}` : sql``}
              ${view.frozen && !view.ready ? sql`AND false` : sql``}
            ORDER BY solves.createdat ASC, solves.id ASC
            LIMIT 3
          ) AS first_blood
        ), ARRAY[]::text[])
      `.as('first_blood_ids'),
    })
    .from(challenges)
    .where(challengeIsPublicSql)

leaderboardGroup.route(
  GetLeaderboardChallengesRouteV2,
  async ({ ctx, user, res }) => {
    const view = await getScoreboardView(ctx.var.db, ctx.var.redis, user)
    const rows = await getLeaderboardChallenges(ctx.var.db, view)

    return res.goodLeaderboardChallengesV2({
      challenges: Object.fromEntries(
        rows.map(row => {
          const scoringKind = scoringKindOf(row.data)
          return [
            row.id,
            {
              name: row.data.name ?? '',
              category: row.data.category ?? '',
              points: view.frozen && !view.ready ? 0 : (row.score ?? 0),
              solves: view.frozen && !view.ready ? 0 : (row.solveCount ?? 0),
              sortWeight: row.data.sortWeight ?? null,
              scoringKind,
              firstSolvers: (row.firstBloodIds ?? []).map(id => ({ id })),
            },
          ]
        })
      ),
    })
  }
)
