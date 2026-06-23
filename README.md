# Zen Space Routing Containers

A local Zen Browser mod that lets a Space Routing rule pin matched tabs to a specific container, instead of always falling back to the destination Space's default container. See [SPEC.md](./SPEC.md) for the full behavior spec and [CONTEXT.md](./CONTEXT.md) for terminology.

## Install

This ships as a [Sine](https://github.com/CosmoCreeper/Sine) mod, not a Zen Mod — Zen Mods are CSS-only and can't run the JS this needs (see [docs/adr/0002](./docs/adr/0002-delivery-via-js-loader-not-zen-mods.md)).

1. Install Sine itself (one-time native installer): https://github.com/sineorg/docs/blob/main/src/installation.md
2. In Zen, go to `about:config` and set `sine.allow-unsafe-js` to `true`. Sine only runs JS from non-store mods when this is enabled — required for any unpublished/private-repo mod, not specific to this one.
3. This repo is already pushed to https://github.com/bheisenberg/zen-space-routing-containers (private).
4. In Sine's settings page, install by repo: enter `bheisenberg/zen-space-routing-containers`.
5. Restart Zen.

## Use

Open a Space's three-dot menu → "Space Routing Settings". Each rule now has a "Container" dropdown below the existing URL match and "open in" Space controls. Leave it on "Space Default" for today's behavior, or pick a container to pin that rule's matches to it regardless of the Space's own default.

## Caveats

This monkey-patches undocumented Zen internals (`ZenSpaceRoutingManager.sys.mjs`, `ZenSpaceRoutingDialog.mjs`). A future Zen release could change either file enough to break this — see "Open risks" in SPEC.md.
