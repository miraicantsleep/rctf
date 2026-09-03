import type { DatabaseClient, User } from '@rctf/db'
import { challenges, scoreEvents, users } from '@rctf/db'
import { takeUnique } from '@rctf/db/util'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { getDynamicScoresForUsers, getUserChallengeSolves } from './challenges'
import { getUser } from './users'
import type { ScoreboardView } from './scoreboard-visibility'

export type SolveData = {
  category: string
  name: string
  id: string
  createdAt: number
  solves: number | null
  points: number | null
  awardedPoints: number | null
  bloodIndex: number | null
}

export type DynamicScoreData = {
  id: string
  points: number
  pointDelta: number
}

export type FullUser = Omit<User, 'email' | 'ctftimeId'> & {
  email: string | null
  ctftimeId: string | null
  score: number
  globalPlace: number | null
  divisionPlace: number | null
  solves: SolveData[]
  dynamicScores: DynamicScoreData[]
}

export const getFullUser = async (
  db: DatabaseClient,
  user: User,
  view: ScoreboardView = { frozen: false, cutoff: undefined, ready: true }
): Promise<FullUser> => {
  const cutoff = view.frozen ? view.cutoff : undefined
  const [solves, freshRanks, dynamicScoresByUser] = await Promise.all([
    getUserChallengeSolves(db, user.id, cutoff),
    db
      .select({
        score: view.frozen
          ? view.ready
            ? users.frozenScore
            : sql<number | null>`NULL`
          : users.score,
        globalRank: view.frozen
          ? view.ready
            ? users.frozenGlobalRank
            : sql<number | null>`NULL`
          : users.globalRank,
        divisionRank: view.frozen
          ? view.ready
            ? users.frozenDivisionRank
            : sql<number | null>`NULL`
          : users.divisionRank,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .then(takeUnique),
    getDynamicScoresForUsers(db, [user.id], cutoff),
  ])

  const challengeIds = solves.map(item => item.solve.challengeid)
  const challengeScores = new Map<
    string,
    { score: number; solveCount: number }
  >()
  const challengeAwardedPoints = new Map<string, number>()

  if (challengeIds.length > 0) {
    const [challRows, awardedRows] = await Promise.all([
      db
        .select({
          id: challenges.id,
          score: view.frozen
            ? view.ready
              ? challenges.frozenScore
              : sql<number | null>`NULL`
            : challenges.score,
          solveCount: view.frozen
            ? view.ready
              ? challenges.frozenSolveCount
              : sql<number | null>`NULL`
            : challenges.solveCount,
        })
        .from(challenges)
        .where(inArray(challenges.id, challengeIds)),
      db
        .select({
          challengeId: scoreEvents.challengeid,
          pointsDelta: scoreEvents.pointsDelta,
        })
        .from(scoreEvents)
        .where(
          and(
            eq(scoreEvents.userid, user.id),
            inArray(scoreEvents.challengeid, challengeIds),
            eq(scoreEvents.source, 'flag'),
            gt(scoreEvents.pointsDelta, 0),
            cutoff === undefined
              ? undefined
              : sql`${scoreEvents.eventAt} <= ${new Date(cutoff).toISOString()}`
          )
        )
        .orderBy(asc(scoreEvents.eventAt), asc(scoreEvents.id)),
    ])

    for (const row of challRows) {
      challengeScores.set(row.id, {
        score: row.score ?? 0,
        solveCount: row.solveCount ?? 0,
      })
    }

    for (const row of awardedRows) {
      if (!challengeAwardedPoints.has(row.challengeId)) {
        challengeAwardedPoints.set(row.challengeId, row.pointsDelta)
      }
    }
  }

  return {
    ...user,
    email: user.email ?? null,
    ctftimeId: user.ctftimeId ?? null,
    score: freshRanks?.score ?? 0,
    globalPlace: freshRanks?.globalRank ?? null,
    divisionPlace: freshRanks?.divisionRank ?? null,
    dynamicScores: dynamicScoresByUser.get(user.id) ?? [],
    solves: solves.map(item => {
      const challScore = challengeScores.get(item.solve.challengeid)
      return {
        ...item.challengeData,
        id: item.solve.challengeid,
        createdAt: new Date(item.solve.createdat).getTime(),
        solves: challScore?.solveCount ?? null,
        points: challScore?.score ?? null,
        awardedPoints:
          challengeAwardedPoints.get(item.solve.challengeid) ?? null,
        bloodIndex: item.bloodIndex,
      }
    }),
  }
}

export const getFullUserFromId = async (
  db: DatabaseClient,
  id: string,
  view: ScoreboardView = { frozen: false, cutoff: undefined, ready: true }
): Promise<FullUser | undefined> => {
  const user = await getUser(db, id)
  if (!user || user.banned) {
    return undefined
  }
  return await getFullUser(db, user, view)
}
