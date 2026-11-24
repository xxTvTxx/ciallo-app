/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  LegacyDshImportOptions, LegacyDshImportResult, LegacyDshSummary,
  LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** Outcome of invoking one-click legacy `~/.dsh` migration. */
export type LegacyDshImportOutcome =
  | { readonly kind: 'imported'; readonly result: LegacyDshImportResult }
  | { readonly kind: 'refused'; readonly message: string }

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /**
   * Ask whether the deployment default model is currently listed by a routable provider.
   * @returns false only when the catalog answered and does not list the default; an unreadable catalog answers true.
   */
  defaultModelAvailable(): Promise<boolean>
  /**
   * Store the deployment default model in the default-model settings section.
   * @param selection - route, model, and optional reasoning effort.
   * @returns the refusal message, or undefined once stored.
   */
  saveDefaultModel(selection: DefaultModelSelection): Promise<string | undefined>
  /**
   * Inspect whether a legacy `~/.dsh` home directory exists with migratable data.
   * @returns redacted counts and flags, or undefined when inspection fails.
   */
  inspectLegacyDsh?(): Promise<LegacyDshSummary | undefined>
  /**
   * Idempotently copy sessions, skills, attachments, `AGENTS.md`, and optionally
   * stored API keys from `~/.dsh` into the active home, then refresh live sessions.
   * @param options - Migration options.
   * @returns imported counts or the Host's refusal message.
   */
  importLegacyDsh?(options?: LegacyDshImportOptions): Promise<LegacyDshImportOutcome>
}

/** The default-model settings section the Host's default-model plugin reads. */
export const DEFAULT_MODEL_NS = 'agent-default-model'

/** A default model as the default-model section stores it. */
export interface DefaultModelSelection {
  /** Registered route id. */
  readonly provider: string
  /** Route-owned model id. */
  readonly model: string
  /** Model reasoning effort; absent follows the model's own default. */
  readonly reasoningEffort?: string
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, `remote.session`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    defaultModelAvailable: async () => {
      const response = await ctx.remote.session.modelCatalog()
      if (!response.ok) return true
      const { default: selected, groups } = response.value
      return groups.some(group => group.id === selected.provider && group.models.some(model => model.id === selected.model))
    },
    saveDefaultModel: async (selection) => {
      const response = await ctx.remote.settings.mutate(DEFAULT_MODEL_NS, [
        { op: 'set', path: ['provider'], value: selection.provider },
        { op: 'set', path: ['model'], value: selection.model },
        selection.reasoningEffort === undefined
          ? { op: 'unset', path: ['reasoningEffort'] }
          : { op: 'set', path: ['reasoningEffort'], value: selection.reasoningEffort },
      ], undefined)
      return response.ok ? undefined : response.error.message
    },
    inspectLegacyDsh: async () => {
      const response = await ctx.remote.settings.inspectLegacyDsh()
      return response.ok ? response.value : undefined
    },
    importLegacyDsh: async (options) => {
      const response = await ctx.remote.settings.importLegacyDsh(options)
      if (!response.ok) return { kind: 'refused', message: response.error.message }
      await Promise.all([
        ctx.get('sessions')?.refresh().catch(() => {
          // Live session list refresh failure should not hide a committed disk import.
        }),
        (async () => {
          const describeFace = ctx.get('configForms')?.describe()
          if (describeFace === undefined) return
          const described = await ctx.remote.settings.describe()
          if (!described.ok) return
          for (const view of described.value.namespaces) describeFace.acceptView(view)
        })().catch(() => {
          // Live settings mirror refresh failure should not hide a committed disk import.
        }),
      ])
      return { kind: 'imported', result: response.value }
    },
  }
}
