# Zen Space Routing Containers — Spec

Terminology used below is defined in [CONTEXT.md](./CONTEXT.md). Key decisions are recorded in [docs/adr/0001-rule-container-precedence.md](./docs/adr/0001-rule-container-precedence.md) and [docs/adr/0002-delivery-via-js-loader-not-zen-mods.md](./docs/adr/0002-delivery-via-js-loader-not-zen-mods.md).

## Problem

Zen's native Space Routing sends a tab to a Space based on a URL-matching Routing Rule, but the tab's container is always whatever that Space's Space Default Container is. There's no way to pin a specific domain to a specific container independent of which Space it routes to. Worse, when a rule fires, it **overwrites** any Explicit Container the navigation already carried (verified in `tabbrowser.js`: when a route is found, `userContextId` is unconditionally replaced with `targetWorkspace.containerTabId`) — so even Explicit Container assignments aren't reliable once routing is involved, and typed URLs never carry an Explicit Container in the first place. The result: a domain like `youtube.com` can land in different containers depending on whether you typed it, clicked a bookmark, or clicked a link.

## Goal

Let a Routing Rule optionally specify a Rule Container. When set, every navigation matching that rule — typed, clicked, or bookmarked — lands in the same Space *and* the same container, consistently.

## Non-goals

- No changes to rule matching syntax (`contains` / `equal-to` / `regex`) or to which rule wins when multiple rules match the same URL.
- No UI for creating/editing containers themselves — that stays in Settings → General → Container Tabs, as today.
- No changes to behavior for rules that don't set a Rule Container — they keep exactly today's behavior (Space Default Container).

## Behavior spec

### Resolution order, when a rule matches

1. **Rule Container**, if the rule has one set and it still exists.
2. **Space Default Container** of the rule's target Space, otherwise (rule has no container set, or its container was deleted).

This applies even if the navigation already carried an Explicit Container (e.g. a bookmark's own "Open Link in Container" setting) — seeAdr 0001. If no rule matches, behavior is entirely unchanged (Explicit Container, then Space default, then most-recent-space fallback).

### Worked example

A rule: `youtube.com` (contains) → Personal Space, Gaming container.

- Typing `youtube.com` in the address bar → Personal Space, Gaming container.
- Clicking a bookmark for `youtube.com` that has its own Explicit Container set to "Work" → still Personal Space, Gaming container (rule wins).
- Clicking a `youtube.com` link from another app → Personal Space, Gaming container (external links already route the same way internally).

### Missing container fallback

If the Rule Container no longer exists (deleted via Settings → Container Tabs), treat the rule as if it had no Rule Container set: route to the target Space using that Space's Space Default Container. No error, no toast — fails soft.

## UI spec

Extends the existing Space Routing Settings dialog (opened via a Space's three-dot menu). Each rule already has a URL-match row and an "open in" Space row. The container picker is its **own** row directly below "open in" (cramming it onto the same row overflowed the dialog's fixed 510px width and wrapped "open in" onto two lines). It still reads as one aligned control group with the Space dropdown above it:

- The row reuses the `sr-rule-bottom` class, giving it the exact same left offset as the "open in" row.
- It starts with an invisible clone of the "open in" row's icon+label element (same markup, `visibility: hidden`), so the container dropdown's left edge lines up under the Space dropdown's left edge by construction, not a guessed margin value.
- The menulist reuses the `open-in-select` width class, so both dropdowns are the same size.
- Both are plain `<menulist class="select">` elements, so they get the identical native dropdown arrow automatically.

A leading "Space Default" sentinel option is selected when the rule has no Rule Container set; picking a real container writes it to the rule, picking "Space Default" clears it back to `null`.

Container menu items show the container's real icon and color using the same mechanism Zen's own "open in" dropdown already uses in this exact dialog: `class="menuitem-iconic"` plus an `image` attribute pointing at `resource://usercontext-content/<icon>.svg` — not Firefox's separate `identity-icon-*`/`usercontext.css` convention, which doesn't get mirrored onto a `<menulist>`'s own closed/collapsed display automatically. Because of that, the closed menulist's `image` is also re-applied explicitly whenever the selection changes, not left to any implicit menuitem→menulist syncing.

The existing `menulist[image]::part(icon) { fill: currentColor; }` rule ties the icon's color to the *whole element's* `color`, which would also retint the label text and dropdown arrow — they need to stay the dialog's standard color, same as the Space dropdown. So the color is instead driven through a scoped `--zsr-icon-color` custom property and a small rule injected once per dialog, which only affects the icon: `.zsr-container-icon[image]::part(icon) { fill: var(--zsr-icon-color, currentColor); }`. This is a XUL/XHTML window, so the rule has to be injected as a `<link rel="stylesheet" href="data:text/css,...">` inside the existing `<linkset>` — the dialog's real stylesheets all load that way, and a plain `<style>` element dropped into the tree turned out to be inert here (not parsed as a stylesheet at all), which is why the icon color silently stopped applying on the first attempt.

No inline container creation — pick from existing containers only, same as the Space-container assignment UI already does.

## Data model change

Add `containerTabId: null` to the route object shape (alongside existing `id`, `reference`, `matchType`, `openIn` in `zen-space-routing.jsonlz4`). `null` means "use Space Default" (today's behavior); a number is a `userContextId` to use directly. Existing rules without the field behave as `null` automatically (no migration needed — `JSONFile`'s `dataPostProcessor` and `structuredClone` round-trip plain objects, so an absent field just reads as `undefined`, which we treat the same as `null`).

## Technical approach

Verified against the actual `zen-browser/desktop` source (cloned and inspected for this spec).

**Delivery**: a privileged userChrome JS script loaded via Sine (see ADR 0002), not a CSS-only Zen Mod. Sine works on any Firefox-based browser, supports local/unpublished mods, and gives the script genuine chrome-privileged JS, which this feature requires.

**Why monkey-patching works here**: both `gZenSpaceRoutingManager` (`resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs`) and `nsZenSpaceRoutingDialog` (`resource:///modules/zen/spacerouting/ZenSpaceRoutingDialog.mjs`) are loaded via `ChromeUtils.importESModule`, which caches modules as singletons by URL. Importing the same resource URL from our script gives us the exact same class/instance Zen's own code uses — including inside the Space Routing dialog's popup window, which imports the same module URL in its inline `<script>`. Patching once at our script's load time (before any dialog is opened) is enough; no per-window/per-dialog-instance patching needed. All methods we need to touch are public (no `#` private fields), so this doesn't require reaching into private state.

**Patch points**:

1. `gZenSpaceRoutingManager.onBeforeAddTab` — wrap it: call the original to get its result, and if `isRouteFound` is true, independently re-find the matching route (via the already-public `getAllRoutes()` + `isRouteMatching()`) to read its `containerTabId`. If set and `ContextualIdentityService` confirms it still exists, override `result.userContextId` with it; otherwise leave the original Space-default result untouched.

   This alone is **not sufficient** — see patch 2.

2. `gBrowser.addTab` (per window, not an ESM singleton like the others — patched on each window's own `gBrowser` instance as that window loads). `tabbrowser.js`'s `addTab()` only consults `onBeforeAddTab`'s resolved container when the caller already passed a `userContextId`:
   ```js
   if (beforeRouteResult.isRouteFound && typeof userContextId !== "undefined") {
     userContextId = beforeRouteResult.userContextId;
   } else if (typeof gZenWorkspaces !== "undefined" ...) {
     [userContextId, ...] = gZenWorkspaces.getContextIdIfNeeded(userContextId, fromExternal, triggeringPrincipal);
   }
   ```
   Most routed navigations — typed URLs, plain link clicks — reach `addTab()` with **no** `userContextId` at all (e.g. `ZenSpaceRoutingNavigation` pulls an in-place typed-URL navigation out into `gBrowser.addTab(url, { triggeringPrincipal, ownerTab })`, nothing else). That falls into the `else if` branch, which calls `getContextIdIfNeeded()` — a function that doesn't know about routing at all and just returns whichever container the *currently active* Space already has. Patch 1's result is silently ignored for this, the most common, case.

   The fix: wrap `gBrowser.addTab` itself to pre-fill `options.userContextId` from the matching rule's container *before* calling the original, whenever the caller didn't already specify one (and the tab isn't pinned/grouped/mid-session-restore). That's enough to flip the original code into the branch that reads `beforeRouteResult.userContextId` — which patch 1 has already made correct.

3. `gZenSpaceRoutingManager.getEmptyRoute` — wrap it to add `containerTabId: null` to the returned object, so new rules get the field.
4. `nsZenSpaceRoutingDialog.prototype.createRouteElement` — wrap it: call the original (builds the existing two rows), then append the container `menulist` described in the UI spec, wire its `command` event to read/write `route.containerTabId` via the existing public `gZenSpaceRoutingManager.getRoute()` / `updateRoute()`.

No patch needed to rule matching/ordering, or to storage — `JSONFile` persists whatever shape the route objects have.

## Open risks

- This relies on undocumented Zen internals (`ZenSpaceRoutingManager.sys.mjs`, `ZenSpaceRoutingDialog.mjs`). A future Zen release could rename/restructure either file and silently break the patch. Since it's a local, unpublished script, breakage just means the mod stops working until updated — not a security or data-loss risk.
- `ContextualIdentityService`'s exact lookup method for "does this userContextId still exist" should be confirmed against the running Firefox version at implementation time rather than assumed from this spec.
- The `resource://usercontext-content/<icon>.svg` paths and `--identity-color-*` hex values are verified against Firefox/Gecko's source, not against a running Zen instance — visually confirm the icon colors match Zen's own container colors exactly.
