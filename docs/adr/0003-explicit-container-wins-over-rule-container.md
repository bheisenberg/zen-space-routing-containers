---
status: accepted
---

# Explicit Container wins over Rule Container (supersedes ADR 0001)

ADR 0001 made the Rule Container win over everything, including an Explicit Container. In practice this broke pinned tabs: a pinned tab's container is itself an explicit choice, and overriding it whenever its URL happened to match a routing rule with a container set was a real, observed bug, not a theoretical edge case. We reversed the precedence: a tab/navigation's own explicit container choice (pinned tabs, bookmarks, "Open Link in Container", etc.) now wins over both the Rule Container and the Space Default Container. The Rule Container only fills in when nothing else has already decided. The Space move (which Space a routed tab lands in) is unaffected either way — only which container it lands in changes.
