import {
  BadAlreadySolvedChallenge,
  type RouteErrorResponse,
  type SubmitFlagRoute,
} from '@rctf/types'
import type { UseApiFormConfig } from '$lib/forms/use-api-form.svelte'

export function createFlagSubmitHandlers(effects: {
  onSolve: () => void
  onCorrect: () => void
  onAlreadySolved: () => void
  onError: (response: RouteErrorResponse<typeof SubmitFlagRoute>) => void
}): Required<
  Pick<UseApiFormConfig<typeof SubmitFlagRoute>, 'onSuccess' | 'onError'>
> {
  return {
    onSuccess: () => {
      effects.onSolve()
      effects.onCorrect()
    },
    onError: response => {
      if (response.kind === BadAlreadySolvedChallenge.kind) {
        effects.onSolve()
        effects.onAlreadySolved()
      } else {
        effects.onError(response)
      }
    },
  }
}
