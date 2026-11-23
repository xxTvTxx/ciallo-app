/**
 * CialloAPI gateway knowledge shared by catalog resolution, discovery, and
 * dispatch. A CialloAPI route is named `cialloapi` or `cialloapi-<n>` (n ≥ 2):
 * the Models page stores one route per gateway API key, because each key
 * belongs to exactly one gateway group.
 *
 * @module dsh-llm-pi-ai/ciallo
 */
import type { PiAiReasoningEfforts } from './catalog.ts'

/** Gateway origin whose model metadata this module describes. */
export const CIALLO_ORIGIN = 'https://cialloapi.com'

const CIALLO_ROUTE = /^cialloapi(?:-(?:[2-9]|[1-9]\d+))?$/

/**
 * Report whether a provider route key names a CialloAPI group route.
 * @param provider - route key, when the caller has one.
 * @returns whether the key follows the CialloAPI group naming.
 */
export function isCialloRoute(provider: string | undefined): boolean {
  return provider !== undefined && CIALLO_ROUTE.test(provider)
}

// The gateway's Claude effort catalog offers these levels on its Anthropic endpoint.
const CIALLO_ADAPTIVE_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
const CIALLO_ADAPTIVE_EFFORTS: PiAiReasoningEfforts = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * Known Claude effort levels on CialloAPI's Anthropic and Responses endpoints.
 * @param provider - route key.
 * @param api - route wire protocol.
 * @param baseURL - route endpoint.
 * @param model - model id.
 * @returns the effort map, or undefined when the gateway metadata does not describe the model.
 */
export function cialloReasoningEfforts(
  provider: string | undefined, api: string, baseURL: string, model: string,
): PiAiReasoningEfforts | undefined {
  if (!isCialloRoute(provider) || (api !== 'anthropic-messages' && api !== 'openai-responses')
    || !CIALLO_ADAPTIVE_MODELS.has(model) || URL.parse(baseURL)?.origin !== CIALLO_ORIGIN) return undefined
  return CIALLO_ADAPTIVE_EFFORTS
}

/**
 * Session affinity a route uses when its profile leaves `sessionAffinity` unset:
 * on for CialloAPI Anthropic routes, off elsewhere.
 * @param provider - route key.
 * @param api - configured route protocol, if any.
 * @returns the default affinity.
 */
export function defaultSessionAffinity(provider: string, api: string | undefined): boolean {
  return isCialloRoute(provider) && api === 'anthropic-messages'
}

/**
 * Anthropic `metadata.user_id` that lets the gateway keep one session on one
 * upstream account. The value follows Claude Code's JSON layout, which the
 * gateway parses for its account selection.
 * @param deviceId - stable identifier of this machine.
 * @param sessionId - root Session id shared by a session and its subagents.
 * @returns the user id string.
 */
export function affinityUserId(deviceId: string, sessionId: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId })
}
