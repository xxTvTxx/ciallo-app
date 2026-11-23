/** CialloAPI gateway identity and the protocol-specific base URLs its routes use. */

/** The gateway's product name, default dashboard origin, and first route id. */
export const CIALLO_API = {
  provider: 'cialloapi',
  displayName: 'CialloAPI',
  origin: 'https://cialloapi.com',
} as const

const BASE_SUFFIXES = new Map([
  ['openai-responses', '/v1'],
  ['openai-completions', '/v1'],
  ['anthropic-messages', ''],
  ['google-generative-ai', '/v1beta'],
])

/** Path suffixes a pasted API URL may carry beyond the gateway address. */
const API_PATH = /\/v1(?:beta)?(?:\/(?:models|messages|responses|chat\/completions))?$/

/**
 * Select protocols served by the gateway, with Responses first for Codex-compatible keys.
 * @param available - protocols the pi-ai schema accepts.
 * @returns the gateway protocols the schema accepts, in gateway preference order.
 */
export function cialloApiProtocols(available: readonly string[]): string[] {
  return [...BASE_SUFFIXES.keys()].filter(protocol => available.includes(protocol))
}

/**
 * Accept the dashboard origin or an API URL, preserving a reverse proxy's path prefix.
 * @param input - address as typed.
 * @param protocol - route protocol whose SDK base the result must suit.
 * @returns the protocol's base URL, or undefined for an unusable address or unknown protocol.
 */
export function cialloApiBaseURL(input: string, protocol: string): string | undefined {
  const url = URL.parse(input.trim())
  const suffix = BASE_SUFFIXES.get(protocol)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash || suffix === undefined) return undefined
  const prefix = url.pathname.replace(/\/+$/, '').replace(API_PATH, '')
  return url.origin + prefix + suffix
}

/**
 * Recover the gateway address a stored base URL was derived from.
 * @param baseURL - a route's stored base URL.
 * @returns the address without its protocol suffix, or undefined when the value is not an HTTP URL.
 */
export function cialloApiOrigin(baseURL: string): string | undefined {
  const url = URL.parse(baseURL.trim())
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  return url.origin + url.pathname.replace(/\/+$/, '').replace(API_PATH, '')
}
