// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'

// jsdom has no layout; the open list scrolls its highlighted row into view.
beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

function setup(autoFocus = true, extraOption?: ReactNode) {
  const directory = createSnapshotStore<ModelDirectoryState>({
    current: { provider: 'fixture', model: 'fixture' }, routable: true,
    groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'fixture', name: 'Fixture' }] }],
    failures: [], status: 'ready', pending: null, error: null, cacheRetention: null,
  })
  const change = vi.fn()
  const select = vi.fn()
  const renderSlot: ComponentProps<typeof ModelSelect>['renderSlot'] = (name, owner, options) => {
    if (name === 'conversation.input.model.options') {
      const controls = owner as object as OwnerOf<'conversation.input.model.options'>
      return <><button type="button" role="menuitem" data-model-menu-pane="fixture" disabled={controls.locked}
        onClick={() => { controls.openPane({ key: 'fixture', title: 'Fixture settings' }) }}>Fixture settings</button>{extraOption}</>
    }
    if (name === 'conversation.input.model.pane') {
      const controls = owner as object as OwnerOf<'conversation.input.model.pane'>
      expect(options?.entryKey).toBe('fixture')
      return <><button type="button" role="switch" aria-checked="false" disabled={controls.locked}
        autoFocus={autoFocus} onClick={change}>Fixture setting</button><p>Fixture explanation</p></>
    }
    return options?.fallback ?? null
  }
  render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} selectCacheRetention={vi.fn()}
    resolveText={text => typeof text === 'string' ? text : text.en} t={makeTranslate(en)} renderSlot={renderSlot} />)
  const trigger = screen.getByRole('button', { name: /^Select model/ })
  fireEvent.click(trigger)
  return { trigger, change, select, directory }
}

it('lists options below the models and returns from a keyed page to its option row on Escape', () => {
  const { trigger, change, select } = setup()
  const options = screen.getByRole('menu', { name: 'Session options' })
  expect(options.contains(screen.getByRole('menuitem', { name: 'Fixture settings' }))).toBe(true)
  expect(screen.getByRole('menu', { name: 'Model' }).compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  expect(screen.queryByRole('menuitemradio', { name: 'Fixture' })).toBeNull()
  const toggle = screen.getByRole('switch')
  expect(document.activeElement).toBe(toggle)
  expect(screen.getByRole('group', { name: 'Fixture settings' })).toBeTruthy()
  fireEvent.blur(toggle, { relatedTarget: null })
  expect(screen.getByText('Fixture explanation')).toBeTruthy()
  // Explanation text keeps its default press so it stays selectable.
  expect(fireEvent.mouseDown(screen.getByText('Fixture explanation'))).toBe(true)
  fireEvent.keyDown(toggle, { key: 'Escape' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: 'Fixture' })).toBeTruthy()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(change).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('keeps focus on the page surface when the page places none, so Escape still returns', () => {
  setup(false)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  const surface = screen.getByRole('group', { name: 'Fixture settings' })
  expect(document.activeElement).toBe(surface)
  fireEvent.keyDown(surface, { key: 'Escape' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fixture settings' }))
})

it('closes a detail pane on an outside touch press that dispatches no mousedown', () => {
  const { trigger } = setup()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  fireEvent.blur(screen.getByRole('switch'), { relatedTarget: null })
  fireEvent.pointerDown(screen.getByText('Fixture explanation'))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.pointerDown(document.body)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('closes a detail pane on Tab without changing its setting', async () => {
  const { trigger, change } = setup()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  fireEvent.keyDown(screen.getByRole('switch'), { key: 'Tab' })
  await act(async () => {})
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(change).not.toHaveBeenCalled()
})

it('returns from a detail pane to the model list on Shift+Tab, then closes', async () => {
  const { trigger, change } = setup()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  expect(fireEvent.keyDown(screen.getByRole('switch'), { key: 'Tab', shiftKey: true })).toBe(false)
  const option = screen.getByRole('menuitem', { name: 'Fixture settings' })
  expect(document.activeElement).toBe(option)
  expect(screen.getByRole('menuitemradio', { name: 'Fixture' })).toBeTruthy()
  fireEvent.keyDown(option, { key: 'Tab', shiftKey: true })
  await act(async () => {})
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(change).not.toHaveBeenCalled()
})

it('walks from the model rows onto option rows with the arrow keys', () => {
  setup()
  const row = screen.getByRole('menuitemradio', { name: 'Fixture' })
  expect(document.activeElement).toBe(row)
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fixture settings' }))
})

it('keeps the default press on focusable plugin options that are not buttons', () => {
  const { trigger } = setup(true, <>
    <div tabIndex={0} data-testid="tabbable"><span>Tabbable option</span></div>
    <a href="#fixture">Fixture link</a>
    <span>Plain option text</span>
  </>)
  const tabbable = screen.getByTestId('tabbable')
  // true = default kept, so the browser can move focus to the control.
  expect(fireEvent.mouseDown(screen.getByText('Tabbable option'))).toBe(true)
  expect(fireEvent.mouseDown(screen.getByRole('link', { name: 'Fixture link' }))).toBe(true)
  // Non-focusable option content still keeps the current focus.
  expect(fireEvent.mouseDown(screen.getByText('Plain option text'))).toBe(false)
  act(() => { tabbable.focus() })
  expect(document.activeElement).toBe(tabbable)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
})

it('keeps the baseline model-save lock on both summary and detail controls', () => {
  const { directory } = setup()
  act(() => { directory.update((state) => { state.pending = { provider: 'fixture', model: 'fixture' } }) })
  expect(screen.getByRole('menuitem', { name: 'Fixture settings' }).hasAttribute('disabled')).toBe(true)
  act(() => { directory.update((state) => { state.pending = null }) })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fixture settings' }))
  act(() => { directory.update((state) => { state.pending = { provider: 'fixture', model: 'fixture' } }) })
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  // A locked option row cannot take focus back; the trigger keeps the menu's keys.
  fireEvent.keyDown(screen.getByRole('switch'), { key: 'Escape' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Select model/ }))
  expect(screen.getByRole('menuitem', { name: 'Fixture settings' })).toBeTruthy()
})
