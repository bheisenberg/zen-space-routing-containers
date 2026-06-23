// Adds a per-rule container override to Zen's native Space Routing.
// See SPEC.md for the full behavior spec, and docs/adr/ for the
// precedence (0001) and delivery-mechanism (0002) decisions this follows.

const { gZenSpaceRoutingManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs"
);
const { nsZenSpaceRoutingDialog } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingDialog.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "resource://gre/modules/ContextualIdentityService.sys.mjs"
);

const SPACE_DEFAULT_SENTINEL = "space-default";

// Both modules above are cached ESM singletons shared by every chrome
// window in the process, including the Space Routing dialog popup, which
// imports the same module URLs. Patching once here is enough; later
// imports of this script (e.g. when a new window loads it) must not
// re-wrap an already-wrapped method, so the guard lives on the shared
// instance rather than in module-local state.
if (!gZenSpaceRoutingManager.__spaceRoutingContainersPatched) {
  gZenSpaceRoutingManager.__spaceRoutingContainersPatched = true;

  patchContainerResolution();
  patchEmptyRouteShape();
  patchSettingsDialog();
}

// gBrowser is one instance per window (not an ESM singleton), so this patch
// is applied per-window instead, guarded on the instance itself. This
// script is loaded into every chrome window, so it runs once per window as
// each one is created.
if (typeof window !== "undefined") {
  if (window.gBrowser) {
    patchAddTabForWindow(window);
  } else {
    window.addEventListener("load", () => patchAddTabForWindow(window), {
      once: true,
    });
  }
}

function containerStillExists(userContextId) {
  try {
    return !!ContextualIdentityService.getPublicIdentityFromId(userContextId);
  } catch {
    return false;
  }
}

function findMatchingRoute(uriString) {
  for (const route of gZenSpaceRoutingManager.getAllRoutes()) {
    if (gZenSpaceRoutingManager.isRouteMatching(uriString, route)) {
      return route;
    }
  }
  return null;
}

// ADR 0001: the Rule Container, when set and still valid, wins over both
// the Space Default Container and any Explicit Container the navigation
// already carried. A missing/deleted Rule Container falls back to
// whatever the original logic already resolved (the Space default).
function patchContainerResolution() {
  const originalOnBeforeAddTab =
    gZenSpaceRoutingManager.onBeforeAddTab.bind(gZenSpaceRoutingManager);

  gZenSpaceRoutingManager.onBeforeAddTab = function (uriString, options, win) {
    const result = originalOnBeforeAddTab(uriString, options, win);

    if (result.isRouteFound) {
      const route = findMatchingRoute(uriString);
      const ruleContainerId = route?.containerTabId;

      if (
        typeof ruleContainerId === "number" &&
        containerStillExists(ruleContainerId)
      ) {
        result.userContextId = ruleContainerId;
      }
    }

    return result;
  };
}

// Most navigations that should be routed (typed URLs, link clicks without
// an explicit container, ...) reach addTab() with NO userContextId at all -
// e.g. ZenSpaceRoutingNavigation pulls an in-place typed-URL navigation out
// into `gBrowser.addTab(url, { triggeringPrincipal, ownerTab })`, nothing
// else. tabbrowser.js's addTab() only consults onBeforeAddTab's resolved
// container when the caller already passed a userContextId; otherwise it
// calls gZenWorkspaces.getContextIdIfNeeded(), which knows nothing about
// routing and just returns the *currently active* Space's container. So
// patchContainerResolution alone never fires for this, the most common,
// case. Pre-filling userContextId here - before the original addTab runs -
// is what flips tabbrowser.js into the branch that actually reads
// onBeforeAddTab's result.
function patchAddTabForWindow(win) {
  const gBrowser = win.gBrowser;
  if (!gBrowser || gBrowser.__spaceRoutingContainersAddTabPatched) {
    return;
  }
  gBrowser.__spaceRoutingContainersAddTabPatched = true;

  const originalAddTab = gBrowser.addTab.bind(gBrowser);

  gBrowser.addTab = function (uriString, options = {}) {
    if (
      typeof uriString === "string" &&
      typeof options.userContextId === "undefined" &&
      !options.skipRoute &&
      !options.pinned &&
      !options.tabGroup &&
      (!win.gZenStartup || win.gZenStartup.isReady)
    ) {
      const route = findMatchingRoute(uriString);
      const ruleContainerId = route?.containerTabId;

      if (
        typeof ruleContainerId === "number" &&
        containerStillExists(ruleContainerId)
      ) {
        options = { ...options, userContextId: ruleContainerId };
      }
    }

    return originalAddTab(uriString, options);
  };
}

// New rules get a containerTabId field. null means "use Space Default",
// which is what every pre-existing rule (without the field at all) is
// also treated as by patchContainerResolution above.
function patchEmptyRouteShape() {
  const originalGetEmptyRoute =
    gZenSpaceRoutingManager.getEmptyRoute.bind(gZenSpaceRoutingManager);

  gZenSpaceRoutingManager.getEmptyRoute = function () {
    const route = originalGetEmptyRoute();
    route.containerTabId = null;
    return route;
  };
}

// Container picker lives on the *same* row as the existing "open in" Space
// dropdown, right after it - not a separate labeled row. Both are plain
// <menulist class="select"> elements, so they share the exact same native
// arrow/widget styling automatically; putting them on one row also means
// they're vertically aligned for free via .sr-rule-row's flex layout.
function patchSettingsDialog() {
  const originalCreateRouteElement =
    nsZenSpaceRoutingDialog.prototype.createRouteElement;

  nsZenSpaceRoutingDialog.prototype.createRouteElement = function (route) {
    const root = originalCreateRouteElement.call(this, route);
    ensureUserContextStylesheet(this.doc);
    addContainerPicker(this.doc, root, route);
    return root;
  };
}

// usercontext.css (the stylesheet that defines .identity-icon-* /
// .identity-color-* and makes [data-usercontextid] menuitems render their
// container icon) isn't one of the stylesheets the Space Routing dialog
// loads by default, so it has to be added explicitly.
function ensureUserContextStylesheet(doc) {
  const href = "chrome://browser/content/usercontext/usercontext.css";
  if (doc.querySelector(`link[href="${href}"]`)) {
    return;
  }
  const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", href);
  (doc.querySelector("linkset") ?? doc.documentElement).appendChild(link);
}

function addContainerPicker(doc, root, route) {
  const bottomRow = root.querySelector(".sr-rule-bottom");

  const containerMenulist = doc.createXULElement("menulist");
  containerMenulist.className = "select container-select";
  // .select defaults to 150px; narrower here so it fits next to
  // open-in-select (165px) within the dialog's fixed 510px width.
  containerMenulist.style.width = "120px";
  containerMenulist.setAttribute("tooltiptext", "Container override");

  const containerMenupopup = doc.createXULElement("menupopup");
  containerMenulist.appendChild(containerMenupopup);

  populateContainerList(doc, containerMenupopup);
  containerMenulist.value =
    typeof route.containerTabId === "number"
      ? String(route.containerTabId)
      : SPACE_DEFAULT_SENTINEL;

  bottomRow.append(containerMenulist);

  containerMenulist.addEventListener("command", (e) => {
    onContainerChange(e.target.value, route.id);
  });
}

function populateContainerList(doc, popupElement) {
  const defaultItem = doc.createXULElement("menuitem");
  defaultItem.setAttribute("label", "Space Default");
  defaultItem.setAttribute("value", SPACE_DEFAULT_SENTINEL);
  popupElement.appendChild(defaultItem);

  popupElement.appendChild(doc.createXULElement("menuseparator"));

  for (const identity of ContextualIdentityService.getPublicIdentities()) {
    const item = doc.createXULElement("menuitem");
    const label =
      ContextualIdentityService.getUserContextLabel(identity.userContextId) ||
      identity.name;
    item.setAttribute("label", label);
    item.setAttribute("value", String(identity.userContextId));
    // Firefox's own container-icon convention (same classes/attribute the
    // tab context menu and "Open New Container Tab" panel use): these two
    // classes set the --identity-icon / --identity-icon-color custom
    // properties that usercontext.css's [data-usercontextid] rule reads.
    item.setAttribute("data-usercontextid", String(identity.userContextId));
    item.classList.add(
      "menuitem-iconic",
      `identity-icon-${identity.icon}`,
      `identity-color-${identity.color}`
    );
    popupElement.appendChild(item);
  }
}

function onContainerChange(value, routeId) {
  const route = gZenSpaceRoutingManager.getRoute(routeId);
  if (!route) {
    return;
  }
  route.containerTabId =
    value === SPACE_DEFAULT_SENTINEL ? null : parseInt(value, 10);
  gZenSpaceRoutingManager.updateRoute(route);
}
