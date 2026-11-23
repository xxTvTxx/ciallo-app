/** CialloAPI routes: group naming, session affinity, and per-Session cache lifetimes on the wire. */
import { hostname } from 'node:os'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as PiAi from '../src/index.ts'
import { affinityUserId, defaultSessionAffinity, isCialloRoute } from '../src/ciallo.ts'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { anthropicFrame, closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

const reply = [
  anthropicFrame({ type: 'message_start', message: {
    id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 },
  } }),
  anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } }),
  anthropicFrame({ type: 'content_block_stop', index: 0 }),
  anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
  anthropicFrame({ type: 'message_stop' }),
]

const parents = new Map<string, string>([['child', 'parent'], ['parent', 'root'], ['loop-a', 'loop-b'], ['loop-b', 'loop-a']])

async function harness(routes: Record<string, object>, withSessions = true): Promise<Context> {
  vi.stubEnv('CIALLO_TEST_KEY', 'fixture-key')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  if (withSessions) {
    ctx.provide('sessions', {
      get: (id: string) => ({ header: parents.has(id) ? { parentSession: parents.get(id) } : {} }),
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: routes })
  return ctx
}

const claude = (baseURL: string, extra: object = {}) => ({
  apiKeyEnv: 'CIALLO_TEST_KEY', api: 'anthropic-messages', baseURL, models: [{ id: 'claude-opus-5-5' }], ...extra,
})

const send = (ctx: Context, provider: string, sessionId?: string) => assemble(ctx, {
  provider, model: 'claude-opus-5-5',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
  ...sessionId === undefined ? {} : { sessionId: brandString<SessionId>(sessionId) },
})

type AnthropicBody = { metadata?: { user_id?: string } }
const body = (request: unknown): AnthropicBody => request as AnthropicBody
const TTL = /"cache_control":\{"type":"ephemeral","ttl":"([^"]+)"\}/
const ttlOf = (request: unknown): string | undefined => TTL.exec(JSON.stringify(request))?.[1]

describe('CialloAPI routes', () => {
  it('recognizes the group route keys and their default affinity', () => {
    expect(['cialloapi', 'cialloapi-2', 'cialloapi-12'].every(isCialloRoute)).toBe(true)
    expect(['cialloapi-1', 'cialloapi-02', 'cialloapi-x', 'ciallo', undefined].some(isCialloRoute)).toBe(false)
    expect(defaultSessionAffinity('cialloapi-2', 'anthropic-messages')).toBe(true)
    expect(defaultSessionAffinity('cialloapi', 'openai-responses')).toBe(false)
    expect(defaultSessionAffinity('gateway', 'anthropic-messages')).toBe(false)
    const profiles = resolveProfiles({
      'cialloapi': { api: 'anthropic-messages', baseURL: 'https://cialloapi.com', models: [{ id: 'm' }] },
      'cialloapi-2': { api: 'anthropic-messages', baseURL: 'https://cialloapi.com', sessionAffinity: false, models: [{ id: 'm' }] },
      'gateway': { api: 'anthropic-messages', baseURL: 'https://g.example', sessionAffinity: true, models: [{ id: 'm' }] },
    })
    expect([...profiles.values()].map(profile => profile.sessionAffinity)).toEqual([true, false, true])
  })

  it('sends the root Session as affinity metadata and the Session lifetime as the cache TTL', async () => {
    const server = await mockServer(Array.from({ length: 5 }, () => ({ events: reply })))
    const ctx = await harness({ 'cialloapi-2': claude(server.url) })
    await send(ctx, 'cialloapi-2', 'child')
    await ctx.llm.setSessionCacheRetention('root', 'long')
    await send(ctx, 'cialloapi-2', 'child')
    await ctx.llm.setSessionCacheRetention('child', 'short')
    await send(ctx, 'cialloapi-2', 'child')
    await send(ctx, 'cialloapi-2', 'loop-a')
    await send(ctx, 'cialloapi-2')
    const device = `dsh-${hostname()}`.toLowerCase()
    expect(body(server.requests[0]).metadata?.user_id).toBe(affinityUserId(device, 'root'))
    expect(JSON.parse(body(server.requests[0]).metadata?.user_id ?? '')).toEqual({ device_id: device, account_uuid: '', session_id: 'root' })
    expect(server.requests.slice(0, 3).map(ttlOf)).toEqual([undefined, '1h', undefined])
    expect(body(server.requests[3]).metadata?.user_id).toBe(affinityUserId(device, 'loop-b'))
    expect(body(server.requests[4]).metadata).toBeUndefined()
    expect(ctx.llm.remoteSessionCacheRetention('child')).toEqual({ retention: 'short' })
    await ctx.llm.setSessionCacheRetention('child', null)
    expect(ctx.llm.remoteSessionCacheRetention('child')).toEqual({})
  })

  it('describes the lifetime choice only where the route honors it', async () => {
    const ctx = await harness({
      'cialloapi': claude('https://cialloapi.com', { cacheRetention: 'long' }),
      'cialloapi-2': claude('https://cialloapi.com'),
      'off': claude('https://g.example', { cacheRetention: 'none' }),
      'short': claude('https://g.example', { compat: { supportsLongCacheRetention: false } }),
      'chat': { apiKeyEnv: 'CIALLO_TEST_KEY', api: 'openai-completions', baseURL: 'https://g.example', models: [{ id: 'claude-opus-5-5' }] },
    })
    const info = async (provider: string) => (await ctx.llm.resolveModelInfo(provider, 'claude-opus-5-5')).cacheRetention
    expect(await info('cialloapi')).toEqual({ default: 'long' })
    expect(await info('cialloapi-2')).toEqual({ default: 'short' })
    for (const provider of ['off', 'short', 'chat']) expect(await info(provider)).toBeUndefined()
  })

  it('keeps routes without affinity and processes without a Session store unchanged', async () => {
    const server = await mockServer([{ events: reply }, { events: textEvents }, { events: reply }])
    const ctx = await harness({
      'cialloapi': claude(server.url, { sessionAffinity: false }),
      'cialloapi-3': { apiKeyEnv: 'CIALLO_TEST_KEY', api: 'openai-completions', baseURL: server.url, models: [{ id: 'claude-opus-5-5' }] },
    }, false)
    await ctx.llm.setSessionCacheRetention('solo', 'long')
    await send(ctx, 'cialloapi', 'solo')
    await send(ctx, 'cialloapi-3', 'solo')
    expect(body(server.requests[0]).metadata).toBeUndefined()
    expect(ttlOf(server.requests[0])).toBe('1h')
    expect(server.requests[1]).not.toHaveProperty('metadata')
    const affine = await harness({ 'cialloapi': claude(server.url) }, false)
    await send(affine, 'cialloapi', 'solo')
    expect(body(server.requests[2]).metadata?.user_id).toBe(affinityUserId(`dsh-${hostname()}`.toLowerCase(), 'solo'))
  })
})
