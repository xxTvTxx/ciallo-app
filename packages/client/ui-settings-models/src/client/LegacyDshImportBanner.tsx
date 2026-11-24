/**
 * One-click migration card offering non-destructive import from an existing
 * DeepSeek Harness home (`~/.dsh`) into the active Ciallo App home (`~/.ciallo`).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LegacyDshImportResult, LegacyDshSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsOperations } from './operations.ts'
import type { ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './LegacyDshImportBanner.module.css'

/** Props for {@link LegacyDshImportBanner}. */
export interface LegacyDshImportBannerProps {
  /** Page operations exposing optional legacy inspection/import callbacks. */
  operations: ModelsOperations
  /** Shared Models store refreshed after credential imports. */
  controller: ModelsSettingsStore
  /** Localized copy accessor. */
  t: (key: keyof typeof en) => string
  /** Optional extra spacing inside modal onboarding flows. */
  compact?: boolean
  /** Hide when no unimported sessions remain (unless an import just completed here). */
  onlyWithNewSessions?: boolean
  /** Callback invoked after an import succeeds. */
  onImported?: (result: LegacyDshImportResult) => void
}

/**
 * Render an unobtrusive one-click `~/.dsh` migration card when a legacy home
 * directory with sessions, files, or stored keys is detected on the Host.
 * @param props - Component props.
 * @returns migration banner or null when unavailable.
 */
export function LegacyDshImportBanner({
  operations,
  controller,
  t,
  compact = false,
  onlyWithNewSessions = false,
  onImported,
}: LegacyDshImportBannerProps): ReactNode {
  const [summary, setSummary] = useState<LegacyDshSummary | undefined>(undefined)
  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LegacyDshImportResult | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    if (operations.inspectLegacyDsh === undefined) return
    void operations.inspectLegacyDsh().then((value) => {
      if (!cancelled) setSummary(value)
    }).catch(() => {
      // Ignore probe failures so onboarding and settings stay responsive.
    })
    return () => { cancelled = true }
  }, [operations])

  if (summary === undefined || !summary.available || operations.importLegacyDsh === undefined) return null
  if (onlyWithNewSessions && summary.newSessionCount === 0 && summary.sessionCount > 0 && result === undefined) {
    return null
  }

  const runImport = async (): Promise<void> => {
    if (operations.importLegacyDsh === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await operations.importLegacyDsh({ includeCredentials })
      if (outcome.kind === 'refused') {
        setFailure(outcome.message)
        return
      }
      setResult(outcome.result)
      onImported?.(outcome.result)
      void controller.load()
      if (operations.inspectLegacyDsh !== undefined) {
        const refreshed = await operations.inspectLegacyDsh().catch(() => undefined)
        if (refreshed !== undefined) setSummary(refreshed)
      }
    } finally {
      setBusy(false)
    }
  }

  const extraCount = (summary.hasSkills ? 1 : 0) + (summary.hasAgentsMd ? 1 : 0) + (summary.hasAttachments ? 1 : 0)
  const summaryText = summary.sessionCount > 0
    ? t('legacyDshSummary')
      .replace('{sessions}', () => String(summary.sessionCount))
      .replace('{newSessions}', () => String(summary.newSessionCount))
      .replace('{credentials}', () => String(summary.credentialCount))
    : t('legacyDshFilesOnly').replace('{credentials}', () => String(summary.credentialCount))

  const nothingPending = (result !== undefined && summary.newSessionCount === 0)
    || (summary.newSessionCount === 0 && summary.credentialCount === 0 && extraCount === 0)

  return (
    <div className={compact ? `${styles['card']} ${styles['compact']}` : styles['card']}>
      <div className={styles['header']}>
        <div className={styles['titleGroup']}>
          <h3 className={styles['title']}>{t('legacyDshTitle')}</h3>
          <p className={styles['summary']}>{summaryText}</p>
        </div>
        <Button
          variant="outline"
          disabled={busy || nothingPending}
          onClick={() => { void runImport() }}
        >
          {t(busy ? 'legacyDshImporting' : 'legacyDshImportAction')}
        </Button>
      </div>
      {summary.credentialCount > 0
        ? (
          <Checkbox
            className={styles['checkbox']}
            checked={includeCredentials}
            disabled={busy}
            label={t('legacyDshIncludeCredentials').replace('{count}', () => String(summary.credentialCount))}
            onChange={setIncludeCredentials}
          />
        )
        : null}
      {result === undefined
        ? null
        : (
          <p className={styles['success']} role="status">
            {t('legacyDshImported')
              .replace('{sessions}', () => String(result.importedSessions))
              .replace('{skipped}', () => String(result.skippedSessions))
              .replace('{credentials}', () => String(result.importedCredentials))}
          </p>
        )}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
    </div>
  )
}
