// One-time cleanup: reset every pinned tab's container to match its own
// Space's Space Default Container. Not loaded by Sine - this is a manual
// tool, not part of the mod. Run it once via Tools -> Browser Tools ->
// Browser Console (enable devtools.chrome.enabled in about:config first if
// the Browser Console option isn't visible), paste the whole thing, press
// Enter.
//
// Containers are fixed per-tab in Firefox and can't be changed on a live
// tab, so "fixing" a mismatched pinned tab means closing it and reopening a
// new pinned tab in the same spot with the correct container. The new tab
// loads fresh - any logged-in session tied to the *wrong* container is
// lost, which is the point.
//
// DRY_RUN defaults to true: it only logs what *would* change. Set it to
// false to actually apply the fix.
(async () => {
  const DRY_RUN = true;

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

        if (DRY_RUN) {
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
    `[fix-pinned-tab-containers] ${DRY_RUN ? "DRY RUN - " : ""}fixed:`,
    results.fixed
  );
  console.log("[fix-pinned-tab-containers] skipped:", results.skipped);
  console.log("[fix-pinned-tab-containers] errors:", results.errors);

  return results;
})();
