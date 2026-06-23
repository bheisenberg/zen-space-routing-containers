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

// Firefox's own container icon/color resources (the same ones the tab
// context menu and "Open New Container Tab" panel use).
const IDENTITY_COLORS = {
  blue: "#37adff",
  turquoise: "#00c79a",
  green: "#51cd00",
  yellow: "#ffcb00",
  orange: "#ff9f00",
  red: "#ff613d",
  pink: "#ff4bda",
  purple: "#af51f5",
  toolbar: "currentColor",
};

function containerIconUrl(icon) {
  return `resource://usercontext-content/${icon}.svg`;
}

// The container picker gets its own row, directly below "open in" - cramming
// it onto the same row overflowed the dialog's fixed 510px width and wrapped
// "open in" onto two lines. To still line up under the Space dropdown (not
// under its icon+label), the row starts with an invisible clone of that
// icon+label: same markup/classes, so the widths match exactly by
// construction instead of a guessed margin. Reusing "sr-rule-bottom" for the
// row's own class gives it the identical 87px offset for free, and reusing
// "open-in-select" for the menulist's width keeps both dropdowns the same
// size, so the two rows read as one aligned control group.
function patchSettingsDialog() {
  const originalCreateRouteElement =
    nsZenSpaceRoutingDialog.prototype.createRouteElement;

  nsZenSpaceRoutingDialog.prototype.createRouteElement = function (route) {
    const root = originalCreateRouteElement.call(this, route);
    addContainerPicker(this.doc, root, route);
    return root;
  };
}

function addContainerPicker(doc, root, route) {
  const spaceLabelContainer = root.querySelector(
    ".sr-rule-bottom .sr-label-container"
  );

  const containerRow = doc.createXULElement("hbox");
  containerRow.className = "sr-rule-row sr-rule-bottom sr-rule-container-row";

  const spacer = spaceLabelContainer.cloneNode(true);
  spacer.style.visibility = "hidden";

  const containerMenulist = doc.createXULElement("menulist");
  containerMenulist.className = "select open-in-select container-select";
  containerMenulist.setAttribute("tooltiptext", "Container override");

  const containerMenupopup = doc.createXULElement("menupopup");
  containerMenulist.appendChild(containerMenupopup);

  populateContainerList(doc, containerMenupopup);
  setSelectedContainer(
    containerMenulist,
    typeof route.containerTabId === "number"
      ? String(route.containerTabId)
      : SPACE_DEFAULT_SENTINEL
  );

  containerRow.append(spacer, containerMenulist);
  root.append(containerRow);

  containerMenulist.addEventListener("command", (e) => {
    setSelectedContainer(e.target, e.target.value);
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
    item.setAttribute("class", "menuitem-iconic");
    item.setAttribute("image", containerIconUrl(identity.icon));
    item.style.color = IDENTITY_COLORS[identity.color] || "currentColor";
    popupElement.appendChild(item);
  }
}

// <menulist> doesn't automatically mirror a class-driven icon from its
// selected <menuitem> onto its own closed/collapsed display - Zen's own
// "open in" dropdown works around this the same way: by setting the `image`
// attribute (and here, color) directly on the <menulist> itself. The
// existing `menulist[image]::part(icon) { fill: currentColor; ... }` rule
// in zen-space-routing.css then renders it, picking up our inline color.
function setSelectedContainer(menulist, value) {
  menulist.value = value;

  if (value === SPACE_DEFAULT_SENTINEL) {
    menulist.removeAttribute("image");
    menulist.style.color = "";
    return;
  }

  let identity;
  try {
    identity = ContextualIdentityService.getPublicIdentityFromId(
      parseInt(value, 10)
    );
  } catch {
    identity = null;
  }
  if (!identity) {
    menulist.removeAttribute("image");
    menulist.style.color = "";
    return;
  }

  menulist.setAttribute("image", containerIconUrl(identity.icon));
  menulist.style.color = IDENTITY_COLORS[identity.color] || "currentColor";
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
