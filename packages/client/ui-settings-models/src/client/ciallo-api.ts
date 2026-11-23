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

/** Select protocols served by the gateway, with Responses first for Codex-compatible keys. */
export function cialloApiProtocols(available: readonly string[]): string[] {
  return [...BASE_SUFFIXES.keys()].filter(protocol => available.includes(protocol))
}

/** Accept the dashboard origin or an API URL, preserving a reverse proxy's path prefix. */
export function cialloApiBaseURL(input: string, protocol: string): string | undefined {
  const url = URL.parse(input.trim())
  const suffix = BASE_SUFFIXES.get(protocol)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash || suffix === undefined) return undefined
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:beta)?(?:\/(?:models|messages|responses|chat\/completions))?$/, '')
  return url.origin + prefix + suffix
}
