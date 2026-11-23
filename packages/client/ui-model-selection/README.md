---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The Web GUI lets users switch the model and reasoning effort for an existing session through either the `/model` popup or the composer's model control. Both surfaces present the same provider-grouped choices, and the selected model determines the available effort names and default. A complete selection applies to the next request; a running step keeps the model and effort it started with. The composer control also chooses the Session's prompt-cache duration for models whose catalog entry allows it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

DeepSeek account and API-key routes appear as separate provider groups, each exposing the same configured model catalog.

When no model is selected or the saved selection is absent from the catalog, the composer shows “Select model” in regular weight and hides the reasoning effort caption. Clicking it opens the model list directly; Escape and Shift+Tab close it. An empty catalog hides the model menu from display and the accessibility tree and displays “No models available.” in a status region.

Mount this plugin alongside `ui-conversation` and the commands package; the composer then shows the model seat next to the pending indicator, and `/model` opens the same directory as a popup. Clicking the seat opens one menu: the provider-grouped model list, with provider names as headings. The expanded model is the model just picked, otherwise the current one; below its row it shows reasoning-effort chips and, when its catalog entry allows a per-Session prompt-cache lifetime, cache-duration chips for 5 minutes and 1 hour. The current model preselects the Session's effort and another model its default effort; the cache chips preselect the Session's choice, or the model default when the Session has none. Clicking the current model closes the menu. Clicking another model with effort levels expands it without saving; clicking a model without effort levels saves it. An effort chip saves the complete selection and closes the menu, or only closes it when nothing changes. A cache chip saves the Session's cache duration immediately and keeps the menu open without changing the model; choosing the model default stores no choice, so the Session follows that default. When the current model uses one-hour caching, the trigger appends “· 1h” after the effort, and its accessible name includes the cache duration.

While the menu is open, `↑`/`↓` move through model rows, setting chips, and option rows; with search shown, a model stop keeps focus in search and moves its highlight, while chips and option rows take focus themselves. Enter and Tab settle the highlighted model or the focused row or chip; Escape and `Shift+Tab` close back to the trigger. Opening focuses model search when shown on desktop devices; otherwise it focuses the current model row, or the first enabled row when none is selected. Expanding another model focuses its checked effort chip. Phones and tablets leave search unfocused until the user taps it or uses keyboard navigation. The composer shows the catalog name while the selected model is available. Removing a model or provider, including account sign-out, preserves the stored provider, model, and reasoning effort without displaying their IDs. Restoring the catalog entry restores its name and effort caption.

Mouse selection uses native browser clicks, including their cancellation behavior; a press alone never selects. Clicking the trigger again closes the menu and returns focus there. Model rows and the search-clear button show the same fill for keyboard focus and hover, without a native outline. Selecting a model or effort returns focus to the trigger without a focus ring; leaving the trigger or reopening the menu restores its normal focus indication. While a selection from either entry is pending, focus stays on the trigger, the trigger shows a spinner in place of its chevron, and each model row and effort chip whose value the selection carries shows one; a rejected selection leaves the menu open. A rejected cache choice keeps the previous duration and announces through the same toast. Tab returns to model search with the current model highlighted when search is shown, otherwise to the current row.

### Model and effort

The button's model menu shows search only when its full catalog contains more than four models; smaller catalogs support keyboard navigation directly and focus the current model or first enabled row on all devices. The `/model` command always keeps its search field. Both search fields match model names case-insensitively, including nonconsecutive characters in order; leading and trailing spaces are ignored. Within each provider, prefix matches come first, followed by alignment score and then catalog order. Empty groups are hidden. Empty catalogs and queries without matches are announced through a status region. Search keeps focus while arrow keys cycle the highlighted result across provider groups; Enter or Tab selects it. Left and right arrows keep their native caret behavior. Opening highlights the current model or the first available row, and editing the query resets the highlight to the first result. Reopening the menu clears the query.

Model and reasoning-effort names use weight 400 (regular) in the composer menu, including the selected item. The search field follows the command popup's compact treatment with transparent background and border in both palettes, with no leading icon and a caption-tone placeholder. Its text is 16px on devices with a coarse primary pointer to avoid Safari focus zoom; fine pointers retain 12px. The clear button appears for a nonempty query and restores the full list with focus in the search field. Setting chips use 12px regular text beside a caption-tone label; unselected chips use the neutral module fill and the selected chip the inverted primary fill.

Both entries group models by provider, with DeepSeek Account first and DeepSeek API second; third-party providers retain their catalog order. Both use the shared, asynchronously observed sticky headings from [ui-primitives](../ui-primitives/README.md#understand-the-implementation): transparent at rest, with the theme's 94%-opaque fill only while pinned, and `md` corners outside macOS Desktop. The composer menu shows model names, effort names, and cache durations only. The `/model` popup shows provider names as group headings and model names as rows, without repeating the provider on each row or showing catalog descriptions. Its search placeholder, no-match text, and empty-catalog text use the same localized labels as the composer model menu. The popup applies the selected model's default effort; the composer can then choose any advertised effort. An adapter without reasoning metadata leaves the effort chips absent; there is no arbitrary effort input.

The composer replaces the model and effort text with the Models icon when the expanded controls cannot share one line, and restores the text when space permits. The full selection remains available in the trigger's accessible name, tooltip, and menu.

### Model label extensions

`conversation.input.model.label` is a session-scoped, inline `single` slot for the composer trigger (`placement: 'trigger'`) and each model option (`'option'`). Its owner props provide `provider: { id, name }`, the exact catalog `model`, `placement`, and `selected`. Provider names are localized display names; match channels by `provider.id`, and identify a model by the provider/model ID pair. Connection URLs and credentials are not passed to the slot.

Contributions must render non-interactive inline content, such as a colored name or badge. The selector owns clicks, search, focus, disabled states, check marks, reasoning effort, and trigger accessibility text. An absent contribution, including after plugin disposal, displays the catalog name with its optional `model.badge` before the name in the trigger and after it in menus: a `Tag` in the badge's tone whose text is resolved for the active locale. Long catalog names ellipsize within the available width while the badge remains visible. A contribution replaces both and receives the badge in its owner props. The trigger uses the slot only when the selected model is present in the displayed catalog; otherwise it keeps the built-in placeholder. During refresh, retained catalog entries continue to use the slot. The composer menu uses CSS anchors to follow its trigger and label size changes within the layout viewport. Pinch zoom scales the menu with the page; it may extend beyond the visual viewport, including while the keyboard is open. `/model` command rows use the command popup's separate rendering API.

Import this package's `/client` declarations type-only, then register through `ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({ name: 'conversation.input.model.label' }, ModelLabel))`. Derive `ModelLabel` props from `PropsRuntime<'conversation.input.model.label'>`; use provider IDs to choose CSS Module classes and retain `model.name` as the text. Registration follows the declaration and contributing plugin lifetimes. Without a component replacement, styles can target the enclosing label's `data-provider-id` and `data-model-id` attributes in both placements.

### Unroutable sessions

Catalog availability does not block sending with a saved selection; request execution reports missing credentials or unavailable models. Refreshes and refresh failures retain the last displayed selection and groups. A Host reset clears that display. Sign-out hides the account provider from the picker while preserving the saved provider/model ID and reasoning effort. Signing in restores the catalog name when that model is available again. Existing session logs remain unchanged.

### Selection failures

When another writer owns the Session, model-selection failures tell the user to quit other running DSH instances and retry.

The session-scoped `conversation.input.model.options` list renders below the model list, behind a divider that appears only when an option renders content. Render each interactive entry as a `button` with role `menuitem`, `menuitemradio`, or `switch`; Arrow keys and Tab reach only those rows besides model rows and chips. Entries call `openPane({ key, title })` to show content registered in the session-scoped keyed `conversation.input.model.pane` slot; the invoking button's `data-model-menu-pane` must match the key. Option and detail entries receive `locked`, `reportFailure(message)`, and `dismiss()`: the lock includes model or effort saves, failures use the menu owner's toast, and dismissal focuses its trigger synchronously before another overlay opens. Contributing plugins own settings and confirmation logic. A detail pane is 240px wide within 12px viewport insets; the model list remains content-sized. The menu exposes a detail pane as a group named by `title`; the pane places its own initial focus, and focus otherwise stays on the menu surface. Escape and `Shift+Tab` return to the model list with focus on the invoking option row; Tab closes a detail pane without activating its switch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Menus use the shared `MenuSurface` material, including the macOS backing for background blur; custom content follows the [menu rules](../../../docs/web-styling.md#component-rules). The composer menu uses a fixed body portal and CSS Anchor Positioning, which requires browser support for `anchor-name`, `position-anchor`, and `anchor()`. The trigger and menu share a unique anchor name. CSS prefers the position above the trigger with right edges aligned and an 8px gap, and keeps the menu within the layout viewport's 12px insets and desktop frame clearance. The trigger gap is preserved when desktop page zoom reflows the sticky composer. No JavaScript reads the trigger rectangle or tracks viewport changes for this placement. Pinch zoom scales the menu with the page; it may extend beyond the visual viewport, including while the keyboard is open. Model names ellipsize within the panel width while badges stay visible. The model list, including the expanded model's settings, scrolls vertically within the panel height limit; option rows stay below it.

<details>
<summary>Implementation internals — click to expand</summary>

The composer `ModelSelect` and `/model` option builder share [provider ordering](src/client/provider-order.ts), while both searches use the shared [text search](../../util/text-search/README.md) within each provider. The command supplies optional groups through the [popupSelect API](../ui-commands/README.md#use-this-package); both entries use `MenuGroup` and rebuild its sticky observer when the rendered groups change. The command popup fills the composer overlay, while the button retains its compact menu.

Two entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`): the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's available directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance, so a switch made in either entry is what the other shows next. Directory loads and selections share a generation counter so an older response never overwrites a newer one. The directory publishes the latest submitted selection as `pending` until it settles or a connection reset invalidates it; a connection reset drops every resident projection and repulls the Host-restored selection before display. Directories are per-session, resolved lazily, and disposed with the session scope; addressed subagent sessions expose neither entry. Loading also reads the Session's prompt-cache choice through `llm.sessionCacheRetention`; a cache chip writes it through `llm.setSessionCacheRetention` and publishes it on the directory only after the Host accepts it. Every resident directory refetches directly on forwarded `llm/adapters-updated`, `llm/models-updated`, `settings/document-updated`, and credential update events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `session.selectModel` selection both entries submit: the Host snapshots the complete `ModelSelection` at the next prompt-assembly boundary and owns the model-visible effect, while a running step keeps its assembled selection.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched. The cache-duration choice sets how long the provider keeps the prompt cache for later requests of the Session and its subagents; it does not change the prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the effort chips absent.
- **Cache duration only where advertised** — the cache chips appear only for models whose catalog entry carries `cacheRetention`, and `/model` offers no cache choice.
- **Badges label the composer seat only** — `/model` popup rows, the trigger's accessible name, and its tooltip keep the plain catalog name.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
