import type { Challenge, DatabaseClient, User } from '@rctf/db'
import type {
  BadChallenge,
  BadEndpoint,
  BadInstancerError,
  BadRateLimit,
  GoodInstancerActionResult,
  ResponseHelpers,
} from '@rctf/types'
import { InstanceStatus } from '@rctf/types'
import type { PinoLogger } from 'hono-pino'
import type { TypedRedis } from '../cache/scripts'
import type {
  InstanceQueryOptions,
  instanceDetailsOrError,
  InstancerProvider,
} from '../providers/instancer/base'
import { inferChallengeIntegrationId } from '../util/instancer'
import {
  buildCreateInstanceOptions,
  filterInstanceEndpoints,
  getInstancerChallenge,
  getInstancerProvider,
  resolveInstancerName,
  returnInstanceStatusOrError,
  type InstancerResponseHelpers,
} from './instancer'
import { rateLimitInstancerAction } from './rate-limit'

export interface InstanceRequest {
  res: InstancerResponseHelpers
  db: DatabaseClient
  user: User
  challengeId: string
  includeHidden?: boolean
}

type InstanceResponse = ReturnType<
  InstancerResponseHelpers[keyof InstancerResponseHelpers]
>

type InstanceActionResponseHelpers = ResponseHelpers<
  [
    typeof GoodInstancerActionResult,
    typeof BadInstancerError,
    typeof BadEndpoint,
    typeof BadChallenge,
    typeof BadRateLimit,
  ]
>

export interface InstanceActionRequest {
  res: InstanceActionResponseHelpers
  db: DatabaseClient
  redis: TypedRedis
  user: User
  challengeId: string
  actionId: string
  includeHidden?: boolean
}

type InstanceActionResponse = ReturnType<
  InstanceActionResponseHelpers[keyof InstanceActionResponseHelpers]
>

const instancerError = (message: string): instanceDetailsOrError => ({
  kind: 'instancerError',
  message,
})

const instanceQueryOptions = (
  teamId: string,
  challenge: Challenge
): InstanceQueryOptions => ({
  teamId,
  challengeIntegrationId: inferChallengeIntegrationId(challenge),
  config: challenge.data.instancerConfig!.config,
})

// Best effort only: callers must not await this when accepting a solve.
export const stopInstanceAfterSolve = async (
  challenge: Challenge,
  teamId: string,
  log: PinoLogger
): Promise<void> => {
  const instancerConfig = challenge.data.instancerConfig
  if (!instancerConfig) {
    return
  }

  const instancerName = resolveInstancerName(instancerConfig)
  try {
    const provider = getInstancerProvider(instancerName)
    if (!provider) {
      throw new Error(
        `Instancer "${instancerName ?? 'default'}" is not available`
      )
    }
    if (!provider.capabilities.canStop) {
      return
    }

    const options = instanceQueryOptions(teamId, challenge)
    const instance = await provider.getInstance(options)
    if (instance.kind === 'instancerError') {
      throw new Error(instance.message)
    }
    if (
      instance.status === InstanceStatus.STOPPED ||
      instance.status === InstanceStatus.STOPPING
    ) {
      return
    }

    const result = await provider.deleteInstance(options)
    if (result.kind === 'instancerError') {
      throw new Error(result.message)
    }
  } catch (err) {
    log.error(
      { err, teamId, challengeId: challenge.id, instancerName },
      'failed to stop instance after solve'
    )
  }
}

const withInstancerChallenge = async (
  { res, db, challengeId, includeHidden }: InstanceRequest,
  run: (
    challenge: Challenge,
    provider: InstancerProvider
  ) => Promise<instanceDetailsOrError>
): Promise<InstanceResponse> => {
  const { challenge, provider, error } = await getInstancerChallenge(
    res,
    db,
    challengeId,
    { includeHidden }
  )
  if (error) {
    return error
  }

  const instanceStatus = await run(challenge, provider)
  return await returnInstanceStatusOrError(
    res,
    filterInstanceEndpoints(instanceStatus, challenge)
  )
}

export const getInstanceStatus = (
  request: InstanceRequest
): Promise<InstanceResponse> =>
  withInstancerChallenge(request, (challenge, provider) =>
    provider.getInstance(instanceQueryOptions(request.user.id, challenge))
  )

export const createInstance = (
  request: InstanceRequest
): Promise<InstanceResponse> =>
  withInstancerChallenge(request, async (challenge, provider) =>
    provider.createInstance(
      await buildCreateInstanceOptions(request.db, challenge, request.user)
    )
  )

export const deleteInstance = (
  request: InstanceRequest
): Promise<InstanceResponse> =>
  withInstancerChallenge(request, async (challenge, provider) => {
    if (!provider.capabilities.canStop) {
      return instancerError('Stopping is disabled for this instancer')
    }

    return await provider.deleteInstance(
      instanceQueryOptions(request.user.id, challenge)
    )
  })

export const extendInstance = (
  request: InstanceRequest
): Promise<InstanceResponse> =>
  withInstancerChallenge(request, async (challenge, provider) => {
    if (!provider.capabilities.canExtend) {
      return instancerError('Extending is disabled for this instancer')
    }

    const instancerConfig = challenge.data.instancerConfig!
    if (instancerConfig.extendable === false) {
      return instancerError('Extending is disabled for this challenge')
    }

    return await provider.extendInstance({
      ...instanceQueryOptions(request.user.id, challenge),
      timeoutMilliseconds: instancerConfig.timeoutMilliseconds,
    })
  })

export const runInstanceAction = async ({
  res,
  db,
  redis,
  user,
  challengeId,
  actionId,
  includeHidden,
}: InstanceActionRequest): Promise<InstanceActionResponse> => {
  const { challenge, provider, error } = await getInstancerChallenge(
    res,
    db,
    challengeId,
    { includeHidden }
  )
  if (error) {
    return error
  }

  const action = provider.actions?.find(a => a.id === actionId)
  if (!action || !provider.runAction) {
    return res.badInstancerError({ message: 'Unknown instancer action' })
  }

  if (action.rateLimit) {
    const timeLeft = await rateLimitInstancerAction(
      redis,
      user.id,
      challengeId,
      action.id,
      action.rateLimit.burst,
      action.rateLimit.intervalMilliseconds
    )
    if (timeLeft !== undefined) {
      return res.badRateLimit({ timeLeft })
    }
  }

  const outcome = await provider.runAction(
    action.id,
    instanceQueryOptions(user.id, challenge)
  )
  if (outcome.kind === 'instancerError') {
    return res.badInstancerError(outcome)
  }

  return res.goodInstancerActionResult({
    message: outcome.message ?? null,
    submitFlag: outcome.submitFlag ?? null,
  })
}
