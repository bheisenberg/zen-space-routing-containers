---
status: accepted
---

# Deliver as a privileged userChrome.js script, not a Zen Mod

We initially planned to ship this as a local/unpublished Zen Mod. Inspecting the actual `zen-browser/desktop` source (`src/zen/mods/ZenMods.mjs`) showed Zen Mods are CSS-only: a mod is a `chrome.css` file plus a declarative `preferences.json`, with no JS execution path. This feature requires monkey-patching `gZenSpaceRoutingManager` (container resolution logic) and `nsZenSpaceRoutingDialog` (settings UI), which is only possible with privileged JS running in browser chrome. We're switching delivery to a userChrome.js-style loader (e.g. fx-autoconfig or Sine) instead, while keeping the mod local/unpublished as originally intended.
