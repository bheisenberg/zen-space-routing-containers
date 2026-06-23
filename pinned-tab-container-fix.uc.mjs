// One-time, opt-in cleanup: resets pinned tabs whose container doesn't
// match their own Space's Space Default Container. This is a temporary
// utility riding along on the same Sine-loaded mod, not part of its
// ongoing behavior - safe to delete this file and its entry in theme.json
// (and run `extensions.zsr-space-routing.run-pinned-tab-fix` cleanup below)
// once you've used it.
//
// Triggered via about:config instead of the Browser Console: create these
// two prefs there (the "+" control next to the search box lets you add a
// Boolean pref that doesn't exist yet), then flip the trigger one to true.
// It resets the trigger back to false once the run finishes. Results are
// printed with console.log - viewable in the Browser Console's *output*
// pane, which doesn't require typing anything into it.
//
//   extensions.zsr-space-routing.dry-run            (Boolean, default true if unset)
//   extensions.zsr-space-routing.run-pinned-tab-fix (Boolean, create it, set true to run)

const { gZenSpaceRoutingManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs"
);

const DRY_RUN_PREF = "extensions.zsr-space-routing.dry-run";
const TRIGGER_PREF = "extensions.zsr-space-routing.run-pinned-tab-fix";

if (!gZenSpaceRoutingManager.__zsrPinnedTabFixObserverInstalled) {
  gZenSpaceRoutingManager.__zsrPinnedTabFixObserverInstalled = true;

  Services.prefs.addObserver(TRIGGER_PREF, () => {
    if (!Services.prefs.getBoolPref(TRIGGER_PREF, false)) {
      return;
    }
    try {
      runFix();
    } finally {
      Services.prefs.setBoolPref(TRIGGER_PREF, false);
    }
  });

  console.log(
    `[zsr-pinned-tab-fix] Ready. In about:config, create/set "${TRIGGER_PREF}" to true to run (check "${DRY_RUN_PREF}", default true, first).`
  );
}

function runFix() {
  const dryRun = Services.prefs.getBoolPref(DRY_RUN_PREF, true);
  const results = { fixed: [], skipped: [], errors: [] };

  const windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    const gBrowser = win.gBrowser;
    const gZenWorkspaces = win.gZenWorkspaces;
    if (!gBrowser || !gZenWorkspaces) {
      continue;
    }

    const pinnedTabs = gBrowser.tabs.filter(
      (t) => t.pinned && !t.hasAttribute("zen-empty-tab")
    );

    for (const tab of pinnedTabs) {
      const url = tab.linkedBrowser?.currentURI?.spec ?? "(unknown url)";

      try {
        const workspaceId = tab.getAttribute("zen-workspace-id");
        if (!workspaceId) {
          results.skipped.push({ url, reason: "no zen-workspace-id" });
          continue;
        }

        const workspace = gZenWorkspaces.getWorkspaceFromId(workspaceId);
        if (!workspace) {
          results.skipped.push({ url, reason: "workspace not found" });
          continue;
        }

        const targetContainerId = workspace.containerTabId || 0;
        const currentContainerId = parseInt(
          tab.getAttribute("usercontextid") || "0",
          10
        );

        if (targetContainerId === currentContainerId) {
          continue;
        }

        const entry = {
          url,
          space: workspace.name,
          from: currentContainerId,
          to: targetContainerId,
        };

        if (dryRun) {
          results.fixed.push({ ...entry, dryRun: true });
          continue;
        }

        const essential = tab.hasAttribute("zen-essential");
        const index = tab._tPos;

        gBrowser.addTrustedTab(url, {
          pinned: true,
          essential,
          userContextId: targetContainerId,
          zenWorkspaceId: workspaceId,
          tabIndex: index,
          skipAnimation: true,
        });

        gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });

        results.fixed.push(entry);
      } catch (e) {
        results.errors.push({ url, error: String(e) });
      }
    }
  }

  console.log(
    `[zsr-pinned-tab-fix] ${dryRun ? "DRY RUN - " : ""}fixed:`,
    results.fixed
  );
  console.log("[zsr-pinned-tab-fix] skipped:", results.skipped);
  console.log("[zsr-pinned-tab-fix] errors:", results.errors);
}
