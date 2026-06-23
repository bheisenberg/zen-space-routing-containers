# Zen Space Routing Containers

A local-only Zen Browser mod that extends Zen's native Space Routing feature so a routing rule can pin matched tabs to a specific container, not just whatever container the destination Space defaults to.

## Language

**Space**:
Zen Browser's term for a focused grouping of tabs (shown in the sidebar; Zen's own UI sometimes calls this "Workspace"). We standardize on "Space" since the feature we're extending is literally named "Space Routing."
_Avoid_: Workspace

**Routing Rule**:
A native Zen Space Routing entry that matches a URL pattern and assigns matching tabs to a target Space. Configured via a Space's three-dot menu → "Space Routing Settings."
_Avoid_: route, redirect

**Space Default Container**:
The container configured (via Settings → Tab Management → Workspaces, or Settings → General → Container Tabs) as the default for a given Space. Applies to a tab opened in that Space when nothing more specific overrides it.
_Avoid_: workspace container, default container

**Explicit Container**:
A container choice that already belongs to the tab or navigation itself, independent of any Space — a pinned tab's own container, a link/bookmark/context-menu action (e.g. "Open Link in Container → X"), etc. Always wins over routing (see Rule Container). Link/bookmark-level Explicit Containers only take effect when navigating via that specific link/bookmark/action — they don't apply to typed URLs or other generic navigation.
_Avoid_: forced container

**Rule Container**:
A container specified directly on a Routing Rule (this mod's contribution to the Routing Rule). When the rule matches and nothing already gave the tab an Explicit Container, the Rule Container is applied instead of the Space Default Container. An Explicit Container always wins over the Rule Container (see ADR 0003 — reversed from the original ADR 0001 after it was found to override pinned tabs' own containers). A rule with no Rule Container set falls back to today's existing behavior.
_Avoid_: rule's default container, override container
