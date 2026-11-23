/**
 * The CialloAPI default card at the top of the Models page. It lists every
 * CialloAPI group — each an llm-pi-ai route bound to one gateway API key —
 * with a one-line summary, edits one group in place, adds a group from a pasted
 * key, and changes the gateway address for every group at once.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CIALLO_API, cialloApiBaseURL, cialloApiOrigin } from './ciallo-api.ts'
import {
  CIALLO_KIND_KEYS, CLAUDE_PROTOCOL, cialloGroupName, cialloSessionAffinity, compareCialloRoutes, modelId,
  nextCialloRoute, readCialloProfile, storedCialloKind,
} from './ciallo-groups.ts'
import { CIALLO_NS } from './ciallo-save.ts'
import { CialloGroupEditor, profileAt } from './CialloGroupEditor.tsx'
import { protocolLabel } from './protocol-label.ts'
import type { ProviderRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import css from './CialloApiCard.module.css'

/** Props of {@link CialloApiCard}. */
export interface CialloApiCardProps {
  /** Configured CialloAPI group rows from the page join. */
  rows: readonly ProviderRow[]
  /** The llm-pi-ai namespace holding every group profile. */
  namespace: SettingsNamespaceView
  /** Gateway protocols the adapter accepts, in preference order. */
  protocols: readonly string[]
  /** Every route id on the page, so a new group takes a free one. */
  taken: readonly string[]
  /** Host operations. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** The settings provider refuses writes. */
  readOnly: boolean
  /** The page snapshot is refreshing; actions that open a draft wait for it. */
  refreshing: boolean
  /** A group editor stored its group. */
  onSaved: (target: { provider: string; displayName: string }) => void
  /** The address change stored new base URLs. */
  onChanged: () => void
  /** The user asked to delete a group; the page confirms it. */
  onDelete: (row: ProviderRow) => void
}

/** The open editor: a stored group, or a new group under its reserved route id. */
type OpenEditor = { kind: 'edit'; route: string } | { kind: 'add'; route: string }

/**
 * Render the CialloAPI card.
 * @param props - group rows, the owning namespace, operations, and callbacks.
 * @returns the card.
 */
export function CialloApiCard(props: CialloApiCardProps): ReactNode {
  const { namespace, protocols, operations, t } = props
  const [editor, setEditor] = useState<OpenEditor | undefined>(undefined)
  const [localOrigin, setLocalOrigin] = useState<string>(CIALLO_API.origin)
  const [addressDraft, setAddressDraft] = useState<string | undefined>(undefined)
  const [addressBusy, setAddressBusy] = useState(false)
  const [addressFailure, setAddressFailure] = useState<string | undefined>(undefined)

  const groups = [...props.rows]
    .sort((left, right) => compareCialloRoutes(left.entry.provider, right.entry.provider))
    .map((row) => {
      const route = row.entry.provider
      const profile = readCialloProfile(profileAt(namespace.value, route))
      const kind = storedCialloKind(profile.api, profile.models.map(modelId))
      return { row, route, profile, name: cialloGroupName(profile.displayName) ?? t(CIALLO_KIND_KEYS[kind]) }
    })
  const storedOrigin = groups.map(group => group.profile.baseURL).find(url => url !== undefined)
  const origin = (storedOrigin === undefined ? undefined : cialloApiOrigin(storedOrigin)) ?? localOrigin
  const blocked = props.readOnly || props.refreshing

  const close = (changed: boolean, target: { provider: string; displayName: string }): void => {
    setEditor(undefined)
    if (changed) props.onSaved(target)
  }

  const addressInvalid = addressDraft !== undefined && cialloApiBaseURL(addressDraft, 'openai-responses') === undefined
  const applyAddress = async (draft: string): Promise<void> => {
    if (groups.length === 0) {
      setLocalOrigin(draft.trim())
      setAddressDraft(undefined)
      return
    }
    setAddressBusy(true)
    setAddressFailure(undefined)
    try {
      const ops = groups.flatMap((group) => {
        const baseURL = cialloApiBaseURL(draft, group.profile.api ?? 'openai-responses')
        /* v8 ignore next -- the draft was validated against a protocol with a known suffix */
        return baseURL === undefined ? [] : [{ op: 'set' as const, path: ['providers', group.route, 'baseURL'], value: baseURL }]
      })
      const written = await operations.writeSettings(CIALLO_NS, ops, namespace.revision)
      if (written.kind !== 'written') {
        setAddressFailure(written.kind === 'conflict' ? t('conflict') : written.message)
        return
      }
      setAddressDraft(undefined)
      props.onChanged()
    } finally {
      setAddressBusy(false)
    }
  }

  return (
    <section className={css.card} aria-label={CIALLO_API.displayName}>
      <div className={css.head}>
        <span className={css.identity}>
          <span className={css.name}>{CIALLO_API.displayName}</span>
          <span className={css.defaultTag}>{t('cialloDefaultTag')}</span>
        </span>
        {addressDraft === undefined
          ? (
            <span className={css.address}>
              <span className={css.addressText} title={origin}>{origin}</span>
              <button
                type="button"
                className={styles['linkButton']}
                disabled={blocked || editor !== undefined}
                onClick={() => { setAddressDraft(origin); setAddressFailure(undefined) }}
              >
                {t('cialloChangeAddress')}
              </button>
            </span>
          )
          : null}
      </div>
      {addressDraft === undefined
        ? null
        : (
          <div className={css.addressEditor}>
            <label className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('cialloAddress')}</span>
              <input
                className={styles['input']}
                type="text"
                value={addressDraft}
                aria-invalid={addressInvalid}
                disabled={addressBusy}
                onChange={(event) => { setAddressDraft(event.target.value) }}
              />
            </label>
            <p className={styles[addressInvalid ? 'error' : 'advancedHint']}>
              {t(addressInvalid ? 'customBaseUrlInvalid' : 'cialloAddressHint')}
            </p>
            {addressFailure === undefined ? null : <p className={styles['error']} role="alert">{addressFailure}</p>}
            <div className={styles['editorActions']}>
              <button type="button" className={styles['secondaryButton']} disabled={addressBusy}
                onClick={() => { setAddressDraft(undefined) }}>
                {t('cancel')}
              </button>
              <button type="button" className={styles['primaryButton']} disabled={addressBusy || addressInvalid}
                onClick={() => { void applyAddress(addressDraft) }}>
                {addressBusy ? t('applying') : t('apply')}
              </button>
            </div>
          </div>
        )}
      {groups.length === 0 && editor === undefined ? <p className={css.empty}>{t('cialloEmpty')}</p> : null}
      {groups.length === 0
        ? null
        : (
          <ul className={css.groups}>
            {groups.map(({ row, route, profile, name }) => {
              const identity = { provider: route, displayName: row.entry.displayName }
              if (editor?.kind === 'edit' && editor.route === route) {
                return (
                  <li key={route}>
                    <CialloGroupEditor
                      route={route}
                      stored={{
                        profile,
                        user: profileAt(namespace.user, route),
                        ...row.credential === undefined ? {} : { credential: row.credential },
                      }}
                      origin={origin}
                      protocols={protocols}
                      revision={namespace.revision}
                      operations={operations}
                      t={t}
                      readOnly={props.readOnly}
                      onClose={(changed) => { close(changed, identity) }}
                    />
                  </li>
                )
              }
              const configured = row.credential?.configured === true
              const missing = !configured && row.credential?.configured === false
              const claude = profile.api === CLAUDE_PROTOCOL
              return (
                <li key={route} className={css.group}>
                  <div className={css.groupHead}>
                    <span className={css.groupName}>{name}</span>
                    {profile.api === undefined ? null : <span className={css.chip}>{protocolLabel(t, profile.api)}</span>}
                    <span className={css.chip}>{t('cialloModelCount').replace('{count}', () => String(profile.models.length))}</span>
                    {configured && row.credential?.masked !== undefined
                      ? <span className={css.masked}>{row.credential.masked}</span>
                      : null}
                    {configured || missing
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles[configured ? 'credentialDotConfigured' : 'credentialDotMissing']}`}
                          role="img"
                          aria-label={t(configured ? 'credentialConfigured' : 'credentialMissing')}
                          title={t(configured ? 'credentialConfigured' : 'credentialMissing')}
                        />
                      )
                      : null}
                    <span className={`${styles['rowActions']} ${css.groupActions}`}>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        aria-label={t('editProvider').replace('{provider}', () => identity.displayName)}
                        disabled={props.refreshing || editor !== undefined}
                        onClick={() => { setEditor({ kind: 'edit', route }) }}
                      >
                        {t('edit')}
                      </button>
                      {row.removable
                        ? (
                          <button
                            type="button"
                            className={styles['dangerButton']}
                            aria-label={t('removeProvider').replace('{provider}', () => identity.displayName)}
                            disabled={blocked || editor !== undefined}
                            onClick={() => { props.onDelete(row) }}
                          >
                            {t('remove')}
                          </button>
                        )
                        : null}
                    </span>
                  </div>
                  {claude
                    ? (
                      <p className={css.summary}>
                        {t('cialloSummary')
                          .replace('{cache}', () => t(profile.cache === '1h' ? 'cialloCache1h' : 'cialloCache5m'))
                          .replace('{affinity}', () => t(cialloSessionAffinity(profile) ? 'cialloOn' : 'cialloOff'))}
                      </p>
                    )
                    : null}
                  {row.entry.error === undefined ? null : <p role="alert" className={styles['error']}>{row.entry.error}</p>}
                </li>
              )
            })}
          </ul>
        )}
      {editor?.kind === 'add'
        ? (
          <CialloGroupEditor
            route={editor.route}
            origin={origin}
            protocols={protocols}
            revision={namespace.revision}
            operations={operations}
            t={t}
            readOnly={props.readOnly}
            onClose={(changed) => {
              close(changed, { provider: editor.route, displayName: editor.route })
            }}
          />
        )
        : (
          <button
            type="button"
            className={css.addGroup}
            disabled={blocked || editor !== undefined || addressDraft !== undefined}
            onClick={() => { setEditor({ kind: 'add', route: nextCialloRoute(props.taken) }) }}
          >
            <IconPlusOutlineRegular size={14} />
            {t('cialloAddGroup')}
          </button>
        )}
    </section>
  )
}
