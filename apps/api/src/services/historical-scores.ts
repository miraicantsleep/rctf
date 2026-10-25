import { scoreEvents, type DatabaseClient } from '@rctf/db'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

export const divisionAtCutoff = (cutoff: number) => sql<string>`COALESCE((
  SELECT division FROM user_divisions
  WHERE userid = "users"."id" AND changed_at <= ${new Date(cutoff).toISOString()}
  ORDER BY changed_at DESC, id DESC LIMIT 1
), "users"."division")`

// A feed entry can disappear from solves when its total reaches zero. The
// immutable ledger is the only source for membership and tiebreaks at a cutoff.
export const historicalDynamicEntries = (
  db: DatabaseClient,
  cutoff: number,
  challengeIds: string[]
) => {
  const running = db
    .select({
      userId: sql<string>`${scoreEvents.userid}`.as('history_user_id'),
      challengeId: sql<string>`${scoreEvents.challengeid}`.as(
        'history_challenge_id'
      ),
      id: scoreEvents.id,
      eventAt: scoreEvents.eventAt,
      delta: scoreEvents.pointsDelta,
      points: sql<number>`SUM(${scoreEvents.pointsDelta}) OVER (
      PARTITION BY ${scoreEvents.userid}, ${scoreEvents.challengeid}
      ORDER BY ${scoreEvents.eventAt}, ${scoreEvents.id}
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )`
        .mapWith(Number)
        .as('history_points'),
    })
    .from(scoreEvents)
    .where(
      and(
        inArray(scoreEvents.challengeid, challengeIds),
        sql`${scoreEvents.userid} IS NOT NULL`,
        sql`${scoreEvents.eventAt} <= ${new Date(cutoff).toISOString()}`
      )
    )
    .as('history_running')

  const lifecycle = db
    .select({
      userId: running.userId,
      challengeId: running.challengeId,
      points: running.points,
      createdAt:
        sql<string>`MAX(CASE WHEN ${running.points} - ${running.delta} = 0 AND ${running.points} <> 0
      THEN ${running.eventAt} END) OVER (PARTITION BY ${running.userId}, ${running.challengeId})`.as(
          'history_created_at'
        ),
      pointsUpdatedAt:
        sql<string>`MAX(${running.eventAt}) FILTER (WHERE ${running.delta} <> 0)
      OVER (PARTITION BY ${running.userId}, ${running.challengeId})`.as(
          'history_points_updated_at'
        ),
      rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${running.userId}, ${running.challengeId}
      ORDER BY ${running.eventAt} DESC, ${running.id} DESC)`.as('history_rn'),
    })
    .from(running)
    .as('history_lifecycle')

  return db
    .select({
      userId: lifecycle.userId,
      challengeId: lifecycle.challengeId,
      points: lifecycle.points,
      createdAt: lifecycle.createdAt,
      pointsUpdatedAt: lifecycle.pointsUpdatedAt,
    })
    .from(lifecycle)
    .where(and(eq(lifecycle.rn, 1), ne(lifecycle.points, 0)))
    .as('historical_dynamic_entries')
}
