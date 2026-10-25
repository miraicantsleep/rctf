import { AdminBotJobStatus, InstanceStatus, type Challenge } from '@rctf/types'
import { QueryClient } from '@tanstack/svelte-query'
import { queryKeys } from '$lib/query/keys'
import { beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('$app/environment', () => ({ browser: false }))

let challenges!: typeof import('$lib/query/challenges')

beforeAll(async () => {
  challenges = await import('$lib/query/challenges')
})

const sorted = (ids: Set<string>): string[] => [...ids].sort()

describe('invalidateAfterSolve', () => {
  test('refreshes the solved challenge instance immediately and retains provider status', async () => {
    const queryClient = new QueryClient()
    const instance = { status: InstanceStatus.RUNNING }
    const instanceKey = queryKeys.challengeInstance('solved')
    const otherKey = queryKeys.challengeInstance('other')
    const adminKey = queryKeys.adminChallengeInstance('solved')
    for (const key of [instanceKey, otherKey, adminKey]) {
      queryClient.setQueryData(key, instance)
    }
    const markSolved = mock()

    const refreshed = challenges.invalidateAfterSolve(
      queryClient,
      'solved',
      markSolved
    )

    expect(markSolved.mock.calls).toEqual([['solved']])
    expect(queryClient.getQueryState(instanceKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData(instanceKey)).toEqual(instance)
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(adminKey)?.isInvalidated).toBe(false)
    await refreshed
    queryClient.clear()
  })

  test('stores confirmation across remounts and refreshes personal progress immediately without changing points', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const cached = [
      { id: 'solved', isSolved: false, points: 500, solves: 0 },
      { id: 'other', isSolved: false, points: 500, solves: 0 },
    ] as Challenge[]
    const pendingList = Promise.withResolvers<Challenge[]>()
    const fetchingList = Promise.withResolvers<void>()
    const refetchList = mock(() => {
      fetchingList.resolve()
      return pendingList.promise
    })
    const refetchSelf = mock(async () => ({
      id: 'team',
      solves: [{ id: 'solved' }],
    }))
    queryClient.setQueryDefaults(queryKeys.challenges, { queryFn: refetchList })
    queryClient.setQueryDefaults(queryKeys.userSelf, { queryFn: refetchSelf })
    queryClient.setQueryData(queryKeys.challenges, cached)
    queryClient.setQueryData(queryKeys.userSelf, { id: 'team', solves: [] })
    const markSolved = mock()

    const refreshed = challenges.invalidateAfterSolve(
      queryClient,
      'solved',
      markSolved
    )
    // The cache update happens after cancellation, without waiting for the new response.
    await fetchingList.promise
    const confirmed = queryClient.getQueryData<Challenge[]>(
      queryKeys.challenges
    )!
    expect(confirmed).toEqual([{ ...cached[0]!, isSolved: true }, cached[1]!])
    expect(
      sorted(challenges.deriveSolvedIds([], new Set(), confirmed))
    ).toEqual(['solved'])
    expect(refetchList).toHaveBeenCalledTimes(1)
    expect(refetchSelf).toHaveBeenCalledTimes(1)

    pendingList.resolve(confirmed)
    await refreshed
    queryClient.clear()
  })

  test('cancels a pre-solve response so it cannot erase the confirmation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const stale = [{ id: 'solved', isSolved: false }] as Challenge[]
    const fresh = [{ id: 'solved', isSolved: true }] as Challenge[]
    const oldResponse = Promise.withResolvers<Challenge[]>()
    const queryFn = mock<() => Promise<Challenge[]>>()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValue(fresh)
    queryClient.setQueryData(queryKeys.challenges, stale)
    const oldRequest = queryClient
      .fetchQuery({
        queryKey: queryKeys.challenges,
        queryFn,
        staleTime: 0,
      })
      .catch(() => undefined)

    await challenges.invalidateAfterSolve(queryClient, 'solved', mock())
    oldResponse.resolve(stale)
    await oldRequest
    await Promise.resolve()
    expect(queryClient.getQueryData(queryKeys.challenges)).toEqual(fresh)
    expect(queryFn).toHaveBeenCalledTimes(2)
    queryClient.clear()
  })
})

describe('deriveSolvedIds', () => {
  test('unions server and local ids without duplicates', () => {
    const result = challenges.deriveSolvedIds(
      [{ id: 'a' }, { id: 'b' }],
      new Set(['b', 'c'])
    )
    expect(sorted(result)).toEqual(['a', 'b', 'c'])
  })

  test('keeps local ids when server solves are null', () => {
    expect(sorted(challenges.deriveSolvedIds(null, new Set(['x'])))).toEqual([
      'x',
    ])
  })

  test('keeps local ids when server solves are undefined', () => {
    expect(
      sorted(challenges.deriveSolvedIds(undefined, new Set(['x'])))
    ).toEqual(['x'])
  })

  test('returns an empty set when both sources are empty', () => {
    expect(sorted(challenges.deriveSolvedIds([], new Set()))).toEqual([])
  })

  test('returns server ids when the local set is empty', () => {
    expect(
      sorted(challenges.deriveSolvedIds([{ id: 'a' }], new Set()))
    ).toEqual(['a'])
  })

  test('uses live challenge confirmation while standings stay at zero and profile data is stale', () => {
    expect(
      sorted(
        challenges.deriveSolvedIds([], new Set(), [
          { id: 'post-freeze', isSolved: true },
          { id: 'unsolved', isSolved: false },
        ])
      )
    ).toEqual(['post-freeze'])
  })

  test('prefers explicit challenge status over older profile data, retaining a newly confirmed solve', () => {
    expect(
      sorted(
        challenges.deriveSolvedIds(
          [{ id: 'removed' }, { id: 'legacy' }],
          new Set(['confirmed']),
          [
            { id: 'removed', isSolved: false },
            { id: 'legacy' },
            { id: 'confirmed', isSolved: false },
          ]
        )
      )
    ).toEqual(['confirmed', 'legacy'])
  })
})

describe('deriveBloodIds', () => {
  test('maps bloodIndex 0/1/2 to gold/silver/bronze', () => {
    const result = challenges.deriveBloodIds([
      { id: 'first', bloodIndex: 0 },
      { id: 'second', bloodIndex: 1 },
      { id: 'third', bloodIndex: 2 },
    ])
    expect(sorted(result.gold)).toEqual(['first'])
    expect(sorted(result.silver)).toEqual(['second'])
    expect(sorted(result.bronze)).toEqual(['third'])
  })

  test('ignores solves with null or out-of-range bloodIndex', () => {
    const result = challenges.deriveBloodIds([
      { id: 'a', bloodIndex: null },
      { id: 'b', bloodIndex: 3 },
      { id: 'c', bloodIndex: 0 },
    ])
    expect(sorted(result.gold)).toEqual(['c'])
    expect(sorted(result.silver)).toEqual([])
    expect(sorted(result.bronze)).toEqual([])
  })

  const nullish: [null | undefined][] = [[null], [undefined]]
  test.each(nullish)('returns empty sets for %p solves', solves => {
    const result = challenges.deriveBloodIds(solves)
    expect(sorted(result.gold)).toEqual([])
    expect(sorted(result.silver)).toEqual([])
    expect(sorted(result.bronze)).toEqual([])
  })

  test('collects multiple ids per placement', () => {
    const result = challenges.deriveBloodIds([
      { id: 'a', bloodIndex: 0 },
      { id: 'b', bloodIndex: 0 },
    ])
    expect(sorted(result.gold)).toEqual(['a', 'b'])
  })
})

describe('getNextOffset', () => {
  const cases: [number, number, number, number | undefined][] = [
    [0, 100, 250, 100],
    [100, 100, 250, 200],
    [200, 50, 250, undefined],
    [200, 100, 250, undefined],
    [0, 0, 0, undefined],
    [0, 5, 5, undefined],
    [0, 3, 10, 3],
  ]
  test.each(cases)(
    'lastOffset=%i count=%i total=%i -> %p',
    (lastOffset, count, total, expected) => {
      expect(challenges.getNextOffset(lastOffset, count, total)).toBe(expected)
    }
  )
})

describe('didAdminBotJobBecomeTerminal', () => {
  const job = (id: string, status: AdminBotJobStatus) => ({ id, status })

  test.each([
    [AdminBotJobStatus.QUEUED, AdminBotJobStatus.COMPLETED],
    [AdminBotJobStatus.QUEUED, AdminBotJobStatus.FAILED],
    [AdminBotJobStatus.RUNNING, AdminBotJobStatus.COMPLETED],
    [AdminBotJobStatus.RUNNING, AdminBotJobStatus.FAILED],
  ])('detects %s -> %s for the same job', (previous, current) => {
    expect(
      challenges.didAdminBotJobBecomeTerminal(
        job('job-1', previous),
        job('job-1', current)
      )
    ).toBe(true)
  })

  test.each([
    [AdminBotJobStatus.QUEUED, AdminBotJobStatus.QUEUED],
    [AdminBotJobStatus.QUEUED, AdminBotJobStatus.RUNNING],
    [AdminBotJobStatus.RUNNING, AdminBotJobStatus.RUNNING],
    [AdminBotJobStatus.COMPLETED, AdminBotJobStatus.COMPLETED],
    [AdminBotJobStatus.FAILED, AdminBotJobStatus.FAILED],
  ])('ignores non-terminal transition %s -> %s', (previous, current) => {
    expect(
      challenges.didAdminBotJobBecomeTerminal(
        job('job-1', previous),
        job('job-1', current)
      )
    ).toBe(false)
  })

  test('ignores a terminal status belonging to a different job', () => {
    expect(
      challenges.didAdminBotJobBecomeTerminal(
        job('job-1', AdminBotJobStatus.RUNNING),
        job('job-2', AdminBotJobStatus.COMPLETED)
      )
    ).toBe(false)
  })

  test('ignores initial and missing jobs', () => {
    expect(
      challenges.didAdminBotJobBecomeTerminal(
        null,
        job('job-1', AdminBotJobStatus.COMPLETED)
      )
    ).toBe(false)
    expect(
      challenges.didAdminBotJobBecomeTerminal(
        job('job-1', AdminBotJobStatus.RUNNING),
        null
      )
    ).toBe(false)
  })
})
