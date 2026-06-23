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

Extends the existing Space Routing Settings dialog (opened via a Space's three-dot menu). Each rule row currently has a URL match row and an "open in" Space row. Add a third control to the "open in" row: a container `menulist` populated from `ContextualIdentityService.getPublicIdentities()` (name + icon), with a leading "Space Default" sentinel option selected when the rule has no Rule Container set. Selecting a container writes it to the rule; selecting "Space Default" clears it back to the sentinel (`null`).

No inline container creation — pick from existing containers only, same as the Space-container assignment UI already does.

## Data model change

Add `containerTabId: null` to the route object shape (alongside existing `id`, `reference`, `matchType`, `openIn` in `zen-space-routing.jsonlz4`). `null` means "use Space Default" (today's behavior); a number is a `userContextId` to use directly. Existing rules without the field behave as `null` automatically (no migration needed — `JSONFile`'s `dataPostProcessor` and `structuredClone` round-trip plain objects, so an absent field just reads as `undefined`, which we treat the same as `null`).

## Technical approach

Verified against the actual `zen-browser/desktop` source (cloned and inspected for this spec).

**Delivery**: a privileged userChrome JS script loaded via Sine (see ADR 0002), not a CSS-only Zen Mod. Sine works on any Firefox-based browser, supports local/unpublished mods, and gives the script genuine chrome-privileged JS, which this feature requires.

**Why monkey-patching works here**: both `gZenSpaceRoutingManager` (`resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs`) and `nsZenSpaceRoutingDialog` (`resource:///modules/zen/spacerouting/ZenSpaceRoutingDialog.mjs`) are loaded via `ChromeUtils.importESModule`, which caches modules as singletons by URL. Importing the same resource URL from our script gives us the exact same class/instance Zen's own code uses — including inside the Space Routing dialog's popup window, which imports the same module URL in its inline `<script>`. Patching once at our script's load time (before any dialog is opened) is enough; no per-window/per-dialog-instance patching needed. All methods we need to touch are public (no `#` private fields), so this doesn't require reaching into private state.

**Patch points**:

1. `gZenSpaceRoutingManager.onBeforeAddTab` — wrap it: call the original to get its result, and if `isRouteFound` is true, independently re-find the matching route (via the already-public `getAllRoutes()` + `isRouteMatching()`) to read its `containerTabId`. If set and `ContextualIdentityService` confirms it still exists, override `result.userContextId` with it; otherwise leave the original Space-default result untouched.
2. `gZenSpaceRoutingManager.getEmptyRoute` — wrap it to add `containerTabId: null` to the returned object, so new rules get the field.
3. `nsZenSpaceRoutingDialog.prototype.createRouteElement` — wrap it: call the original (builds the existing two rows), then append the container `menulist` described in the UI spec, wire its `command` event to read/write `route.containerTabId` via the existing public `gZenSpaceRoutingManager.getRoute()` / `updateRoute()`.

No patch needed to `tabbrowser.js` itself, to rule matching/ordering, or to storage — `JSONFile` persists whatever shape the route objects have.

## Open risks

- This relies on undocumented Zen internals (`ZenSpaceRoutingManager.sys.mjs`, `ZenSpaceRoutingDialog.mjs`). A future Zen release could rename/restructure either file and silently break the patch. Since it's a local, unpublished script, breakage just means the mod stops working until updated — not a security or data-loss risk.
- `ContextualIdentityService`'s exact lookup method for "does this userContextId still exist" should be confirmed against the running Firefox version at implementation time rather than assumed from this spec.
