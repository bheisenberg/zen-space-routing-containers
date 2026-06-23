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

// Adds a container picker row to each rule in the Space Routing Settings
// dialog, below the existing URL-match and "open in" rows.
function patchSettingsDialog() {
  const originalCreateRouteElement =
    nsZenSpaceRoutingDialog.prototype.createRouteElement;

  nsZenSpaceRoutingDialog.prototype.createRouteElement = function (route) {
    const root = originalCreateRouteElement.call(this, route);
    addContainerRow(this.doc, root, route);
    return root;
  };
}

function addContainerRow(doc, root, route) {
  const containerRow = doc.createXULElement("hbox");
  containerRow.className = "sr-rule-row sr-rule-container-row";

  const labelContainer = doc.createXULElement("hbox");
  labelContainer.className = "sr-label-container";

  const label = doc.createXULElement("label");
  label.className = "sr-label";
  label.setAttribute("value", "Container");
  labelContainer.append(label);

  const containerMenulist = doc.createXULElement("menulist");
  containerMenulist.className = "select container-select";

  const containerMenupopup = doc.createXULElement("menupopup");
  containerMenulist.appendChild(containerMenupopup);

  populateContainerList(doc, containerMenupopup);
  containerMenulist.value =
    typeof route.containerTabId === "number"
      ? String(route.containerTabId)
      : SPACE_DEFAULT_SENTINEL;

  containerRow.append(labelContainer, containerMenulist);
  root.append(containerRow);

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
