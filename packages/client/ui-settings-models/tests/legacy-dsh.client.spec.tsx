// @vitest-environment jsdom
/** One-click migration banner behavior in CialloStartDialog and ModelsSection. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LegacyDshSummary, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { CialloStartDialog, type CialloStartDialogProps } from '../src/client/CialloStartDialog.tsx'
import { ModelsSection, type ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    displayName: Schema.string(),
    api: Schema.union(['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']),
    baseURL: Schema.string(),
  })),
})

function piAiNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers: {} },
    user: { providers: {} },
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

function storeFixture() {
  const ctx = {
    remote: {
      llm: {
        listProviders: async () => ({ ok: true as const, value: [] }),
        listConfigurableProviders: async () => ({ ok: true as const, value: [] }),
        discoverModels: async () => ({ ok: true as const, value: [] }),
      },
      settings: {
        describe: async () => ({
          ok: true as const,
          value: { writable: true, hasDocument: false, namespaces: [piAiNamespace()] },
        }),
        mutate: async () => ({ ok: true as const, value: piAiNamespace() }),
      },
      credentials: {
        describe: async () => ({ ok: true as const, value: {} }),
        set: async () => ({ ok: true as const, value: undefined }),
      },
    },
  } as never
  return new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
}

const unusedHook = (() => { throw new Error('unused standard hook') }) as never
const useResource = unusedHook satisfies GlobalStandardProps['useResource']

describe('LegacyDshImportBanner integration', () => {
  it('shows migration banner in CialloStartDialog and allows opting out of credentials', async () => {
    const controller = storeFixture()
    await controller.load()
    let summary: LegacyDshSummary = {
      available: true,
      sourceDisplay: '~/.dsh',
      targetDisplay: '~/.ciallo',
      sessionCount: 4,
      newSessionCount: 4,
      hasAttachments: true,
      hasSkills: true,
      hasAgentsMd: true,
      credentialCount: 2,
      providerCount: 5,
      newProviderCount: 5,
    }
    const inspectLegacyDsh = vi.fn(async () => summary)
    const importLegacyDsh = vi.fn(async () => {
      summary = { ...summary, newSessionCount: 0, newProviderCount: 0 }
      return {
        kind: 'imported' as const,
        result: {
          importedSessions: 4,
          skippedSessions: 0,
          attachedWorkspaces: 1,
          importedAttachments: 2,
          importedSkills: 1,
          importedAgentsMd: true,
          importedCredentials: 0,
          importedProviders: 5,
        },
      }
    })
    const operations: ModelsOperations = {
      storeCredential: vi.fn(async () => undefined),
      removeCredential: vi.fn(async () => undefined),
      writeSettings: vi.fn(async () => ({ kind: 'written' as const, view: piAiNamespace() })),
      discoverModels: vi.fn(async () => ({ kind: 'found' as const, models: [] })),
      defaultModelAvailable: vi.fn(async () => false),
      saveDefaultModel: vi.fn(async () => undefined),
      inspectLegacyDsh,
      importLegacyDsh,
    }
    const startProps: CialloStartDialogProps = {
      stepId: 'ciallo-start',
      explicit: false,
      complete: vi.fn(),
      openSection: vi.fn(),
      useSessions: unusedHook,
      useSessionStatus: unusedHook,
      usePanelInfo: unusedHook,
      useSessionRetainInfo: () => undefined,
      useResource,
      useWorkspaces: unusedHook,
      ...allowAllAccess,
      useContextMenu: contextMenuHook(),
      controller,
      useModels: bindSnapshotSelector(controller.store),
      useAutomatic: bindSnapshotSelector(createSnapshotStore(true)),
      operations,
      schema: settingsSchema,
      t,
    }

    render(<CialloStartDialog {...startProps} />)

    expect(await screen.findByText(en.legacyDshTitle)).toBeTruthy()
    expect(screen.getByText(en.legacyDshOneWayHint)).toBeTruthy()
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en.legacyDshImportAction }))
    await waitFor(() => { expect(importLegacyDsh).toHaveBeenCalledWith({ includeCredentials: false }) })
    expect(await screen.findByText(/Imported 4 sessions \(0 skipped\), 5 model providers, 0 keys/)).toBeTruthy()
  })

  it('shows migration banner in ModelsSection when unimported sessions exist and reports errors', async () => {
    const controller = storeFixture()
    await controller.load()
    const operations: ModelsOperations = {
      storeCredential: vi.fn(async () => undefined),
      removeCredential: vi.fn(async () => undefined),
      writeSettings: vi.fn(async () => ({ kind: 'written' as const, view: piAiNamespace() })),
      discoverModels: vi.fn(async () => ({ kind: 'found' as const, models: [] })),
      defaultModelAvailable: vi.fn(async () => false),
      saveDefaultModel: vi.fn(async () => undefined),
      inspectLegacyDsh: vi.fn(async () => ({
        available: true,
        sourceDisplay: '~/.dsh',
        targetDisplay: '~/.ciallo',
        sessionCount: 3,
        newSessionCount: 2,
        hasAttachments: false,
        hasSkills: false,
        hasAgentsMd: false,
        credentialCount: 0,
        providerCount: 0,
        newProviderCount: 0,
      })),
      importLegacyDsh: vi.fn(async () => ({ kind: 'refused' as const, message: 'disk read failed' })),
    }
    const sectionProps: ModelsSectionProps = {
      controller,
      useSnapshot: bindSnapshotSelector(controller.store),
      operations,
      schema: settingsSchema,
      t,
      renderSlot: (_name, _props, options) => options?.fallback,
    }

    render(<ModelsSection {...sectionProps} />)

    expect(await screen.findByText(en.legacyDshTitle)).toBeTruthy()
    expect(screen.getByText(en.legacyDshOneWayHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.legacyDshImportAction }))
    expect(await screen.findByText('disk read failed')).toBeTruthy()
  })
})
