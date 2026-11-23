// @vitest-environment jsdom
/** CialloAPI groups: recognition, the group card and editor, the shared create path, and the first-run step. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CredentialInfo, LlmDiscoveredModel, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { CIALLO_API, cialloApiBaseURL, cialloApiOrigin, cialloApiProtocols } from '../src/client/ciallo-api.ts'
import {
  cialloDisplayName, cialloGroupName, cialloKindProtocol, cialloPreferredModel, cialloProfile, cialloSessionAffinity,
  classifyCialloModels, compareCialloRoutes, isCialloRoute, mergeCialloModels, modelId, nextCialloRoute,
  readCialloProfile, storedCialloKind,
} from '../src/client/ciallo-groups.ts'
import { createCialloGroup } from '../src/client/ciallo-save.ts'
import type { CialloCreateRequest } from '../src/client/ciallo-save.ts'
import { CialloGroupEditor, profileAt } from '../src/client/CialloGroupEditor.tsx'
import type { CialloGroupEditorProps } from '../src/client/CialloGroupEditor.tsx'
import { CialloApiCard } from '../src/client/CialloApiCard.tsx'
import type { CialloApiCardProps } from '../src/client/CialloApiCard.tsx'
import { CialloStartDialog, cialloStartReadiness } from '../src/client/CialloStartDialog.tsx'
import type { CialloStartDialogProps } from '../src/client/CialloStartDialog.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { createModelsOperations, DEFAULT_MODEL_NS } from '../src/client/operations.ts'
import type { ModelDiscoveryOutcome, ModelsOperations, SettingsWriteOutcome } from '../src/client/operations.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]
const PROTOCOLS = ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']
const EFFORTS = { low: 'low', medium: 'medium', high: 'high' }
const CLAUDE_MODELS: LlmDiscoveredModel[] = [
  { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'high' },
  { id: 'claude-opus-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'medium' },
  { id: 'claude-opus-5-5', contextWindow: 1_000_000 },
]

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    displayName: Schema.string(),
    api: Schema.union(PROTOCOLS),
    baseURL: Schema.string(),
  })),
})

function piAi(providers: Record<string, JsonValue>, revision = 5): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers },
    user: { providers },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision,
  }
}

function written(view: SettingsNamespaceView = piAi({})): SettingsWriteOutcome {
  return { kind: 'written', view }
}

/** Host operations as plain stubs. */
function stubOperations(overrides: Partial<ModelsOperations> = {}) {
  const base = {
    storeCredential: vi.fn((_ref: string, _value: string) => Promise.resolve<string | undefined>(undefined)),
    removeCredential: vi.fn((_ref: string) => Promise.resolve<string | undefined>(undefined)),
    writeSettings: vi.fn((..._args: Parameters<ModelsOperations['writeSettings']>) => Promise.resolve(written())),
    discoverModels: vi.fn((..._args: Parameters<ModelsOperations['discoverModels']>) =>
      Promise.resolve<ModelDiscoveryOutcome>({ kind: 'found', models: CLAUDE_MODELS })),
    defaultModelAvailable: vi.fn(() => Promise.resolve(false)),
    saveDefaultModel: vi.fn((..._args: Parameters<ModelsOperations['saveDefaultModel']>) =>
      Promise.resolve<string | undefined>(undefined)),
  }
  return Object.assign(base, overrides)
}

function groupRow(route: string, credential?: CredentialInfo, patch: Partial<ProviderRow['entry']> = {}): ProviderRow {
  return {
    entry: {
      provider: route, displayName: route, settingsNs: 'llm-pi-ai', settingsPath: ['providers', route], active: true, ...patch,
    },
    configured: true,
    removable: true,
    apiKeyEnv: `${route.toUpperCase().replace('-', '_')}_API_KEY`,
    credential,
  }
}

describe('CialloAPI recognition', () => {
  it('derives protocol base URLs and recovers the gateway address', () => {
    expect(cialloApiProtocols(['openai-completions', 'anthropic-messages', 'other'])).toEqual(['openai-completions', 'anthropic-messages'])
    expect(cialloApiBaseURL('https://gw.example/team/v1/responses', 'anthropic-messages')).toBe('https://gw.example/team')
    expect(cialloApiBaseURL('https://gw.example', 'google-generative-ai')).toBe('https://gw.example/v1beta')
    expect(cialloApiBaseURL('ftp://gw.example', 'openai-responses')).toBeUndefined()
    expect(cialloApiBaseURL('https://gw.example', 'unknown')).toBeUndefined()
    expect(cialloApiOrigin('https://gw.example/team/v1beta')).toBe('https://gw.example/team')
    expect(cialloApiOrigin('https://cialloapi.com')).toBe('https://cialloapi.com')
    expect(cialloApiOrigin('not a url')).toBeUndefined()
  })

  it('numbers group routes from cialloapi and orders them numerically', () => {
    expect(['cialloapi', 'cialloapi-2', 'cialloapi-10'].every(isCialloRoute)).toBe(true)
    expect(['cialloapi-1', 'cialloapi-02', 'cialloapi2', 'openai'].some(isCialloRoute)).toBe(false)
    expect(nextCialloRoute(['openai'])).toBe('cialloapi')
    expect(nextCialloRoute(['cialloapi', 'cialloapi-3'])).toBe('cialloapi-2')
    expect(nextCialloRoute(['cialloapi', 'cialloapi-2'])).toBe('cialloapi-3')
    expect(['cialloapi-10', 'cialloapi', 'cialloapi-9'].sort(compareCialloRoutes)).toEqual(['cialloapi', 'cialloapi-9', 'cialloapi-10'])
  })

  it('recognizes a group from most of its model ids', () => {
    expect(classifyCialloModels(['claude-opus-5-5', 'Claude-haiku', 'gpt-5'])).toBe('claude')
    expect(classifyCialloModels(['gemini-3-pro', 'gemini-3-flash'])).toBe('gemini')
    expect(classifyCialloModels(['gpt-6.2', 'o4-mini', 'codex-mini', 'chatgpt-5'])).toBe('openai')
    expect(classifyCialloModels(['gpt-6.2', 'grok-4'])).toBe('mixed')
    expect(classifyCialloModels([])).toBe('mixed')
    expect(storedCialloKind('anthropic-messages', [])).toBe('claude')
    expect(storedCialloKind('google-generative-ai', [])).toBe('gemini')
    expect(storedCialloKind('openai-responses', ['gpt-5'])).toBe('openai')
    expect(storedCialloKind(undefined, ['claude-opus-5-5'])).toBe('mixed')
    expect(cialloKindProtocol('claude', PROTOCOLS)).toBe('anthropic-messages')
    expect(cialloKindProtocol('mixed', PROTOCOLS)).toBe('openai-responses')
    expect(cialloPreferredModel('claude', ['claude-sonnet-5-5', 'claude-opus-5-5'])).toBe('claude-opus-5-5')
    expect(cialloPreferredModel('claude', ['claude-sonnet-5-5'])).toBe('claude-sonnet-5-5')
    expect(cialloPreferredModel('openai', [])).toBe('')
  })

  it('names groups inside the route display name', () => {
    expect(cialloDisplayName('Claude')).toBe('CialloAPI · Claude')
    expect(cialloGroupName('CialloAPI · Team A ')).toBe('Team A')
    expect(cialloGroupName('CialloAPI · ')).toBeUndefined()
    expect(cialloGroupName('CialloAPI')).toBeUndefined()
    expect(cialloGroupName(undefined)).toBeUndefined()
  })

  it('reads a stored profile and its effective session affinity', () => {
    expect(readCialloProfile(null)).toEqual({ models: [], cache: '5m' })
    const profile = readCialloProfile({
      displayName: 'CialloAPI', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      models: [{ id: 'claude-opus-5-5' }], cacheRetention: 'long', sessionAffinity: false, extra: 1,
    })
    expect(profile).toEqual({
      displayName: 'CialloAPI', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      models: [{ id: 'claude-opus-5-5' }], cache: '1h', sessionAffinity: false,
    })
    expect(cialloSessionAffinity(profile)).toBe(false)
    expect(cialloSessionAffinity({ api: 'anthropic-messages' })).toBe(true)
    expect(cialloSessionAffinity({ api: 'openai-responses' })).toBe(false)
    expect(modelId({ id: 7 })).toBe('')
    expect(profileAt({ providers: { a: { api: 'x' } } }, 'a')).toEqual({ api: 'x' })
    expect(profileAt(undefined, 'a')).toBeUndefined()
    expect(profileAt({ providers: null }, 'a')).toBeUndefined()
  })

  it('merges a listing without overwriting configured fields', () => {
    const rows = [
      { model: { id: 'a', contextWindow: 5 }, checked: true },
      { model: { id: 'b', contextWindow: 9, name: 'B' }, checked: false },
      { model: { id: 'z' }, checked: true },
    ]
    const merged = mergeCialloModels(rows, [
      { id: 'a', contextWindow: 1, reasoningEfforts: EFFORTS },
      { id: 'b', contextWindow: 2 },
      { id: 'c', name: 'C' },
    ], false)
    expect(merged).toEqual([
      { model: { id: 'a', contextWindow: 5, reasoningEfforts: EFFORTS }, checked: true },
      rows[1],
      rows[2],
      { model: { id: 'c', name: 'C' }, checked: false },
    ])
  })

  it('builds Claude and other group profiles over the stored fields', () => {
    const draft = {
      route: 'cialloapi', groupName: 'Claude', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      apiKeyEnv: 'CIALLOAPI_API_KEY', models: [{ id: 'claude-opus-5-5' }], cache: '1h' as const, sessionAffinity: true,
    }
    expect(cialloProfile(draft, { headers: { a: 'b' }, cacheRetention: 'long' })).toEqual({
      headers: { a: 'b' }, displayName: 'CialloAPI · Claude', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages',
      baseURL: 'https://cialloapi.com', models: [{ id: 'claude-opus-5-5' }], sessionAffinity: true, cacheRetention: 'long',
    })
    expect(cialloProfile({ ...draft, cache: '5m', sessionAffinity: false }, { cacheRetention: 'long' }))
      .not.toHaveProperty('cacheRetention')
    expect(cialloProfile({ ...draft, api: 'openai-responses', apiKeyEnv: undefined }, ['not', 'a', 'profile'])).toEqual({
      displayName: 'CialloAPI · Claude', api: 'openai-responses', baseURL: 'https://cialloapi.com', models: [{ id: 'claude-opus-5-5' }],
    })
  })
})

describe('createCialloGroup', () => {
  const request: CialloCreateRequest = {
    route: 'cialloapi', profile: { api: 'anthropic-messages' }, keyRef: 'CIALLOAPI_API_KEY', key: 'sk-1', revision: 4,
    defaultModel: { provider: 'cialloapi', model: 'claude-opus-5-5', reasoningEffort: 'medium' },
  }

  it('stores the profile and key, then adopts the default only when the old one was unavailable', async () => {
    const operations = stubOperations()
    expect(await createCialloGroup(operations, request)).toEqual({ kind: 'created' })
    expect(operations.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'cialloapi'], value: { api: 'anthropic-messages' } }], 4)
    expect(operations.storeCredential).toHaveBeenCalledWith('CIALLOAPI_API_KEY', 'sk-1')
    expect(operations.saveDefaultModel).toHaveBeenCalledWith(request.defaultModel)
    // The availability check precedes the write that reloads the pi-ai routes.
    expect(operations.defaultModelAvailable.mock.invocationCallOrder[0]).toBeLessThan(operations.writeSettings.mock.invocationCallOrder[0]!)

    const available = stubOperations({ defaultModelAvailable: vi.fn(() => Promise.resolve(true)) })
    expect(await createCialloGroup(available, request)).toEqual({ kind: 'created' })
    expect(available.saveDefaultModel).not.toHaveBeenCalled()

    const firstRun = stubOperations({ defaultModelAvailable: vi.fn(() => Promise.resolve(true)) })
    expect(await createCialloGroup(firstRun, { ...request, replaceDefault: true })).toEqual({ kind: 'created' })
    expect(firstRun.defaultModelAvailable).not.toHaveBeenCalled()
    expect(firstRun.saveDefaultModel).toHaveBeenCalledOnce()

    const { defaultModel: _omitted, ...withoutDefault } = request
    const none = stubOperations()
    expect(await createCialloGroup(none, withoutDefault)).toEqual({ kind: 'created' })
    expect(none.defaultModelAvailable).not.toHaveBeenCalled()
  })

  it('reports conflicts, refusals, and a key-only retry', async () => {
    expect(await createCialloGroup(stubOperations({ writeSettings: vi.fn(() => Promise.resolve<SettingsWriteOutcome>({ kind: 'conflict', message: 'moved' })) }), request))
      .toEqual({ kind: 'conflict' })
    expect(await createCialloGroup(stubOperations({ writeSettings: vi.fn(() => Promise.resolve<SettingsWriteOutcome>({ kind: 'refused', message: 'no' })) }), request))
      .toEqual({ kind: 'failed', message: 'no' })
    const keyless = stubOperations({ storeCredential: vi.fn(() => Promise.resolve<string | undefined>('locked')) })
    expect(await createCialloGroup(keyless, request)).toEqual({ kind: 'failed', message: 'locked', resume: { adoptDefault: true } })
    const retry = stubOperations({ saveDefaultModel: vi.fn(() => Promise.resolve<string | undefined>('read-only')) })
    expect(await createCialloGroup(retry, { ...request, resume: { adoptDefault: true } }))
      .toEqual({ kind: 'created', defaultFailure: 'read-only' })
    expect(retry.writeSettings).not.toHaveBeenCalled()
    expect(retry.defaultModelAvailable).not.toHaveBeenCalled()
  })
})

describe('default-model operations', () => {
  function bound(catalog: unknown, mutate: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve({ ok: true, value: piAi({}) }))) {
    const ctx = Object.assign(new Context(), { remote: {
      session: { modelCatalog: vi.fn(() => Promise.resolve(catalog)) },
      settings: { mutate },
    } })
    return { operations: createModelsOperations(ctx), mutate }
  }
  const catalog = (provider: string, model: string) => ({ ok: true, value: {
    default: { provider, model }, routableProviders: ['cialloapi'], failures: [],
    groups: [{ id: 'cialloapi', name: 'CialloAPI', models: [{ id: 'claude-opus-5-5', name: 'Opus' }] }],
  } })

  it('reads availability from the catalog and treats an unreadable catalog as available', async () => {
    expect(await bound(catalog('cialloapi', 'claude-opus-5-5')).operations.defaultModelAvailable()).toBe(true)
    expect(await bound(catalog('cialloapi', 'gone')).operations.defaultModelAvailable()).toBe(false)
    expect(await bound(catalog('deepseek-official', 'deepseek-flash')).operations.defaultModelAvailable()).toBe(false)
    expect(await bound({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) }).operations.defaultModelAvailable()).toBe(true)
  })

  it('writes the default-model section', async () => {
    const { operations, mutate } = bound(catalog('a', 'b'))
    expect(await operations.saveDefaultModel({ provider: 'cialloapi', model: 'm', reasoningEffort: 'high' })).toBeUndefined()
    expect(mutate).toHaveBeenLastCalledWith(DEFAULT_MODEL_NS, [
      { op: 'set', path: ['provider'], value: 'cialloapi' },
      { op: 'set', path: ['model'], value: 'm' },
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
    ], undefined)
    await operations.saveDefaultModel({ provider: 'cialloapi', model: 'm' })
    expect(mutate.mock.calls.at(-1)?.[1]).toContainEqual({ op: 'unset', path: ['reasoningEffort'] })
    const refused = bound(catalog('a', 'b'), vi.fn(() => Promise.resolve({
      ok: false, error: new RemoteError('settings/rejected', 'no entry', { ns: DEFAULT_MODEL_NS }),
    })))
    expect(await refused.operations.saveDefaultModel({ provider: 'x', model: 'y' })).toBe('no entry')
  })
})

function renderEditor(props: Partial<CialloGroupEditorProps> = {}, operations = stubOperations()) {
  const onClose = vi.fn()
  render(<CialloGroupEditor
    route="cialloapi-2" origin={CIALLO_API.origin} protocols={PROTOCOLS} revision={5}
    operations={operations} t={t} readOnly={false} onClose={onClose} {...props}
  />)
  return { operations, onClose }
}

function pasteKey(value: string): void {
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value } })
}

describe('CialloGroupEditor', () => {
  it('fetches a pasted key, recognizes a Claude group, and creates it with every listed model', async () => {
    const { operations, onClose } = renderEditor()
    expect(screen.getByText(en.cialloKeyHint)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloSave }).disabled).toBe(true)
    pasteKey(' sk-claude ')
    expect(await screen.findByText(en.cialloDetecting)).toBeTruthy()
    await screen.findByText(en.cialloDetectedKind.replace('{kind}', 'Claude'))
    expect(operations.discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      provider: 'cialloapi-2', baseURL: 'https://cialloapi.com/v1', api: 'openai-responses', apiKey: 'sk-claude',
    })
    expect(screen.getByText(en.cialloModels.replace('{count}', '2').replace('{checked}', '2'))).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.cialloGroupName).placeholder).toBe('Claude')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.customApi }).value).toBe('anthropic-messages')
    fireEvent.click(screen.getByRole('tab', { name: en.cialloCache1h }))
    expect(screen.getByRole('switch', { name: en.cialloSessionAffinity }).getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} claude-opus-5-5`), { target: { value: '200K' } })
    fireEvent.change(screen.getByLabelText(`${en.modelReasoningDefault} claude-opus-5-5`), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(operations.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'cialloapi-2'], value: {
      displayName: 'CialloAPI · Claude', apiKeyEnv: 'CIALLOAPI_2_API_KEY', api: 'anthropic-messages',
      baseURL: 'https://cialloapi.com',
      models: [
        { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'high' },
        { id: 'claude-opus-5-5', contextWindow: 200_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'high' },
      ],
      sessionAffinity: true, cacheRetention: 'long',
    } }], 5)
    expect(operations.storeCredential).toHaveBeenCalledWith('CIALLOAPI_2_API_KEY', 'sk-claude')
    expect(operations.saveDefaultModel).toHaveBeenCalledWith({ provider: 'cialloapi-2', model: 'claude-opus-5-5', reasoningEffort: 'high' })
  })

  it('names unusable keys, refusals, empty listings, and drops superseded answers', async () => {
    const first = Promise.withResolvers<ModelDiscoveryOutcome>()
    const discoverModels = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'refused', message: 'key rejected' })
      .mockResolvedValueOnce({ kind: 'found', models: [] })
      .mockResolvedValue({ kind: 'found', models: [{ id: 'gpt-6.2' }] })
    const { operations } = renderEditor({}, stubOperations({ discoverModels }))
    pasteKey('KEY=value')
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    pasteKey('sk-slow')
    await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
    pasteKey('sk-bad')
    await act(async () => { first.resolve({ kind: 'found', models: CLAUDE_MODELS }) })
    expect(await screen.findByText('key rejected')).toBeTruthy()
    expect(screen.queryByText('claude-opus-5-5')).toBeNull()
    pasteKey('sk-empty')
    expect(await screen.findByText(en.fetchEmpty)).toBeTruthy()
    pasteKey('')
    expect(screen.getByText(en.cialloKeyHint)).toBeTruthy()
    pasteKey('sk-openai')
    await screen.findByText(en.cialloDetectedKind.replace('{kind}', 'OpenAI'))
    expect(screen.queryByRole('switch')).toBeNull()
    // The fetch action asks again on demand.
    fireEvent.click(screen.getByRole('button', { name: en.cialloRefetch }))
    await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(5) })
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(operations.saveDefaultModel).toHaveBeenCalledWith({ provider: 'cialloapi-2', model: 'gpt-6.2' }) })
  })

  it('reports create failures and retries only the key, then closes after a refused default', async () => {
    const storeCredential = vi.fn()
      .mockResolvedValueOnce('credential store locked')
      .mockResolvedValue(undefined)
    const writeSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict', message: 'moved' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'denied' })
      .mockResolvedValue(written())
    const { operations, onClose } = renderEditor({}, stubOperations({
      storeCredential, writeSettings, saveDefaultModel: vi.fn(() => Promise.resolve<string | undefined>('read-only')),
    }))
    pasteKey('sk-claude')
    await screen.findByText(en.cialloDetectedKind.replace('{kind}', 'Claude'))
    fireEvent.change(screen.getByLabelText(en.cialloGroupName), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText(en.conflict)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText('denied')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText('credential store locked')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText(en.cialloDefaultModelFailed.replace('{message}', 'read-only'))).toBeTruthy()
    expect(writeSettings).toHaveBeenCalledTimes(3)
    expect(writeSettings.mock.calls[2]?.[1]).toMatchObject([{ value: { displayName: 'CialloAPI · Team' } }])
    expect(operations.storeCredential).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('cancels a create without reporting a change', () => {
    const { onClose } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
  })

  const storedClaude = {
    profile: readCialloProfile({
      displayName: 'CialloAPI', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      cacheRetention: 'long',
      models: [
        { id: 'claude-opus-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'max' },
        { id: 'claude-haiku-5-5' },
      ],
    }),
    user: {
      displayName: 'CialloAPI', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      cacheRetention: 'long',
      models: [
        { id: 'claude-opus-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'max' },
        { id: 'claude-haiku-5-5' },
      ],
    },
    credential: { configured: true, writable: true, source: 'file', masked: 'sk-…9f2a' },
  }

  it('edits a stored Claude group as path operations and stores a replacement key', async () => {
    const view = piAi({ cialloapi: { displayName: 'CialloAPI · Claude' } }, 6)
    const writeSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'refused', message: 'schema says no' })
      .mockResolvedValue(written(view))
    const storeCredential = vi.fn().mockResolvedValueOnce('locked').mockResolvedValue(undefined)
    const { onClose } = renderEditor({ route: 'cialloapi', stored: storedClaude }, stubOperations({ writeSettings, storeCredential }))
    expect(screen.getByText(en.cialloDetectedKind.replace('{kind}', 'Claude'))).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe('sk-…9f2a')
    expect(screen.getByRole('tab', { name: en.cialloCache1h }).getAttribute('aria-selected')).toBe('true')
    // A stored default outside the declared levels stays selectable; a model without levels has no choice.
    expect(screen.getByLabelText<HTMLSelectElement>(`${en.modelReasoningDefault} claude-opus-5-5`).value).toBe('max')
    expect(screen.getByLabelText<HTMLSelectElement>(`${en.modelReasoningDefault} claude-haiku-5-5`).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(`${en.modelReasoningDefault} claude-opus-5-5`), { target: { value: '' } })
    fireEvent.click(screen.getByRole('tab', { name: en.cialloCache5m }))
    fireEvent.click(screen.getByRole('switch', { name: en.cialloSessionAffinity }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'claude-haiku-5-5' }))
    pasteKey('sk-new')
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText('schema says no')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText('locked')).toBeTruthy()
    expect(writeSettings.mock.calls[1]).toEqual(['llm-pi-ai', [
      { op: 'set', path: ['providers', 'cialloapi', 'displayName'], value: 'CialloAPI · Claude' },
      { op: 'set', path: ['providers', 'cialloapi', 'models'], value: [{ id: 'claude-opus-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS }] },
      { op: 'set', path: ['providers', 'cialloapi', 'sessionAffinity'], value: false },
      { op: 'unset', path: ['providers', 'cialloapi', 'cacheRetention'] },
    ], 5])
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    // The retry diffs against the stored answer, so only the key travels again.
    expect(writeSettings).toHaveBeenCalledTimes(3)
    expect(writeSettings.mock.calls[2]?.[2]).toBe(6)
    expect(storeCredential).toHaveBeenLastCalledWith('CIALLOAPI_API_KEY', 'sk-new')
  })

  it('refetches into unchecked rows, switches protocol, and refuses an empty or unreadable list', async () => {
    const discoverModels = vi.fn()
      .mockResolvedValueOnce({ kind: 'refused', message: 'gateway down' })
      .mockResolvedValue({ kind: 'found', models: [{ id: 'claude-new' }] })
    const writeSettings = vi.fn(() => Promise.resolve<SettingsWriteOutcome>({ kind: 'conflict', message: 'moved' }))
    renderEditor({ route: 'cialloapi', stored: { ...storedClaude, credential: { configured: false, writable: true } } },
      stubOperations({ discoverModels, writeSettings }))
    fireEvent.click(screen.getByRole('button', { name: en.cialloRefetch }))
    expect(await screen.findByText('gateway down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cialloRefetch }))
    expect(await screen.findByRole('checkbox', { name: 'claude-new' })).toHaveProperty('checked', false)
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'cialloapi', baseURL: 'https://cialloapi.com', api: 'anthropic-messages' })
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} claude-opus-5-5`), { target: { value: 'lots' } })
    expect(screen.getByText(en.modelContextInvalid)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} claude-opus-5-5`), { target: { value: '' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'claude-opus-5-5' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'claude-haiku-5-5' }))
    expect(screen.getByText(en.cialloNoModels)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloSave }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'claude-new' }))
    fireEvent.change(screen.getByRole('combobox', { name: en.customApi }), { target: { value: 'openai-responses' } })
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect(await screen.findByText(en.conflict)).toBeTruthy()
  })

  it('closes an unchanged edit without writing', async () => {
    const user = { displayName: 'CialloAPI · Codex', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'openai-responses', baseURL: 'https://cialloapi.com/v1', models: [{ id: 'gpt-6.2' }] }
    const { operations, onClose } = renderEditor({ route: 'cialloapi', stored: { profile: readCialloProfile(user), user } })
    expect(screen.getByLabelText<HTMLInputElement>(en.cialloGroupName).value).toBe('Codex')
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(operations.writeSettings).not.toHaveBeenCalled()
  })

  it('refuses a stored protocol the gateway has no address for', () => {
    renderEditor({ route: 'cialloapi', stored: { profile: readCialloProfile({ api: 'mystery', models: [{ id: 'm' }] }), user: {} } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloSave }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloRefetch }).disabled).toBe(true)
  })

  it('names the derived key reference for a stored group without one', async () => {
    const view = piAi({}, 6)
    const operations = stubOperations({ writeSettings: vi.fn(() => Promise.resolve(written(view))) })
    const { onClose } = renderEditor({
      route: 'cialloapi',
      stored: { profile: readCialloProfile({ api: 'openai-responses', models: [{ id: 'gpt-6.2' }] }), user: undefined },
    }, operations)
    expect(screen.getByLabelText<HTMLInputElement>(en.cialloGroupName).placeholder).toBe('OpenAI')
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(operations.writeSettings.mock.calls[0]?.[1]).not.toContainEqual(expect.objectContaining({ path: ['providers', 'cialloapi', 'apiKeyEnv'] }))
    expect(operations.storeCredential).not.toHaveBeenCalled()
    cleanup()
    const second = stubOperations({ writeSettings: vi.fn(() => Promise.resolve(written(view))) })
    renderEditor({ route: 'cialloapi', stored: { profile: readCialloProfile({ models: [{ id: 'gpt-6.2' }] }), user: {} } }, second)
    pasteKey('sk-key')
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(second.storeCredential).toHaveBeenCalledWith('CIALLOAPI_API_KEY', 'sk-key') })
    expect(second.writeSettings.mock.calls[0]?.[1]).toContainEqual({ op: 'set', path: ['providers', 'cialloapi', 'apiKeyEnv'], value: 'CIALLOAPI_API_KEY' })
  })
})

function renderCard(props: Partial<CialloApiCardProps> = {}, operations = stubOperations()) {
  const callbacks = { onSaved: vi.fn(), onChanged: vi.fn(), onDelete: vi.fn() }
  const namespace = props.namespace ?? piAi({
    'cialloapi': {
      displayName: 'CialloAPI', api: 'anthropic-messages', baseURL: 'https://gw.example/team',
      models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], cacheRetention: 'long', sessionAffinity: false,
    },
    'cialloapi-2': { displayName: 'CialloAPI · Codex', api: 'openai-responses', baseURL: 'https://gw.example/team/v1', models: [{ id: 'gpt-6.2' }] },
    'cialloapi-3': { models: [{ id: 'grok-4' }] },
  })
  render(<CialloApiCard
    rows={[
      groupRow('cialloapi-2', { configured: false, writable: true }, { error: 'route broken' }),
      groupRow('cialloapi', { configured: true, writable: true, source: 'file', masked: 'sk-…9f2a' }),
      { ...groupRow('cialloapi-3'), removable: false },
    ]}
    namespace={namespace} protocols={PROTOCOLS} taken={['cialloapi', 'cialloapi-2', 'cialloapi-3', 'openai']}
    operations={operations} t={t} readOnly={false} refreshing={false}
    {...callbacks} {...props}
  />)
  return { operations, ...callbacks }
}

describe('CialloApiCard', () => {
  it('summarizes every group in route order', () => {
    const { onDelete } = renderCard()
    const card = screen.getByRole('region', { name: 'CialloAPI' })
    expect(within(card).getByText(en.cialloDefaultTag)).toBeTruthy()
    expect(within(card).getByText('https://gw.example/team')).toBeTruthy()
    const groups = within(card).getAllByRole('listitem')
    expect(groups.map(group => group.querySelector('span')?.textContent)).toEqual(['Claude', 'Codex', en.cialloKindMixed])
    expect(within(groups[0]!).getByText('sk-…9f2a')).toBeTruthy()
    expect(within(groups[0]!).getByText(en.protocolAnthropicMessages)).toBeTruthy()
    expect(within(groups[0]!).getByText(en.cialloModelCount.replace('{count}', '2'))).toBeTruthy()
    expect(within(groups[0]!).getByRole('img', { name: en.credentialConfigured })).toBeTruthy()
    expect(within(groups[0]!).getByText(en.cialloSummary.replace('{cache}', en.cialloCache1h).replace('{affinity}', en.cialloOff))).toBeTruthy()
    expect(within(groups[1]!).getByRole('img', { name: en.credentialMissing })).toBeTruthy()
    expect(within(groups[1]!).getByRole('alert').textContent).toBe('route broken')
    expect(within(groups[1]!).queryByText(/Cache/)).toBeNull()
    expect(within(groups[2]!).queryByRole('img')).toBeNull()
    expect(within(groups[2]!).queryByText(en.protocolGemini)).toBeNull()
    expect(within(groups[2]!).queryByRole('button', { name: en.removeProvider.replace('{provider}', 'cialloapi-3') })).toBeNull()
    fireEvent.click(within(groups[1]!).getByRole('button', { name: en.removeProvider.replace('{provider}', 'cialloapi-2') }))
    expect(onDelete.mock.calls[0]?.[0]).toMatchObject({ entry: { provider: 'cialloapi-2' } })
  })

  it('edits one group in place and adds a group under the next free route', async () => {
    const { onSaved, operations } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: en.editProvider.replace('{provider}', 'cialloapi') }))
    const editor = screen.getByRole('group', { name: en.cialloEditGroup })
    expect(within(editor).getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe('sk-…9f2a')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloAddGroup }).disabled).toBe(true)
    fireEvent.click(within(editor).getByRole('button', { name: en.cancel }))
    expect(onSaved).not.toHaveBeenCalled()
    // A group whose key state is unknown opens with an empty key field.
    fireEvent.click(screen.getByRole('button', { name: en.editProvider.replace('{provider}', 'cialloapi-3') }))
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).placeholder).toBe(en.keyPlaceholder)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    fireEvent.click(screen.getByRole('button', { name: en.editProvider.replace('{provider}', 'cialloapi') }))
    fireEvent.click(within(screen.getByRole('group', { name: en.cialloEditGroup })).getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onSaved).toHaveBeenCalledWith({ provider: 'cialloapi', displayName: 'cialloapi' }) })
    fireEvent.click(screen.getByRole('button', { name: en.cialloAddGroup }))
    pasteKey('sk-more')
    await screen.findByText(en.cialloDetectedKind.replace('{kind}', 'Claude'))
    expect(operations.discoverModels).toHaveBeenLastCalledWith('llm-pi-ai', expect.objectContaining({
      provider: 'cialloapi-4', baseURL: 'https://gw.example/team/v1',
    }))
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    await waitFor(() => { expect(onSaved).toHaveBeenLastCalledWith({ provider: 'cialloapi-4', displayName: 'cialloapi-4' }) })
  })

  it('moves every group to a changed address in one write', async () => {
    const writeSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict', message: 'moved' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'denied' })
      .mockResolvedValue(written())
    const { onChanged } = renderCard({}, stubOperations({ writeSettings }))
    fireEvent.click(screen.getByRole('button', { name: en.cialloChangeAddress }))
    const address = screen.getByLabelText<HTMLInputElement>(en.cialloAddress)
    expect(address.value).toBe('https://gw.example/team')
    fireEvent.change(address, { target: { value: 'nope' } })
    expect(screen.getByText(en.customBaseUrlInvalid)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.apply }).disabled).toBe(true)
    fireEvent.change(address, { target: { value: 'https://new.example/' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(await screen.findByText(en.conflict)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(await screen.findByText('denied')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    expect(writeSettings).toHaveBeenLastCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'cialloapi', 'baseURL'], value: 'https://new.example' },
      { op: 'set', path: ['providers', 'cialloapi-2', 'baseURL'], value: 'https://new.example/v1' },
      { op: 'set', path: ['providers', 'cialloapi-3', 'baseURL'], value: 'https://new.example/v1' },
    ], 5)
    expect(screen.queryByLabelText(en.cialloAddress)).toBeNull()
  })

  it('keeps an address chosen before the first group for the group it adds', async () => {
    const operations = stubOperations()
    render(<CialloApiCard rows={[]} namespace={piAi({})} protocols={PROTOCOLS} taken={[]} operations={operations} t={t}
      readOnly={false} refreshing={false} onSaved={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(en.cialloEmpty)).toBeTruthy()
    expect(screen.getByText(CIALLO_API.origin)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cialloChangeAddress }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    fireEvent.click(screen.getByRole('button', { name: en.cialloChangeAddress }))
    fireEvent.change(screen.getByLabelText(en.cialloAddress), { target: { value: ' https://self.example ' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(screen.getByText('https://self.example')).toBeTruthy()
    expect(operations.writeSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.cialloAddGroup }))
    expect(screen.queryByText(en.cialloEmpty)).toBeNull()
    pasteKey('sk-first')
    await waitFor(() => {
      expect(operations.discoverModels).toHaveBeenCalledWith('llm-pi-ai', expect.objectContaining({ provider: 'cialloapi', baseURL: 'https://self.example/v1' }))
    })
  })

  it('holds its actions while read-only or refreshing', () => {
    renderCard({ readOnly: true })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloAddGroup }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cialloChangeAddress }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.editProvider.replace('{provider}', 'cialloapi') }).disabled).toBe(false)
  })
})

/** Models join state for the first-run step. */
function joinState(patch: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true,
    rows: [{
      entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      configured: true, removable: false, apiKeyEnv: 'DEEPSEEK_API_KEY', credential: { configured: false, writable: true },
    }],
    namespaces: new Map([['llm-pi-ai', piAi({})]]),
    ...patch,
  }
}

describe('cialloStartReadiness', () => {
  it('offers a key field only where a group can be created for a user without a provider', () => {
    expect(cialloStartReadiness(joinState({ status: 'loading', rows: [] }), settingsSchema, false)).toEqual({ kind: 'loading' })
    expect(cialloStartReadiness(joinState({ status: 'error' }), settingsSchema, false)).toEqual({ kind: 'skip' })
    expect(cialloStartReadiness(joinState({ writable: false }), settingsSchema, false)).toEqual({ kind: 'skip' })
    expect(cialloStartReadiness(joinState({ namespaces: new Map() }), settingsSchema, false)).toEqual({ kind: 'skip' })
    const unusable = piAi({})
    expect(cialloStartReadiness(joinState({ namespaces: new Map([['llm-pi-ai', { ...unusable, schema: {} }]]) }), settingsSchema, false))
      .toEqual({ kind: 'skip' })
    const usable = joinState()
    usable.rows = [{ ...usable.rows[0]!, credential: { configured: true, writable: true } }]
    expect(cialloStartReadiness(usable, settingsSchema, false)).toEqual({ kind: 'skip' })
    expect(cialloStartReadiness(usable, settingsSchema, true)).toMatchObject({ kind: 'offer', revision: 5, taken: ['deepseek-official'] })
    expect(cialloStartReadiness(joinState(), settingsSchema, false)).toMatchObject({ kind: 'offer', protocols: PROTOCOLS })
  })
})

function renderStart(options: {
  state?: ModelsSettingsState
  automatic?: boolean
  explicit?: boolean
  operations?: ReturnType<typeof stubOperations>
} = {}) {
  const ctx = Object.assign(new Context(), { remote: {} })
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  const load = vi.spyOn(controller, 'load').mockResolvedValue()
  const state = options.state ?? joinState()
  controller.store.update((draft) => { Object.assign(draft, state) })
  const complete = vi.fn()
  const operations = options.operations ?? stubOperations()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: CialloStartDialogProps = {
    stepId: 'ciallo-start',
    explicit: options.explicit ?? false,
    complete,
    openSection: vi.fn(),
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    usePanelInfo: unusedHook,
    useSessionRetainInfo: () => undefined,
    useResource: unusedHook satisfies GlobalStandardProps['useResource'],
    useWorkspaces: unusedHook,
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    controller,
    useModels: bindSnapshotSelector(controller.store),
    useAutomatic: bindSnapshotSelector(createSnapshotStore(options.automatic ?? true)),
    operations,
    schema: settingsSchema,
    t,
  }
  render(<CialloStartDialog {...props} />)
  return { complete, load, operations, controller }
}

describe('CialloStartDialog', () => {
  it('creates the first group from one pasted key and makes its model the default', async () => {
    const { complete, load, operations } = renderStart()
    const dialog = screen.getByRole('dialog', { name: en.startTitle })
    expect(within(dialog).getByText(en.startHint)).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.startSubmit }).disabled).toBe(true)
    pasteKey('sk-claude')
    await screen.findByText(en.cialloDetecting)
    await screen.findByText(en.cialloDetected.replace('{kind}', 'Claude').replace('{count}', '2').replace('{model}', 'claude-opus-5-5'))
    expect(operations.discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      provider: 'cialloapi', baseURL: 'https://cialloapi.com/v1', api: 'openai-responses', apiKey: 'sk-claude',
    })
    fireEvent.click(screen.getByRole('button', { name: en.startSubmit }))
    await waitFor(() => { expect(complete).toHaveBeenCalledOnce() })
    expect(load).toHaveBeenCalled()
    expect(operations.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'cialloapi'], value: {
      displayName: 'CialloAPI · Claude', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com',
      models: [
        { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'high' },
        { id: 'claude-opus-5-5', contextWindow: 1_000_000, reasoningEfforts: EFFORTS, defaultReasoningEffort: 'medium' },
      ],
      sessionAffinity: true,
    } }], 5)
    expect(operations.saveDefaultModel).toHaveBeenCalledWith({ provider: 'cialloapi', model: 'claude-opus-5-5', reasoningEffort: 'medium' })
  })

  it('shows key, discovery, and create failures and lets the user leave', async () => {
    const discoverModels = vi.fn()
      .mockResolvedValueOnce({ kind: 'refused', message: 'unknown key' })
      .mockResolvedValueOnce({ kind: 'found', models: [] })
      .mockResolvedValue({ kind: 'found', models: [{ id: 'gpt-6.2' }] })
    const writeSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict', message: 'moved' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'denied' })
      .mockResolvedValue(written())
    const storeCredential = vi.fn().mockResolvedValueOnce('locked').mockResolvedValue(undefined)
    const { complete, operations } = renderStart({ operations: stubOperations({
      discoverModels, writeSettings, storeCredential, saveDefaultModel: vi.fn(() => Promise.resolve<string | undefined>('no default entry')),
    }) })
    pasteKey('"sk-quoted"')
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    pasteKey('sk-a')
    expect(await screen.findByText('unknown key')).toBeTruthy()
    pasteKey('sk-b')
    expect(await screen.findByText(en.fetchEmpty)).toBeTruthy()
    pasteKey('sk-c')
    await screen.findByText(en.cialloDetected.replace('{kind}', 'OpenAI').replace('{count}', '1').replace('{model}', 'gpt-6.2'))
    fireEvent.click(screen.getByRole('button', { name: en.startSubmit }))
    expect(await screen.findByText(en.conflict)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.startSubmit }))
    expect(await screen.findByText('denied')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.startSubmit }))
    expect(await screen.findByText('locked')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.startSubmit }))
    expect(await screen.findByText(en.cialloDefaultModelFailed.replace('{message}', 'no default entry'))).toBeTruthy()
    expect(operations.writeSettings).toHaveBeenCalledTimes(3)
    expect(complete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.startContinue }))
    expect(complete).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('closes on Configure later and pastes a blank key back to the hint', () => {
    const { complete } = renderStart()
    pasteKey('sk-x')
    pasteKey('')
    expect(screen.getByText(en.startHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.startLater }))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('completes without showing when not automatic, nothing to offer, or a provider is usable', () => {
    expect(renderStart({ automatic: false }).complete).toHaveBeenCalled()
    cleanup()
    expect(renderStart({ state: joinState({ writable: false }) }).complete).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('loads the shared join while deciding, and an explicit request offers it to a configured user', () => {
    const { load, complete } = renderStart({ state: joinState({ status: 'idle', rows: [] }), automatic: false, explicit: true })
    expect(load).toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ModelsSection CialloAPI card', () => {
  function face(credentials: Record<string, CredentialInfo>) {
    const namespace = piAi({ cialloapi: { displayName: 'CialloAPI · Claude', apiKeyEnv: 'CIALLOAPI_API_KEY', api: 'anthropic-messages', baseURL: 'https://cialloapi.com', models: [{ id: 'claude-opus-5-5' }] } })
    const directory = [{ provider: 'cialloapi', displayName: 'CialloAPI · Claude', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'cialloapi'], declared: true }]
    return {
      llm: {
        listProviders: vi.fn(() => Promise.resolve({ ok: true, value: [{ id: 'cialloapi', name: 'CialloAPI · Claude' }] })),
        listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: directory })),
        discoverModels: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      },
      settings: {
        describe: vi.fn(() => Promise.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace] } })),
        mutate: vi.fn(() => Promise.resolve({ ok: true, value: namespace })),
      },
      credentials: {
        describe: vi.fn((refs: string[]) => Promise.resolve({
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, credentials[ref] ?? { configured: false, writable: true }])),
        })),
        set: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
        unset: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
      },
      session: { modelCatalog: vi.fn(() => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) })) },
    }
  }

  async function mount(credentials: Record<string, CredentialInfo>) {
    const remote = face(credentials)
    const ctx = Object.assign(new Context(), { remote })
    const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
    await controller.load()
    render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
      operations={createModelsOperations(ctx)} schema={settingsSchema} t={t} renderSlot={() => null} />)
    return { remote, controller }
  }

  it('lists the group in the card, saves it, moves its address, and deletes it with its key', async () => {
    const { remote, controller } = await mount({ CIALLOAPI_API_KEY: { configured: true, writable: true, source: 'file' } })
    const card = screen.getByRole('region', { name: 'CialloAPI' })
    expect(within(card).getByText('Claude')).toBeTruthy()
    // The group is not repeated among the provider rows below the card.
    expect(screen.getAllByRole('button', { name: en.editProvider.replace('{provider}', 'CialloAPI · Claude') })).toHaveLength(1)
    fireEvent.click(within(card).getByRole('button', { name: en.editProvider.replace('{provider}', 'CialloAPI · Claude') }))
    fireEvent.click(screen.getByRole('switch', { name: en.cialloSessionAffinity }))
    fireEvent.click(screen.getByRole('button', { name: en.cialloSave }))
    expect((await screen.findByRole('status')).textContent).toBe(en.savedProvider.replace('{provider}', 'CialloAPI · Claude (cialloapi)'))
    fireEvent.click(screen.getByRole('button', { name: en.cialloChangeAddress }))
    fireEvent.change(screen.getByLabelText(en.cialloAddress), { target: { value: 'https://next.example' } })
    const loads = remote.llm.listProviders.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(remote.llm.listProviders.mock.calls.length).toBeGreaterThan(loads) })
    const remove = within(card).getByRole('button', { name: en.removeProvider.replace('{provider}', 'CialloAPI · Claude') })
    const ready = controller.store.getSnapshot()
    const snapshot = vi.spyOn(controller.store, 'getSnapshot').mockReturnValue({ ...ready, status: 'loading' })
    fireEvent.click(remove)
    snapshot.mockRestore()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(remove)
    const dialog = screen.getByRole('dialog', { name: en.deleteTitle.replace('{provider}', 'CialloAPI · Claude (cialloapi)') })
    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteConfirm.replace('{provider}', 'CialloAPI · Claude (cialloapi)') }))
    await waitFor(() => { expect(remote.credentials.unset).toHaveBeenCalledWith('CIALLOAPI_API_KEY') })
    expect(remote.settings.mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'cialloapi'] }], undefined)
  })
})
