import {
  mountWeatherDashboard,
  type WeatherDashboardController,
  type WeatherView,
} from "./index.js";

const root = document.querySelector<HTMLElement>("#weather-app");

// register the installable offline shell
async function registerServiceWorker(): Promise<void> {
  // skip unsupported browsers
  if (!("serviceWorker" in navigator)) {
    return;
  }

  const release = document.querySelector<HTMLMetaElement>('meta[name="weather-release"]')?.content ?? "development";
  const controlled = navigator.serviceWorker.controller !== null;
  let reloading = false;

  // reload one installed app after its replacement worker takes control
  if (controlled) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // avoid one browser emitting duplicate ownership events
      if (reloading) {
        return;
      }

      reloading = true;
      window.location.reload();
    }, { once: true });
  }

  const registration = await navigator.serviceWorker.register(
    `/service-worker.js?release=${encodeURIComponent(release)}`,
    { scope: "/", updateViaCache: "none" },
  );
  await registration.update();
}

// resolve one supported browser route
function resolveView(pathname: string): WeatherView {
  // open the protected property sensor editor
  if (pathname === "/admin" || pathname === "/admin/") {
    return "admin";
  }

  // open the historical log
  if (pathname === "/logs" || pathname === "/logs/") {
    return "logs";
  }

  // open the station map
  if (pathname === "/map" || pathname === "/map/") {
    return "map";
  }

  // open the daily forecast
  if (pathname === "/forecast" || pathname === "/forecast/") {
    return "forecast";
  }

  // open historical trends
  if (pathname === "/trends" || pathname === "/trends/") {
    return "trends";
  }

  // open device display preferences
  if (pathname === "/settings" || pathname === "/settings/") {
    return "settings";
  }

  return "home";
}

// select the history surface visible to the user
function resolveHistoryWindow(): Window | null {
  const topWindow = window.top;

  // keep standalone navigation on the application window
  if (topWindow === null || topWindow === window) {
    return window;
  }

  try {
    // synchronize a same-origin embedding host
    if (topWindow.location.origin === window.location.origin) {
      return topWindow;
    }
  } catch {
    // preserve native navigation across isolated frames
    return null;
  }

  return null;
}

// connect public page links to browser history
function bindBrowserNavigation(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const historyWindow = resolveHistoryWindow();

  // let cross-origin frames perform observable document navigation
  if (historyWindow === null) {
    return;
  }

  root.addEventListener("click", (event) => {
    // preserve modified clicks and previously handled events
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>("a[data-weather-route]") ?? null;

    // preserve unrelated and external links
    if (link === null) {
      return;
    }

    const destination = new URL(link.href, window.location.href);

    // retain native navigation across origins
    if (destination.origin !== window.location.origin) {
      return;
    }

    event.preventDefault();
    const nextLocation = `${destination.pathname}${destination.search}${destination.hash}`;

    // avoid duplicate history entries for the active route
    if (nextLocation === `${historyWindow.location.pathname}${historyWindow.location.search}${historyWindow.location.hash}`) {
      return;
    }

    historyWindow.history.pushState(null, "", nextLocation);
    void controller.setView(resolveView(destination.pathname));
  });

  historyWindow.addEventListener("popstate", () => {
    // restore content when browser history changes
    void controller.setView(resolveView(historyWindow.location.pathname));
  });
}

const view = resolveView(window.location.pathname);

// mount only when the application shell is present
if (root !== null) {
  const controller = mountWeatherDashboard(root, { view });
  bindBrowserNavigation(root, controller);
}

registerServiceWorker().catch(
  // keep optional install support from interrupting weather rendering
  () => undefined,
);
