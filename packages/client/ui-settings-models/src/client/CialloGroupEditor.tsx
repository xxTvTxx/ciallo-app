/**
 * Create or edit one CialloAPI group: its name, key, Claude cache and session
 * affinity, and a flat model list where each model is enabled, sized, and given
 * a default reasoning effort. A new group fetches its models as soon as a
 * pasted key settles, recognizes its kind from the model ids, and starts with
 * every listed model enabled. The protocol is the one setting folded under
 * Advanced.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialInfo, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiKeyFailure } from './apiKey.ts'
import { ApiKeyInput } from './ApiKeyInput.tsx'
import { cialloApiBaseURL } from './ciallo-api.ts'
import {
  CIALLO_KIND_KEYS, CLAUDE_PROTOCOL, cialloGroupName, cialloKindProtocol, cialloPreferredModel, cialloProfile,
  classifyCialloModels, mergeCialloModels, modelId, storedCialloKind,
} from './ciallo-groups.ts'
import type { CacheChoice, CialloModelRow, CialloProfile } from './ciallo-groups.ts'
import { CIALLO_NS, createCialloGroup } from './ciallo-save.ts'
import type { CialloCreateResume } from './ciallo-save.ts'
import { formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { pathOps } from './ProviderEditor.tsx'
import { protocolLabel } from './protocol-label.ts'
import { deriveKeyRef } from './store.ts'
import { useCialloDiscovery } from './useCialloDiscovery.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import css from './CialloApiCard.module.css'

/** A stored group as its editor opens it. */
export interface StoredCialloGroup {
  /** Effective profile. */
  profile: CialloProfile
  /** The user-layer profile edits are diffed against. */
  user: unknown
  /** Redacted state of the profile's credential reference. */
  credential?: CredentialInfo
}

/** Props of {@link CialloGroupEditor}. */
export interface CialloGroupEditorProps {
  /** Route id of the group. */
  route: string
  /** The stored group; absent while adding one. */
  stored?: StoredCialloGroup
  /** Gateway address the group's base URL derives from. */
  origin: string
  /** Gateway protocols the adapter accepts, in preference order. */
  protocols: readonly string[]
  /** Namespace revision the editor opened at. */
  revision: number
  /** Host operations. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the editor; `changed` reports whether anything was stored. */
  onClose: (changed: boolean) => void
}

/**
 * Read the group profile at `providers.<route>` inside a namespace layer.
 * @param layer - a namespace value, base, or user layer.
 * @param route - group route id.
 * @returns the stored profile, or undefined when the layer has none.
 */
export function profileAt(layer: unknown, route: string): unknown {
  const providers = typeof layer === 'object' && layer !== null ? (layer as { providers?: unknown }).providers : undefined
  return typeof providers === 'object' && providers !== null ? (providers as Record<string, unknown>)[route] : undefined
}

/** The reasoning levels a model declares, in stored order. */
function effortsOf(model: DeepSeekModelDraft): string[] {
  const efforts = model['reasoningEfforts']
  return typeof efforts === 'object' && efforts !== null && !Array.isArray(efforts) ? Object.keys(efforts) : []
}

/**
 * Render the group editor.
 * @param props - the group, gateway facts, Host operations, and copy.
 * @returns the editor panel.
 */
export function CialloGroupEditor(props: CialloGroupEditorProps): ReactNode {
  const { route, stored, origin, protocols, operations, t } = props
  const creating = stored === undefined
  const cacheId = useId()
  const discovery = useCialloDiscovery(operations)
  const [openedAt] = useState(props.revision)
  const [nameDraft, setNameDraft] = useState<string | undefined>(() =>
    stored === undefined ? undefined : cialloGroupName(stored.profile.displayName))
  const [protocolDraft, setProtocolDraft] = useState<string | undefined>(stored?.profile.api)
  const [keyDraft, setKeyDraft] = useState('')
  const [rows, setRows] = useState<readonly CialloModelRow[]>(() =>
    (stored?.profile.models ?? []).map(model => ({ model, checked: true })))
  const [contextText, setContextText] = useState<ReadonlyMap<string, string>>(new Map())
  const [cache, setCache] = useState<CacheChoice>(stored?.profile.cache ?? '5m')
  const [affinity, setAffinity] = useState(stored?.profile.sessionAffinity ?? true)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** A create whose profile is stored; a retry writes only what is left. */
  const [resume, setResume] = useState<CialloCreateResume | undefined>(undefined)
  /** A created group whose default-model write failed: the editor only closes now. */
  const [created, setCreated] = useState(false)
  /** The user profile and revision an edit diffs against; both advance after each stored write. */
  const [baseline, setBaseline] = useState(() => ({ user: stored?.user, revision: props.revision }))

  const ids = rows.map(row => modelId(row.model))
  const kind = creating ? classifyCialloModels(ids) : storedCialloKind(protocolDraft, ids)
  const kindName = t(CIALLO_KIND_KEYS[kind])
  const api = protocolDraft ?? cialloKindProtocol(kind, protocols)
  const baseURL = cialloApiBaseURL(origin, api)
  const claude = api === CLAUDE_PROTOCOL
  const groupName = nameDraft?.trim() || kindName
  const keyValue = keyDraft.trim()
  const keyFailure = apiKeyFailure(keyDraft)
  const checked = rows.filter(row => row.checked).map(row => row.model)
  const contextInvalid = checked.some(model => Number.isNaN(model['contextWindow']))
  const disabled = props.readOnly || busy || created
  const ready = !disabled && baseURL !== undefined && keyFailure === undefined && checked.length > 0
    && !contextInvalid && (!creating || resume !== undefined || keyValue.length > 0)

  const probe = (key: string, url: string): Parameters<typeof discovery.fetch>[0] => ({
    provider: route,
    baseURL: url,
    api,
    ...key.length === 0 ? {} : { apiKey: key },
  })

  const changeKey = (value: string): void => {
    setKeyDraft(value)
    setFailure(undefined)
    if (!creating || resume !== undefined) return
    /* v8 ignore next -- a create derives its protocol from the gateway list, which always has a base URL */
    if (baseURL === undefined) return
    const key = value.trim()
    discovery.schedule(key.length === 0 || apiKeyFailure(value) !== undefined ? undefined : probe(key, baseURL), (models) => {
      setRows(mergeCialloModels([], models, true))
      setContextText(new Map())
    })
  }

  const refetch = (): void => {
    /* v8 ignore next -- the fetch action is disabled without a base URL */
    if (baseURL === undefined) return
    void discovery.fetch(probe(keyValue, baseURL)).then((models: readonly LlmDiscoveredModel[] | undefined) => {
      if (models !== undefined) setRows(current => mergeCialloModels(current, models, creating))
    })
  }

  const patchModel = (index: number, field: string, value: string | number | undefined): void => {
    setRows(current => current.map((row, at) => {
      if (at !== index) return row
      const model = { ...row.model }
      if (value === undefined) Reflect.deleteProperty(model, field)
      else model[field] = value
      return { ...row, model }
    }))
  }

  const draftProfile = (apiKeyEnv: string | undefined, previous: unknown, url: string) => cialloProfile({
    route, groupName, api, baseURL: url, apiKeyEnv, models: checked, cache, sessionAffinity: affinity,
  }, previous)

  const createOnce = async (url: string): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const preferred = cialloPreferredModel(kind, checked.map(modelId))
    const preferredEffort = checked.find(model => modelId(model) === preferred)?.['defaultReasoningEffort']
    const outcome = await createCialloGroup(operations, {
      route,
      profile: draftProfile(keyRef, undefined, url),
      keyRef,
      key: keyValue,
      revision: openedAt,
      /* v8 ignore next -- Save requires a checked model, so a default is always proposed */
      ...preferred === '' ? {} : { defaultModel: {
        provider: route, model: preferred,
        ...typeof preferredEffort === 'string' ? { reasoningEffort: preferredEffort } : {},
      } },
      ...resume === undefined ? {} : { resume },
    })
    switch (outcome.kind) {
      case 'conflict': return t('conflict')
      case 'failed':
        if (outcome.resume !== undefined) setResume(outcome.resume)
        return outcome.message
      case 'created': {
        const { defaultFailure } = outcome
        if (defaultFailure === undefined) return undefined
        setCreated(true)
        return t('cialloDefaultModelFailed').replace('{message}', () => defaultFailure)
      }
    }
  }

  const editOnce = async (url: string): Promise<string | undefined> => {
    const apiKeyEnv = stored?.profile.apiKeyEnv ?? (keyValue.length > 0 ? deriveKeyRef(route) : undefined)
    const next = draftProfile(apiKeyEnv, baseline.user, url)
    const ops = pathOps(['providers', route], baseline.user, next)
    if (ops.length > 0) {
      const written = await operations.writeSettings(CIALLO_NS, ops, baseline.revision)
      if (written.kind !== 'written') return written.kind === 'conflict' ? t('conflict') : written.message
      setBaseline({ user: profileAt(written.view.user, route), revision: written.view.revision })
    }
    if (keyValue.length > 0) {
      /* v8 ignore next -- an edit names a reference whenever it stores a key */
      const refused = await operations.storeCredential(apiKeyEnv ?? deriveKeyRef(route), keyValue)
      if (refused !== undefined) return refused
    }
    return undefined
  }

  const save = async (): Promise<void> => {
    /* v8 ignore next -- Save is disabled without a base URL */
    if (baseURL === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = creating ? await createOnce(baseURL) : await editOnce(baseURL)
      if (outcome === undefined) props.onClose(true)
      else setFailure(outcome)
    } finally {
      setBusy(false)
    }
  }

  const detection = discovery.state
  const keyStatus = detection.kind === 'fetching'
    ? <p className={styles['advancedHint']} role="status">{t('cialloDetecting')}</p>
    : detection.kind === 'failed'
      ? <p className={styles['error']} role="alert">{detection.message}</p>
      : detection.kind === 'empty'
        ? <p className={styles['error']} role="alert">{t('fetchEmpty')}</p>
        : creating && rows.length === 0 && keyFailure === undefined
          ? <p className={styles['advancedHint']}>{t('cialloKeyHint')}</p>
          : null
  const savedKey = stored?.credential?.configured === true && stored.credential.masked !== undefined && keyDraft.length === 0
    ? { masked: stored.credential.masked }
    : undefined

  return (
    <div className={css.editor} role="group" aria-label={t(creating ? 'cialloNewGroup' : 'cialloEditGroup')}>
      <div className={css.editorHead}>
        <span className={css.editorTitle}>{t(creating ? 'cialloNewGroup' : 'cialloEditGroup')}</span>
        {rows.length > 0 ? <span className={css.detected}>{t('cialloDetectedKind').replace('{kind}', () => kindName)}</span> : null}
      </div>
      <div className={css.pair}>
        <label className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('cialloGroupName')}</span>
          <input
            className={styles['input']}
            type="text"
            value={nameDraft ?? ''}
            placeholder={kindName}
            disabled={disabled}
            onChange={(event) => { setNameDraft(event.target.value) }}
          />
        </label>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('keyInput')}</span>
          <ApiKeyInput
            t={t}
            value={keyDraft}
            {...savedKey === undefined ? {} : { saved: savedKey }}
            placeholder={t('keyPlaceholder')}
            aria-label={t('keyInput')}
            required={creating}
            autoFocus={creating}
            disabled={disabled || (creating && resume !== undefined)}
            onChange={(event) => { changeKey(event.target.value) }}
          />
          {keyFailure === undefined ? keyStatus : <p className={styles['error']}>{t(keyFailure)}</p>}
        </div>
      </div>
      {claude
        ? (
          <div className={css.claude}>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('cialloCacheRetention')}</span>
              <SegmentedControl
                id={cacheId}
                label={t('cialloCacheRetention')}
                value={cache}
                disabled={disabled}
                options={[{ value: '5m', label: t('cialloCache5m') }, { value: '1h', label: t('cialloCache1h') }]}
                onChange={setCache}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('cialloSessionAffinity')}</span>
              <span className={css.affinity}>
                <Switch checked={affinity} label={t('cialloSessionAffinity')} disabled={disabled} onChange={setAffinity} />
                <span className={styles['advancedHint']}>{t('cialloSessionAffinityHint')}</span>
              </span>
            </div>
          </div>
        )
        : null}
      <section className={styles['field']} aria-label={t('models')}>
        <div className={css.modelsHead}>
          <span className={css.modelsTitle}>
            {t('cialloModels').replace('{count}', () => String(rows.length)).replace('{checked}', () => String(checked.length))}
          </span>
          <button
            type="button"
            className={styles['linkButton']}
            disabled={disabled || detection.kind === 'fetching' || baseURL === undefined || keyFailure !== undefined
              || (creating && keyValue.length === 0)}
            onClick={refetch}
          >
            {detection.kind === 'fetching' ? t('fetching') : t('cialloRefetch')}
          </button>
        </div>
        {rows.length === 0
          ? null
          : (
            <ul className={css.models}>
              {rows.map((row, index) => {
                const id = modelId(row.model)
                const context = row.model['contextWindow']
                const efforts = effortsOf(row.model)
                const effort = row.model['defaultReasoningEffort']
                const selected = typeof effort === 'string' ? effort : ''
                return (
                  <li key={id} className={css.model}>
                    <label className={css.modelCheck}>
                      <input
                        type="checkbox"
                        checked={row.checked}
                        disabled={disabled}
                        onChange={() => {
                          setRows(current => current.map((candidate, at) =>
                            at === index ? { ...candidate, checked: !candidate.checked } : candidate))
                        }}
                      />
                      <span className={css.modelId} title={id}>{id}</span>
                    </label>
                    <label className={css.modelField}>
                      <span>{t('cialloContext')}</span>
                      <input
                        className={styles['input']}
                        type="text"
                        aria-label={`${t('contextWindow')} ${id}`}
                        aria-invalid={Number.isNaN(context)}
                        value={contextText.get(id) ?? (typeof context === 'number' ? formatCapacity(context) : '')}
                        disabled={disabled}
                        onChange={(event) => {
                          const text = event.target.value
                          setContextText(current => new Map(current).set(id, text))
                          patchModel(index, 'contextWindow', parseCapacity(text))
                        }}
                      />
                    </label>
                    <label className={css.modelField}>
                      <span>{t('cialloDefaultEffort')}</span>
                      <select
                        className={`${styles['input']} ${styles['selectInput']}`}
                        aria-label={`${t('modelReasoningDefault')} ${id}`}
                        value={selected}
                        disabled={disabled || efforts.length === 0}
                        onChange={(event) => {
                          patchModel(index, 'defaultReasoningEffort', event.target.value === '' ? undefined : event.target.value)
                        }}
                      >
                        <option value="">{t('modelReasoningAutomatic')}</option>
                        {selected !== '' && !efforts.includes(selected) ? <option value={selected}>{selected}</option> : null}
                        {efforts.map(level => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        {rows.length > 0 && checked.length === 0 ? <p className={styles['error']}>{t('cialloNoModels')}</p> : null}
        {contextInvalid ? <p className={styles['error']}>{t('modelContextInvalid')}</p> : null}
      </section>
      <details className={styles['customized']}>
        <summary className={styles['customizedSummary']}>{t('cialloAdvanced')}</summary>
        <div className={styles['customizedBody']}>
          <label className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('customApi')}</span>
            <select
              className={`${styles['input']} ${styles['selectInput']}`}
              value={api}
              disabled={disabled}
              onChange={(event) => { setProtocolDraft(event.target.value) }}
            >
              {protocols.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
            </select>
          </label>
        </div>
      </details>
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={!ready}
        submitLabelKey="cialloSave"
        submitBusyLabelKey="cialloSaving"
        cancelLabelKey={created ? 'close' : 'cancel'}
        onCancel={() => { props.onClose(created || resume !== undefined) }}
        onSubmit={() => { void save() }}
      />
    </div>
  )
}
