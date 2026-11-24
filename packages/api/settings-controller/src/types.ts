/**
 * Browser-safe failure and migration vocabulary of the configuration surfaces
 * this package serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Redacted summary of an existing legacy DeepSeek Harness home (`~/.dsh`). */
export interface LegacyDshSummary {
  /** Whether a distinct, readable legacy `~/.dsh` home directory was found. */
  readonly available: boolean
  /** Symbolic display path of the legacy source home. */
  readonly sourceDisplay: string
  /** Symbolic display path of the active target home. */
  readonly targetDisplay: string
  /** Total valid sessions detected inside the legacy home. */
  readonly sessionCount: number
  /** Legacy sessions not yet present in the active target home. */
  readonly newSessionCount: number
  /** Whether legacy attachments exist on disk. */
  readonly hasAttachments: boolean
  /** Whether legacy skills exist on disk. */
  readonly hasSkills: boolean
  /** Whether a legacy `AGENTS.md` instruction file exists on disk. */
  readonly hasAgentsMd: boolean
  /** Number of stored credential references detected (values never leave Host). */
  readonly credentialCount: number
  /** Total model provider configs detected across legacy profiles. */
  readonly providerCount: number
  /** Legacy model provider configs not yet configured in the active target home. */
  readonly newProviderCount: number
}

/** Caller options for importing legacy DeepSeek Harness home data. */
export interface LegacyDshImportOptions {
  /** Whether to copy stored API key references into the active credential store (default true). */
  readonly includeCredentials?: boolean | undefined
}

/** Outcome of one idempotent import from `~/.dsh` into the active home. */
export interface LegacyDshImportResult {
  /** Number of session directories newly copied. */
  readonly importedSessions: number
  /** Number of session directories already present in target and skipped cleanly. */
  readonly skippedSessions: number
  /** Number of workspaces registered or updated for imported sessions. */
  readonly attachedWorkspaces: number
  /** Number of attachment files newly copied. */
  readonly importedAttachments: number
  /** Number of skill files newly copied. */
  readonly importedSkills: number
  /** Whether `AGENTS.md` was newly copied. */
  readonly importedAgentsMd: boolean
  /** Number of credential references written into the target credential store. */
  readonly importedCredentials: number
  /** Number of model provider configs newly imported into active settings. */
  readonly importedProviders: number
}
