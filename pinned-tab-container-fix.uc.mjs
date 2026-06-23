// One-time cleanup: resets pinned tabs whose container doesn't match their
// own Space's Space Default Container. This is a temporary utility riding
// along on the same Sine-loaded mod, not part of its ongoing behavior -
// safe to delete this file and its entry in theme.json once you've used it.
//
// Neither the Browser Console's input line nor about:config's toggle
// control were cooperating, so this needs no typing and no config UI at
// all: press Ctrl+Alt+Shift+P anywhere in the browser window. It computes
// what would change across every pinned tab in every window, shows a
// native confirm dialog with the count and a short preview, and only
// applies anything if you click OK.

const KEY_COMBO = "p"; // with ctrl+alt+shift

if (typeof window !== "undefined" && !window.__zsrPinnedTabFixKeyInstalled) {
  window.__zsrPinnedTabFixKeyInstalled = true;

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.ctrlKey &&
        event.altKey &&
        event.shiftKey &&
        event.key.toLowerCase() === KEY_COMBO
      ) {
        event.preventDefault();
        runFix(window);
      }
    },
    true
  );

  console.log(
    "[zsr-pinned-tab-fix] Ready. Press Ctrl+Alt+Shift+P to check/fix pinned tab containers."
  );
}

function collectMismatches() {
  const mismatches = [];
  const errors = [];

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
          continue;
        }

        const workspace = gZenWorkspaces.getWorkspaceFromId(workspaceId);
        if (!workspace) {
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

        mismatches.push({
          tab,
          gBrowser,
          url,
          space: workspace.name,
          workspaceId,
          from: currentContainerId,
          to: targetContainerId,
          essential: tab.hasAttribute("zen-essential"),
          index: tab._tPos,
        });
      } catch (e) {
        errors.push({ url, error: String(e) });
      }
    }
  }

  return { mismatches, errors };
}

function runFix(promptWindow) {
  const { mismatches, errors } = collectMismatches();

  console.log(
    `[zsr-pinned-tab-fix] Found ${mismatches.length} pinned tab(s) to fix:`,
    mismatches.map(({ url, space, from, to }) => ({ url, space, from, to }))
  );
  if (errors.length) {
    console.log("[zsr-pinned-tab-fix] errors while scanning:", errors);
  }

  if (mismatches.length === 0) {
    Services.prompt.alert(
      promptWindow,
      "Pinned Tab Container Fix",
      "All pinned tabs already match their Space's default container. Nothing to do."
    );
    return;
  }

  const preview = mismatches
    .slice(0, 10)
    .map((m) => `• ${m.url}  (container ${m.from} → ${m.to}, ${m.space})`)
    .join("\n");
  const more =
    mismatches.length > 10 ? `\n...and ${mismatches.length - 10} more` : "";

  const proceed = Services.prompt.confirm(
    promptWindow,
    "Pinned Tab Container Fix",
    `${mismatches.length} pinned tab(s) don't match their Space's default container:\n\n${preview}${more}\n\n` +
      `Apply now? Each one will close and reopen pinned in the same spot with the correct container - any session tied to its current (wrong) container will be lost.`
  );

  if (!proceed) {
    console.log("[zsr-pinned-tab-fix] Cancelled - no changes made.");
    return;
  }

  const applied = [];
  const failed = [];

  for (const m of mismatches) {
    try {
      m.gBrowser.addTrustedTab(m.url, {
        pinned: true,
        essential: m.essential,
        userContextId: m.to,
        zenWorkspaceId: m.workspaceId,
        tabIndex: m.index,
        skipAnimation: true,
      });
      m.gBrowser.removeTab(m.tab, { animate: false, skipPermitUnload: true });
      applied.push(m);
    } catch (e) {
      failed.push({ url: m.url, error: String(e) });
    }
  }

  console.log(
    `[zsr-pinned-tab-fix] Applied ${applied.length} fix(es).`,
    applied.map(({ url, space, from, to }) => ({ url, space, from, to }))
  );
  if (failed.length) {
    console.log("[zsr-pinned-tab-fix] failed:", failed);
  }

  Services.prompt.alert(
    promptWindow,
    "Pinned Tab Container Fix",
    `Done. Fixed ${applied.length} pinned tab(s)${failed.length ? `, ${failed.length} failed (see Browser Console)` : ""}.`
  );
}
