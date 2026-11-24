/** Read-only detection and idempotent import from a legacy ~/.dsh home into the active home. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
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
})
