/** Read-only detection and idempotent import from a legacy ~/.dsh home into the active home. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { sessionListMetadataDefinition } from '@deepseek-ai/dsh-session-query/src/list-metadata.ts'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply,
  Config as storageDomainConfig,
  inject as storageDomainInject,
  name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply,
  Config as storageJsonConfig,
  inject as storageJsonInject,
  name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import SettingsController from '../src/index.ts'

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('legacy ~/.dsh inspection and migration', () => {
  it('reports unavailable when the legacy home is absent or matches the target home', async () => {
    const missingRoot = await makeTempDir('dsh-legacy-missing-')
    const targetRoot = await makeTempDir('dsh-target-empty-')

    const absentCtx = new Context()
    onTestFinished(() => absentCtx.fiber.dispose())
    const absentController = new SettingsController(absentCtx, {
      legacyHome: () => join(missingRoot, 'nonexistent'),
      targetHome: () => targetRoot,
    })
    const absent = await absentController.inspectLegacyDsh(new AbortController().signal)
    expect(absent.available).toBe(false)
    expect(absent.sessionCount).toBe(0)

    const sameCtx = new Context()
    onTestFinished(() => sameCtx.fiber.dispose())
    const sameController = new SettingsController(sameCtx, {
      legacyHome: () => targetRoot,
      targetHome: () => targetRoot,
    })
    const same = await sameController.inspectLegacyDsh(new AbortController().signal)
    expect(same.available).toBe(false)
  })

  it('detects legacy artifacts without exposing secrets and imports idempotently', async () => {
    const legacyRoot = await makeTempDir('dsh-legacy-src-')
    const targetRoot = await makeTempDir('dsh-target-dst-')
    const workspaceDir = await makeTempDir('dsh-workspace-proj-')

    // Populate legacy sessions, projcache, attachments, skills, AGENTS.md, workspace metadata, and credentials.
    const s1Dir = join(legacyRoot, 'sessions', '--proj--', 'sess-1')
    const s2Dir = join(legacyRoot, 'sessions', '--proj--', 'sess-2')
    await mkdir(s1Dir, { recursive: true })
    await mkdir(s2Dir, { recursive: true })
    await writeFile(join(s1Dir, 'session.v4.jsonl.zstd'), 'legacy-session-1', 'utf8')
    await writeFile(join(s2Dir, 'session.v4.jsonl.zstd'), 'legacy-session-2', 'utf8')
    // Pre-existing session in target must never be overwritten.
    const existingS2 = join(targetRoot, 'sessions', '--proj--', 'sess-2')
    await mkdir(existingS2, { recursive: true })
    await writeFile(join(existingS2, 'session.v4.jsonl.zstd'), 'target-existing-session-2', 'utf8')

    await mkdir(join(legacyRoot, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(legacyRoot, 'storages', 'session_projcache', 'sessions', 'sess-1.json'), '{"title":"Legacy"}', 'utf8')
    await writeFile(
      join(legacyRoot, 'storages', 'workspace.json'),
      JSON.stringify({ tables: { workspaces: { w1: { path: workspaceDir, title: 'My Legacy Project' } } } }),
      'utf8',
    )

    await mkdir(join(legacyRoot, 'attachments', 'objects', 'aa'), { recursive: true })
    await writeFile(join(legacyRoot, 'attachments', 'objects', 'aa', 'img.png'), 'png-bytes', 'utf8')
    await mkdir(join(legacyRoot, 'skills', 'custom-skill'), { recursive: true })
    await writeFile(join(legacyRoot, 'skills', 'custom-skill', 'SKILL.md'), '# Skill', 'utf8')
    await writeFile(join(legacyRoot, 'AGENTS.md'), '# Global Instructions', 'utf8')

    const secretOne = 'sk-super-secret-legacy-123'
    const secretTwo = 'sk-already-configured-456'
    await writeFile(
      join(legacyRoot, '.credentials.yaml'),
      [
        'version: 1',
        'refs:',
        `  CIALLOAPI_API_KEY: "${secretOne}"`,
        `  OPENAI_API_KEY: "${secretTwo}"`,
        'records:',
        '  deepseek-account/token: ignored',
        '',
      ].join('\n'),
      'utf8',
    )

    const storedCredentials = new Map<string, string>([['OPENAI_API_KEY', secretTwo]])
    const attached = new Set<string>()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('credentials', {
      async describe(ref: unknown) {
        const key = String(ref)
        const info: CredentialInfo = {
          configured: storedCredentials.has(key),
          writable: true,
        }
        return info
      },
      async set(ref: unknown, value: string) {
        storedCredentials.set(String(ref), value)
      },
    } as never)
    ctx.provide('sessionPersistence', {
      async list() {
        return [
          { header: { id: 'sess-1', createdAt: 100, cwd: workspaceDir, version: 4, isSeeded: false }, revision: 'r1' },
          { header: { id: 'sess-2', createdAt: 200, cwd: workspaceDir, version: 4, isSeeded: false }, revision: 'r2' },
        ]
      },
    } as never)
    const fakeWorkspace = {
      id: 'ws-1',
      path: workspaceDir,
      title: 'My Legacy Project',
      get sessionIds() { return [...attached] },
      async attachSession(id: string) { attached.add(id) },
    }
    const createWorkspace = vi.fn(async () => fakeWorkspace)
    ctx.provide('workspaceRegistry', {
      create: createWorkspace,
    } as never)

    const controller = new SettingsController(ctx, {
      legacyHome: () => legacyRoot,
      targetHome: () => targetRoot,
    })

    const summary = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(summary.available).toBe(true)
    expect(summary.sourceDisplay).toBe('~/.dsh')
    expect(summary.sessionCount).toBe(2)
    expect(summary.newSessionCount).toBe(1)
    expect(summary.hasAttachments).toBe(true)
    expect(summary.hasSkills).toBe(true)
    expect(summary.hasAgentsMd).toBe(true)
    expect(summary.credentialCount).toBe(2)
    expect(JSON.stringify(summary)).not.toContain(secretOne)
    expect(JSON.stringify(summary)).not.toContain(secretTwo)

    const first = await controller.importLegacyDsh({ includeCredentials: true }, new AbortController().signal)
    expect(first).toEqual({
      importedSessions: 1,
      skippedSessions: 1,
      attachedWorkspaces: 1,
      importedAttachments: 1,
      importedSkills: 1,
      importedAgentsMd: true,
      importedCredentials: 1,
      importedProviders: 0,
    })
    expect(await readFile(join(targetRoot, 'sessions', '--proj--', 'sess-1', 'session.v4.jsonl.zstd'), 'utf8')).toBe('legacy-session-1')
    expect(await readFile(join(existingS2, 'session.v4.jsonl.zstd'), 'utf8')).toBe('target-existing-session-2')
    expect(await readFile(join(targetRoot, 'AGENTS.md'), 'utf8')).toBe('# Global Instructions')
    expect(storedCredentials.get(String(credentialRef('CIALLOAPI_API_KEY')))).toBe(secretOne)
    expect(createWorkspace).toHaveBeenCalledWith(workspaceDir, 'My Legacy Project')
    expect(attached).toEqual(new Set(['sess-1', 'sess-2']))

    // Second run is completely idempotent and imports zero duplicates.
    const second = await controller.importLegacyDsh({ includeCredentials: true }, new AbortController().signal)
    expect(second).toEqual({
      importedSessions: 0,
      skippedSessions: 2,
      attachedWorkspaces: 0,
      importedAttachments: 0,
      importedSkills: 0,
      importedAgentsMd: false,
      importedCredentials: 0,
      importedProviders: 0,
    })
  })

  it('rejects non-owner principals', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('invocation', {
      peer: { principal: { kind: 'guest', id: 'p-1' } },
    } as never)
    const controller = new SettingsController(ctx)
    const failure = await controller.inspectLegacyDsh(new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.code).toBe('settings/rejected')
  })

  it('hydrates open SessionProjectionCache in memory via storageDomain and coldSnapshot without restart', async () => {
    const legacyRoot = await makeTempDir('dsh-legacy-projcache-src-')
    const targetRoot = await makeTempDir('dsh-target-projcache-dst-')
    const workspaceDir = await makeTempDir('dsh-workspace-projcache-')

    const idA = SessionId('legacy-cached-a')
    const idB = SessionId('legacy-cold-b')
    const idC = SessionId('legacy-heal-c')
    const headerA: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: idA,
      createdAt: 1_700_000_000_000,
      cwd: workspaceDir,
      isSeeded: false,
    }
    const headerB: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: idB,
      createdAt: 1_700_000_000_100,
      cwd: workspaceDir,
      isSeeded: false,
    }
    const headerC: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: idC,
      createdAt: 1_700_000_000_200,
      cwd: workspaceDir,
      isSeeded: false,
    }

    const makeEvents = (title: string): SessionEvent[] => [
      { type: 'turn/start', seq: SessionSeq(0), time: 1_700_000_001_000, data: { turn: 1 } },
      {
        type: 'session/title',
        seq: SessionSeq(1),
        time: 1_700_000_001_010,
        data: { title, messageSeqs: [], source: { kind: 'user' } },
      },
      { type: 'turn/end', seq: SessionSeq(2), time: 1_700_000_001_020, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    // Seed legacy JSONL logs via JsonlSessionPersistence, then dispose cleanly.
    const legacySeedCtx = new Context()
    await legacySeedCtx.plugin(JsonlSessionPersistence, {
      root: join(legacyRoot, 'sessions'),
      compression: 'none',
    })
    for (const [header, title] of [
      [headerA, 'Cached Legacy Title'],
      [headerB, 'Cold Folded Title'],
      [headerC, 'Repaired Cold Title'],
    ] as const) {
      const handle = await legacySeedCtx.sessionPersistence.create(header)
      try {
        await handle.append(makeEvents(title))
        await handle.flush()
      } finally {
        await handle.close()
      }
    }
    await legacySeedCtx.fiber.dispose()

    // Session A has a persisted per-record projection cache entry in ~/.dsh;
    // Session B has no cache entry at all; Session C will simulate raw-copied log without cache.
    await mkdir(join(legacyRoot, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(
      join(legacyRoot, 'storages', 'session_projcache', 'sessions', `${idA}.json`),
      JSON.stringify({
        version: projectionCacheDomainSpec.version,
        record: {
          identity: {
            formatVersion: SESSION_FORMAT_VERSION,
            createdAt: headerA.createdAt,
            cwd: workspaceDir,
            isSeeded: false,
            inheritedEventCount: 0,
          },
          rows: {
            title: { ver: 1, seq: 1, val: 'Cached Legacy Title' },
            sessionListMetadata: { ver: 1, seq: 0, val: { blank: false, lastPromptAt: 1_700_000_000_050 } },
          },
        },
      }),
      'utf8',
    )

    // Pre-copy Session C's log directory (without any projcache entry) to verify self-healing inspection & repair later.
    await mkdir(join(targetRoot, 'sessions'), { recursive: true })

    // Boot target Host storage + projection cache BEFORE importing (matching live web/desktop runtime).
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    await ctx.plugin(
      { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
      { root: join(targetRoot, 'storages') },
    )
    await ctx.plugin(
      { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
      { backend: 'json' },
    )
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.sessionProjections.register(titleProjectionDefinition)
    await ctx.sessionProjections.register(sessionListMetadataDefinition)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    await ctx.plugin(JsonlSessionPersistence, {
      root: join(targetRoot, 'sessions'),
      compression: 'none',
    })

    const controller = new SettingsController(ctx, {
      legacyHome: () => legacyRoot,
      targetHome: () => targetRoot,
    })

    const before = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(before.available).toBe(true)
    expect(before.sessionCount).toBe(3)
    expect(before.newSessionCount).toBe(3)
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerA)).toBeUndefined()
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerB)).toBeUndefined()
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerC)).toBeUndefined()

    const outcome = await controller.importLegacyDsh({ includeCredentials: false }, new AbortController().signal)
    expect(outcome.importedSessions).toBe(3)
    expect(outcome.skippedSessions).toBe(0)

    expect(ctx.sessionProjectionCache.cachedSnapshot(headerA)?.values).toEqual({
      title: 'Cached Legacy Title',
      sessionListMetadata: { blank: false, lastPromptAt: 1_700_000_000_050 },
    })
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerB)?.values).toEqual({
      title: 'Cold Folded Title',
      sessionListMetadata: { blank: false, lastPromptAt: null },
    })
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerC)?.values).toEqual({
      title: 'Repaired Cold Title',
      sessionListMetadata: { blank: false, lastPromptAt: null },
    })

    const after = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(after.newSessionCount).toBe(0)

    // Remove Session C's on-disk + in-memory cache row via storageDomain to simulate a prior raw copy lacking cache.
    await ctx.storageDomain.get(projectionCacheDomainSpec.name)?.table('sessions').delete(idC)
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerC)).toBeUndefined()

    const needsHeal = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(needsHeal.newSessionCount).toBe(1)

    await controller.importLegacyDsh({ includeCredentials: false }, new AbortController().signal)
    expect(ctx.sessionProjectionCache.cachedSnapshot(headerC)?.values).toEqual({
      title: 'Repaired Cold Title',
      sessionListMetadata: { blank: false, lastPromptAt: null },
    })
    expect((await controller.inspectLegacyDsh(new AbortController().signal)).newSessionCount).toBe(0)
  })

  it('imports profile model providers, upgrades local affinity proxies, and preserves target routes', async () => {
    const legacyRoot = await makeTempDir('dsh-legacy-models-src-')
    const targetRoot = await makeTempDir('dsh-target-models-dst-')

    await mkdir(join(legacyRoot, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-ciallo-affinity'), { recursive: true })
    await mkdir(join(legacyRoot, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(legacyRoot, 'profiles', 'desktop', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {
          '@local/dsh-ciallo-affinity': 'github:xxTvTxx/dsh-ciallo-affinity#v1.1.2',
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@local/dsh-ciallo-affinity'],
          },
        },
      }),
      'utf8',
    )
    await writeFile(
      join(legacyRoot, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-ciallo-affinity', 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: ciallo-affinity',
        '      name: "@local/dsh-ciallo-affinity"',
        '      config:',
        '        port: 18765',
        '        upstream: https://cialloapi.com/',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(legacyRoot, 'profiles', 'desktop', 'cordis.patch.yml'),
      [
        '- id: theme',
        '  config:',
        '    accent: !js "window.defaultAccent"',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      ciallo-claude:',
        '        displayName: Ciallo-Claude',
        '        api: anthropic-messages',
        '        baseURL: http://127.0.0.1:18765',
        '        apiKeyEnv: OHMYSWITCH_CIALLO_CLAUDE_API_KEY',
        '      local-ollama:',
        '        displayName: Local Ollama',
        '        api: anthropic-messages',
        '        baseURL: http://127.0.0.1:11434',
        '      ciallo:',
        '        displayName: Ciallo',
        '        api: openai-responses',
        '        baseURL: https://cialloapi.com/v1',
        '        apiKeyEnv: OHMYSWITCH_CIALLO_API_KEY',
        '      existing-custom:',
        '        displayName: Legacy Custom',
        '        api: openai-completions',
        '        baseURL: https://legacy.example/v1',
        '        apiKeyEnv: LEGACY_KEY',
        '- id: agent-default-model',
        '  config:',
        '    provider: ciallo-claude',
        '    model: claude-opus-5-5',
        '    reasoningEffort: medium',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(legacyRoot, 'profiles', 'web', 'cordis.patch.yml'),
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      ciallo:',
        '        displayName: Web Duplicate Should Be Ignored',
        '        api: openai-responses',
        '        baseURL: https://ignored.example/v1',
        '      openrouter:',
        '        displayName: OpenRouter',
        '        api: openai-completions',
        '        baseURL: https://openrouter.ai/api/v1',
        '        apiKeyEnv: OPENROUTER_API_KEY',
        '',
      ].join('\n'),
      'utf8',
    )

    const piAiState: { providers: Record<string, Record<string, unknown>> } = {
      providers: {
        'existing-custom': {
          displayName: 'Target Existing Custom',
          api: 'openai-completions',
          baseURL: 'https://target.example/v1',
          apiKeyEnv: 'TARGET_KEY',
        },
      },
    }
    const defaultModelState: Record<string, unknown> = {}
    let piAiRevision = 1
    let defaultRevision = 1

    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('settings', {
      writable: true,
      describe: () => [
        {
          ns: 'llm-pi-ai',
          schema: { type: 'object', properties: { providers: { type: 'object' } } },
          value: { providers: { ...piAiState.providers } },
          user: { providers: { ...piAiState.providers } },
          revision: piAiRevision,
          applies: 'live',
        },
        {
          ns: 'agent-default-model',
          schema: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
          },
          value: { ...defaultModelState },
          user: { ...defaultModelState },
          revision: defaultRevision,
          applies: 'live',
        },
      ],
      async mutate(ns: string, ops: ReadonlyArray<{ op: string; path: readonly string[]; value?: unknown }>, expectedRevision?: number) {
        if (ns !== 'llm-pi-ai') throw new Error(`unexpected namespace ${ns}`)
        if (expectedRevision !== undefined && expectedRevision !== piAiRevision) {
          throw new Error(`revision conflict: ${expectedRevision} !== ${piAiRevision}`)
        }
        for (const op of ops) {
          if (op.op === 'set' && op.path.length === 2 && op.path[0] === 'providers') {
            piAiState.providers[op.path[1]!] = op.value as Record<string, unknown>
          }
        }
        piAiRevision++
      },
      async update(ns: string, patch: Record<string, unknown>, expectedRevision?: number) {
        if (ns !== 'agent-default-model') throw new Error(`unexpected namespace ${ns}`)
        if (expectedRevision !== undefined && expectedRevision !== defaultRevision) {
          throw new Error(`revision conflict: ${expectedRevision} !== ${defaultRevision}`)
        }
        Object.assign(defaultModelState, patch)
        defaultRevision++
      },
    } as never)

    const controller = new SettingsController(ctx, {
      legacyHome: () => legacyRoot,
      targetHome: () => targetRoot,
    })

    const before = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(before.available).toBe(true)
    expect(before.providerCount).toBe(5)
    expect(before.newProviderCount).toBe(4)

    const outcome = await controller.importLegacyDsh({ includeCredentials: false }, new AbortController().signal)
    expect(outcome.importedProviders).toBe(4)

    expect(piAiState.providers['existing-custom']).toEqual({
      displayName: 'Target Existing Custom',
      api: 'openai-completions',
      baseURL: 'https://target.example/v1',
      apiKeyEnv: 'TARGET_KEY',
    })
    expect(piAiState.providers['ciallo-claude']).toEqual({
      displayName: 'Ciallo-Claude',
      api: 'anthropic-messages',
      baseURL: 'https://cialloapi.com',
      apiKeyEnv: 'OHMYSWITCH_CIALLO_CLAUDE_API_KEY',
      sessionAffinity: true,
    })
    expect(piAiState.providers['local-ollama']).toEqual({
      displayName: 'Local Ollama',
      api: 'anthropic-messages',
      baseURL: 'http://127.0.0.1:11434',
    })
    expect(piAiState.providers['ciallo']).toEqual({
      displayName: 'Ciallo',
      api: 'openai-responses',
      baseURL: 'https://cialloapi.com/v1',
      apiKeyEnv: 'OHMYSWITCH_CIALLO_API_KEY',
    })
    expect(piAiState.providers['openrouter']).toEqual({
      displayName: 'OpenRouter',
      api: 'openai-completions',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    })
    expect(defaultModelState).toEqual({
      provider: 'ciallo-claude',
      model: 'claude-opus-5-5',
      reasoningEffort: 'medium',
    })

    const after = await controller.inspectLegacyDsh(new AbortController().signal)
    expect(after.providerCount).toBe(5)
    expect(after.newProviderCount).toBe(0)

    const second = await controller.importLegacyDsh({ includeCredentials: false }, new AbortController().signal)
    expect(second.importedProviders).toBe(0)
  })
})
