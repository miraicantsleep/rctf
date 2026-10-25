import {
  BadAlreadySolvedChallenge,
  BadFlag,
  GoodFlag,
  SubmitFlagRoute,
} from '@rctf/types'
import { createFlagSubmitHandlers } from '$routes/challenges/details/flag-submit-handlers'
import { describe, expect, mock, test } from 'bun:test'

const effects = () => ({
  onSolve: mock(),
  onCorrect: mock(),
  onAlreadySolved: mock(),
  onError: mock(),
})

describe('flag submit form callbacks', () => {
  test('marks an accepted flag solved through the success callback', () => {
    const callbacks = effects()
    createFlagSubmitHandlers(callbacks).onSuccess({
      kind: GoodFlag.kind,
      message: GoodFlag.message,
    })
    expect(callbacks.onSolve).toHaveBeenCalledTimes(1)
    expect(callbacks.onCorrect).toHaveBeenCalledTimes(1)
    expect(callbacks.onAlreadySolved).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  test('handles the already-solved rejection through the error callback and confirms the solve', () => {
    const callbacks = effects()
    expect(SubmitFlagRoute.badResponses).toContain(BadAlreadySolvedChallenge)
    createFlagSubmitHandlers(callbacks).onError({
      kind: BadAlreadySolvedChallenge.kind,
      message: BadAlreadySolvedChallenge.message,
    })
    expect(callbacks.onSolve).toHaveBeenCalledTimes(1)
    expect(callbacks.onAlreadySolved).toHaveBeenCalledTimes(1)
    expect(callbacks.onCorrect).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  test('keeps a wrong flag as an error and leaves the challenge unsolved', () => {
    const callbacks = effects()
    const response = { kind: BadFlag.kind, message: BadFlag.message }
    createFlagSubmitHandlers(callbacks).onError(response)
    expect(callbacks.onSolve).not.toHaveBeenCalled()
    expect(callbacks.onCorrect).not.toHaveBeenCalled()
    expect(callbacks.onAlreadySolved).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(response)
  })
})
