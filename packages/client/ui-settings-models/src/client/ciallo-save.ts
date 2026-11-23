/**
 * Create one CialloAPI group: the route profile, then its key, then — when the
 * deployment default model was unavailable before the group existed — the new
 * group's proposed model as the default. Shared by the Models page and the
 * first-run step so both leave the same configuration behind.
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { DefaultModelSelection, ModelsOperations } from './operations.ts'

/** Settings namespace holding every group route. */
export const CIALLO_NS = 'llm-pi-ai'

/** One create request. */
export interface CialloCreateRequest {
  /** New route id. */
  route: string
  /** Complete route profile. */
  profile: Record<string, JsonValue>
  /** Credential reference the profile names. */
  keyRef: string
  /** Key to store under {@link keyRef}. */
  key: string
  /** Namespace revision the draft opened at; a concurrent change is a conflict. */
  revision: number
  /** Default to adopt when the current one is unavailable; absent adopts nothing. */
  defaultModel?: DefaultModelSelection
  /**
   * Adopt {@link defaultModel} without asking whether the current default is
   * available. First run uses it: its dialog opens only while no provider is
   * usable, and a catalog may still list a provider's models without a key.
   */
  replaceDefault?: boolean
  /**
   * An earlier attempt stored the profile and failed at the key: retry only the
   * key, carrying that attempt's default-model decision.
   */
  resume?: CialloCreateResume
}

/** State an earlier attempt carries into a key-only retry. */
export interface CialloCreateResume {
  /** Whether the default model was unavailable before the profile was stored. */
  adoptDefault: boolean
}

/** What one create attempt answered. */
export type CialloCreateOutcome =
  /** The group exists with its key; `defaultFailure` reports a default-model write the Host refused. */
  | { kind: 'created'; defaultFailure?: string }
  /** A conflicting concurrent settings change refused the profile; nothing was written. */
  | { kind: 'conflict' }
  /** The Host refused a write; `resume` is present once the profile is stored. */
  | { kind: 'failed'; message: string; resume?: CialloCreateResume }

/**
 * Create one group. The default-model check runs before the profile write
 * because storing the profile reloads every llm-pi-ai route, which can hide a
 * default on another route of that namespace while it reloads.
 * @param operations - Host operations.
 * @param request - route, profile, key, and default-model choice.
 * @returns the attempt outcome.
 */
export async function createCialloGroup(
  operations: ModelsOperations,
  request: CialloCreateRequest,
): Promise<CialloCreateOutcome> {
  let resume = request.resume
  if (resume === undefined) {
    const adoptDefault = request.defaultModel !== undefined
      && (request.replaceDefault === true || !await operations.defaultModelAvailable())
    const written = await operations.writeSettings(
      CIALLO_NS,
      [{ op: 'set', path: ['providers', request.route], value: request.profile }],
      request.revision,
    )
    if (written.kind === 'conflict') return { kind: 'conflict' }
    if (written.kind === 'refused') return { kind: 'failed', message: written.message }
    resume = { adoptDefault }
  }
  const stored = await operations.storeCredential(request.keyRef, request.key)
  if (stored !== undefined) return { kind: 'failed', message: stored, resume }
  if (!resume.adoptDefault || request.defaultModel === undefined) return { kind: 'created' }
  const defaultFailure = await operations.saveDefaultModel(request.defaultModel)
  return defaultFailure === undefined ? { kind: 'created' } : { kind: 'created', defaultFailure }
}
