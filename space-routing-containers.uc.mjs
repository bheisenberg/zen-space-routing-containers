// Adds a per-rule container override to Zen's native Space Routing.
// See SPEC.md for the full behavior spec, and docs/adr/ for the precedence
// (0001, superseded by 0003) and delivery-mechanism (0002) decisions this
// follows.

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

// ADR 0003 (supersedes ADR 0001): if the tab/navigation already has its own
// container - pinned tabs being the case that surfaced the bug, but this
// covers any explicit choice (bookmarks, "Open Link in Container", etc.) -
// that wins, full stop. The Rule Container only fills in when nothing else
// already decided. onBeforeAddTab itself has no visibility into whether the
// caller passed an explicit userContextId (tabbrowser.js doesn't forward it
// into the options object it builds), so patchAddTabForWindow stashes that
// fact here for the synchronous duration of the addTab() call it triggers.
function patchContainerResolution() {
  const originalOnBeforeAddTab =
    gZenSpaceRoutingManager.onBeforeAddTab.bind(gZenSpaceRoutingManager);

  gZenSpaceRoutingManager.onBeforeAddTab = function (uriString, options, win) {
    const result = originalOnBeforeAddTab(uriString, options, win);

    if (!result.isRouteFound) {
      return result;
    }

    if (gZenSpaceRoutingManager.__zsrHasExplicitContainer) {
      // tabbrowser.js only overwrites userContextId with this result's
      // value when isRouteFound is true, so clearing it here is what makes
      // the tab's own container choice stick instead. targetRoute (read
      // separately by onAfterAddTab) is untouched, so the tab still moves
      // to the rule's target Space - only the container is left alone.
      result.isRouteFound = false;
      return result;
    }

    const route = findMatchingRoute(uriString);
    const ruleContainerId = route?.containerTabId;

    if (
      typeof ruleContainerId === "number" &&
      containerStillExists(ruleContainerId)
    ) {
      result.userContextId = ruleContainerId;
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
    const hasExplicitContainer = typeof options.userContextId !== "undefined";

    if (
      !hasExplicitContainer &&
      typeof uriString === "string" &&
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

    // Handoff to patchContainerResolution's onBeforeAddTab wrapper, called
    // synchronously inside originalAddTab below - see ADR 0003.
    gZenSpaceRoutingManager.__zsrHasExplicitContainer = hasExplicitContainer;
    try {
      return originalAddTab(uriString, options);
    } finally {
      gZenSpaceRoutingManager.__zsrHasExplicitContainer = false;
    }
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

// Firefox's own container colors (same hex values as
// browser/components/contextualidentity/content/usercontext.css).
const IDENTITY_COLORS = {
  blue: "#37adff",
  turquoise: "#00c79a",
  green: "#51cd00",
  yellow: "#ffcb00",
  orange: "#ff9f00",
  red: "#ff613d",
  pink: "#ff4bda",
  purple: "#af51f5",
  toolbar: "#737373",
};

// Firefox's own container icon artwork (same files as
// browser/components/contextualidentity/content/<icon>.svg), with the
// `fill="context-fill"` placeholder each ships with so a privileged
// embedder can recolor them via -moz-context-properties. That mechanism
// turned out not to apply reliably inside this dialog (two attempts to
// drive it via CSS didn't take effect), so instead the real color is baked
// directly into the SVG text before it's ever used as an `image` - the
// icon is then just a plain, already-colored image, with no dependency on
// any CSS cascade behavior in this window at all.
const IDENTITY_ICON_SVGS = {
  fingerprint: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M7.17741905,12 C7.10965537,12 7.041327,11.9953181 6.97243393,11.985018 C6.33263187,11.8918489 5.90515601,11.3862071 6.01809547,10.8552833 C7.41798011,4.26321358 12.2613889,2.57493207 15.0238882,2.15590491 C19.6448063,1.45690206 24.3408291,3.21541158 25.8344535,5.29743816 C26.1664955,5.76047488 25.9835336,6.35881757 25.4244832,6.63364321 C24.8654329,6.9098734 24.1437497,6.75583996 23.8122724,6.29327142 C22.8923805,5.01043967 19.1749781,3.51130562 15.4479759,4.07406612 C12.8080159,4.474834 9.43056132,6.03623689 8.33561323,11.1942506 C8.23453242,11.666651 7.73816348,12 7.17741905,12 Z M16.63127,26 C16.1452186,26 15.6509104,25.9658335 15.147795,25.8938767 C10.637921,25.257137 6.71207921,21.8114952 6.01575422,17.8807924 C5.91171832,17.2932317 6.33391695,16.7382846 6.95813239,16.6404441 C7.58454965,16.5343208 8.17298555,16.9406954 8.27757192,17.5272206 C8.80876054,20.5255916 11.9766264,23.26409 15.4885263,23.7610576 C17.3975027,24.02766 20.959494,23.8221432 23.3220449,19.3789425 C24.4625867,17.2331815 23.0049831,11.881462 19.9521622,9.34692739 C18.2380468,7.92384005 16.4573263,7.76905536 14.6628445,8.89499751 C13.26469,9.77142052 11.8070864,12.2857658 11.8665355,14.6287608 C11.9127737,16.4835887 12.8386382,17.9325598 14.6171568,18.9363308 C15.2210054,19.2764429 16.9411759,19.4933486 17.9424527,18.8296898 C18.7257495,18.3104622 18.9591422,17.2761485 18.6365758,15.7583267 C18.3822659,14.5650869 17.2219077,12.4452096 16.6664991,12.3711821 C16.6692513,12.3722175 16.4666841,12.4312324 16.1276041,12.9095636 C15.8545786,13.2936782 15.58981,14.7297074 15.9476054,15.3581643 C16.0142104,15.4761941 16.0725586,15.5465978 16.3202632,15.5465978 C16.9532859,15.5465978 17.46686,16.0290705 17.46686,16.6249139 C17.46686,17.2207573 16.9543868,17.7042653 16.3213641,17.7042653 C15.2644914,17.7042653 14.4140391,17.2336992 13.9268868,16.3774655 C13.1083609,14.9388479 13.5536787,12.6548678 14.2202791,11.7137354 C15.2540327,10.2564816 16.3631986,10.1151564 17.1123672,10.2564816 C19.7066595,10.7389543 20.8763754,15.2908666 20.8857331,15.3359043 C21.5303153,18.3648181 20.3594985,19.8665919 19.264094,20.593407 C17.4151172,21.8192603 14.6920186,21.493643 13.4380832,20.7859819 C10.3280151,19.0310652 9.62013053,16.497566 9.5744428,14.6805283 C9.49022326,11.3643051 11.4779146,8.30018945 13.391845,7.10021984 C16.0417332,5.43848454 18.9877658,5.66781436 21.4714167,7.72919442 C25.1176276,10.7565552 27.0871539,17.1229168 25.3746898,20.3433702 C23.4326862,23.9950465 20.2983981,26 16.63127,26 Z M16.0845157,30 C14.9348455,30 13.9050564,29.8557557 13.0394288,29.6610017 C10.2114238,29.0257442 7.58700058,27.4599412 6.18892823,25.5735955 C5.84440518,25.1078371 5.98426642,24.4803503 6.50105099,24.1700066 C7.01675554,23.8596629 7.71552172,23.986423 8.06112477,24.4507244 C9.89498097,26.9252176 15.9397944,29.9781448 22.2508301,26.1937972 C22.7676147,25.8844249 23.4658409,26.0087566 23.8109039,26.474515 C24.155427,26.9397877 24.0161057,27.5672745 23.4993212,27.8776182 C20.7987573,29.4963593 18.2315746,30 16.0845157,30 Z"/></svg>`,
  briefcase: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" fill-rule="evenodd" d="M23.1,5.3c0-1.4-1.2-2.7-2.8-2.7h-8.7c-1.4,0-2.7,1.2-2.7,2.7v4.4H7.1v19.6h17.8V9.8h-1.8V5.3z M20.8,9.8H11V5.3c0-0.4,0.2-0.5,0.5-0.5h8.7c0.4,0,0.5,0.2,0.5,0.5V9.8z M1.8,9.8h2.7v19.6H1.8c-0.9,0-1.8-0.9-1.8-1.8v-16C0,10.5,0.9,9.8,1.8,9.8z M32,11.6v16c0,0.9-0.7,1.8-1.8,1.8h-2.7V9.8h2.7C31.3,9.8,32,10.5,32,11.6z"/></svg>`,
  dollar: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M16.2,0c-8.9,0-16,7.3-16,16c0,8.9,7.1,16,15.8,16s15.8-7.1,15.8-16C32,7.3,24.9,0,16.2,0z M17.1,25.1v1.6c0,0.4-0.4,0.5-0.7,0.5c-0.4,0-0.7-0.2-0.7-0.5v-1.6c-3.2-0.2-5-1.8-5.5-4.3c0-0.2,0-0.2,0-0.4c0-0.5,0.4-0.9,0.9-0.9c0.2,0,0.2,0,0.4,0c0.5,0,0.9,0.2,1.1,0.7c0.4,1.8,1.2,2.7,3.4,2.8v-6.8c-3.6-0.4-5.3-1.8-5.3-4.6c0-3,2.5-4.6,5.2-4.8V5.7c0-0.4,0.4-0.5,0.7-0.5c0.4,0,0.7,0.2,0.7,0.5v1.1c2.7,0.4,4.4,1.8,5,3.9c0,0.2,0,0.2,0,0.4c0,0.5-0.4,0.7-0.7,0.9c-0.2,0-0.2,0-0.4,0c-0.4,0-0.7-0.2-0.9-0.7c-0.4-1.4-1.2-2.3-3-2.5v6c3.2,0.7,5.5,1.8,5.5,5.2C22.8,23.5,20.1,25.1,17.1,25.1z M12.4,11.6c0,1.6,0.7,2.5,3.2,3V8.7C13.7,8.9,12.4,10,12.4,11.6z M17.1,16.9v6.4c2.3-0.2,3.6-1.2,3.6-3.2C20.6,17.8,19.2,17.2,17.1,16.9z"/></svg>`,
  cart: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" fill-rule="evenodd" d="M26.9,21.4H9.4c-0.7,0-1.3,0.5-1.3,1.3s0.5,1.3,1.3,1.3h17.5c0.7,0,1.3-0.5,1.3-1.3C28.5,21.9,27.8,21.4,26.9,21.4z M13.3,30.1c1.3,0,2.7-1.2,2.7-2.7c0-1.3-1.2-2.7-2.7-2.7s-2.7,1.2-2.7,2.7C10.6,29,12,30.1,13.3,30.1z M23.9,30.1c1.3,0,2.7-1.2,2.7-2.7c0-1.3-1.2-2.7-2.7-2.7c-1.5,0-2.7,1.2-2.7,2.7C21.4,29,22.6,30.1,23.9,30.1z M31.5,7.4L31.5,7.4H7.6V7.2L5.7,2.5C5.4,2.2,5.1,1.9,4.6,1.9H0.7C0,1.9,0,2.5,0,2.9C0,3.5-0.2,4,0.7,4.2h2.7l0.7,1.5l4,13.3c0,0.2,0.2,0.5,0.8,0.5h18.5c0.3,0,0.7-0.2,0.7-0.5L32,8.3C32,8.1,31.8,7.4,31.5,7.4z"/></svg>`,
  circle: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle fill="{{FILL}}" cx="16" cy="16" r="16"/></svg>`,
  vacation: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M3.6,27l-2.5-1.8L0.8,25c-0.7-0.4-0.7-1.2-0.4-2c0.4-0.5,1.1-0.7,1.6-0.5l3.6,1.2c0-0.4,0.2-0.9,0.4-1.4c0.2-0.7,0.5-1.6,1.1-2.3c0.2-0.4,0.5-0.7,0.7-1.2c0.2-0.4,0.5-0.9,0.9-1.2c0.4-0.9,1.1-1.6,1.8-2.5c0.7-0.9,1.4-1.6,2.3-2.5c0.4-0.4,0.9-0.7,1.2-1.2c0.4-0.2,0.9-0.7,1.2-1.1c0.2-0.2,0.2-0.2,0.4-0.4L3.1,7.3c-0.2,0-0.2,0-0.4,0l-2,0.9C0.2,8.3-0.3,7.6,0.2,7.1l2-2C2.4,5,2.4,5,2.5,5h17.9c0.5-0.5,1.2-1.1,1.8-1.6c0.7-0.7,1.4-1.2,2.1-1.8c0.4-0.4,0.7-0.5,1.1-0.7c0.4-0.2,0.7-0.4,1.1-0.5c0.5,0,0.9-0.2,1.2-0.2s0.7,0,1.1,0s0.7,0,1.1,0c0.4,0,0.5,0,0.7,0.2c0.5,0,0.7,0.2,0.7,0.2c0.2,0,0.2,0.2,0.4,0.4c0,0,0,0.4,0.2,0.7c0,0.2,0,0.5,0.2,0.7c0,0.4,0,0.7,0,1.1s0,0.7,0,1.1c0,0.4,0,0.9-0.2,1.2c-0.2,0.4-0.4,0.7-0.5,1.1c-0.2,0.4-0.5,0.7-0.7,1.1c-0.5,0.7-1.1,1.4-1.8,2.1c-0.4,0.4-0.7,0.7-1.1,1.1v17.8c0,0.2,0,0.4-0.2,0.4l-2,2c-0.5,0.5-1.2,0-1.1-0.5l0.7-2c0-0.2,0-0.2,0-0.4L22.8,16c-0.4,0.4-0.7,0.7-0.9,0.9c-0.4,0.4-0.7,0.9-1.2,1.2c-0.4,0.4-0.7,0.9-1.2,1.2c-0.7,0.9-1.6,1.6-2.5,2.3c-0.9,0.7-1.6,1.4-2.5,2c-0.4,0.4-0.9,0.5-1.2,0.9c-0.4,0.2-0.7,0.5-1.2,0.7c-0.7,0.4-1.6,0.7-2.3,1.1c-0.4,0.2-0.7,0.2-1.2,0.4L9.6,30c0.4,0.7,0,1.4-0.7,1.8c-0.5,0.2-1.2,0-1.6-0.5l-0.2-0.4l-1.8-2.3c-0.2,0-0.2,0-0.4,0.2c-0.4,0-0.5,0.2-0.7,0.2s-0.2,0-0.4,0c-0.2,0-0.2,0-0.4,0c-0.2,0-0.4,0-0.5,0c-0.2,0-0.2,0-0.2,0s0,0,0-0.2c0-0.2,0-0.2,0-0.5c0-0.2,0-0.2,0-0.4c0-0.2,0-0.2,0-0.4C3.4,27.5,3.4,27.3,3.6,27L3.6,27z M5.7,28.4L5.7,28.4L5.7,28.4L5.7,28.4z"/></svg>`,
  gift: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M30.3,8.1h-4.5V8c0.7-0.7,1.3-1.9,1.3-3.2c0-2.6-2.1-4.7-4.9-4.7c-1.5,0-4.5,1.5-6.4,3.4C14,1.6,11,0.1,9.5,0.1c-2.6,0-4.9,2.1-4.9,4.7C4.7,6.1,5.2,7.2,6,8H1.7C0.6,8,0,8.7,0,9.6v4.5c0,0.2,0.2,0.4,0.4,0.4h13.8V9.6h3.2v4.9h14.2c0.2,0,0.4-0.2,0.4-0.4V9.6C32,8.7,31.4,8.1,30.3,8.1z M9.5,6.5C8.6,6.5,8,5.9,8,4.8s0.6-1.5,1.5-1.5s3.7,1.9,4.7,2.8C13.7,6.3,9.5,6.5,9.5,6.5z M22.3,6.5c0,0-4.1-0.2-4.7-0.4c0.9-1.1,3.7-2.8,4.7-2.8S24,3.8,24,4.8S23.2,6.5,22.3,6.5z M1.7,17.7h12.7v14.2H1.7V17.7z M17.6,17.7h12.7v14.2H17.6V17.7z"/></svg>`,
  food: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M14.1,0.9v5.3h-1.4V0.9c0-1.1-1.4-1.1-1.4,0v5.3h-1.2V0.9c0-1.1-1.4-1.1-1.4,0v5.3H7.2V0.9c0-1.2-1.6-1.1-1.6,0v10.4c0,1.8,1.2,3,2.8,3v15.2c0,1.6,1.1,2.5,2.1,2.5s2.1-0.9,2.1-2.5V14.3c1.6,0,2.8-1.4,2.8-2.8V0.9C15.6-0.4,14.1-0.2,14.1,0.9z M19.8,3.7v25.8c0,3.2,4.2,3.2,4.2,0V17.1h2.3V3.7C26.5-1.2,19.8-1.2,19.8,3.7z"/></svg>`,
  fruit: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M16.5,8c-2.1-0.9-3.9-1.2-6.6-0.9C4.6,8,1.8,12.6,1.8,18c0,5.9,4.8,14,9.8,14c1.6,0,3.9-1.2,4.4-1.2c0.5,0,2.8,1.2,4.4,1.2c5,0,9.8-8.4,9.8-14c0-5.9-3.2-10.8-9.8-10.8C19,7.1,17.8,7.5,16.5,8z M11.7,0c1.1,0.2,3.2,0.9,4.1,2.3c0.9,1.4,0.5,3.6,0.2,4.6c-1.2-0.2-3.2-0.7-4.1-2.3C11,3.2,11.4,1.1,11.7,0L11.7,0z"/></svg>`,
  pet: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M28.5,8.1c0-1.1-1-1.9-2.1-2.4V3.7c-0.2-0.2-0.3-0.3-0.6-0.3c-0.6,0-1.1,0.8-1.3,2.1c-0.2,0-0.3,0-0.5,0l0,0c0-0.2,0-0.3-0.2-0.5c-0.3-1.1-0.8-1.9-1.3-2.6C22,2.6,21.7,3.2,21.7,4L22,6.3c-0.3,0.2-0.6,0.3-1,0.6l-3.5,3.7l0,0c0,0-6.3-0.8-10.9,0.2c-0.6,0-1,0.2-1.1,0.3c-0.5,0.2-0.8,0.3-1.1,0.6c-1.1-0.8-2.2-2.1-3.2-4c0-0.3-0.5-0.5-0.8-0.5s-0.5,0.6-0.3,1c0.8,2.1,2.1,3.5,3.4,4.5c-0.5,0.5-0.8,1-1,1.6c0,0-0.3,2.2-0.3,5.5l1.4,8c0,1,0.8,1.8,1.9,1.8c1,0,1.9-0.8,1.9-1.8V23l0.5-1.3h8.8l0.8,1.3v4.7c0,1,0.8,1.8,1.9,1.8c1,0,1.6-0.6,1.8-1.4l0,0l1.9-9l0,0l2.1-6.4h3c3.4,0,3.7-2.9,3.7-2.9L28.5,8.1z"/></svg>`,
  tree: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M0.7,18c0,4.9,3.6,8.8,8.1,9.5v4.3c0.2,0,3.2,0,3.2,0v-4.3c1.8-0.4,3.6-1.1,4.9-2.5c0.2-0.2,0.2-0.2,0.2-0.5c-0.2-0.4-0.2-1.1-0.2-1.6c0-2,0.2-4.9,1.6-7.9c0,0,0.9-1.6,0.7-1.8C18,7.2,14.4,0,10.4,0C5,0,0.7,12.6,0.7,18z M18.3,22.8c0,3.1,2.2,5.6,4.9,6.3V32h3.2v-2.9c2.7-0.7,4.9-3.2,4.9-6.3c0-3.6-2.9-12.9-6.5-12.9S18.3,19.2,18.3,22.8z"/></svg>`,
  chill: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M9.1,18.5l-5.7,5.9C3.2,23.8,3,23.3,3,22.6c0-2.5,2-4.4,4.4-4.4C7.8,18.1,8.5,18.3,9.1,18.5 M26.5,18.5l-5.7,5.9c-0.2-0.5-0.4-1.1-0.4-1.8c0-2.5,2-4.4,4.4-4.4C25.4,18.1,26,18.3,26.5,18.5 M24.7,2L24.7,2c-0.7,0-1.4,0.7-1.4,1.4s0.7,1.4,1.4,1.4c2.5,0,4.4,2,4.4,4.4v7.6c-1.6-1.2-3.6-1.8-5.5-1.4c-2.1,0.4-3.9,1.6-5,3.4c-1.6-1.2-3.9-1.2-5.5,0c-1.1-1.8-2.8-3-5-3.4c-2-0.4-3.9,0.2-5.5,1.4V9.2c0-2.5,2-4.4,4.4-4.4c0.5,0,0.9-0.4,1.2-0.7c0.2-0.4,0.2-0.9,0-1.4C8.2,2.3,7.6,2,7.1,2C3.2,2,0,5.2,0,9.2v13.5C0,26.7,3.2,30,7.1,30l0,0c3.9,0,7.1-3.2,7.1-7.3c0-0.2,0-0.4,0-0.5c0.2-0.9,0.9-1.4,1.8-1.4s1.6,0.5,1.8,1.4v0.2c0,0.2,0,0.2,0,0.4c0,2,0.7,3.7,2.1,5c1.4,1.4,3,2.1,5,2.1l0,0c2,0,3.6-0.7,5-2.1c1.4-1.2,2.1-3.2,2.1-5V9.2C32,5.2,28.8,2,24.7,2"/></svg>`,
  fence: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="{{FILL}}" d="M28,4l-2,2v4h-4V6l-2-2l-2,2v4h-4V6l-2-2l-2,2v4H6V6L4,4L2,6v22h4v-4h4v4h4v-4h4v4h4v-4h4v4h4V6L28,4z M6,22V12h4v10H6z M14,22V12h4v10H14z M22,22V12h4v10H22z"/></svg>`,
};

function containerIconUrl(icon, color) {
  const template = IDENTITY_ICON_SVGS[icon];
  if (!template) {
    return null;
  }
  const svg = template.replace("{{FILL}}", color || "#737373");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
    item.setAttribute(
      "image",
      containerIconUrl(identity.icon, IDENTITY_COLORS[identity.color])
    );
    popupElement.appendChild(item);
  }
}

// <menulist> doesn't automatically mirror a class-driven icon from its
// selected <menuitem> onto its own closed/collapsed display - Zen's own
// "open in" dropdown works around this the same way: by setting the `image`
// attribute directly on the <menulist> itself, picked up by the existing
// `menulist[image]::part(icon)` rule. The icon image itself is already the
// right color baked in (see containerIconUrl), so no extra color handling
// is needed here, and the label text/arrow are untouched - they stay the
// dialog's standard color, same as the Space dropdown.
function setSelectedContainer(menulist, value) {
  menulist.value = value;

  if (value === SPACE_DEFAULT_SENTINEL) {
    menulist.removeAttribute("image");
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
    return;
  }

  menulist.setAttribute(
    "image",
    containerIconUrl(identity.icon, IDENTITY_COLORS[identity.color])
  );
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
