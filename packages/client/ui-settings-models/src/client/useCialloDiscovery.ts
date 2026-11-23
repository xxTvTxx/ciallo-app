/** Ask a CialloAPI key which models its group serves, after typing settles or on demand. */

import { useEffect, useRef, useState } from 'react'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import { CIALLO_NS } from './ciallo-save.ts'

/** Pause after the last key edit before a typed or pasted key is interrogated. */
const SETTLE_MS = 400

/** The latest interrogation's state. */
export type CialloDiscovery =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  /** The key's group lists these models, keeping the first entry of a repeated id. */
  | { kind: 'found'; models: readonly LlmDiscoveredModel[] }
  /** The gateway answered with no models. */
  | { kind: 'empty' }
  /** The Host refused, with its diagnostic. */
  | { kind: 'failed'; message: string }

/** Discovery state and its two triggers. */
export interface CialloDiscoveryControl {
  /** The latest interrogation's state; an older answer never replaces a newer request's. */
  state: CialloDiscovery
  /**
   * Interrogate now.
   * @param request - endpoint facts as the form shows them.
   * @returns the listed models, or undefined when refused, empty, or superseded.
   */
  fetch: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[] | undefined>
  /**
   * Interrogate once edits settle, superseding any pending or running request.
   * @param request - endpoint facts, or undefined to return to idle (an unusable key).
   * @param onFound - receives the listed models when this request is still current.
   */
  schedule: (request: LlmModelDiscoveryRequest | undefined, onFound: (models: readonly LlmDiscoveredModel[]) => void) => void
}

/**
 * Track model discovery for one CialloAPI key field.
 * @param operations - Host operations.
 * @returns the discovery state and triggers.
 */
export function useCialloDiscovery(operations: ModelsOperations): CialloDiscoveryControl {
  const [state, setState] = useState<CialloDiscovery>({ kind: 'idle' })
  const latest = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    clearTimeout(timer.current)
    latest.current += 1
  }, [])

  const fetch = async (request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[] | undefined> => {
    clearTimeout(timer.current)
    const id = ++latest.current
    setState({ kind: 'fetching' })
    const answer = await operations.discoverModels(CIALLO_NS, request)
    if (id !== latest.current) return undefined
    if (answer.kind === 'refused') {
      setState({ kind: 'failed', message: answer.message })
      return undefined
    }
    // A listing may repeat an id; its first entry describes the model.
    const models = answer.models.filter((model, index) => answer.models.findIndex(other => other.id === model.id) === index)
    setState(models.length === 0 ? { kind: 'empty' } : { kind: 'found', models })
    return models.length === 0 ? undefined : models
  }

  const schedule: CialloDiscoveryControl['schedule'] = (request, onFound) => {
    clearTimeout(timer.current)
    latest.current += 1
    if (request === undefined) {
      setState({ kind: 'idle' })
      return
    }
    timer.current = setTimeout(() => {
      void fetch(request).then((models) => { if (models !== undefined) onFound(models) })
    }, SETTLE_MS)
  }

  return { state, fetch, schedule }
}
