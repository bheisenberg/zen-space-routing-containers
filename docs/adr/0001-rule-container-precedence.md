---
status: superseded by ADR 0003
---

# Rule Container takes precedence over Explicit Container

Zen's native behavior lets an Explicit Container (set on a specific link/bookmark) override a Space's default container, but that signal is inconsistent — it doesn't apply to typed URLs or other generic navigation, so a domain like youtube.com can land in different containers depending on how it was opened. We decided a Routing Rule's container, when set, always wins — over both the Space Default Container and any Explicit Container — so that all navigation to a given domain (typed, clicked, bookmarked) lands in the same Space and container. Rules with no Rule Container set are unaffected and keep today's behavior.
