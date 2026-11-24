/**
 * First-run step: one CialloAPI key gets a user started. While no provider can
 * serve requests, the step asks for a key, recognizes the key's group from the
 * models it lists, and creates the first CialloAPI group with every listed
 * model enabled. When the deployment default model is unavailable, the new
 * group's proposed model becomes the default.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiKeyFailure } from './apiKey.ts'
import { ApiKeyInput } from './ApiKeyInput.tsx'
import { CIALLO_API, cialloApiBaseURL, cialloApiProtocols } from './ciallo-api.ts'
import {
  CIALLO_KIND_KEYS, cialloKindProtocol, cialloPreferredModel, cialloProfile, classifyCialloModels, nextCialloRoute,
} from './ciallo-groups.ts'
import { adoptCandidate } from './ModelListEditor.tsx'
import { CIALLO_NS, createCialloGroup } from './ciallo-save.ts'
import type { CialloCreateResume } from './ciallo-save.ts'
import { deriveKeyRef, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { useCialloDiscovery } from './useCialloDiscovery.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import { LegacyDshImportBanner } from './LegacyDshImportBanner.tsx'
import { OnboardingModal } from './OnboardingModal.tsx'
import css from './CialloStartDialog.module.css'

/** Registration-side dependencies of {@link CialloStartDialog}. */
export interface CialloStartInjected {
  hooks: {
    /** Shared Models-page join state. */
    models: SnapshotStore<ModelsSettingsState>
    /** Whether first-run setup shows automatically; read once when the step mounts. */
    automatic: ObservableSnapshot<boolean>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Host operations. */
  operations: ModelsOperations
  /** Settings schema callbacks. */
  schema: SettingsSchemaOperations
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the step's injected dependencies. */
export type CialloStartDialogProps = PropsRuntime<'settings.onboarding'> & InjectFace<CialloStartInjected>

/** Whether the step can help: still deciding, nothing to do, or a key to ask for. */
export type CialloStartReadiness =
  | { kind: 'loading' }
  | { kind: 'skip' }
  | { kind: 'offer'; protocols: readonly string[]; revision: number; taken: readonly string[] }

/**
 * Decide the step from the shared Models join. The step offers a key field only
 * where it can create a group — a writable pi-ai namespace that accepts a
 * gateway protocol — and, unless requested explicitly, only while no provider
 * can serve requests.
 * @param state - Models join snapshot.
 * @param schema - settings schema callbacks.
 * @param explicit - whether the user asked for the step.
 * @returns the step readiness.
 */
export function cialloStartReadiness(
  state: ModelsSettingsState, schema: SettingsSchemaOperations, explicit: boolean,
): CialloStartReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) return { kind: 'loading' }
  if (state.status === 'error' || !state.writable) return { kind: 'skip' }
  if (!explicit && state.rows.some(providerUsable)) return { kind: 'skip' }
  const namespace = state.namespaces.get(CIALLO_NS)
  const protocols = cialloApiProtocols(protocolChoices(namespace, schema))
  if (namespace === undefined || protocols.length === 0) return { kind: 'skip' }
  return { kind: 'offer', protocols, revision: namespace.revision, taken: state.rows.map(row => row.entry.provider) }
}

/**
 * Render the first-run CialloAPI step.
 * @param props - settings-shell owner state and Models dependencies.
 * @returns the step modal, or null while deciding or when there is nothing to offer.
 */
export function CialloStartDialog(props: CialloStartDialogProps): ReactNode {
  const { complete, controller, useModels, useAutomatic, operations, schema, t, explicit = false } = props
  const automaticOnMount = useAutomatic(value => value)
  const [automatic] = useState(automaticOnMount)
  const state = useModels(snapshot => snapshot)
  const readiness = cialloStartReadiness(state, schema, explicit)
  const discovery = useCialloDiscovery(operations)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [resume, setResume] = useState<CialloCreateResume | undefined>(undefined)
  /** The group exists but its default-model write failed; the step only closes now. */
  const [created, setCreated] = useState(false)
  /** Keep the dialog open to display migration results even if imported keys made a provider usable. */
  const [importedLegacy, setImportedLegacy] = useState(false)
  /** Fixed when the step first offers, so a refresh cannot move the new group to another id. */
  const [route, setRoute] = useState<string | undefined>(undefined)
  const shown = automatic || explicit

  useEffect(() => {
    if (shown && state.status === 'idle') void controller.load()
  }, [controller, state.status, shown])

  useEffect(() => {
    if (!shown || (readiness.kind === 'skip' && !importedLegacy)) complete()
  }, [complete, importedLegacy, readiness.kind, shown])

  if (!shown || (readiness.kind !== 'offer' && !importedLegacy)) return null
  const offered = readiness.kind === 'offer' ? readiness : undefined
  const target = route ?? (offered === undefined ? '' : nextCialloRoute(offered.taken))

  const detection = discovery.state
  const models = detection.kind === 'found' ? detection.models : []
  const ids = models.map(model => model.id)
  const kind = classifyCialloModels(ids)
  const kindName = t(CIALLO_KIND_KEYS[kind])
  const api = offered === undefined ? '' : cialloKindProtocol(kind, offered.protocols)
  const preferred = cialloPreferredModel(kind, ids)
  const keyValue = keyDraft.trim()
  const keyFailure = apiKeyFailure(keyDraft)

  const changeKey = (value: string): void => {
    if (offered === undefined) return
    setRoute(target)
    setKeyDraft(value)
    setFailure(undefined)
    const key = value.trim()
    const probeApi = cialloKindProtocol('mixed', offered.protocols)
    discovery.schedule(key.length === 0 || apiKeyFailure(value) !== undefined ? undefined : {
      provider: target,
      /* v8 ignore next -- the default origin resolves for every gateway protocol */
      baseURL: cialloApiBaseURL(CIALLO_API.origin, probeApi) ?? CIALLO_API.origin,
      api: probeApi,
      apiKey: key,
    }, () => {})
  }

  const start = async (): Promise<void> => {
    if (offered === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const keyRef = deriveKeyRef(target)
      const adopted = models.map(adoptCandidate)
      const effort = adopted.find(model => model.id === preferred)?.['defaultReasoningEffort']
      const outcome = await createCialloGroup(operations, {
        route: target,
        profile: cialloProfile({
          route: target,
          groupName: kindName,
          api,
          /* v8 ignore next -- the default origin resolves for every gateway protocol */
          baseURL: cialloApiBaseURL(CIALLO_API.origin, api) ?? CIALLO_API.origin,
          apiKeyEnv: keyRef,
          models: adopted,
          cache: '5m',
          sessionAffinity: true,
        }, undefined),
        keyRef,
        key: keyValue,
        revision: offered.revision,
        /* v8 ignore next -- the start action requires a non-empty listing, so a default is always proposed */
        ...preferred === '' ? {} : { defaultModel: {
          provider: target, model: preferred, ...typeof effort === 'string' ? { reasoningEffort: effort } : {},
        } },
        replaceDefault: true,
        ...resume === undefined ? {} : { resume },
      })
      switch (outcome.kind) {
        case 'conflict':
          setFailure(t('conflict'))
          return
        case 'failed':
          if (outcome.resume !== undefined) setResume(outcome.resume)
          setFailure(outcome.message)
          return
        case 'created': {
          void controller.load()
          const { defaultFailure } = outcome
          if (defaultFailure === undefined) {
            complete()
            return
          }
          setCreated(true)
          setFailure(t('cialloDefaultModelFailed').replace('{message}', () => defaultFailure))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const status = keyFailure !== undefined
    ? <p className={css.error} role="alert">{t(keyFailure)}</p>
    : detection.kind === 'fetching'
      ? <p className={css.status} role="status">{t('cialloDetecting')}</p>
      : detection.kind === 'failed'
        ? <p className={css.error} role="alert">{detection.message}</p>
        : detection.kind === 'empty'
          ? <p className={css.error} role="alert">{t('fetchEmpty')}</p>
          : detection.kind === 'found'
            ? (
              <p className={`${css.status} ${css.found}`} role="status">
                {t('cialloDetected')
                  .replace('{kind}', () => kindName)
                  .replace('{count}', () => String(ids.length))
                  .replace('{model}', () => preferred)}
              </p>
            )
            : <p className={css.status}>{t('startHint')}</p>

  return (
    <OnboardingModal title={t('startTitle')}>
      <p className={css.description}>{t('startDescription')}</p>
      <LegacyDshImportBanner
        operations={operations}
        controller={controller}
        t={t}
        compact
        onImported={() => { setImportedLegacy(true) }}
      />
      {offered === undefined
        ? (
          <div className={css.actions}>
            <span />
            <Button variant="primary" className={css.primary} onClick={complete}>{t('startContinue')}</Button>
          </div>
        )
        : (
          <>
            <label className={css.field}>
              <span className={css.label}>{t('keyInput')}</span>
              <ApiKeyInput
                t={t}
                value={keyDraft}
                placeholder={t('keyPlaceholder')}
                aria-label={t('keyInput')}
                autoFocus
                required
                disabled={busy || created || resume !== undefined}
                onChange={(event) => { changeKey(event.target.value) }}
              />
            </label>
            <div className={css.field}>{status}</div>
            {failure === undefined ? null : <p className={css.error} role="alert">{failure}</p>}
            <div className={css.actions}>
              <Button variant="ghost" disabled={busy} onClick={complete}>
                {t(created ? 'close' : 'startLater')}
              </Button>
              {created
                ? <Button variant="primary" className={css.primary} onClick={complete}>{t('startContinue')}</Button>
                : (
                  <Button
                    variant="primary"
                    className={css.primary}
                    disabled={busy || detection.kind !== 'found' || keyFailure !== undefined}
                    onClick={() => { void start() }}
                  >
                    {t(busy ? 'startSubmitting' : 'startSubmit')}
                  </Button>
                )}
            </div>
          </>
        )}
    </OnboardingModal>
  )
}
