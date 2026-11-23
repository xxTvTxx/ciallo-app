/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * The trigger (figma 313:14108's ToggleButton) shows the model name and effort
 * in the caption tone, followed by a one-hour cache marker when the Session
 * uses one-hour prompt caching. It opens one menu: the provider-grouped model
 * list over the shared directory, with provider names as headings. The
 * expanded model is the model the user just picked, otherwise the current one;
 * below its row it shows reasoning-effort chips and, when its catalog entry
 * carries `cacheRetention`, cache-lifetime chips. The current model
 * preselects the Session's effort and another model its default effort; the
 * cache chips preselect the Session's choice or the model default. An effort
 * chip submits the complete selection and closes, or only closes when nothing
 * changes. A cache chip records the Session's prompt-cache lifetime, sending
 * null for the model default, and keeps the menu open. Picking the current
 * model closes; picking another model with effort levels expands it without
 * submitting; picking a model without effort levels submits it.
 * Plugin options (`conversation.input.model.options`) follow the list below
 * a divider and may open a plugin-owned detail pane; Escape and Shift+Tab
 * return from that pane to the list and otherwise close back to the trigger.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ move the highlighted model; Enter and Tab accept it. A step from a
 * model onto chips or option rows moves focus there, and a step back onto a
 * model returns focus to search with that model highlighted. Smaller catalogs
 * move focus across model rows, chips, and option rows. Expanding a model
 * focuses its checked effort chip. Opening focuses search on desktop devices
 * when shown, otherwise the current model row; mobile devices focus search
 * only after explicit user input. Provider headings paint their background
 * only while pinned by scrolling. Clearing a query restores the full list and
 * search focus. Selecting restores trigger focus without a ring until the
 * trigger loses focus or the menu reopens. Model names match a
 * case-insensitive ordered subsequence within each provider group, ranked by
 * prefix, alignment score, then catalog order. Data and submission ride the
 * same per-session ModelDirectory as the /model popup; exact-model reasoning
 * and cache metadata and the selected effort come from the Host rather than a
 * client-owned vocabulary. A rejected selection or cache choice announces
 * through the shared transient Toast anchored to the composer card; the
 * in-menu strip with Retry remains the catalog-load surface. While the
 * directory's pending selection is unsettled, the trigger shows a spinner in
 * place of its chevron, and each model row and effort chip whose value that
 * selection carries shows one.
 */
import { MenuGroup, MenuSurface, observeStickyMenuGroups } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseFillRegular,
  IconDataOutlineRegular, IconWarningOutlineRegular, Input, isMobileDevice, StateDot, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CacheRetention } from './directory.ts'
import type { ModelLabelOwner, ModelMenuControls, ModelMenuPaneRef, ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import { orderModelProviders } from './provider-order.ts'

/** Which pane the dropdown shows: the model list or a plugin-owned detail pane. */
type Pane =
  | { kind: 'list' }
  | { kind: 'detail'; pane: ModelMenuPaneRef }

const LIST_PANE: Pane = { kind: 'list' }

/** One catalog model by its provider/model id pair. */
type ModelRef = Pick<ModelSelection, 'provider' | 'model'>

/**
 * Focus placement for the next committed menu state: the opening position,
 * the expanded model's effort chip, a detail pane's own focus, or the option
 * row that opened the detail pane being left.
 */
type FocusIntent = 'open' | 'expand' | 'detail' | { back: ModelMenuPaneRef }

/** One dynamic effort chip; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Enabled keyboard stops inside the menu: model rows, setting chips, and option rows. */
const NAV_ROWS = 'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), button[role="switch"]:not([disabled])'

const CACHE_RETENTIONS: readonly CacheRetention[] = ['short', 'long']

function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a.provider === b.provider && a.model === b.model
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the model menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, selectCacheRetention, resolveText, t, renderSlot }:
  ModelSelectInjected & Pick<PropsRuntime<'conversation.input.model'>, 'locked'> & PropsLocale<'model'>
    & Omit<PropsRenderSlots<'conversation.input.model.label' | 'conversation.input.model.options' | 'conversation.input.model.pane'>, 'SessionProvider'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>(LIST_PANE)
  const [picked, setPicked] = useState<ModelRef | null>(null)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const cacheSaving = useRef(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const modelRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const anchorStyle: CSSProperties & Record<'--dsh-model-anchor', string> = {
    '--dsh-model-anchor': `--dsh-model-${id.replaceAll(':', '')}`,
  }

  const accountProviderName = t('provider.account')
  const groups = useMemo(() => orderModelProviders(state.groups).map(group => ({
    ...group,
    provider: {
      id: group.id,
      name: group.id === 'deepseek-account' ? accountProviderName : group.name,
    },
  })), [state.groups, accountProviderName])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({ group, model }))), [groups])
  const showSearch = choices.length > 4
  const groupIndexes = useMemo(() => groups.map(group => ({
    group, index: new TextSearchIndex(group.models, model => ({ fuzzy: [model.name, model.id], substring: [model.description] })),
  })), [groups])
  const filteredGroups = useMemo(() => groupIndexes.map(({ group, index }) => ({
    ...group, models: index.search(showSearch ? query : ''),
  })).filter(group => group.models.length > 0), [groupIndexes, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
  }))), [filteredGroups])
  const currentVisibleIndex = visibleModels.findIndex(model => sameModel(model, state.current))
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const findChoice = (ref: ModelRef | null) => ref === null
    ? undefined
    : choices.find(choice => choice.group.id === ref.provider && choice.model.id === ref.model)
  const currentChoice = findChoice(state.current)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const expandedChoice = picked === null ? currentChoice : findChoice(picked)
  const expandedIsCurrent = expandedChoice !== undefined && expandedChoice === currentChoice
  const expandedReasoning = expandedChoice?.model.reasoning
  const expandedCache = expandedChoice?.model.cacheRetention
  const pickedEffort = expandedIsCurrent ? effectiveEffort : expandedReasoning?.defaultEffort
  const pickedCache = expandedCache === undefined ? undefined : state.cacheRetention ?? expandedCache.default
  const currentCache = currentChoice?.model.cacheRetention
  const longCache = currentCache !== undefined && (state.cacheRetention ?? currentCache.default) === 'long'
  const effortLabel = currentChoice === undefined
    ? undefined
    : reasoning === undefined
      ? state.retainedEffort
      : effectiveEffort === undefined
        ? t('effort.providerDefault')
        : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => expandedReasoning === undefined
    ? []
    : [
      ...expandedReasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...expandedReasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [expandedReasoning, t])
  const { pending } = state
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    // WebKit touch taps on non-clickable areas dispatch pointerdown without mousedown.
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('mousedown', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('mousedown', closeOutside)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // Opening, expanding, and pane switches mount or unmount the focused
  // control; place focus inside the menu so keyboard navigation remains available.
  const focusIntent = useRef<FocusIntent | null>(null)
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = focusIntent.current ?? (changedSearchMode && pane.kind === 'list' ? 'open' : null)
    focusIntent.current = null
    if (!open || intent === null) return
    const menu = menuRef.current
    if (intent === 'detail') {
      // A detail pane places its own initial focus (autoFocus commits before
      // this effect); otherwise the surface keeps the menu's keys reachable.
      if (menu?.contains(document.activeElement) !== true) (menu ?? triggerRef.current)?.focus()
      return
    }
    if (intent === 'expand') {
      const chips = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[data-model-chip="effort"]:not([disabled])') ?? [])
      const target = chips.find(chip => chip.getAttribute('aria-checked') === 'true') ?? chips[0]
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    if (intent === 'open') {
      if (showSearch && !isMobileDevice()) {
        searchRef.current?.focus()
        return
      }
      // The checked row is the model in use; a list without one opens on its
      // first row. Rows a selection in flight disabled cannot take the
      // keyboard; the trigger does, so the card's keys still reach the menu.
      const rows = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[data-model-row]:not([disabled])') ?? [])
      const target = rows.find(row => row.getAttribute('aria-checked') === 'true') ?? rows[0]
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[data-model-menu-pane]') ?? [])
      .find(button => button.dataset.modelMenuPane === intent.back.key)
    ;(cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, picked, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups])

  useLayoutEffect(() => {
    if (open && pane.kind === 'list' && activeModelIndex >= 0) {
      modelRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    setPicked(null)
    focusIntent.current = 'open'
    setPane(LIST_PANE)
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
    // A new result list starts at its top, below no pinned heading.
    if (groupsRef.current !== null) groupsRef.current.scrollTop = 0
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane(LIST_PANE)
    setPicked(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const openDetail = (next: ModelMenuPaneRef): void => {
    setQuery('')
    setHighlightedIndex(null)
    focusIntent.current = 'detail'
    setPane({ kind: 'detail', pane: next })
  }

  /** Leave a detail pane for the model list, handing the keyboard back to its option row. */
  const back = (from: ModelMenuPaneRef): void => {
    focusIntent.current = { back: from }
    setPane(LIST_PANE)
  }

  const controls: ModelMenuControls = {
    locked: locked || busy,
    dismiss: () => {
      close()
      triggerRef.current?.focus()
    },
    reportFailure: (message) => { setToast({ seq: ++toastSeq.current, text: message }) },
  }

  const navRows = (): HTMLButtonElement[] => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(NAV_ROWS) ?? [])

  /**
   * Step through the menu's keyboard stops. With search shown, a model stop is
   * the search field with that model highlighted; chips and option rows take
   * focus themselves.
   */
  const step = (offset: number): void => {
    const items = navRows()
    if (items.length === 0) return
    const focused = document.activeElement
    const searching = showSearch && pane.kind === 'list' && searchRef.current !== null
    const active = searching && focused === searchRef.current
      ? items.findIndex(item => item.hasAttribute('data-highlighted'))
      : items.findIndex(item => item === focused)
    // Focus outside the stops (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first stop forward,
    // the last stop backward.
    const next = items[active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length]
    /* v8 ignore next -- the index is reduced modulo the non-empty list length */
    if (next === undefined) return
    if (searching && next.dataset.modelIndex !== undefined) {
      setHighlightedIndex(Number(next.dataset.modelIndex))
      searchRef.current?.focus()
      return
    }
    next.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || !open) return
    // Shift+Tab leaves like Escape: a detail pane returns to the list, the
    // list closes back to the trigger.
    if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      if (pane.kind === 'detail') back(pane.pane)
      else close(true)
      return
    }
    if (pane.kind === 'detail' && event.key === 'Tab') {
      event.preventDefault()
      close(true)
      return
    }
    if (pane.kind === 'list' && showSearch && event.target === searchRef.current) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!busy) step(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab' && visibleModels.length === 0) return
        event.preventDefault()
        const highlighted = visibleModels[activeModelIndex]
        if (!busy && highlighted !== undefined) choose(highlighted)
        return
      }
    }
    // Tab settles like Enter, so the menu's keys mean what they mean in the
    // composer. It is consumed: the card keeps the browser's focus traversal
    // out while it is open.
    if (event.key === 'Tab') {
      // Settling activates the stop the keyboard is on; with focus still on
      // the trigger, Tab enters the menu at the value in use instead. Any
      // other control inside the card (a retry button) keeps the browser's
      // traversal, so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = navRows()
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane.kind === 'list' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[data-model-row][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows[0])?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    // Clicking explanation text can clear focus without leaving its page.
    if (pane.kind === 'detail' && event.relatedTarget === null) return
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const announce = (text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    announce(error.code === 'session/writer-held'
      ? t('error.sessionInUse')
      : t('error.action', { message: `${error.code}: ${error.message}` }))
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (ref: ModelRef): void => {
    if (sameModel(ref, state.current)) {
      closeAfterSelection()
      return
    }
    if ((findChoice(ref)?.model.reasoning?.efforts.length ?? 0) > 0) {
      focusIntent.current = 'expand'
      setPicked({ provider: ref.provider, model: ref.model })
      return
    }
    submit({ provider: ref.provider, model: ref.model })
  }

  const chooseEffort = (target: ModelRef, effort: string | undefined): void => {
    if (expandedIsCurrent && effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    submit({
      provider: target.provider,
      model: target.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  }

  const chooseCache = (retention: CacheRetention, modelDefault: CacheRetention): void => {
    // The model default is stored as no choice, so the Session follows later default changes.
    const next = retention === modelDefault ? null : retention
    if (next === state.cacheRetention || cacheSaving.current) return
    cacheSaving.current = true
    void selectCacheRetention(next).then((result) => {
      if (result !== undefined && !result.ok) {
        announce(t('error.cache', { message: `${result.error.code}: ${result.error.message}` }))
      }
    }).finally(() => { cacheSaving.current = false })
  }

  const waiting = currentChoice === undefined && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? t('trigger.fallback')
  const cacheMark = t('trigger.cacheLong')
  const triggerLabel = [
    effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`,
    ...longCache ? [cacheMark] : [],
  ].join(' ')
  const triggerAria = waiting
    ? t('trigger.loading')
    : currentChoice === undefined
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? longCache
          ? t('trigger.ariaCache', { model: modelLabel, cache: t('cache.long') })
          : t('trigger.aria', { model: modelLabel })
        : longCache
          ? t('trigger.ariaEffortCache', { model: modelLabel, effort: effortLabel, cache: t('cache.long') })
          : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  const renderModelLabel = (
    provider: ModelLabelOwner['provider'], model: ModelLabelOwner['model'],
    placement: ModelLabelOwner['placement'], selected: boolean,
  ) => (
    <span data-provider-id={provider.id} data-model-id={model.id}>
      {renderSlot('conversation.input.model.label', {
        provider, model, placement, selected,
      }, {
        fallback: model.badge === undefined ? model.name : (
          <span className={css.badgedName}>
            {placement === 'trigger' ? <><Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag>{' '}</> : null}
            <span className={css.badgedNameText}>{model.name}</span>
            {placement === 'trigger' ? null : <>{' '}<Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag></>}
          </span>
        ),
      })}
    </span>
  )

  /** Inline settings below the expanded model's row. */
  const renderSettings = (target: ModelRef) => {
    const effortLabelId = `${id}-effort`
    const cacheLabelId = `${id}-cache`
    return (
      <div className={css.settings} data-model-settings="">
        {expandedReasoning !== undefined && (
          <div className={css.setting} role="group" aria-labelledby={effortLabelId}>
            <span id={effortLabelId} className={css.settingLabel}>{t('menu.effort')}</span>
            <span className={css.chips}>
              {effortChoices.map(level => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={pickedEffort === level.effort}
                  data-model-chip="effort"
                  className={css.chip}
                  key={level.key}
                  disabled={busy}
                  onClick={() => { chooseEffort(target, level.effort) }}
                >
                  {level.label}
                  {sameModel(pending, target) && pending?.reasoningEffort === level.effort
                    ? <StateDot className={css.chipSpinner} state="ongoing" size={10} />
                    : null}
                </button>
              ))}
            </span>
          </div>
        )}
        {expandedCache !== undefined && (
          <div className={css.setting} role="group" aria-labelledby={cacheLabelId}>
            <span id={cacheLabelId} className={css.settingLabel}>{t('menu.cache')}</span>
            <span className={css.chips}>
              {CACHE_RETENTIONS.map(retention => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={pickedCache === retention}
                  data-model-chip="cache"
                  className={css.chip}
                  key={retention}
                  onClick={() => { chooseCache(retention, expandedCache.default) }}
                >
                  {t(retention === 'short' ? 'cache.short' : 'cache.long')}
                </button>
              ))}
            </span>
          </div>
        )}
      </div>
    )
  }

  let modelIndex = 0

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown
        // keeps focus. Pressing non-focusable card content (a provider heading,
        // padding, status text) would move focus to the body and close the card
        // through onBlur; other focusable controls, which plugin options may
        // render, keep their default focus, and a detail pane keeps the default
        // so its prose stays selectable.
        const { target } = event
        if (target instanceof Element && (
          target.closest('button') !== null
          || (pane.kind !== 'detail' && menuRef.current?.contains(target) === true
            && target.closest('a[href], input, select, textarea, [role="button"], [contenteditable], [tabindex]') === null)
        )) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        style={anchorStyle}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>
          {currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)}
        </span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {longCache && <span className={css.triggerCache}>{cacheMark}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          data-model-menu=""
          tabIndex={pane.kind === 'detail' ? -1 : undefined}
          id={`${id}-menu`}
          className={clsx(css.menu, pane.kind === 'detail' && css.settingsMenu)}
          style={anchorStyle}
          // The list holds a search field and a detail pane holds plugin
          // controls and prose; their rows sit in nested menus.
          role="group"
          aria-label={pane.kind === 'detail' ? pane.pane.title : t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane.kind === 'list' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>}
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                ref={groupsRef}
                id={`${id}-models`}
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
                hidden={filteredGroups.length === 0}
              >
                {filteredGroups.map(group => (
                  <MenuGroup key={group.id} label={group.provider.name}>
                    {group.models.map((model) => {
                      const index = modelIndex++
                      const ref = { provider: group.id, model: model.id }
                      const selected = sameModel(ref, state.current)
                      const expanded = expandedChoice !== undefined && expandedChoice.group.id === group.id
                        && expandedChoice.model.id === model.id
                      return (
                        <Fragment key={model.id}>
                          <button
                            ref={(node) => { modelRefs.current[index] = node }}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            id={`${id}-model-${index}`}
                            data-model-row=""
                            data-model-index={index}
                            tabIndex={showSearch ? -1 : 0}
                            onFocus={() => { setHighlightedIndex(index) }}
                            data-highlighted={index === activeModelIndex ? '' : undefined}
                            className={clsx(
                              css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                            )}
                            onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                              if (showSearch) setHighlightedIndex(index)
                              else modelRefs.current[index]?.focus()
                            }}
                            title={model.name}
                            disabled={busy}
                            onClick={() => { choose(ref) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{renderModelLabel(group.provider, model, 'option', selected)}</span>
                            </span>
                            <span className={css.check}>
                              {sameModel(pending, ref)
                                ? <StateDot state="ongoing" />
                                : selected ? <IconCheckOutlineRegular /> : null}
                            </span>
                          </button>
                          {expanded && (expandedReasoning !== undefined || expandedCache !== undefined) && renderSettings(ref)}
                        </Fragment>
                      )
                    })}
                  </MenuGroup>
                ))}
              </div>
              {state.status === 'ready' && filteredGroups.length === 0 && (
                <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
              )}
              <div className={css.options} role="menu" aria-label={t('menu.options')}>
                {renderSlot('conversation.input.model.options', { ...controls, openPane: openDetail })}
              </div>
            </>
          )}
          {pane.kind === 'detail' && (
            <div className={clsx(css.groups, 'scrollable')}>
              {renderSlot('conversation.input.model.pane', controls, { entryKey: pane.pane.key })}
            </div>
          )}
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
