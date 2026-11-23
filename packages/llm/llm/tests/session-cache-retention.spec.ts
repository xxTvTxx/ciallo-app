/** Per-Session prompt-cache lifetime choices survive a restart and validate adapter metadata. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LlmRuntime, { LlmAdapter } from '../src/index.ts'
import type { LlmResolvedModelInfo, StreamChunk } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function runtime(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  return ctx
}

it('keeps each Session choice across a restart and forgets a cleared one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-llm-cache-retention-'))
  roots.push(root)
  const first = await runtime(root)
  await first.llm.setSessionCacheRetention('kept', 'long')
  await first.llm.setSessionCacheRetention('cleared', 'short')
  await first.llm.setSessionCacheRetention('cleared', null)
  expect(first.llm.sessionCacheRetention('kept')).toBe('long')
  await contexts.splice(0)[0]?.fiber.dispose()

  const second = await runtime(root)
  await second.llm.setSessionCacheRetention('other', 'short')
  expect(second.llm.remoteSessionCacheRetention('kept')).toEqual({ retention: 'long' })
  expect(second.llm.remoteSessionCacheRetention('cleared')).toEqual({})
  expect(second.llm.sessionCacheRetention('other')).toBe('short')
})

it('keeps choices for the process when the storage domain cannot open', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('storageDomain', { open: () => Promise.reject(new Error('locked')) } as never)
  await ctx.plugin(LlmRuntime)
  await ctx.llm.setSessionCacheRetention('memory', 'long')
  expect(ctx.llm.sessionCacheRetention('memory')).toBe('long')
})

class FixedAdapter extends LlmAdapter {
  constructor(private readonly info: Partial<LlmResolvedModelInfo>) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.info })
  }

  override async * stream(): AsyncIterable<StreamChunk> { await Promise.resolve() }
}

it('passes a valid lifetime choice through model metadata and rejects an unknown one', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['valid'], new FixedAdapter({ cacheRetention: { default: 'long' } }))
  ctx.llm.registerAdapter(['invalid'], new FixedAdapter({ cacheRetention: { default: 'forever' as never } }))
  expect((await ctx.llm.resolveModelInfo('valid', 'm')).cacheRetention).toEqual({ default: 'long' })
  await expect(ctx.llm.resolveModelInfo('invalid', 'm')).rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
})
