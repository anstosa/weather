import {
  browserUnitPreferenceStorage,
  DEFAULT_UNIT_PREFERENCES,
  formatMeasurement,
  loadUnitPreferences,
  normalizeUnitPreferences,
  persistUnitPreferences,
  type FormattedMeasurement,
  type UnitPreferences,
  type UnitPreferenceStorage,
} from "./units.js";

export {
  DEFAULT_UNIT_PREFERENCES,
  formatMeasurement,
  loadUnitPreferences,
  normalizeUnitPreferences,
  UNIT_PREFERENCE_STORAGE_KEY,
} from "./units.js";
export type { UnitPreferences, UnitPreferenceStorage } from "./units.js";

export interface SiteSource {
  readonly attribution: {
    readonly label: string;
    readonly url: string;
  };
  readonly id: string;
  readonly key: string;
  readonly kind: "forecast" | "model_current" | "physical_sensor" | "reanalysis" | "tide_observation" | "tide_prediction";
  readonly providerKey: string;
  readonly providerName: string;
  readonly provenanceLabel: string;
}

export interface WeatherSite {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string;
  readonly slug: string;
  readonly stations: readonly {
    readonly kind: "physical" | "virtual";
    readonly latitude: number;
    readonly longitude: number;
    readonly name: string;
    readonly slug: string;
    readonly sources: readonly SiteSource[];
  }[];
  readonly timezone: string;
}

export interface WeatherRecord {
  readonly freshness: {
    readonly ageSeconds: number;
    readonly label: string;
    readonly status: "delayed" | "fresh" | "stale";
  };
  readonly id: string;
  readonly metadata: {
    readonly device: {
      readonly model: string | null;
      readonly serial: string | null;
      readonly vendor: string | null;
    } | null;
    readonly provider: {
      readonly dataset: string | null;
      readonly elevationM: number | null;
      readonly gridCell: string | null;
      readonly propertySensors: readonly PropertySensorSnapshot[] | null;
    } | null;
    readonly quality: {
      readonly confidencePercent: number | null;
      readonly flags: readonly string[] | null;
      readonly interpolation: string | null;
      readonly status: string | null;
    } | null;
    readonly upstream: {
      readonly model: string | null;
      readonly timezone: string;
    };
  };
  readonly metrics: {
    readonly apparentTemperatureC: number | null;
    readonly blackGlobeTemperatureC: number | null;
    readonly cloudCoverPercent: number | null;
    readonly pm25MicrogramsPerCubicMeter: number | null;
    readonly precipitationMm: number | null;
    readonly precipitationRateMmPerHour: number | null;
    readonly pressureHpa: number | null;
    readonly relativeHumidityPercent: number | null;
    readonly soilElectricalConductivityMicrosiemensPerCm: number | null;
    readonly soilMoisturePercent: number | null;
    readonly solarRadiationWm2: number | null;
    readonly temperatureC: number | null;
    readonly uvIndex: number | null;
    readonly windDirectionDegrees: number | null;
    readonly windGustMps: number | null;
    readonly windSpeedMps: number | null;
    readonly wetBulbGlobeTemperatureC: number | null;
  };
  readonly productRunAt: string | null;
  readonly provenance: {
    readonly attribution: {
      readonly label: string;
      readonly url: string;
    };
    readonly label: string;
    readonly providerKey: string;
    readonly sourceId: string;
    readonly sourceKey: string;
    readonly sourceKind: SiteSource["kind"];
    readonly stationSlug: string;
  };
  readonly receivedAt: string;
  readonly revisionCount: number;
  readonly validAt: string;
}

export interface PropertySensorSnapshot {
  readonly channel: number | null;
  readonly key: string;
  readonly model: string;
  readonly readings: Readonly<Record<string, number>>;
}

export interface PropertySensorLayout {
  readonly displayName: string;
  readonly icon: PropertySensorIcon | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly sensorKey: string;
  readonly updatedAt: string;
}

export interface TideRecord {
  readonly eventType: "high" | "low" | null;
  readonly kind: "observation" | "prediction";
  readonly source: {
    readonly attribution: {
      readonly label: string;
      readonly url: string;
    };
    readonly providerKey: string;
    readonly stationName: string;
    readonly stationSlug: string;
  };
  readonly validAt: string;
  readonly waterLevelM: number;
}

export interface HistoryFilters {
  readonly from?: string;
  readonly sourceId?: string;
  readonly sourceKind?: SiteSource["kind"];
  readonly stationSlug?: string;
  readonly to?: string;
}

export interface DashboardState {
  readonly current: readonly WeatherRecord[];
  readonly dailyPrecipitation: DailyPrecipitation | null;
  readonly error: string | null;
  readonly filters: HistoryFilters;
  readonly forecast: readonly WeatherRecord[];
  readonly forecastDays: ForecastDays;
  readonly history: readonly WeatherRecord[];
  readonly loading: boolean;
  readonly mapLayer: MapLayer;
  readonly nextCursor: string | null;
  readonly page: number;
  readonly propertyMapLayer: MapLayer;
  readonly propertySensorLayout: readonly PropertySensorLayout[];
  readonly selectedPropertySensorKey: string | null;
  readonly selectedStationSlug: string | null;
  readonly trendDetail: TrendDetail;
  readonly trendDisplayMode: TrendDisplayMode;
  readonly selectedTrendMetric: TrendChartMetric;
  readonly selectedTrendYear: number | null;
  readonly selectedSite: WeatherSite | null;
  readonly sites: readonly WeatherSite[];
  readonly tideGeneratedAt: string | null;
  readonly tides: readonly TideRecord[];
  readonly trendGeneratedAt: string | null;
  readonly trends: readonly TrendPoint[];
  readonly units: UnitPreferences;
}

export interface DashboardOptions {
  readonly apiBaseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly storage?: UnitPreferenceStorage | null;
  readonly view?: WeatherView;
}

export type WeatherView = "admin" | "forecast" | "home" | "logs" | "map" | "settings" | "trends";
export type ForecastDays = 1 | 5 | 10;
export type MapLayer = "roads" | "satellite" | "topo";
export type TrendDetail = "daily" | "rolling";
export type TrendDisplayMode = "aggregate" | "all";
export type TrendChartMetric =
  | "apparentTemperatureC"
  | "precipitationMm"
  | "pressureHpa"
  | "relativeHumidityPercent"
  | "temperatureC"
  | "windGustMps"
  | "windSpeedMps";
export type PropertySensorIcon = "air-quality" | "rain" | "temperature" | "wind";
export type ForecastMapLayer = "clouds" | "precipitation" | "radar" | "wind";
type ForecastMapPhase = "forecast" | "history";
interface ForecastWeatherMapBinding {
  readonly scrubSurface: SVGSVGElement;
  readonly updateTime: (value: string, immediate: boolean) => void;
}

export interface TrendPoint {
  readonly metrics: {
    readonly apparentTemperatureC: number | null;
    readonly precipitationMm: number | null;
    readonly pressureHpa: number | null;
    readonly relativeHumidityPercent: number | null;
    readonly temperatureC: number | null;
    readonly windGustMps: number | null;
    readonly windSpeedMps: number | null;
  };
  readonly validAt: string;
}

export interface DailyPrecipitation {
  readonly accumulationMm: number;
  readonly source: {
    readonly sourceId: string;
    readonly stationSlug: string;
  };
  readonly validThrough: string;
}

interface RecordsResponse {
  readonly data: readonly WeatherRecord[];
  readonly page?: {
    readonly limit: number;
    readonly nextCursor: string | null;
  };
  readonly site: WeatherSite;
}

interface TrendsResponse {
  readonly data: readonly TrendPoint[];
  readonly generatedAt: string;
  readonly site: WeatherSite;
}

interface TidesResponse {
  readonly data: readonly TideRecord[];
  readonly generatedAt: string;
  readonly site: WeatherSite;
}

interface DailyPrecipitationResponse {
  readonly data: DailyPrecipitation | null;
  readonly generatedAt: string;
  readonly site: WeatherSite;
}

interface PropertySensorLayoutResponse {
  readonly data: readonly PropertySensorLayout[];
}

type DashboardListener = (state: DashboardState) => void;

const EMPTY_STATE: DashboardState = {
  current: [],
  dailyPrecipitation: null,
  error: null,
  filters: {},
  forecast: [],
  forecastDays: 1,
  history: [],
  loading: false,
  mapLayer: "roads",
  nextCursor: null,
  page: 0,
  propertyMapLayer: "satellite",
  propertySensorLayout: [],
  selectedPropertySensorKey: null,
  selectedStationSlug: null,
  trendDetail: "rolling",
  trendDisplayMode: "aggregate",
  selectedTrendMetric: "temperatureC",
  selectedTrendYear: null,
  selectedSite: null,
  sites: [],
  tideGeneratedAt: null,
  tides: [],
  trendGeneratedAt: null,
  trends: [],
  units: DEFAULT_UNIT_PREFERENCES,
};

const PRODUCT_SITE: WeatherSite = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  name: "Ballydídean",
  slug: "ballydidean",
  stations: [],
  timezone: "America/Los_Angeles",
};

const INVALID_HISTORY_WALL_CLOCK_MESSAGE =
  "That site time does not exist or occurs twice because of daylight saving time. Choose another time.";
const WALL_CLOCK_OFFSET_SAMPLE_MS = 6 * 60 * 60 * 1_000;
const WALL_CLOCK_OFFSET_WINDOW_MS = 48 * 60 * 60 * 1_000;

// coordinate browser reads and pagination
export class WeatherDashboardController {
  readonly #apiBaseUrl: string;
  readonly #cursors: Array<string | undefined> = [undefined];
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<DashboardListener>();
  readonly #storage: UnitPreferenceStorage | null;
  #view: WeatherView;
  #state: DashboardState;

  // retain injectable browser boundaries
  constructor(options: DashboardOptions = {}) {
    this.#apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl ?? "/api/v1");
    this.#fetcher = options.fetcher ?? fetch;
    this.#storage = options.storage === undefined
      ? browserUnitPreferenceStorage()
      : options.storage;
    this.#view = options.view ?? "home";
    this.#state = {
      ...EMPTY_STATE,
      loading: true,
      selectedSite: PRODUCT_SITE,
      sites: [PRODUCT_SITE],
      units: loadUnitPreferences(this.#storage),
    };
  }

  // expose the latest immutable view
  get state(): DashboardState {
    return this.#state;
  }

  // expose the active browser route to the renderer
  get view(): WeatherView {
    return this.#view;
  }

  // notify one dashboard view
  subscribe(listener: DashboardListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);

    // remove the listener safely
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // load the fixed Ballydidean view directly
  async initialize(): Promise<void> {
    await this.loadSelectedSite();
  }

  // apply new history filters
  async setFilters(filters: HistoryFilters): Promise<void> {
    this.resetPagination();
    this.#state = { ...this.#state, filters };
    this.emit();
    await this.loadSelectedSite();
  }

  // report a rejected site time
  reportInvalidHistoryWallClock(): void {
    this.patch({
      error: INVALID_HISTORY_WALL_CLOCK_MESSAGE,
      loading: false,
    });
  }

  // apply and persist one complete unit preference record
  setUnitPreferences(value: unknown): void {
    const units = normalizeUnitPreferences(value);
    persistUnitPreferences(this.#storage, units);
    this.patch({ units });
  }

  // load the newly selected public application route
  async setView(view: WeatherView): Promise<void> {
    // preserve the current page without duplicate reads
    if (view === this.#view) {
      return;
    }

    this.#view = view;
    await this.loadSelectedSite();
  }

  // switch and reload the forecast horizon
  async setForecastDays(days: ForecastDays): Promise<void> {
    const site = this.#state.selectedSite;

    // wait for initialization
    if (site === null || days === this.#state.forecastDays) {
      return;
    }

    const previousDays = this.#state.forecastDays;
    this.patch({ error: null, forecastDays: days, loading: true });

    try {
      const response = await getJson<RecordsResponse>(
        this.#fetcher,
        buildForecastUrl(this.#apiBaseUrl, site.slug, days),
      );
      const responseSite = requireProductSite(response.site);
      this.patch({ error: null, forecast: response.data, loading: false, selectedSite: responseSite, sites: [responseSite] });
    } catch (error) {
      this.#state = { ...this.#state, forecastDays: previousDays };
      this.fail(error);
    }
  }

  // switch the dependency-free station base map
  setMapLayer(layer: MapLayer): void {
    this.patch({ mapLayer: layer });
  }

  // switch the bounded property base map
  setPropertyMapLayer(layer: MapLayer): void {
    this.patch({ propertyMapLayer: layer });
  }

  // switch the visible annual trend measurement
  setSelectedTrendMetric(metric: TrendChartMetric): void {
    this.patch({ selectedTrendMetric: metric, selectedTrendYear: null });
  }

  // switch between the aggregate and individual years
  toggleTrendDisplayMode(): void {
    const trendDisplayMode = this.#state.trendDisplayMode === "aggregate" ? "all" : "aggregate";
    this.patch({ selectedTrendYear: null, trendDisplayMode });
  }

  // switch between a rolling overview and daily detail
  toggleTrendDetail(): void {
    const trendDetail = this.#state.trendDetail === "rolling" ? "daily" : "rolling";
    this.patch({ trendDetail });
  }

  // emphasize one annual trend line
  setSelectedTrendYear(year: number): void {
    this.patch({ selectedTrendYear: this.#state.selectedTrendYear === year ? null : year });
  }

  // select one physical station for compact conditions
  setSelectedStation(stationSlug: string): void {
    const station = this.#state.selectedSite?.stations.find(
      // require a rendered physical weather station
      (candidate) =>
        candidate.slug === stationSlug &&
        candidate.kind === "physical" &&
        candidate.sources.some((source) => source.kind === "physical_sensor"),
    );

    // reject stale or synthetic rendered values
    if (station === undefined) {
      return;
    }

    this.patch({ selectedStationSlug: station.slug });
  }

  // select one EcoWitt property sensor for editing
  setSelectedPropertySensor(sensorKey: string): void {
    const sensor = propertySensorSnapshots(this.#state).find(
      // require one currently reported sensor key
      (candidate) => candidate.key === sensorKey,
    );

    // reject stale rendered sensor identities
    if (sensor === undefined) {
      return;
    }

    this.patch({ selectedPropertySensorKey: sensor.key });
  }

  // persist one shared property sensor name and position
  async savePropertySensorLayout(
    sensorKey: string,
    displayName: string,
    icon: PropertySensorIcon,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    this.patch({ error: null, loading: true });

    try {
      const response = await putJson<{ readonly data: PropertySensorLayout }>(
        this.#fetcher,
        buildAdminPropertySensorLayoutUrl(this.#apiBaseUrl, PRODUCT_SITE.slug, sensorKey),
        { displayName, icon, latitude, longitude },
      );
      const next = this.#state.propertySensorLayout.filter(
        // replace only the saved sensor key
        (entry) => entry.sensorKey !== response.data.sensorKey,
      );
      next.push(response.data);
      this.patch({
        loading: false,
        propertySensorLayout: next.sort(
          // retain deterministic editor order
          (left, right) => left.sensorKey.localeCompare(right.sensorKey),
        ),
        selectedPropertySensorKey: response.data.sensorKey,
      });
    } catch (error) {
      this.fail(error);
    }
  }

  // advance to the next cursor page
  async nextPage(): Promise<void> {
    // stop at the final page
    if (this.#state.nextCursor === null || this.#state.loading) {
      return;
    }

    const previousPage = this.#state.page;
    this.#cursors.push(this.#state.nextCursor);
    this.#state = { ...this.#state, page: previousPage + 1 };
    this.emit();
    await this.loadHistory();

    // restore last-good pagination after failure
    if (this.#state.error !== null) {
      this.#cursors.pop();
      this.#state = { ...this.#state, page: previousPage };
      this.emit();
    }
  }

  // return to the preceding cursor page
  async previousPage(): Promise<void> {
    // stop at the first page
    if (this.#state.page === 0 || this.#state.loading) {
      return;
    }

    const previousPage = this.#state.page;
    const removedCursor = this.#cursors.pop();
    this.#state = { ...this.#state, page: previousPage - 1 };
    this.emit();
    await this.loadHistory();

    // restore last-good pagination after failure
    if (this.#state.error !== null) {
      this.#cursors.push(removedCursor);
      this.#state = { ...this.#state, page: previousPage };
      this.emit();
    }
  }

  // load only the active page data
  async loadSelectedSite(): Promise<void> {
    const site = this.#state.selectedSite;

    // wait for initialization
    if (site === null) {
      return;
    }

    // keep weather reads off the local-only settings page
    if (this.#view === "settings") {
      this.patch({ loading: false });
      return;
    }

    // keep historical reads off the homepage
    if (this.#view === "logs") {
      await this.loadHistory();
      return;
    }

    await this.loadCurrent();
  }

  // load only the current conditions panel
  async loadCurrent(): Promise<void> {
    const site = this.#state.selectedSite;

    // wait for initialization
    if (site === null) {
      return;
    }

    this.patch({ error: null, loading: true });

    try {
      const needsCurrent = this.#view === "home" || this.#view === "map" || this.#view === "forecast" || this.#view === "admin";
      const needsDailyPrecipitation = this.#view === "home";
      const needsForecast = this.#view === "home" || this.#view === "forecast";
      const needsTides = this.#view === "home" || this.#view === "forecast";
      const needsTrends = this.#view === "trends";
      const needsPropertySensorLayout = this.#view === "map" || this.#view === "admin";
      const [current, dailyPrecipitation, forecast, tides, trends, propertySensorLayout] = await Promise.all([
        // load observations only where rendered
        needsCurrent
          ? getJson<RecordsResponse>(
            this.#fetcher,
            buildCurrentUrl(
              this.#apiBaseUrl,
              site.slug,
              this.#state.filters,
            ),
          )
          : Promise.resolve(null),
        // load today's gauge total only on home
        needsDailyPrecipitation
          ? getJson<DailyPrecipitationResponse>(
            this.#fetcher,
            buildDailyPrecipitationUrl(this.#apiBaseUrl, site.slug),
          )
          : Promise.resolve(null),
        // load modeled hours only where rendered
        needsForecast
          ? getJson<RecordsResponse>(
            this.#fetcher,
            buildForecastUrl(this.#apiBaseUrl, site.slug, this.#state.forecastDays),
          )
          : Promise.resolve(null),
        // load tide curves only where rendered
        needsTides
          ? getJson<TidesResponse>(
            this.#fetcher,
            buildTidesUrl(this.#apiBaseUrl, site.slug),
          )
          : Promise.resolve(null),
        // load trend buckets only on Trends
        needsTrends
          ? getJson<TrendsResponse>(
            this.#fetcher,
            buildTrendsUrl(
              this.#apiBaseUrl,
              site.slug,
            ),
          )
          : Promise.resolve(null),
        // load shared sensor positions only where rendered
        needsPropertySensorLayout
          ? getJson<PropertySensorLayoutResponse>(
            this.#fetcher,
            buildPropertySensorLayoutUrl(this.#apiBaseUrl, site.slug),
          )
          : Promise.resolve(null),
      ]);
      const responseSite = requireProductSite(
        current?.site ?? dailyPrecipitation?.site ?? forecast?.site ?? tides?.site ?? trends?.site ?? site,
      );
      this.#state = {
        ...this.#state,
        current: current?.data ?? this.#state.current,
        dailyPrecipitation: dailyPrecipitation === null
          ? this.#state.dailyPrecipitation
          : dailyPrecipitation.data,
        error: null,
        forecast: forecast?.data ?? this.#state.forecast,
        loading: false,
        propertySensorLayout: propertySensorLayout?.data ?? this.#state.propertySensorLayout,
        selectedSite: responseSite,
        sites: [responseSite],
        tideGeneratedAt: tides?.generatedAt ?? this.#state.tideGeneratedAt,
        tides: tides?.data ?? this.#state.tides,
        trendGeneratedAt: trends?.generatedAt ?? this.#state.trendGeneratedAt,
        trends: trends?.data ?? this.#state.trends,
      };
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  // load only the history panel
  async loadHistory(): Promise<void> {
    const site = this.#state.selectedSite;

    // wait for initialization
    if (site === null) {
      return;
    }

    this.patch({ error: null, loading: true });

    try {
      const response = await getJson<RecordsResponse>(
        this.#fetcher,
        buildHistoryUrl(
          this.#apiBaseUrl,
          site.slug,
          this.#state.filters,
          this.#cursors[this.#state.page],
        ),
      );
      const responseSite = requireProductSite(response.site);
      this.#state = {
        ...this.#state,
        error: null,
        history: response.data,
        loading: false,
        nextCursor: response.page?.nextCursor ?? null,
        selectedSite: responseSite,
        sites: [responseSite],
      };
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  // merge a partial state update
  private patch(update: Partial<DashboardState>): void {
    this.#state = { ...this.#state, ...update };
    this.emit();
  }

  // publish the current state
  private emit(): void {
    // notify every mounted view
    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }

  // publish a bounded error
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : "Weather data could not be loaded";
    this.patch({ error: message, loading: false });
  }

  // restore the first cursor page
  private resetPagination(): void {
    this.#cursors.splice(0, this.#cursors.length, undefined);
    this.#state = { ...this.#state, nextCursor: null, page: 0 };
  }
}

// construct a filtered history endpoint
export function buildHistoryUrl(
  apiBaseUrl: string,
  siteSlug: string,
  filters: HistoryFilters,
  cursor?: string,
): string {
  const parameters = new URLSearchParams({ limit: "25" });

  // include the station filter
  if (filters.stationSlug !== undefined) {
    parameters.set("station", filters.stationSlug);
  }

  // include the source filter
  if (filters.sourceId !== undefined) {
    parameters.set("source", filters.sourceId);
  }

  // include the provenance filter
  if (filters.sourceKind !== undefined) {
    parameters.set("sourceKind", filters.sourceKind);
  }

  // include the lower bound
  if (filters.from !== undefined) {
    parameters.set("from", filters.from);
  }

  // include the upper bound
  if (filters.to !== undefined) {
    parameters.set("to", filters.to);
  }

  // include the page cursor
  if (cursor !== undefined) {
    parameters.set("cursor", cursor);
  }

  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/history?${parameters.toString()}`;
}

// construct a filtered current endpoint
export function buildCurrentUrl(
  apiBaseUrl: string,
  siteSlug: string,
  filters: HistoryFilters,
): string {
  const parameters = new URLSearchParams();

  // include the station filter
  if (filters.stationSlug !== undefined) {
    parameters.set("station", filters.stationSlug);
  }

  // include the source filter
  if (filters.sourceId !== undefined) {
    parameters.set("source", filters.sourceId);
  }

  const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/current${query}`;
}

// construct today's nearest-gauge accumulation endpoint
export function buildDailyPrecipitationUrl(
  apiBaseUrl: string,
  siteSlug: string,
): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/daily-precipitation`;
}

// construct the fixed normalized forecast endpoint
export function buildForecastUrl(
  apiBaseUrl: string,
  siteSlug: string,
  days: ForecastDays = 1,
): string {
  const query = days === 1 ? "" : `?days=${String(days)}`;
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/forecast${query}`;
}

// construct the bounded observed and predicted tide endpoint
export function buildTidesUrl(
  apiBaseUrl: string,
  siteSlug: string,
): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/tides`;
}

// construct the shared property sensor layout endpoint
export function buildPropertySensorLayoutUrl(
  apiBaseUrl: string,
  siteSlug: string,
): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/property-sensor-layout`;
}

// construct one authenticated property sensor update endpoint
export function buildAdminPropertySensorLayoutUrl(
  apiBaseUrl: string,
  siteSlug: string,
  sensorKey: string,
): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/admin/sites/${encodeURIComponent(siteSlug)}/property-sensor-layout/${encodeURIComponent(sensorKey)}`;
}

// construct one bounded trend endpoint
export function buildTrendsUrl(
  apiBaseUrl: string,
  siteSlug: string,
): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/sites/${encodeURIComponent(siteSlug)}/trends`;
}

// mount the interactive dashboard
export function mountWeatherDashboard(
  root: HTMLElement,
  options: DashboardOptions = {},
): WeatherDashboardController {
  const controller = new WeatherDashboardController(options);

  // redraw and wire one state snapshot
  controller.subscribe((state) => {
    root.innerHTML = renderWeatherDashboard(state, controller.view);
    bindDashboardControls(root, controller);
  });
  void controller.initialize();
  return controller;
}

// render the complete accessible dashboard
export function renderWeatherDashboard(
  state: DashboardState,
  view: WeatherView = "home",
): string {
  return `
    <main class="shell">
      <header class="masthead">
        <h1>Ballydídean Weather</h1>
        <div class="masthead-actions">
          ${renderLoadingIndicator(state)}
        </div>
      </header>
      ${renderSectionNavigation(view)}
      <div class="weather-content">
        ${renderErrorStatus(state)}
        ${renderWeatherView(state, view)}
        ${renderCredits(state, view)}
      </div>
    </main>
  `;
}

// render one route body
function renderWeatherView(state: DashboardState, view: WeatherView): string {
  // render the authenticated property sensor editor
  if (view === "admin") {
    return renderPropertySensorAdmin(state);
  }

  // render historical records alone
  if (view === "logs") {
    return renderHistory(state);
  }

  // render nearby stations alone
  if (view === "map") {
    return `${renderPropertySensorMap(state)}${renderStationMap(state)}`;
  }

  // render the daily forecast alone
  if (view === "forecast") {
    return renderForecast(state);
  }

  // render historical trends alone
  if (view === "trends") {
    return renderTrends(state);
  }

  // render device-local display preferences alone
  if (view === "settings") {
    return renderUnitSettings(state.units);
  }

  return renderHomepage(state);
}

// render the complete decision-first homepage
function renderHomepage(state: DashboardState): string {
  return `
    ${renderAlerts(state)}
    ${renderCurrent(state)}
  `;
}

// render the stable product routes
function renderSectionNavigation(view: WeatherView): string {
  const settingsCurrent = view === "settings" || view === "logs" || view === "admin";

  return `
    <nav class="section-nav" aria-label="Weather sections">
      <a class="section-nav-home" href="/" data-weather-route${view === "home" ? ' aria-current="page"' : ""}><span class="section-nav-icon">${renderMaterialIcon("home")}</span><span>Home</span></a>
      <a class="section-nav-forecast" href="/forecast" data-weather-route${view === "forecast" ? ' aria-current="page"' : ""}><span class="section-nav-icon">${renderMaterialIcon("partly_cloudy_day")}</span><span>Forecast</span></a>
      <a class="section-nav-trends" href="/trends" data-weather-route${view === "trends" ? ' aria-current="page"' : ""}><span class="section-nav-icon">${renderMaterialIcon("trending_up")}</span><span>Trends</span></a>
      <a class="section-nav-map" href="/map" data-weather-route${view === "map" ? ' aria-current="page"' : ""}><span class="section-nav-icon">${renderMaterialIcon("map")}</span><span>Map</span></a>
      <a class="section-nav-settings" href="/settings" data-weather-route${settingsCurrent ? ' aria-current="page"' : ""}><span class="section-nav-icon">${renderMaterialIcon("settings")}</span><span>Settings</span></a>
    </nav>
  `;
}

// render the browser-persisted measurement unit page
function renderUnitSettings(units: UnitPreferences): string {
  return `
    <div class="settings-page">
      <nav class="settings-destinations" aria-label="Weather data">
        <a class="settings-logs-link" href="/logs" data-weather-route aria-label="Logs">
          <span class="settings-destination-icon">${renderMaterialIcon("history")}</span>
          <span><strong>Logs</strong><small>Browse current and historical readings</small></span>
        </a>
        <a class="settings-logs-link" href="/admin" aria-label="Admin">
          <span class="settings-destination-icon">${renderMaterialIcon("settings")}</span>
          <span><strong>Admin</strong></span>
        </a>
      </nav>
      <section class="unit-settings-page" aria-labelledby="unit-settings-heading">
        <div class="unit-settings-heading">
          <p class="eyebrow">Display preferences</p>
          <h2 id="unit-settings-heading">Measurement units</h2>
          <p class="unit-settings-intro">Choose how weather measurements appear on this device.</p>
        </div>
        <form class="unit-settings-form" data-unit-settings-form>
          <div class="unit-settings-grid">
            <label><span>Temperature</span><select name="temperature">
              <option value="fahrenheit"${units.temperature === "fahrenheit" ? " selected" : ""}>Fahrenheit (°F)</option>
              <option value="celsius"${units.temperature === "celsius" ? " selected" : ""}>Celsius (°C)</option>
            </select></label>
            <label><span>Wind speed</span><select name="windSpeed">
              <option value="miles_per_hour"${units.windSpeed === "miles_per_hour" ? " selected" : ""}>Miles per hour (mph)</option>
              <option value="kilometers_per_hour"${units.windSpeed === "kilometers_per_hour" ? " selected" : ""}>Kilometers per hour (km/h)</option>
              <option value="meters_per_second"${units.windSpeed === "meters_per_second" ? " selected" : ""}>Meters per second (m/s)</option>
            </select></label>
            <label><span>Precipitation</span><select name="precipitation">
              <option value="inches"${units.precipitation === "inches" ? " selected" : ""}>Inches (in)</option>
              <option value="millimeters"${units.precipitation === "millimeters" ? " selected" : ""}>Millimeters (mm)</option>
            </select></label>
            <label><span>Pressure</span><select name="pressure">
              <option value="atmosphere_percent"${units.pressure === "atmosphere_percent" ? " selected" : ""}>Difference from 1 atm (%)</option>
              <option value="inches_of_mercury"${units.pressure === "inches_of_mercury" ? " selected" : ""}>Inches of mercury (inHg)</option>
              <option value="hectopascals"${units.pressure === "hectopascals" ? " selected" : ""}>Hectopascals (hPa)</option>
            </select></label>
            <label><span>Tide height</span><select name="waterLevel">
              <option value="feet"${units.waterLevel === "feet" ? " selected" : ""}>Feet (ft)</option>
              <option value="meters"${units.waterLevel === "meters" ? " selected" : ""}>Meters (m)</option>
            </select></label>
          </div>
          <div class="unit-settings-actions">
            <button type="submit">Save units</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

// render compact provider and license attribution
function renderCredits(state: DashboardState, view: WeatherView): string {
  const attributions = new Map<string, string>();
  let includesOpenMeteo = false;

  // collect every station attribution
  for (const station of state.selectedSite?.stations ?? []) {
    // collect every unique provider
    for (const source of station.sources) {
      attributions.set(source.attribution.url, source.attribution.label);

      // retain the Open-Meteo license requirement
      if (source.providerKey === "open-meteo") {
        includesOpenMeteo = true;
      }
    }
  }

  let providerCredits = "";

  // render each unique provider once
  for (const [url, label] of attributions) {
    providerCredits += `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(label)}</a><span aria-hidden="true">·</span>`;
  }

  // include the required Open-Meteo license
  const licenseCredit = includesOpenMeteo
    ? `<span>Open-Meteo data licensed under <a href="https://creativecommons.org/licenses/by/4.0/" rel="license noreferrer">CC BY 4.0</a></span><span aria-hidden="true">·</span>`
    : "";

  // keep forecast map credits collapsed
  const forecastMapCredits = view === "forecast"
    ? `<span>Map © <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap contributors</a></span><span aria-hidden="true">·</span><a href="https://www.xweather.com/" rel="noreferrer">Weather maps by Xweather</a><span aria-hidden="true">·</span>`
    : "";

  return `
    <footer class="credits" aria-label="Weather data credits">
      <details>
        <summary>Data sources &amp; credits</summary>
        <div class="credit-list">
          ${providerCredits}
          ${licenseCredit}
          ${forecastMapCredits}
          <span>A <a href="https://www.ballydidean.farm/" rel="noreferrer">Ballydídean Farm Sanctuary</a> project</span>
        </div>
      </details>
    </footer>
  `;
}

// render one reserved in-place loading indicator
function renderLoadingIndicator(state: DashboardState): string {
  const activeClass = state.loading ? " active" : "";
  const message = state.loading
    ? "Refreshing weather data…"
    : state.error === null
      ? "Weather data is up to date."
      : "Weather refresh failed.";
  return `<p class="refresh-indicator${activeClass}" role="status"><span class="sr-only">${message}</span></p>`;
}

// render error feedback without affecting routine refreshes
function renderErrorStatus(state: DashboardState): string {
  // expose only actionable failures in the document flow
  if (state.error !== null) {
    return `<p class="notice error" role="alert">${escapeHtml(state.error)}</p>`;
  }

  return "";
}

// render the current summary
function renderCurrent(state: DashboardState): string {
  const currentRecords = preferredCurrentRecords(state.current);
  const current = currentRecords[0];

  // render an honest empty state
  if (current === undefined) {
    // reserve the final card grid during the first read
    if (state.loading) {
      return renderCurrentSkeleton();
    }

    return '<p class="notice">No current weather value is available yet.</p>';
  }

  const airQuality = findMetric(currentRecords, "pm25MicrogramsPerCubicMeter");
  const dailyRain = state.dailyPrecipitation?.accumulationMm ?? null;
  const rainRate = findMetric(currentRecords, "precipitationRateMmPerHour");
  const uvIndex = findMetric(currentRecords, "uvIndex");
  const windGust = findMetric(currentRecords, "windGustMps");
  const forecast = forecastForSiteDay(
    state.forecast,
    current.validAt,
    state.selectedSite?.timezone ?? current.metadata.upstream.timezone,
  );
  return `
    <section class="current-conditions" aria-label="Current conditions">
      ${renderConditionCard({
          band: temperatureBand(current.metrics.temperatureC),
          className: "temperature-condition",
          icon: "device_thermostat",
          label: "Temperature",
          measurement: formatMeasurement(current.metrics.temperatureC, "temperature", state.units, 0),
          forecast: forecastTemperature(forecast, state.units),
          secondary: {
            label: "Feels like",
            measurement: formatMeasurement(current.metrics.apparentTemperatureC, "temperature", state.units, 0),
          },
        })}
      ${renderConditionCard({
          band: windBand(current.metrics.windSpeedMps, windGust, state.units),
          className: "wind-condition",
          icon: "air",
          label: "Wind",
          measurement: formatMeasurement(current.metrics.windSpeedMps, "windSpeed", state.units, 0),
          forecast: forecastWind(forecast, state.units),
          secondary: {
            label: "Gusts",
            measurement: formatMeasurement(windGust, "windSpeed", state.units, 0),
          },
        })}
      ${renderConditionCard({
          band: rainBand(rainRate),
          className: "rain-condition",
          icon: "rainy",
          label: "Rain",
          measurement: formatPrecipitationRate(rainRate, state.units),
          forecast: forecastRain(forecast, state.units),
          secondary: {
            label: "Accumulation",
            measurement: formatPrecipitationAccumulation(dailyRain, state.units),
          },
        })}
      ${renderTideCondition(state)}
      ${renderConditionCard({
          band: humidityBand(current.metrics.relativeHumidityPercent),
          className: "compact-condition",
          icon: "humidity_percentage",
          label: "Humidity",
          measurement: formatFixedMeasurement(current.metrics.relativeHumidityPercent, "%"),
          forecast: forecastMaximumFixed(forecast, "relativeHumidityPercent", "%", 0, humidityBand),
        })}
      ${renderConditionCard({
          band: airQualityBand(airQuality),
          className: "air-quality-condition",
          icon: "masks",
          label: "Air quality",
          measurement: formatFixedMeasurement(airQuality, "", 0),
          forecast: forecastMaximumFixed(forecast, "pm25MicrogramsPerCubicMeter", "", 0, airQualityBand),
        })}
      ${renderConditionCard({
          band: pressureBand(current.metrics.pressureHpa, state.units),
          className: "compact-condition",
          icon: "speed",
          label: "Pressure",
          measurement: formatMeasurement(current.metrics.pressureHpa, "pressure", state.units, 1),
          forecast: forecastRange(
            forecast,
            "pressureHpa",
            "pressure",
            state.units,
            1,
            // classify pressure in the active display preference
            (value) => pressureBand(value, state.units),
          ),
        })}
      ${renderConditionCard({
          band: uvBand(uvIndex),
          className: "compact-condition",
          icon: "wb_sunny",
          label: "UV index",
          measurement: formatFixedMeasurement(uvIndex, ""),
          forecast: forecastMaximumFixed(forecast, "uvIndex", "", 1, uvBand),
        })}
    </section>
  `;
}

// order current readings around the on-site gateway
function preferredCurrentRecords(
  records: readonly WeatherRecord[],
): readonly WeatherRecord[] {
  return [...records].sort(
    // preserve API order within each source priority
    (left, right) => currentRecordPriority(left) - currentRecordPriority(right),
  );
}

// rank a current reading for the single-location homepage
function currentRecordPriority(record: WeatherRecord): number {
  // prefer a usable first-party gateway reading
  if (
    record.provenance.providerKey === "ecowitt-local" &&
    record.freshness.status !== "stale"
  ) {
    return 0;
  }

  // retain the model as the immediate fallback
  if (record.provenance.sourceKind === "model_current") {
    return 1;
  }

  // keep a stale first-party reading ahead of unrelated stations
  if (record.provenance.providerKey === "ecowitt-local") {
    return 2;
  }

  return 3;
}

// reserve the complete current-condition grid
function renderCurrentSkeleton(): string {
  const cards: readonly Readonly<{
    className: string;
    forecast: ForecastCardValue;
    icon: MaterialIconName;
    label: string;
    secondary?: string;
    detail?: string | null;
  }>[] = [
    { className: "temperature-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "°F", value: "00" } }, { label: "Min", measurement: { unit: "°F", value: "00" } }, { label: "Max", measurement: { unit: "°F", value: "00" } }, { label: "Min", measurement: { unit: "°F", value: "00" } }] }, icon: "device_thermostat", label: "Temperature", secondary: "Feels like" },
    { className: "wind-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "mph", value: "00" } }, { label: "Max", measurement: { unit: "mph", value: "00" } }] }, icon: "air", label: "Wind", secondary: "Gusts" },
    { className: "rain-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "in/h", value: "0.00" } }, { label: "Total", measurement: { unit: "in", value: "0.00" } }] }, icon: "rainy", label: "Rain", secondary: "Accumulation" },
    { className: "compact-condition tide-condition", detail: null, forecast: { readings: [{ label: "Next low", measurement: { unit: "", value: "00:00 PM" } }] }, icon: "water", label: "Tide", secondary: "Direction" },
    { className: "compact-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "%", value: "00" } }] }, icon: "humidity_percentage", label: "Humidity" },
    { className: "air-quality-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "", value: "00" } }] }, icon: "masks", label: "Air quality" },
    { className: "compact-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "%", value: "+0.0" } }, { label: "Min", measurement: { unit: "%", value: "-0.0" } }] }, icon: "speed", label: "Pressure" },
    { className: "compact-condition", forecast: { readings: [{ label: "Max", measurement: { unit: "", value: "0.0" } }] }, icon: "wb_sunny", label: "UV index" },
  ];

  return `
    <section class="current-conditions skeleton-region" aria-label="Loading current conditions" aria-busy="true">
      ${cards.map(
        // preserve every final grid span
        (card) => `
          <article class="condition-card ${card.className} skeleton-card" data-condition="${card.label.toLowerCase().replaceAll(" ", "-")}" aria-hidden="true">
            <div class="condition-card-content">
              <div class="condition-card-heading"><span class="condition-label">${renderMaterialIcon(card.icon)}<span>${card.label}</span></span><span class="condition-status">Loading</span></div>
              <div class="condition-body${card.secondary === undefined ? "" : " condition-body-secondary"}">
                <div class="condition-live">
                  <div class="condition-primary"><strong>00<small>unit</small></strong></div>
                  ${card.secondary === undefined ? "" : `<div class="condition-secondary"><span>${card.secondary}</span><strong>00<small>unit</small></strong></div>`}
                </div>
                ${renderConditionForecast(card.forecast)}
              </div>
              ${card.detail === null ? "" : `<p class="condition-detail">${card.detail ?? "Loading"}</p>`}
            </div>
          </article>
        `,
      ).join("")}
    </section>
  `;
}

// render the latest observed tide and next local event
function renderTideCondition(state: DashboardState): string {
  const generatedAt = Date.parse(state.tideGeneratedAt ?? "");
  const asOf = Number.isFinite(generatedAt) ? generatedAt : Date.now();
  const observations = state.tides.filter(
    // retain observations available at response generation
    (record) => record.kind === "observation" && Date.parse(record.validAt) <= asOf,
  );
  const current = observations.at(-1);
  const previous = observations.at(-2);
  const next = state.tides.find(
    // select the next explicit tide turn
    (record) =>
      record.kind === "prediction" &&
      record.eventType !== null &&
      Date.parse(record.validAt) >= asOf,
  );
  const direction = tideDirectionBand(current, previous, next);
  const currentMeasurement = formatMeasurement(current?.waterLevelM ?? null, "waterLevel", state.units);
  const level = tideLevelLabel(current, state.tides);
  const nextLow = state.tides.find(
    // locate the next predicted low tide
    (record) =>
      record.kind === "prediction" &&
      record.eventType === "low" &&
      Date.parse(record.validAt) >= asOf,
  );

  return renderConditionCard({
    band: { ...direction, detail: "", label: level },
    className: "compact-condition tide-condition",
    icon: "water",
    label: "Tide",
    measurement: currentMeasurement,
    forecast: {
      readings: [{
        label: "Next low",
        measurement: {
          unit: "",
          value: nextLow === undefined
            ? "Unavailable"
            : formatForecastTime(nextLow.validAt, state.selectedSite?.timezone),
        },
      }],
    },
    secondary: {
      label: "Direction",
      measurement: { unit: "", value: direction.label },
    },
  });
}

// classify the recent observed tide direction
function tideDirectionBand(
  current: TideRecord | undefined,
  previous: TideRecord | undefined,
  next: TideRecord | undefined,
): ConditionBand {
  // preserve an unavailable observation honestly
  if (current === undefined) {
    return unavailableBand("No recent NOAA tide observation");
  }

  // infer direction from the next turn when only one observation exists
  if (previous === undefined) {
    return next?.eventType === "low"
      ? { color: "rgb(124, 81, 116)", detail: "Falling", label: "Falling" }
      : { color: "rgb(56, 120, 197)", detail: "Rising", label: "Rising" };
  }

  const changeM = current.waterLevelM - previous.waterLevelM;
  return changeM >= 0
    ? { color: "rgb(56, 120, 197)", detail: "Rising", label: "Rising" }
    : { color: "rgb(124, 81, 116)", detail: "Falling", label: "Falling" };
}

// classify observed height within the surrounding local tidal range
export function tideLevelLabel(
  current: TideRecord | undefined,
  records: readonly TideRecord[],
): "High" | "Medium" | "Low" | "Unavailable" {
  // preserve a missing observation honestly
  if (current === undefined) {
    return "Unavailable";
  }

  const currentTime = Date.parse(current.validAt);
  const turns = records
    .filter(
      // retain explicit predicted turns
      (record) => record.kind === "prediction" && record.eventType !== null,
    )
    .toSorted(
      // order turns around the observation
      (left, right) => Date.parse(left.validAt) - Date.parse(right.validAt),
    );
  const previousTurn = turns.findLast(
    // locate the prior local extreme
    (record) => Date.parse(record.validAt) <= currentTime,
  );
  const nextTurn = turns.find(
    // locate the next local extreme
    (record) => Date.parse(record.validAt) >= currentTime,
  );
  const surroundingTurns = previousTurn !== undefined && nextTurn !== undefined
    ? [previousTurn, nextTurn]
    : turns;
  const levels = surroundingTurns.map(
    // collect comparable local datum levels
    (record) => record.waterLevelM,
  );
  const low = Math.min(...levels);
  const high = Math.max(...levels);

  // avoid inventing a level without a usable range
  if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < 0.05) {
    return "Medium";
  }

  const position = (current.waterLevelM - low) / (high - low);

  // label the lower third of the local range
  if (position <= 1 / 3) {
    return "Low";
  }

  // label the upper third of the local range
  if (position >= 2 / 3) {
    return "High";
  }

  return "Medium";
}

interface LocalWeatherAlert {
  readonly detail: string;
  readonly label: string;
  readonly tone: "caution" | "danger";
}

// describe one current-condition health or comfort band
interface ConditionBand {
  readonly color: string;
  readonly detail: string;
  readonly label: string;
}

// configure one friendly current-condition card
interface ConditionCardOptions {
  readonly band: ConditionBand;
  readonly className: string;
  readonly forecast: ForecastCardValue;
  readonly icon: MaterialIconName;
  readonly label: string;
  readonly measurement: FormattedMeasurement;
  readonly secondary?: Readonly<{
    label: string;
    measurement: FormattedMeasurement;
  }>;
}

interface ForecastCardValue {
  readonly readings: readonly Readonly<{
    label: string;
    measurement: FormattedMeasurement;
    tone?: ForecastTone;
  }>[];
}

type ForecastTone = "blue" | "burgundy" | "gold" | "gray" | "green" | "neutral" | "orange" | "purple" | "red" | "yellow";

// describe one synchronized forecast chart
interface ForecastChartDefinition {
  readonly domain?: Readonly<{ maximum: number; minimum: number }>;
  readonly format: ForecastChartFormat;
  readonly icon: MaterialIconName;
  readonly key: string;
  readonly label: string;
  readonly series: readonly ForecastChartSeries[];
}

// describe one line inside a forecast chart
interface ForecastChartSeries {
  readonly label: string;
  readonly values: readonly (number | null)[];
}

type ForecastChartFormat =
  | "airQuality"
  | "humidity"
  | "precipitationRate"
  | "pressure"
  | "temperature"
  | "uvIndex"
  | "waterLevel"
  | "windSpeed";

type MaterialIconName =
  | "air"
  | "cloud"
  | "close"
  | "device_thermostat"
  | "history"
  | "home"
  | "humidity_percentage"
  | "map"
  | "masks"
  | "partly_cloudy_day"
  | "radar"
  | "rainy"
  | "settings"
  | "speed"
  | "trending_up"
  | "water"
  | "wb_sunny";

type RgbColor = readonly [number, number, number];

type WeatherMetricKey = keyof WeatherRecord["metrics"];
type TrendMetricKey = keyof TrendPoint["metrics"];

// render threshold-based local weather watches
function renderAlerts(state: DashboardState): string {
  const alerts = deriveAlerts(state);

  // hide the watch region when every threshold is clear
  if (alerts.length === 0) {
    return "";
  }

  return `
    <section class="alert-list" aria-label="Conditions to watch">
      ${alerts.map((alert) => `<article class="local-alert ${alert.tone}"><strong>${escapeHtml(alert.label)}</strong><span>${escapeHtml(alert.detail)}</span></article>`).join("")}
    </section>
  `;
}

// derive bounded operational watches from normalized values
function deriveAlerts(state: DashboardState): readonly LocalWeatherAlert[] {
  const alerts: LocalWeatherAlert[] = [];
  const forecastLow = minimumMetric(state.forecast, "temperatureC");
  const apparentHigh = maximumMetric(state.current, "apparentTemperatureC");
  const wetBulbHigh = maximumMetric(state.current, "wetBulbGlobeTemperatureC");
  const windHigh = maximumMetric(
    [...state.current, ...state.forecast],
    "windGustMps",
  );
  const rainRate = maximumMetric(state.current, "precipitationRateMmPerHour");
  const forecastRain = maximumMetric(state.forecast, "precipitationMm");
  const pm25 = maximumMetric(state.current, "pm25MicrogramsPerCubicMeter");

  // flag forecast frost
  if (forecastLow !== null && forecastLow <= 0) {
    const measurement = formatMeasurement(forecastLow, "temperature", state.units);
    alerts.push({
      detail: `Forecast low ${measurement.value}${measurement.unit}`,
      label: "Frost possible",
      tone: "caution",
    });
  }

  // flag heat-stress conditions
  if (
    (apparentHigh !== null && apparentHigh >= 32.2) ||
    (wetBulbHigh !== null && wetBulbHigh >= 29)
  ) {
    alerts.push({
      detail: "Apparent temperature or wet-bulb globe temperature is elevated",
      label: "Heat stress",
      tone: "danger",
    });
  }

  // flag damaging gust potential
  if (windHigh !== null && windHigh >= 15.65) {
    const measurement = formatMeasurement(windHigh, "windSpeed", state.units);
    alerts.push({
      detail: `Gusts reaching ${measurement.value} ${measurement.unit}`,
      label: "High wind",
      tone: "danger",
    });
  }

  // flag heavy observed or forecast precipitation
  if (
    (rainRate !== null && rainRate >= 7.62) ||
    (forecastRain !== null && forecastRain >= 6.35)
  ) {
    alerts.push({
      detail: "Heavy hourly rainfall is observed or forecast",
      label: "Heavy rain",
      tone: "caution",
    });
  }

  // flag unhealthy particulate levels
  if (pm25 !== null && pm25 >= 35.5) {
    alerts.push({
      detail: `PM2.5 is ${formatNumber(pm25)} µg/m³`,
      label: "Air quality",
      tone: "danger",
    });
  }

  return alerts;
}

// render the site-local forecast day
function renderForecast(state: DashboardState): string {
  const days = state.forecastDays ?? 1;
  const reference = state.current.find(
    // align the timeline with the current model day
    (record) => record.provenance.sourceKind === "model_current",
  )?.validAt ?? state.forecast[0]?.validAt;
  const hours = reference === undefined
    ? []
    : forecastForSiteDays(
        state.forecast,
        reference,
        state.selectedSite?.timezone ?? "UTC",
        days,
      );

  // render an honest ingestion warm-up state
  if (hours.length === 0) {
    // reserve the final forecast charts during the first read
    if (state.loading) {
      return renderForecastSkeleton(state);
    }

    return `
      <section class="panel forecast-panel" aria-label="Weather forecast">
        <div class="forecast-controls">${renderForecastRangeSelector(days, state.loading)}</div>
        <p class="empty-panel">The first normalized forecast product is being collected.</p>
      </section>
    `;
  }

  const charts = buildForecastCharts(hours, state.tides);
  const hourlyTimes = hours.map(
    // retain one shared continuous clock
    (record) => record.validAt,
  );
  const finalHourlyTime = hourlyTimes.at(-1) ?? hours[0]!.validAt;
  const finalBoundary = new Date(new Date(finalHourlyTime).getTime() + 60 * 60 * 1_000).toISOString();
  const forecastTimes = [...hourlyTimes, finalBoundary];
  const daylightBands = renderForecastDaylightBands(hours.map(
    // align every chart's light bands to the shared hourly axis
    (hour) => forecastDaylightState(hour, state.selectedSite?.timezone),
  ));
  const dayMarkers = renderForecastDayMarkers(
    hours,
    state.selectedSite?.timezone,
    days,
  );
  const currentPosition = forecastPositionForInstant(hours, reference ?? hours[0]?.validAt);
  const selectedIndex = Math.max(0, Math.min(hours.length - 1, Math.round(currentPosition)));
  const selectedTime = interpolateForecastInstant(forecastTimes, currentPosition);

  return `
    <section class="panel forecast-panel" aria-label="Weather forecast">
      <div class="forecast-controls">${renderForecastRangeSelector(days, state.loading)}</div>
      <div class="forecast-chart-shell">
        <div class="forecast-current-time-line" aria-hidden="true"></div>
        <div class="forecast-shared-crosshair" aria-hidden="true"></div>
        <div
          class="forecast-chart-grid"
          data-forecast-charts
          data-forecast-days="${String(days)}"
          data-forecast-initial-index="${String(currentPosition)}"
          data-forecast-current-position="${String(currentPosition)}"
          data-forecast-times="${escapeHtml(JSON.stringify(forecastTimes))}"
          tabindex="0"
          role="slider"
          aria-label="Forecast time scrubber"
          aria-valuemin="0"
          aria-valuemax="${String(Math.max(0, forecastTimes.length - 1))}"
          aria-valuenow="${String(selectedIndex)}"
        >
          <div class="forecast-current-time-label" aria-hidden="true"><span>Now</span></div>
          <div class="forecast-crosshair-label" aria-hidden="true">
            <time data-forecast-crosshair-time datetime="${escapeHtml(selectedTime)}">${formatForecastHour(selectedTime, state.selectedSite?.timezone, days)}</time>
          </div>
          ${charts.map(
            // render every current-condition forecast chart
            (chart) => renderForecastChart(chart, selectedIndex, state.units, daylightBands, dayMarkers, days),
          ).join("")}
        </div>
        ${days === 1 ? renderForecastWeatherMap(state, hours, reference ?? hours[0]?.validAt) : ""}
        ${renderForecastXAxis(hours, state.selectedSite?.timezone, days)}
      </div>
    </section>
  `;
}

const FORECAST_MAP_HEIGHT = 168;
const FORECAST_MAP_WIDTH = 256;
const FORECAST_MAP_ZOOM = 10;
const FORECAST_MAP_FORECAST_INTERVAL_MS = 60 * 60 * 1_000;
const FORECAST_MAP_CLIENT_CACHE_NAME = "weather-xweather-tiles-v1";
const FORECAST_MAP_CLIENT_CACHE_TIMESTAMP_HEADER = "X-Weather-Client-Cached-At";
const FORECAST_MAP_CLIENT_FORECAST_FRESHNESS_MS = 60 * 60 * 1_000;
const FORECAST_MAP_LAYERS: readonly Readonly<{
  icon: MaterialIconName;
  key: ForecastMapLayer;
  label: string;
}>[] = [
  { icon: "radar", key: "radar", label: "Radar" },
  { icon: "cloud", key: "clouds", label: "Clouds" },
  { icon: "rainy", key: "precipitation", label: "Rain" },
  { icon: "air", key: "wind", label: "Wind" },
];

interface ForecastMapLegendPresentation {
  readonly labels: readonly string[];
  readonly title: string;
  readonly unit: string | null;
}

// select one documented Xweather overlay legend
function forecastMapLegend(
  layer: ForecastMapLayer,
  phase: ForecastMapPhase,
): ForecastMapLegendPresentation {
  // match each public overlay to its raster color scale
  switch (layer) {
    case "radar":
      return { labels: ["10", "30", "50", "70+"], title: "Radar intensity", unit: "dBZ" };
    case "clouds":
      return {
        labels: ["Clear", "Dense"],
        title: phase === "history" ? "Satellite clouds" : "Forecast clouds",
        unit: null,
      };
    case "precipitation":
      return {
        labels: phase === "history" ? ["0", "1", "3", "5+"] : ["0", "2", "6", "10+"],
        title: phase === "history" ? "Past-hour rain" : "Forecast 1-hour rain",
        unit: "in",
      };
    case "wind":
      return { labels: ["0", "20", "50", "100"], title: "Wind speed", unit: "mph" };
  }
}

// render one compact overlay scale
function renderForecastMapLegendContent(
  presentation: ForecastMapLegendPresentation,
): string {
  return `
    <p><strong>${presentation.title}</strong>${presentation.unit === null ? "" : `<span>${presentation.unit}</span>`}</p>
    <span class="forecast-map-legend-bar" aria-hidden="true"></span>
    <span class="forecast-map-legend-labels">
      ${presentation.labels.map(
        // render every scale stop label
        (label) => `<small>${label}</small>`,
      ).join("")}
    </span>
  `;
}

// render the Today-only observed and forecast weather map
function renderForecastWeatherMap(
  state: DashboardState,
  hours: readonly WeatherRecord[],
  reference: string | undefined,
): string {
  const site = state.selectedSite;
  const first = hours[0]?.validAt;
  const last = hours.at(-1)?.validAt;

  // require one complete site-local day contract
  if (site === null || first === undefined || last === undefined || reference === undefined) {
    return "";
  }

  const startMs = new Date(first).getTime();
  const endMs = new Date(last).getTime() + 60 * 60 * 1_000;
  const nowMs = Math.max(startMs, Math.min(endMs, new Date(reference).getTime()));
  const mapStepMs = 10 * 60 * 1_000;
  const initialCacheFrames = 7;
  const initialMs = startMs + Math.floor((nowMs - startMs) / mapStepMs) * mapStepMs;
  const selectedLayer: ForecastMapLayer = "radar";
  const initialPhase: ForecastMapPhase = initialMs <= nowMs ? "history" : "forecast";
  const initialLegend = forecastMapLegend(selectedLayer, initialPhase);
  const viewport = createCenteredMapViewport(
    site.latitude,
    site.longitude,
    FORECAST_MAP_WIDTH,
    FORECAST_MAP_HEIGHT,
    FORECAST_MAP_ZOOM,
  );
  const sitePoint = projectMapPoint(site.latitude, site.longitude, viewport);
  const initialTime = new Date(initialMs).toISOString();

  return `
    <div
      class="forecast-weather-map"
      data-forecast-weather-map
      data-forecast-map-start="${String(startMs)}"
      data-forecast-map-now="${String(nowMs)}"
      data-forecast-map-end="${String(endMs)}"
      data-forecast-map-step="${String(mapStepMs)}"
      data-forecast-map-selected="${String(initialMs)}"
      data-forecast-map-layer="${selectedLayer}"
      data-forecast-map-timezone="${escapeHtml(site.timezone)}"
      aria-busy="false"
    >
      <div class="forecast-map-canvas" role="img" aria-label="Radar near ${escapeHtml(site.name)} at ${escapeHtml(formatForecastMapTime(initialTime, site.timezone))}">
        <svg class="forecast-map-svg" data-forecast-map-scrubber viewBox="0 0 ${FORECAST_MAP_WIDTH} ${FORECAST_MAP_HEIGHT}" focusable="false" aria-hidden="true">
          <g class="map-tile-layer">
            ${renderMapTiles("roads", viewport, FORECAST_MAP_WIDTH, FORECAST_MAP_HEIGHT)}
          </g>
          <g class="forecast-map-weather-layer">
            ${renderForecastWeatherFrame(selectedLayer, "history", initialTime, site)}
          </g>
          <g class="forecast-map-place-layer">
            <circle cx="${sitePoint.x.toFixed(2)}" cy="${sitePoint.y.toFixed(2)}" r="8" class="farm-marker"/>
            <text x="${(sitePoint.x + 13).toFixed(2)}" y="${(sitePoint.y + 4).toFixed(2)}">Ballydídean</text>
          </g>
        </svg>
        <div class="forecast-map-layer-controls" role="group" aria-label="Weather map layer">
          ${FORECAST_MAP_LAYERS.map(
            // render each weather overlay choice
            (layer) => `<button type="button" data-forecast-map-layer="${layer.key}" aria-pressed="${String(layer.key === selectedLayer)}">${renderMaterialIcon(layer.icon)}<span>${layer.label}</span></button>`,
          ).join("")}
        </div>
        <div class="forecast-map-selection-phase" data-forecast-map-selection-phase="${initialPhase}" aria-hidden="true">
          <span data-forecast-map-selection-phase-label>${initialPhase === "history" ? "Historical" : "Forecast"}</span>
        </div>
        <div
          class="forecast-map-legend"
          data-forecast-map-legend
          data-forecast-map-legend-layer="${selectedLayer}"
          data-forecast-map-legend-phase="${initialPhase}"
          role="img"
          aria-label="${initialLegend.title} color legend"
        >
          ${renderForecastMapLegendContent(initialLegend)}
        </div>
        <div
          class="forecast-map-cache-progress"
          data-forecast-map-cache-progress
          aria-label="Map cache progress"
          hidden
        >
          <p><strong data-forecast-map-cache-label>Caching Radar</strong><span data-forecast-map-cache-percent>0%</span></p>
          <progress data-forecast-map-cache-bar max="${String(initialCacheFrames)}" value="0" aria-label="Cached nearby Radar map frames"></progress>
          <small data-forecast-map-cache-count>0 of ${String(initialCacheFrames)} nearby frames ready</small>
        </div>
        <div class="forecast-map-loading" data-forecast-map-loading hidden aria-hidden="true"></div>
        <p class="forecast-map-error" data-forecast-map-error hidden>Weather tiles are temporarily unavailable.</p>
      </div>
    </div>
  `;
}

// create one fixed weather-map viewport around the farm
function createCenteredMapViewport(
  latitude: number,
  longitude: number,
  width: number,
  height: number,
  zoom: number,
): MapViewport {
  const center = webMercatorPoint(latitude, longitude, zoom);
  return {
    left: center.x - width / 2,
    top: center.y - height / 2,
    zoom,
  };
}

// render one aligned transparent Xweather static frame
function renderForecastWeatherFrame(
  layer: ForecastMapLayer,
  phase: ForecastMapPhase,
  validAt: string,
  site: WeatherSite,
  loadImmediately = false,
): string {
  const validTime = xweatherValidTime(validAt);
  const url = xweatherFrameUrl(phase, layer, validTime, FORECAST_MAP_ZOOM, FORECAST_MAP_WIDTH, FORECAST_MAP_HEIGHT, site.latitude, site.longitude);
  const immediateSource = loadImmediately ? ` href="${escapeHtml(url)}" fetchpriority="high"` : "";
  return `<image class="forecast-map-weather-tile" data-forecast-map-tile data-map-zoom="${String(FORECAST_MAP_ZOOM)}" data-map-width="${String(FORECAST_MAP_WIDTH)}" data-map-height="${String(FORECAST_MAP_HEIGHT)}" data-map-latitude="${site.latitude.toFixed(6)}" data-map-longitude="${site.longitude.toFixed(6)}" data-map-tile-url="${escapeHtml(url)}"${immediateSource} x="0" y="0" width="${String(FORECAST_MAP_WIDTH)}" height="${String(FORECAST_MAP_HEIGHT)}" preserveAspectRatio="none"/>`;
}

// build one same-origin Xweather static-frame proxy URL
function xweatherFrameUrl(
  phase: ForecastMapPhase,
  layer: ForecastMapLayer,
  validTime: string,
  zoom: number,
  width: number,
  height: number,
  latitude: number,
  longitude: number,
): string {
  return `/maps/xweather/${phase}/${layer}/${validTime}/${String(zoom)}/${String(width)}x${String(height)}/${latitude.toFixed(6)},${longitude.toFixed(6)}.png`;
}

// format one UTC instant for the Xweather tile API
function xweatherValidTime(value: string): string {
  const instant = new Date(value);
  return [
    String(instant.getUTCFullYear()).padStart(4, "0"),
    String(instant.getUTCMonth() + 1).padStart(2, "0"),
    String(instant.getUTCDate()).padStart(2, "0"),
    String(instant.getUTCHours()).padStart(2, "0"),
    String(instant.getUTCMinutes()).padStart(2, "0"),
    String(instant.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

// format one site-local weather-map clock
function formatForecastMapTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(value));
}

// render the reviewed forecast horizon control
function renderForecastRangeSelector(
  selected: ForecastDays,
  loading: boolean,
): string {
  const options: readonly Readonly<{ days: ForecastDays; label: string }>[] = [
    { days: 1, label: "Today" },
    { days: 5, label: "5 days" },
    { days: 10, label: "10 days" },
  ];
  return `
    <div class="range-selector forecast-range-selector" role="group" aria-label="Forecast range">
      ${options.map(
        // render each reviewed forecast horizon
        (option) => `<button type="button" data-forecast-days="${String(option.days)}" aria-pressed="${String(selected === option.days)}"${loading ? " disabled" : ""}>${option.label}</button>`,
      ).join("")}
    </div>
  `;
}

// reserve one complete forecast chart stack
function renderForecastSkeleton(state: DashboardState): string {
  const charts: readonly Readonly<{ icon: MaterialIconName; label: string }>[] = [
    { icon: "device_thermostat", label: "Temperature" },
    { icon: "air", label: "Wind" },
    { icon: "rainy", label: "Rain rate" },
    { icon: "humidity_percentage", label: "Humidity" },
    { icon: "masks", label: "Air quality" },
    { icon: "wb_sunny", label: "UV index" },
    { icon: "speed", label: "Pressure" },
    { icon: "water", label: "Tide" },
  ];
  const site = state.selectedSite ?? PRODUCT_SITE;
  const previewMs = Math.floor(Date.now() / (10 * 60 * 1_000)) * 10 * 60 * 1_000;
  const previewTime = new Date(previewMs).toISOString();
  const viewport = createCenteredMapViewport(
    site.latitude,
    site.longitude,
    FORECAST_MAP_WIDTH,
    FORECAST_MAP_HEIGHT,
    FORECAST_MAP_ZOOM,
  );
  const sitePoint = projectMapPoint(site.latitude, site.longitude, viewport);
  const previewLegend = forecastMapLegend("radar", "history");

  return `
    <section class="panel forecast-panel skeleton-region" aria-label="Loading weather forecast" aria-busy="true">
      <div class="forecast-controls">${renderForecastRangeSelector(1, true)}</div>
      <div class="forecast-chart-shell" aria-label="Loading weather forecast charts for today">
        <div class="forecast-chart-grid">
          ${charts.map(
            // preserve every final chart frame
            (chart) => `
              <article class="forecast-chart skeleton-forecast-chart" aria-label="${chart.label} forecast loading">
                <div class="forecast-chart-heading forecast-chart-heading-top"><h3>${renderMaterialIcon(chart.icon)}<span>${chart.label}</span></h3></div>
                <div class="forecast-chart-plot" aria-hidden="true"><svg viewBox="0 0 720 150" focusable="false"><rect class="skeleton-chart-fill" width="720" height="150" rx="8"/></svg></div>
              </article>
            `,
          ).join("")}
        </div>
        <div class="forecast-weather-map skeleton-forecast-map" aria-busy="true">
          <div class="forecast-map-canvas" role="img" aria-label="Loading radar near ${escapeHtml(site.name)}">
            <svg class="forecast-map-svg" viewBox="0 0 ${FORECAST_MAP_WIDTH} ${FORECAST_MAP_HEIGHT}" focusable="false" aria-hidden="true">
              <g class="map-tile-layer">
                ${renderMapTiles("roads", viewport, FORECAST_MAP_WIDTH, FORECAST_MAP_HEIGHT)}
              </g>
              <g class="forecast-map-weather-layer">
                ${renderForecastWeatherFrame("radar", "history", previewTime, site, true)}
              </g>
              <g class="forecast-map-place-layer">
                <circle cx="${sitePoint.x.toFixed(2)}" cy="${sitePoint.y.toFixed(2)}" r="8" class="farm-marker"/>
                <text x="${(sitePoint.x + 13).toFixed(2)}" y="${(sitePoint.y + 4).toFixed(2)}">Ballydídean</text>
              </g>
            </svg>
            <div class="forecast-map-layer-controls" role="group" aria-label="Weather map layer loading">
              ${FORECAST_MAP_LAYERS.map(
                // preserve every final layer control
                (layer) => `<button type="button" aria-pressed="${String(layer.key === "radar")}" disabled>${renderMaterialIcon(layer.icon)}<span>${layer.label}</span></button>`,
              ).join("")}
            </div>
            <div class="forecast-map-selection-phase" data-forecast-map-selection-phase="history" aria-hidden="true"><span>Historical</span></div>
            <div class="forecast-map-legend" data-forecast-map-legend-layer="radar" data-forecast-map-legend-phase="history" role="img" aria-label="${previewLegend.title} color legend">
              ${renderForecastMapLegendContent(previewLegend)}
            </div>
          </div>
        </div>
        <div class="forecast-x-axis" aria-hidden="true">
          ${Array.from({ length: 24 },
            // preserve every final hourly tick
            (_, index) => `<span class="forecast-x-tick" data-forecast-light="${index >= 7 && index < 19 ? "day" : "night"}">${index % 6 === 0 || index === 23 ? `<time>${formatForecastAxisHour(new Date(Date.UTC(2026, 0, 1, index)).toISOString(), "UTC")}</time>` : ""}</span>`,
          ).join("")}
        </div>
      </div>
    </section>
  `;
}

// build the eight current-condition forecast series
function buildForecastCharts(
  hours: readonly WeatherRecord[],
  tides: readonly TideRecord[],
): readonly ForecastChartDefinition[] {
  const metric = (key: WeatherMetricKey): readonly (number | null)[] => hours.map(
    // align every weather metric to the shared hourly index
    (record) => record.metrics[key],
  );

  return [
    {
      domain: { maximum: 26.666_666_666_7, minimum: -1.111_111_111_1 },
      format: "temperature",
      icon: "device_thermostat",
      key: "temperature",
      label: "Temperature",
      series: [
        { label: "Air", values: metric("temperatureC") },
        { label: "Feels", values: metric("apparentTemperatureC") },
      ],
    },
    {
      domain: { maximum: 22.351_999_999_5, minimum: 0 },
      format: "windSpeed",
      icon: "air",
      key: "wind",
      label: "Wind",
      series: [
        { label: "Wind", values: metric("windSpeedMps") },
        { label: "Gust", values: metric("windGustMps") },
      ],
    },
    {
      domain: { maximum: 25.4, minimum: 0 },
      format: "precipitationRate",
      icon: "rainy",
      key: "rain-rate",
      label: "Rain rate",
      series: [{
        label: "Rate",
        values: hours.map(
          // prefer the direct forecast rate
          (record) => record.metrics.precipitationRateMmPerHour ?? record.metrics.precipitationMm,
        ),
      }],
    },
    {
      format: "humidity",
      icon: "humidity_percentage",
      key: "humidity",
      label: "Humidity",
      series: [{ label: "Humidity", values: metric("relativeHumidityPercent") }],
    },
    {
      domain: HISTORICAL_FORECAST_DOMAINS.airQuality,
      format: "airQuality",
      icon: "masks",
      key: "air-quality",
      label: "Air quality",
      series: [{ label: "PM2.5", values: metric("pm25MicrogramsPerCubicMeter") }],
    },
    {
      domain: FIXED_FORECAST_DOMAINS.uvIndex,
      format: "uvIndex",
      icon: "wb_sunny",
      key: "uv-index",
      label: "UV index",
      series: [{ label: "Index", values: metric("uvIndex") }],
    },
    {
      domain: HISTORICAL_FORECAST_DOMAINS.pressure,
      format: "pressure",
      icon: "speed",
      key: "pressure",
      label: "Pressure",
      series: [{ label: "Pressure", values: metric("pressureHpa") }],
    },
    {
      domain: FIXED_FORECAST_DOMAINS.tide,
      format: "waterLevel",
      icon: "water",
      key: "tide",
      label: "Tide",
      series: [{ label: "Level", values: forecastTideValues(hours, tides) }],
    },
  ];
}

// render one dependency-free synchronized SVG forecast chart
function renderForecastChart(
  chart: ForecastChartDefinition,
  selectedIndex: number,
  units: UnitPreferences,
  daylightBands: string,
  dayMarkers: string,
  days: ForecastDays,
): string {
  const width = 720;
  const height = 150;
  const edgePadding = 12;
  const headingPadding = 52;
  const domain = chart.domain ?? forecastChartDomain(chart.series);
  const scaleMaximum = formatForecastChartAxisValue(domain.maximum, chart.format, units);
  const scaleMinimum = formatForecastChartAxisValue(domain.minimum, chart.format, units);
  const valueEdge = forecastValueLabelEdge(
    chart.series.map(
      // read every initial selector intersection
      (series) => series.values[selectedIndex] ?? null,
    ),
    domain.minimum,
    domain.maximum,
  );
  const paddingBottom = edgePadding;
  const paddingTop = headingPadding;

  return `
    <article
      class="forecast-chart"
      data-forecast-chart="${escapeHtml(chart.key)}"
      data-forecast-format="${chart.format}"
      data-forecast-min="${String(domain.minimum)}"
      data-forecast-max="${String(domain.maximum)}"
      data-forecast-series="${escapeHtml(JSON.stringify(chart.series))}"
    >
      <div class="forecast-chart-heading forecast-chart-heading-top"><h3>${renderMaterialIcon(chart.icon)}<span>${escapeHtml(chart.label)}</span></h3></div>
      <div class="forecast-chart-plot">
        ${daylightBands}
        ${dayMarkers}
        <span class="forecast-chart-scale forecast-chart-scale-maximum">${escapeHtml(scaleMaximum)}</span>
        <span class="forecast-chart-scale forecast-chart-scale-minimum">${escapeHtml(scaleMinimum)}</span>
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(chart.label)} forecast for ${days === 1 ? "today" : `${String(days)} days`}">
          <defs>
            ${chart.series.map(
              // color every line with the matching condition scale
              (series, seriesIndex) => renderForecastLineGradient(chart, series, seriesIndex),
            ).join("")}
          </defs>
          ${chart.series.map(
            // draw every available series
            (series, seriesIndex) => {
              const boundaryValues = series.values.length === 0
                ? []
                : [...series.values, series.values.at(-1) ?? null];
              const points = boundaryValues.flatMap(
                // omit missing values from the line
                (value, index) => value === null || !Number.isFinite(value)
                  ? []
                  : [`${((index / Math.max(1, boundaryValues.length - 1)) * width).toFixed(2)},${forecastChartY(value, domain.minimum, domain.maximum, height, paddingTop, paddingBottom).toFixed(2)}`],
              ).join(" ");
              return `<polyline points="${points}" class="forecast-chart-line forecast-chart-line-${String(seriesIndex)}" stroke="url(#${forecastLineGradientId(chart.key, seriesIndex)})"/>`;
            },
          ).join("")}
        </svg>
        <output class="forecast-chart-value forecast-chart-value-${valueEdge}" aria-live="off">
          ${chart.series.map(
            // show every value intersecting the shared line
            (series, seriesIndex) => `<span><small>${escapeHtml(series.label)}</small><strong data-forecast-value="${String(seriesIndex)}">${escapeHtml(compactMeasurement(formatForecastChartValue(series.values[selectedIndex] ?? null, chart.format, units)) ?? "—")}</strong></span>`,
          ).join("")}
        </output>
      </div>
    </article>
  `;
}

// place one value pill opposite its line intersections
function forecastValueLabelEdge(
  values: readonly (number | null)[],
  minimum: number,
  maximum: number,
): "bottom" | "top" {
  const positions = values.flatMap(
    // normalize every available selector intersection
    (value) => value === null || !Number.isFinite(value)
      ? []
      : [Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))],
  );

  // retain the familiar lower edge without data
  if (positions.length === 0) {
    return "bottom";
  }

  const average = positions.reduce(
    // combine multi-line selector intersections
    (total, position) => total + position,
    0,
  ) / positions.length;
  return average >= 0.5 ? "bottom" : "top";
}

// use one population deviation from the normalized local archives
const HISTORICAL_FORECAST_DOMAINS = {
  airQuality: { maximum: 14.488_261_472_4, minimum: 0 },
  pressure: { maximum: 1_020.904_338_320_5, minimum: 1_006.795_791_563_2 },
} as const;

// retain the requested consumer chart scales in canonical units
const FIXED_FORECAST_DOMAINS = {
  tide: { maximum: 3.6576, minimum: -0.3048 },
  uvIndex: { maximum: 4, minimum: 0 },
} as const;

// render one CSP-safe condition-color gradient
function renderForecastLineGradient(
  chart: ForecastChartDefinition,
  series: ForecastChartSeries,
  seriesIndex: number,
): string {
  const boundaryValues = series.values.length === 0
    ? []
    : [...series.values, series.values.at(-1) ?? null];
  const denominator = Math.max(1, boundaryValues.length - 1);
  return `
    <linearGradient id="${forecastLineGradientId(chart.key, seriesIndex)}" x1="0%" y1="0%" x2="100%" y2="0%">
      ${boundaryValues.map(
        // align every color stop with its forecast hour
        (value, index) => `<stop offset="${((index / denominator) * 100).toFixed(3)}%" stop-color="${escapeHtml(forecastLineColor(chart.format, value, index, boundaryValues))}"/>`,
      ).join("")}
    </linearGradient>
  `;
}

// create one document-safe line gradient identifier
function forecastLineGradientId(chartKey: string, seriesIndex: number): string {
  return `forecast-line-${chartKey}-${String(seriesIndex)}`;
}

// match each plotted value to its current-condition color
function forecastLineColor(
  format: ForecastChartFormat,
  value: number | null,
  index: number,
  values: readonly (number | null)[],
): string {
  switch (format) {
    case "temperature":
      return temperatureBand(value).color;
    case "windSpeed":
      return windBand(value, value).color;
    case "precipitationRate":
      return rainBand(value).color;
    case "airQuality":
      return airQualityBand(value).color;
    case "uvIndex":
      return uvBand(value).color;
    case "pressure":
      return pressureBand(value).color;
    case "humidity":
      return humidityBand(value).color;
    case "waterLevel": {
      const previous = values[index - 1];

      // show the same rise-and-fall colors as the tide card
      if (value === null || previous === undefined || previous === null) {
        return unavailableBand("Tide forecast unavailable").color;
      }

      return value >= previous ? "rgb(56, 120, 197)" : "rgb(124, 81, 116)";
    }
  }
}

// render one shared forecast time axis
function renderForecastXAxis(
  hours: readonly WeatherRecord[],
  timezone?: string,
  days: ForecastDays = 1,
): string {
  const finalIndex = Math.max(0, hours.length - 1);
  const labelIndexes = forecastAxisLabelIndexes(hours, timezone, days);
  return `<div class="forecast-x-axis" aria-label="Forecast hourly time axis with day and night shading">${hours.map(
    // render every static hourly tick
    (hour, index) => {
      const showLabel = days === 1
        ? index % 6 === 0 || index === finalIndex
        : labelIndexes.has(index);
      const light = forecastDaylightState(hour, timezone) ? "day" : "night";
      return `<span class="forecast-x-tick" data-forecast-light="${light}"${showLabel ? ' data-major="true"' : ""}>${showLabel ? `<time datetime="${escapeHtml(hour.validAt)}">${days === 1 ? formatForecastAxisHour(hour.validAt, timezone) : formatForecastAxisDate(hour.validAt, timezone)}</time>` : ""}</span>`;
    },
  ).join("")}</div>`;
}

// choose readable local-date labels for extended ranges
function forecastAxisLabelIndexes(
  hours: readonly WeatherRecord[],
  timezone: string | undefined,
  days: ForecastDays,
): ReadonlySet<number> {
  const labels = new Set<number>();
  const seenDates = new Set<string>();
  let dateIndex = 0;

  // visit the first hour from each site-local date
  for (const [index, hour] of hours.entries()) {
    const date = forecastSiteDateKey(hour.validAt, timezone ?? "UTC");

    // skip repeated hours inside one date
    if (seenDates.has(date)) {
      continue;
    }

    seenDates.add(date);

    // label every date for five days and alternating dates for ten
    if (days === 5 || dateIndex % 2 === 0) {
      labels.add(index);
    }

    dateIndex += 1;
  }

  // retain the final visible endpoint
  if (hours.length > 0) {
    labels.add(hours.length - 1);
  }

  return labels;
}

// render CSP-safe hourly daylight bands
function renderForecastDaylightBands(states: readonly boolean[]): string {
  return `<div class="forecast-chart-daylight" aria-hidden="true">${states.map(
    // preserve one equal-width band per forecast hour
    (daylight) => `<span data-forecast-light="${daylight ? "day" : "night"}"></span>`,
  ).join("")}</div>`;
}

// render site-local midnight dividers and day panels for extended ranges
function renderForecastDayMarkers(
  hours: readonly WeatherRecord[],
  timezone: string | undefined,
  days: ForecastDays,
): string {
  // keep today's compact chart free of redundant day dividers
  if (days === 1) {
    return "";
  }

  return `<div class="forecast-chart-days" aria-hidden="true">${hours.map(
    // align every divider to its exact hourly cell
    (hour, index) => {
      const date = forecastSiteDateKey(hour.validAt, timezone ?? "UTC");
      const previousDate = index === 0
        ? null
        : forecastSiteDateKey(hours[index - 1]?.validAt ?? hour.validAt, timezone ?? "UTC");
      const startsDay = date !== previousDate;
      return startsDay
        ? `<span class="forecast-chart-day-start" data-forecast-day="${date}"><b>${escapeHtml(formatForecastDayPanel(hour.validAt, timezone))}</b></span>`
        : "<span></span>";
    },
  ).join("")}</div>`;
}

// classify one modeled hour as daylight
function forecastDaylightState(
  hour: WeatherRecord,
  timezone?: string,
): boolean {
  // prefer modeled surface sunlight
  if (hour.metrics.solarRadiationWm2 !== null) {
    return hour.metrics.solarRadiationWm2 > 0;
  }

  // use modeled ultraviolet light when radiation is unavailable
  if (hour.metrics.uvIndex !== null) {
    return hour.metrics.uvIndex > 0;
  }

  const localHour = Number(new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: timezone ?? "UTC",
  }).format(new Date(hour.validAt)));
  return localHour >= 7 && localHour < 19;
}

// locate one instant continuously on the shared hourly axis
function forecastPositionForInstant(
  hours: readonly WeatherRecord[],
  reference?: string,
): number {
  // start at the first hour without a usable clock
  if (hours.length === 0 || reference === undefined) {
    return 0;
  }

  const target = new Date(reference).getTime();
  const first = new Date(hours[0]?.validAt ?? reference).getTime();

  // clamp times before the forecast day
  if (target <= first) {
    return 0;
  }

  // locate the surrounding hourly pair
  for (let index = 1; index < hours.length; index += 1) {
    const previous = new Date(hours[index - 1]?.validAt ?? reference).getTime();
    const next = new Date(hours[index]?.validAt ?? reference).getTime();

    // interpolate inside the located interval
    if (target <= next) {
      return index - 1 + (target - previous) / Math.max(1, next - previous);
    }
  }

  return Math.max(0, hours.length - 1);
}

// derive a padded chart range across every visible line
function forecastChartDomain(
  series: readonly ForecastChartSeries[],
): Readonly<{ maximum: number; minimum: number }> {
  const values = series.flatMap(
    // retain finite chart values only
    (line) => line.values.filter((value): value is number => value !== null && Number.isFinite(value)),
  );

  // provide a stable empty chart range
  if (values.length === 0) {
    return { maximum: 1, minimum: 0 };
  }

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);

  // expand a flat series visibly
  if (minimum === maximum) {
    const padding = Math.max(1, Math.abs(minimum) * 0.05);
    return { maximum: maximum + padding, minimum: minimum - padding };
  }

  const padding = (maximum - minimum) * 0.08;
  return { maximum: maximum + padding, minimum: minimum - padding };
}

// map one chart value into the SVG plot height
function forecastChartY(
  value: number,
  minimum: number,
  maximum: number,
  height: number,
  paddingTop: number,
  paddingBottom: number,
): number {
  const position = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return height - paddingBottom - position * (height - paddingTop - paddingBottom);
}

// format one forecast chart value in the browser preference
function formatForecastChartValue(
  value: number | null,
  format: ForecastChartFormat,
  units: UnitPreferences,
): FormattedMeasurement {
  // preserve unavailable intersections
  if (value === null || !Number.isFinite(value)) {
    return { unit: "", value: "—" };
  }

  switch (format) {
    case "temperature":
      return formatMeasurement(value, "temperature", units, 0);
    case "windSpeed":
      return formatMeasurement(value, "windSpeed", units, 0);
    case "precipitationRate":
      return formatPrecipitationRate(value, units);
    case "airQuality":
      return formatFixedMeasurement(value, "µg/m³", 0);
    case "uvIndex":
      return formatFixedMeasurement(value, "", 1);
    case "pressure":
      return formatMeasurement(value, "pressure", units, 1);
    case "humidity":
      return formatFixedMeasurement(value, "%", 0);
    case "waterLevel":
      return formatMeasurement(value, "waterLevel", units, 1);
  }
}

// format one compact fixed-domain endpoint
function formatForecastChartAxisValue(
  value: number,
  format: ForecastChartFormat,
  units: UnitPreferences,
): string {
  const measurement = formatForecastChartValue(value, format, units);
  return compactMeasurement(measurement) ?? "—";
}

// interpolate NOAA high and low tide events onto the hourly forecast clock
function forecastTideValues(
  hours: readonly WeatherRecord[],
  tides: readonly TideRecord[],
): readonly (number | null)[] {
  const predictions = tides.filter(
    // retain reviewed high and low events only
    (record) => record.kind === "prediction" && record.eventType !== null,
  ).toSorted((left, right) => new Date(left.validAt).getTime() - new Date(right.validAt).getTime());
  return hours.map(
    // interpolate one hourly level between adjacent extrema
    (hour) => interpolateTidePrediction(new Date(hour.validAt).getTime(), predictions),
  );
}

// interpolate one smooth level between adjacent NOAA tide extrema
function interpolateTidePrediction(
  instant: number,
  predictions: readonly TideRecord[],
): number | null {
  let previous: TideRecord | undefined;

  // locate the adjacent prediction pair
  for (const prediction of predictions) {
    const predictionInstant = new Date(prediction.validAt).getTime();

    // return an exact NOAA event
    if (predictionInstant === instant) {
      return prediction.waterLevelM;
    }

    // interpolate once the upper event is found
    if (predictionInstant > instant) {
      // require a complete pair
      if (previous === undefined) {
        return null;
      }

      const previousInstant = new Date(previous.validAt).getTime();
      const position = (instant - previousInstant) / (predictionInstant - previousInstant);
      const easedPosition = (1 - Math.cos(Math.PI * position)) / 2;
      return previous.waterLevelM + (prediction.waterLevelM - previous.waterLevelM) * easedPosition;
    }

    previous = prediction;
  }

  return null;
}

interface TrendCalendarSample {
  readonly dayKey: string;
  readonly value: number;
  readonly x: number;
}

interface TrendYearSeries {
  readonly points: readonly TrendCalendarSample[];
  readonly year: number;
}

interface TrendAggregateSample {
  readonly dayKey: string;
  readonly lowerQuartile: number;
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly upperQuartile: number;
  readonly x: number;
}

interface TrendCrosshairSeries {
  readonly colorClass: string;
  readonly key: string;
  readonly label: string;
  readonly points: readonly TrendCalendarSample[];
}

const TREND_CHART_HEIGHT = 280;
const TREND_CHART_PADDING_BOTTOM = 34;
const TREND_CHART_PADDING_LEFT = 42;
const TREND_CHART_PADDING_RIGHT = 18;
const TREND_CHART_PADDING_TOP = 42;
const TREND_CHART_WIDTH = 720;
const TREND_ROLLING_WINDOW_DAYS = 7;
const TREND_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const TREND_CURRENT_YEAR_COLOR = "var(--brand-orange)";
const TREND_YEAR_COLORS = ["#3878c5", "#439756", "#e6b519", "#ef7e1f", "#cf4337", "#8d6e63", "#545450", "#00838f"] as const;
type TrendChartFormat = keyof UnitPreferences | "humidity";
interface TrendChartOption {
  readonly format: TrendChartFormat;
  readonly label: string;
  readonly maximum?: number;
  readonly metric: TrendChartMetric;
  readonly minimum?: number;
}
const TREND_CHART_OPTIONS: readonly TrendChartOption[] = [
  { format: "temperature", label: "Temperature", metric: "temperatureC" },
  { format: "temperature", label: "Feels like", metric: "apparentTemperatureC" },
  { format: "windSpeed", label: "Wind speed", metric: "windSpeedMps", minimum: 0 },
  { format: "windSpeed", label: "Wind gust", metric: "windGustMps", minimum: 0 },
  { format: "precipitation", label: "Daily rain", metric: "precipitationMm", minimum: 0 },
  { format: "humidity", label: "Humidity", maximum: 100, metric: "relativeHumidityPercent", minimum: 0 },
  { format: "pressure", label: "Pressure", metric: "pressureHpa" },
];

// render calendar-year comparison charts
function renderTrends(state: DashboardState): string {
  // reserve the final chart during the first read
  if (state.trends.length === 0 && state.loading) {
    return renderTrendsSkeleton();
  }

  const selected = TREND_CHART_OPTIONS.find(
    // resolve the selected chart configuration
    (option) => option.metric === state.selectedTrendMetric,
  ) ?? TREND_CHART_OPTIONS[0]!;

  return `
    <section class="panel trends-panel" aria-label="Trends">
      ${state.trends.length === 0
        ? '<p class="empty-panel">No normalized calendar-year trend buckets are available yet.</p>'
        : `<div class="trend-grid">
            ${renderTrendLineChart(state, selected)}
          </div>`}
    </section>
  `;
}

// reserve the complete trend chart grid
function renderTrendsSkeleton(): string {
  return `
    <section class="panel trends-panel skeleton-region" aria-label="Trends" aria-busy="true">
      <div class="trend-grid">
        <article class="trend-chart skeleton-trend-chart" aria-hidden="true">
          <div class="trend-chart-viewport">
            <div class="trend-chart-landscape">
              ${renderTrendMetricControl("temperatureC", true)}
              <span class="trend-chart-range">00–00 unit</span>
              <svg viewBox="0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}" preserveAspectRatio="none" focusable="false">
                ${renderTrendMonthGrid()}
                <rect class="skeleton-chart-fill" x="${TREND_CHART_PADDING_LEFT}" y="${TREND_CHART_PADDING_TOP}" width="${TREND_CHART_WIDTH - TREND_CHART_PADDING_LEFT - TREND_CHART_PADDING_RIGHT}" height="${TREND_CHART_HEIGHT - TREND_CHART_PADDING_TOP - TREND_CHART_PADDING_BOTTOM}" rx="3"/>
              </svg>
              ${renderTrendMonthAxis()}
              <div class="trend-chart-legend skeleton-trend-legend"><span>25th–75th</span><span>Historical median</span></div>
            </div>
          </div>
        </article>
      </div>
    </section>
  `;
}

// render one dependency-free accessible SVG trend chart
function renderTrendLineChart(
  state: DashboardState,
  option: TrendChartOption,
): string {
  const rawSeries = buildTrendYearSeries(state.trends, option.metric, state.selectedSite?.timezone ?? "UTC");

  // render a per-series empty state
  if (rawSeries.length === 0) {
    return `<article class="trend-chart">${renderTrendMetricControl(option.metric)}<p>No values</p></article>`;
  }

  const currentYear = trendCurrentYear(state, rawSeries);
  const series = state.trendDetail === "rolling"
    ? smoothTrendYearSeries(rawSeries, TREND_ROLLING_WINDOW_DAYS)
    : rawSeries;
  const historicalSeries = series.filter(
    // exclude the incomplete current year from historical statistics
    (year) => year.year !== currentYear,
  );
  const aggregate = buildTrendAggregateSeries(
    // retain a useful fallback before a second calendar year exists
    historicalSeries.length === 0 ? series : historicalSeries,
  );
  const selectedTrendYear = state.trendDisplayMode === "all" ? state.selectedTrendYear : null;
  const { maximum, minimum } = trendVisibleDomain(
    series,
    aggregate,
    state.trendDisplayMode,
    selectedTrendYear,
    currentYear,
    option,
    state.units,
  );
  const span = maximum === minimum ? 1 : maximum - minimum;
  const minimumLabel = formatTrendMeasurement(minimum, option.format, state.units);
  const maximumLabel = formatTrendMeasurement(maximum, option.format, state.units);
  const aggregateBandPath = renderTrendAggregateBandPath(aggregate, minimum, span);
  const aggregateMaximum = renderTrendAggregateLinePoints(aggregate, "maximum", minimum, span);
  const aggregateMedian = renderTrendAggregateLinePoints(aggregate, "median", minimum, span);
  const aggregateMinimum = renderTrendAggregateLinePoints(aggregate, "minimum", minimum, span);
  const initialPosition = trendInitialPosition(state, rawSeries);
  const todayPosition = trendTodayPosition(state);
  const indexedSeries = series.map(
    // retain each stable year color while changing its SVG stacking order
    (year, index) => ({ index, year }),
  );
  const selectedSeries = indexedSeries.find(
    // locate the emphasized calendar year
    (entry) => entry.year.year === selectedTrendYear,
  );
  const currentSeries = indexedSeries.find(
    // locate the permanent current-year comparison
    (entry) => entry.year.year === currentYear,
  );
  const drawableSeries = selectedSeries === undefined
    ? indexedSeries
    : [
        ...indexedSeries.filter(
          // draw every muted year below the emphasized line
          (entry) => entry.year.year !== selectedSeries.year.year,
        ),
        selectedSeries,
      ];
  const crosshairSeries = buildTrendCrosshairSeries(
    series,
    aggregate,
    state.trendDisplayMode,
    selectedTrendYear,
    currentYear,
  );
  const detailLabel = state.trendDetail === "daily" ? "Daily values" : "7-day average";

  // move non-data chart chrome outside the daily scrollport
  const dailyDetail = state.trendDetail === "daily";
  const metricControl = renderTrendMetricControl(option.metric);
  const chartRange = `<span class="trend-chart-range">${escapeHtml(minimumLabel.value)}–${escapeHtml(maximumLabel.value)} ${escapeHtml(maximumLabel.unit)}</span>`;
  const modeToggle = `<button type="button" class="trend-mode-toggle" data-trend-mode-toggle aria-pressed="${state.trendDisplayMode === "all" ? "true" : "false"}">${state.trendDisplayMode === "aggregate" ? "Show all" : "Aggregate"}</button>`;
  const detailToggle = `<button type="button" class="trend-detail-toggle" data-trend-detail-toggle aria-pressed="${dailyDetail ? "true" : "false"}">${dailyDetail ? "7-day average" : "Daily detail"}</button>`;
  const yAxis = renderTrendYAxis(minimum, maximum, option.format, state.units);

  // share one interactive legend between both layouts
  const legend = `
    <div class="trend-chart-legend" aria-label="Trend legend">
      <span class="trend-legend-quartiles"><i aria-hidden="true"></i>25th–75th</span>
      <span class="trend-legend-range"><i aria-hidden="true"></i>Historical min/max</span>
      ${state.trendDisplayMode === "aggregate"
        ? `<span class="trend-legend-median"><i aria-hidden="true"></i>Historical median</span>${currentSeries === undefined ? "" : `<span class="trend-legend-current"><i class="trend-current-year-color" aria-hidden="true"></i>${String(currentYear)}</span>`}`
        : series.map(
            // label every clickable overlaid calendar year
            (year, index) => `<button type="button" class="trend-year-legend${year.year === currentYear ? " trend-legend-current" : ""}${year.year === selectedTrendYear ? " trend-year-legend-selected" : ""}" data-trend-year-select="${String(year.year)}" aria-pressed="${year.year === selectedTrendYear ? "true" : "false"}"><i class="${year.year === currentYear ? "trend-current-year-color" : `trend-year-color-${String(index % TREND_YEAR_COLORS.length)}`}" aria-hidden="true" data-trend-legend-year="${String(year.year)}"></i>${String(year.year)}</button>`,
          ).join("")}
    </div>
  `;

  // preserve every non-scrolling daily control in one overlay
  const fixedChrome = `
    ${metricControl}
    ${chartRange}
    ${modeToggle}
    ${yAxis}
    ${detailToggle}
    ${legend}
  `;

  return `
    <article class="trend-chart" data-trend-chart="${escapeHtml(option.metric)}" data-trend-detail="${state.trendDetail}" data-trend-display-mode="${state.trendDisplayMode}" data-trend-maximum="${maximum.toFixed(6)}" data-trend-minimum="${minimum.toFixed(6)}" data-trend-domain="visible"${selectedSeries === undefined ? "" : ` data-selected-trend-year="${String(selectedSeries.year.year)}"`}>
      <div class="trend-chart-frame">
        <div class="trend-chart-viewport">
          <div class="trend-chart-landscape" data-trend-scrub-surface data-trend-initial-position="${initialPosition.toFixed(12)}" data-trend-today-position="${todayPosition.toFixed(12)}">
            ${dailyDetail ? "" : metricControl}
            ${dailyDetail ? "" : chartRange}
            ${dailyDetail ? "" : modeToggle}
            <svg viewBox="0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(option.label)} ${escapeHtml(detailLabel)} with historical median, quartiles, and range">
              ${renderTrendMonthGrid()}
              ${aggregateBandPath.length === 0 ? "" : `<path d="${aggregateBandPath}" class="trend-historical-quartile-band"/>`}
              <polyline points="${aggregateMinimum}" class="trend-historical-range-line" data-trend-historical-range="minimum"/>
              <polyline points="${aggregateMaximum}" class="trend-historical-range-line" data-trend-historical-range="maximum"/>
              ${state.trendDisplayMode === "aggregate"
                ? `<polyline points="${aggregateMedian}" class="trend-aggregate-median-line"/>${currentSeries === undefined ? "" : `<polyline points="${renderTrendLinePoints(currentSeries.year.points, minimum, span)}" class="trend-year-line trend-year-line-current" data-trend-year="${String(currentYear)}" stroke="${TREND_CURRENT_YEAR_COLOR}" aria-label="${String(currentYear)} ${escapeHtml(option.label)}"/>`}`
                : drawableSeries.map(
                    // render one forgiving tap target beneath its visible yearly line
                    ({ index, year }) => {
                      const points = renderTrendLinePoints(year.points, minimum, span);
                      const selected = year.year === selectedTrendYear;
                      const current = year.year === currentYear;
                      return `<polyline points="${points}" class="trend-year-hit-target${current ? " trend-year-hit-target-current" : ""}${selected ? " trend-year-hit-target-selected" : ""}" data-trend-year-select="${String(year.year)}" stroke="transparent" aria-hidden="true"/><polyline points="${points}" class="trend-year-line${current ? " trend-year-line-current" : ""}${selected ? " trend-year-line-selected" : ""}" data-trend-year="${String(year.year)}" data-trend-year-select="${String(year.year)}" stroke="${current ? TREND_CURRENT_YEAR_COLOR : trendYearColor(index)}" role="button" tabindex="0" aria-label="${String(year.year)} ${escapeHtml(option.label)}" aria-pressed="${selected ? "true" : "false"}"/>`;
                    },
                  ).join("")}
            </svg>
            <div class="trend-today-marker" aria-hidden="true"><span>Today</span></div>
            ${dailyDetail ? "" : yAxis}
            ${renderTrendMonthAxis()}
            ${renderTrendCrosshair(crosshairSeries, initialPosition, option, state.units)}
            ${dailyDetail ? "" : detailToggle}
            ${dailyDetail ? "" : legend}
          </div>
        </div>
        ${dailyDetail ? `<div class="trend-chart-fixed-chrome">${fixedChrome}</div>` : ""}
      </div>
    </article>
  `;
}

// render responsive vertical scale labels outside the stretched SVG
function renderTrendYAxis(
  minimum: number,
  maximum: number,
  format: TrendChartFormat,
  units: UnitPreferences,
): string {
  const ticks = Array.from({ length: 5 },
    // interpolate one label from the vertical maximum to minimum
    (_value, index) => maximum - ((maximum - minimum) * index) / 4,
  );
  return `
    <div class="trend-y-axis" aria-hidden="true">
      ${ticks.map(
        // format one preferred-unit vertical tick
        (value) => {
          const measurement = formatTrendMeasurement(value, format, units);
          return `<span>${escapeHtml(measurement.value)} ${escapeHtml(measurement.unit)}</span>`;
        },
      ).join("")}
    </div>
  `;
}

// render the one-chart measurement title and flyover
function renderTrendMetricControl(
  selected: TrendChartMetric,
  disabled = false,
): string {
  const selectedOption = TREND_CHART_OPTIONS.find(
    // resolve the visible title from the reviewed metrics
    (option) => option.metric === selected,
  ) ?? TREND_CHART_OPTIONS[0]!;

  // reserve a non-interactive title during loading
  if (disabled) {
    return `
      <div class="trend-metric-control trend-metric-control-skeleton">
        <h2 class="trend-chart-title">${escapeHtml(selectedOption.label)}</h2>
        <span class="trend-metric-caret" aria-hidden="true"></span>
      </div>
    `;
  }

  return `
    <div class="trend-metric-control" data-trend-metric-control>
      <h2 class="trend-chart-title">
        <button type="button" class="trend-metric-trigger" data-trend-metric-trigger aria-expanded="false" aria-haspopup="menu" aria-controls="trend-metric-flyover">
          <span>${escapeHtml(selectedOption.label)}</span>
          <span class="trend-metric-caret" aria-hidden="true"></span>
        </button>
      </h2>
      <div class="trend-metric-flyover" id="trend-metric-flyover" role="menu" aria-label="Trend measurement" hidden>
        ${TREND_CHART_OPTIONS.map(
          // render one reviewed flyover option
          (option) => `<button type="button" class="trend-metric-option" data-trend-metric-option="${escapeHtml(option.metric)}" role="menuitemradio" aria-checked="${String(option.metric === selected)}">${escapeHtml(option.label)}</button>`,
        ).join("")}
      </div>
    </div>
  `;
}

// group daily trend points by their site-local calendar year
function buildTrendYearSeries(
  trends: readonly TrendPoint[],
  metric: TrendMetricKey,
  timezone: string,
): readonly TrendYearSeries[] {
  const years = new Map<number, Map<string, TrendCalendarSample>>();

  // retain each finite daily reading
  for (const point of trends) {
    const value = point.metrics[metric];

    // omit missing daily readings
    if (value === null || !Number.isFinite(value)) {
      continue;
    }

    const parts = formatWallClockParts(new Date(point.validAt), timezone);
    const dayKey = `${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    const samples = years.get(parts.year) ?? new Map<string, TrendCalendarSample>();
    samples.set(dayKey, {
      dayKey,
      value,
      x: trendCalendarPosition(parts.month, parts.day),
    });
    years.set(parts.year, samples);
  }

  return [...years.entries()].sort(([left], [right]) => left - right).map(
    // order one year from January through December
    ([year, samples]) => ({
      points: [...samples.values()].sort((left, right) => left.x - right.x),
      year,
    }),
  );
}

// smooth every calendar year with one centered moving average
function smoothTrendYearSeries(
  series: readonly TrendYearSeries[],
  windowDays: number,
): readonly TrendYearSeries[] {
  const radius = Math.floor(Math.max(1, windowDays) / 2);
  const tolerance = radius / 366;
  return series.map(
    // smooth one year without crossing the calendar boundary
    (year) => ({
      points: year.points.map(
        // average one centered calendar-day neighborhood
        (point) => {
          const neighbors = year.points.filter(
            // exclude samples outside the fixed rolling window
            (candidate) => Math.abs(candidate.x - point.x) <= tolerance,
          );
          const value = neighbors.reduce(
            // total one nearby sample
            (total, neighbor) => total + neighbor.value,
            0,
          ) / neighbors.length;
          return { ...point, value };
        },
      ),
      year: year.year,
    }),
  );
}

// calculate historical median, quartiles, and range per calendar day
function buildTrendAggregateSeries(series: readonly TrendYearSeries[]): readonly TrendAggregateSample[] {
  const days = new Map<string, { readonly values: number[]; readonly x: number }>();

  // collect each historical year into matching month-day buckets
  for (const year of series) {
    // collect every observed day
    for (const point of year.points) {
      const day = days.get(point.dayKey) ?? { values: [], x: point.x };
      day.values.push(point.value);
      days.set(point.dayKey, day);
    }
  }

  return [...days.entries()].sort(
    // preserve the calendar order
    ([_leftKey, left], [_rightKey, right]) => left.x - right.x,
  ).map(
    // summarize one historical calendar day
    ([dayKey, day]) => {
      const values = [...day.values].sort(
        // order one day's measurements for percentile interpolation
        (left, right) => left - right,
      );
      return {
        dayKey,
        lowerQuartile: trendPercentile(values, 0.25),
        maximum: values.at(-1) ?? 0,
        median: trendPercentile(values, 0.5),
        minimum: values[0] ?? 0,
        upperQuartile: trendPercentile(values, 0.75),
        x: day.x,
      };
    },
  );
}

// interpolate one percentile from an ordered finite sample
function trendPercentile(values: readonly number[], percentile: number): number {
  // preserve an impossible empty bucket honestly
  if (values.length === 0) {
    return 0;
  }

  const position = Math.max(0, Math.min(1, percentile)) * (values.length - 1);
  const lower = values[Math.floor(position)] ?? values[0] ?? 0;
  const upper = values[Math.ceil(position)] ?? values.at(-1) ?? lower;
  return lower + (upper - lower) * (position - Math.floor(position));
}

// describe the visible lines used by the shared trend scrubber
function buildTrendCrosshairSeries(
  series: readonly TrendYearSeries[],
  aggregate: readonly TrendAggregateSample[],
  displayMode: TrendDisplayMode,
  selectedYear: number | null,
  currentYear: number,
): readonly TrendCrosshairSeries[] {
  const indexedSeries = series.map(
    // retain stable line colors after visibility filtering
    (year, index) => ({ index, year }),
  );
  const currentSeries = indexedSeries.find(
    // locate the permanent current-year comparison
    (entry) => entry.year.year === currentYear,
  );

  // show the aggregate and current year together by default
  if (displayMode === "aggregate") {
    return [
      {
        colorClass: "trend-aggregate-color",
        key: "median",
        label: "Median",
        points: aggregate.map(
          // expose the median through the shared date scrubber
          (point) => ({ dayKey: point.dayKey, value: point.median, x: point.x }),
        ),
      },
      ...(currentSeries === undefined
        ? []
        : [{
            colorClass: "trend-current-year-color",
            key: String(currentYear),
            label: String(currentYear),
            points: currentSeries.year.points,
          }]),
    ];
  }

  const visibleSeries = selectedYear === null
    ? indexedSeries
    : indexedSeries.filter(
        // retain the selection and permanent current-year comparison
        (entry) => entry.year.year === selectedYear || entry.year.year === currentYear,
      );
  return visibleSeries.map(
    // expose every visible year through the shared date scrubber
    ({ index, year }) => ({
      colorClass: year.year === currentYear
        ? "trend-current-year-color"
        : `trend-year-color-${String(index % TREND_YEAR_COLORS.length)}`,
      key: String(year.year),
      label: String(year.year),
      points: year.points,
    }),
  );
}

// fit one vertical scale to every currently visible series
function trendVisibleDomain(
  series: readonly TrendYearSeries[],
  aggregate: readonly TrendAggregateSample[],
  displayMode: TrendDisplayMode,
  selectedYear: number | null,
  currentYear: number,
  option: TrendChartOption,
  units: UnitPreferences,
): Readonly<{ maximum: number; minimum: number }> {
  const visibleYears = displayMode === "all"
    ? selectedYear === null
      ? series
      : series.filter(
          // retain the selection and permanent current-year comparison
          (year) => year.year === selectedYear || year.year === currentYear,
        )
    : series.filter(
        // fit the permanent current-year comparison
        (year) => year.year === currentYear,
      );
  const values = [
    ...aggregate.flatMap(
      // include both visible historical range lines
      (point) => [point.minimum, point.maximum],
    ),
    ...visibleYears.flatMap(
      // include every visible individual yearly line
      (year) => year.points.map(
        // retain one canonical measurement
        (point) => point.value,
      ),
    ),
  ].filter(
    // reject impossible chart coordinates
    (value) => Number.isFinite(value),
  );

  // preserve a usable empty scale
  if (values.length === 0) {
    return { maximum: option.maximum ?? 1, minimum: option.minimum ?? 0 };
  }

  const ordered = [...values].sort(
    // order values for the constant-domain fallback median
    (left, right) => left - right,
  );
  const median = trendPercentile(ordered, 0.5);
  let minimum = trendCanonicalValue(
    Math.floor(trendDisplayValue(ordered[0] ?? median, option.format, units)),
    option.format,
    units,
  );
  let maximum = trendCanonicalValue(
    Math.ceil(trendDisplayValue(ordered.at(-1) ?? median, option.format, units)),
    option.format,
    units,
  );

  // preserve natural bounds after display-unit rounding
  if (option.minimum !== undefined) {
    minimum = Math.max(option.minimum, minimum);
  }

  // preserve natural bounds after display-unit rounding
  if (option.maximum !== undefined) {
    maximum = Math.min(option.maximum, maximum);
  }

  // recover from a fully clamped or constant scale
  if (maximum <= minimum) {
    const displayMedian = trendDisplayValue(median, option.format, units);
    minimum = trendCanonicalValue(Math.floor(displayMedian) - 1, option.format, units);
    maximum = trendCanonicalValue(Math.ceil(displayMedian) + 1, option.format, units);

    // preserve one natural lower boundary after fallback expansion
    if (option.minimum !== undefined) {
      minimum = Math.max(option.minimum, minimum);
    }

    // preserve one natural upper boundary after fallback expansion
    if (option.maximum !== undefined) {
      maximum = Math.min(option.maximum, maximum);
    }
  }

  return { maximum, minimum };
}

// convert one canonical trend value into the configured consumer unit
function trendDisplayValue(
  value: number,
  format: TrendChartFormat,
  units: UnitPreferences,
): number {
  // convert one monotonic display scale
  switch (format) {
    case "humidity":
      return value;
    case "temperature":
      return units.temperature === "fahrenheit" ? (value * 9) / 5 + 32 : value;
    case "windSpeed":
      switch (units.windSpeed) {
        case "miles_per_hour":
          return value * 2.236_936_292_1;
        case "kilometers_per_hour":
          return value * 3.6;
        case "meters_per_second":
          return value;
      }
    case "precipitation":
      return units.precipitation === "inches" ? value / 25.4 : value;
    case "pressure":
      switch (units.pressure) {
        case "atmosphere_percent":
          return ((value / 1_013.25) - 1) * 100;
        case "inches_of_mercury":
          return value * 0.029_529_983_1;
        case "hectopascals":
          return value;
      }
    case "waterLevel":
      return units.waterLevel === "feet" ? value * 3.280_839_895 : value;
  }
}

// convert one consumer-unit boundary back into canonical storage units
function trendCanonicalValue(
  value: number,
  format: TrendChartFormat,
  units: UnitPreferences,
): number {
  // invert one monotonic display scale
  switch (format) {
    case "humidity":
      return value;
    case "temperature":
      return units.temperature === "fahrenheit" ? ((value - 32) * 5) / 9 : value;
    case "windSpeed":
      switch (units.windSpeed) {
        case "miles_per_hour":
          return value / 2.236_936_292_1;
        case "kilometers_per_hour":
          return value / 3.6;
        case "meters_per_second":
          return value;
      }
    case "precipitation":
      return units.precipitation === "inches" ? value * 25.4 : value;
    case "pressure":
      switch (units.pressure) {
        case "atmosphere_percent":
          return (value / 100 + 1) * 1_013.25;
        case "inches_of_mercury":
          return value / 0.029_529_983_1;
        case "hectopascals":
          return value;
      }
    case "waterLevel":
      return units.waterLevel === "feet" ? value / 3.280_839_895 : value;
  }
}

// format one trend value with its consumer unit
function formatTrendMeasurement(
  value: number | null,
  format: TrendChartFormat,
  units: UnitPreferences,
): FormattedMeasurement {
  // format normalized humidity without a configurable unit
  if (format === "humidity") {
    return formatFixedMeasurement(value, "%", 0);
  }

  // retain useful precision for small daily rain totals
  if (format === "precipitation") {
    return formatMeasurement(value, format, units);
  }

  // preserve the product-wide pressure precision
  if (format === "pressure") {
    return formatMeasurement(value, format, units, 1);
  }

  // match homepage whole-number temperature presentation
  if (format === "temperature") {
    return formatMeasurement(value, format, units, 0);
  }

  return formatMeasurement(value, format, units, 1);
}

// render the initial shared date and every visible line intersection
function renderTrendCrosshair(
  series: readonly TrendCrosshairSeries[],
  position: number,
  option: TrendChartOption,
  units: UnitPreferences,
): string {
  const date = trendCalendarDate(position);
  const newestFirst = [...series].reverse();
  const summaries = newestFirst.map(
    // render one visible line at the selected calendar position
    (entry) => {
      const measurement = formatTrendMeasurement(
        interpolateTrendValue(entry.points, position),
        option.format,
        units,
      );
      const compact = compactMeasurement(measurement) ?? "—";
      return `<span class="trend-crosshair-value"><i class="${entry.colorClass}" aria-hidden="true"></i><strong>${escapeHtml(entry.label)}</strong><output data-trend-crosshair-value="${escapeHtml(entry.key)}">${escapeHtml(compact)}</output></span>`;
    },
  );
  const ariaValueText = `${date.label}. ${newestFirst.map(
    // summarize one visible line for assistive technology
    (entry) => {
      const measurement = formatTrendMeasurement(
        interpolateTrendValue(entry.points, position),
        option.format,
        units,
      );
      return `${entry.label} ${compactMeasurement(measurement) ?? "unavailable"}`;
    },
  ).join(". ")}`;

  return `
    <div class="trend-crosshair-line" aria-hidden="true"></div>
    <div
      class="trend-crosshair-slider"
      data-trend-crosshair-slider
      role="slider"
      tabindex="0"
      aria-label="Annual trend date scrubber"
      aria-valuemin="0"
      aria-valuemax="365"
      aria-valuenow="${String(Math.round(position * 365))}"
      aria-valuetext="${escapeHtml(ariaValueText)}"
    ></div>
    <time class="trend-crosshair-date-pill" data-trend-crosshair-date datetime="${date.key}" aria-hidden="true">${date.label}</time>
    <div class="trend-crosshair-summary" aria-hidden="true">
      <div class="trend-crosshair-values">${summaries.join("")}</div>
    </div>
  `;
}

// resolve the latest populated day in the current calendar year
function trendInitialPosition(
  state: DashboardState,
  series: readonly TrendYearSeries[],
): number {
  const currentYear = trendCurrentYear(state, series);
  const currentSeries = series.find(
    // locate the current calendar-year line
    (year) => year.year === currentYear,
  ) ?? series.at(-1);
  return currentSeries?.points.at(-1)?.x ?? 0;
}

// map today's site-local date onto the shared annual axis
function trendTodayPosition(state: DashboardState): number {
  const instant = new Date(state.trendGeneratedAt ?? Date.now());
  const parts = formatWallClockParts(instant, state.selectedSite?.timezone ?? "UTC");
  return trendCalendarPosition(parts.month, parts.day);
}

// interpolate one yearly line at a shared calendar date
function interpolateTrendValue(
  points: readonly TrendCalendarSample[],
  position: number,
): number | null {
  const first = points[0];
  const last = points.at(-1);
  const tolerance = 1 / (366 * 24 * 60);

  // reject dates beyond one partial year's coverage
  if (
    first === undefined ||
    last === undefined ||
    position < first.x - tolerance ||
    position > last.x + tolerance
  ) {
    return null;
  }

  const boundedPosition = Math.max(first.x, Math.min(last.x, position));

  // locate one enclosing pair
  for (let index = 0; index < points.length; index += 1) {
    const upper = points[index];

    // skip an impossible sparse entry
    if (upper === undefined) {
      continue;
    }

    // return one exact daily sample
    if (upper.x === boundedPosition || index === 0) {
      if (upper.x === boundedPosition) {
        return upper.value;
      }

      continue;
    }

    // interpolate after reaching the upper daily sample
    if (upper.x > boundedPosition) {
      const lower = points[index - 1];

      // preserve one malformed sparse series honestly
      if (lower === undefined || upper.x === lower.x) {
        return null;
      }

      const ratio = (boundedPosition - lower.x) / (upper.x - lower.x);
      return lower.value + (upper.value - lower.value) * ratio;
    }
  }

  return last.value;
}

// convert a shared calendar position into a stable display date
function trendCalendarDate(position: number): Readonly<{ key: string; label: string }> {
  const bounded = Math.max(0, Math.min(1, position));
  const start = Date.UTC(2000, 0, 1);
  const day = Math.max(0, Math.min(365, Math.round(bounded * 366)));
  const date = new Date(start + day * 24 * 60 * 60 * 1_000);
  return {
    key: date.toISOString().slice(0, 10),
    label: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(date),
  };
}

// place one crosshair on the padded SVG plot
function trendChartPercentage(position: number): number {
  return (trendChartX(Math.max(0, Math.min(1, position))) / TREND_CHART_WIDTH) * 100;
}

// render one closed historical interquartile band
function renderTrendAggregateBandPath(
  aggregate: readonly TrendAggregateSample[],
  minimum: number,
  span: number,
): string {
  // omit an area without enough horizontal extent
  if (aggregate.length < 2) {
    return "";
  }

  const upper = aggregate.map(
    // project one upper quartile edge
    (point) => `${trendChartX(point.x).toFixed(2)},${trendChartY(point.upperQuartile, minimum, span).toFixed(2)}`,
  );
  const lower = [...aggregate].reverse().map(
    // project one lower quartile edge
    (point) => `${trendChartX(point.x).toFixed(2)},${trendChartY(point.lowerQuartile, minimum, span).toFixed(2)}`,
  );
  return `M ${upper.join(" L ")} L ${lower.join(" L ")} Z`;
}

// render one aggregate statistic as a point list
function renderTrendAggregateLinePoints(
  aggregate: readonly TrendAggregateSample[],
  statistic: "maximum" | "median" | "minimum",
  minimum: number,
  span: number,
): string {
  return aggregate.map(
    // project one daily aggregate point
    (point) => `${trendChartX(point.x).toFixed(2)},${trendChartY(point[statistic], minimum, span).toFixed(2)}`,
  ).join(" ");
}

// render one yearly line point list
function renderTrendLinePoints(
  points: readonly TrendCalendarSample[],
  minimum: number,
  span: number,
): string {
  return points.map(
    // project one daily point
    (point) => `${trendChartX(point.x).toFixed(2)},${trendChartY(point.value, minimum, span).toFixed(2)}`,
  ).join(" ");
}

// render month markers across one fixed calendar-year axis
function renderTrendMonthGrid(): string {
  return `
    <line x1="${TREND_CHART_PADDING_LEFT}" y1="${TREND_CHART_HEIGHT - TREND_CHART_PADDING_BOTTOM}" x2="${TREND_CHART_WIDTH - TREND_CHART_PADDING_RIGHT}" y2="${TREND_CHART_HEIGHT - TREND_CHART_PADDING_BOTTOM}" class="trend-chart-axis"/>
    <line x1="${TREND_CHART_PADDING_LEFT}" y1="${TREND_CHART_PADDING_TOP}" x2="${TREND_CHART_PADDING_LEFT}" y2="${TREND_CHART_HEIGHT - TREND_CHART_PADDING_BOTTOM}" class="trend-chart-axis"/>
    ${Array.from({ length: 4 },
      // draw one horizontal guide for each non-bottom vertical tick
      (_value, index) => {
        const y = TREND_CHART_PADDING_TOP +
          (index * (TREND_CHART_HEIGHT - TREND_CHART_PADDING_TOP - TREND_CHART_PADDING_BOTTOM)) / 4;
        return `<line x1="${TREND_CHART_PADDING_LEFT}" y1="${y.toFixed(2)}" x2="${TREND_CHART_WIDTH - TREND_CHART_PADDING_RIGHT}" y2="${y.toFixed(2)}" class="trend-y-grid-line"/>`;
      },
    ).join("")}
    ${TREND_MONTH_LABELS.map(
      // mark one calendar month
      (_label, index) => {
        const x = trendChartX(trendCalendarPosition(index + 1, 1));
        return `<line x1="${x.toFixed(2)}" y1="${TREND_CHART_PADDING_TOP}" x2="${x.toFixed(2)}" y2="${TREND_CHART_HEIGHT - TREND_CHART_PADDING_BOTTOM}" class="trend-month-line"/>`;
      },
    ).join("")}
  `;
}

// render responsive month labels outside the stretched SVG
function renderTrendMonthAxis(): string {
  return `
    <div class="trend-month-axis" aria-hidden="true">
      ${TREND_MONTH_LABELS.map(
        // label one calendar month
        (label) => `<span class="trend-month-label">${label}</span>`,
      ).join("")}
    </div>
  `;
}

// resolve the highlighted current site year
function trendCurrentYear(state: DashboardState, series: readonly TrendYearSeries[]): number {
  // use the response clock when available
  if (typeof state.trendGeneratedAt === "string") {
    return formatWallClockParts(
      new Date(state.trendGeneratedAt),
      state.selectedSite?.timezone ?? "UTC",
    ).year;
  }

  return series.at(-1)?.year ?? 0;
}

// map one month-day onto a leap-safe shared year
function trendCalendarPosition(month: number, day: number): number {
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2001, 0, 1);
  return (Date.UTC(2000, month - 1, day) - start) / (end - start);
}

// project one normalized horizontal coordinate
function trendChartX(position: number): number {
  return TREND_CHART_PADDING_LEFT + position * (TREND_CHART_WIDTH - TREND_CHART_PADDING_LEFT - TREND_CHART_PADDING_RIGHT);
}

// project one measurement onto the shared vertical scale
function trendChartY(value: number, minimum: number, span: number): number {
  return TREND_CHART_HEIGHT - TREND_CHART_PADDING_BOTTOM -
    ((value - minimum) / span) * (TREND_CHART_HEIGHT - TREND_CHART_PADDING_TOP - TREND_CHART_PADDING_BOTTOM);
}

// select one stable year color
function trendYearColor(index: number): string {
  return TREND_YEAR_COLORS[index % TREND_YEAR_COLORS.length] ?? TREND_YEAR_COLORS[0];
}

const STATION_MAP_HEIGHT = 520;
const STATION_MAP_TILE_SIZE = 256;
const STATION_MAP_WIDTH = 640;
const STATION_MAP_ZOOM = 13;
const PROPERTY_MAP_HEIGHT = 400;
const PROPERTY_MAP_WIDTH = 640;
const PROPERTY_MAP_ZOOM = 17;
const PROPERTY_SATELLITE_IMAGE_SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage";
const WEB_MERCATOR_LIMIT_METERS = 20_037_508.342_789_244;
const PROPERTY_SENSOR_ICON_OPTIONS: readonly Readonly<{
  icon: PropertySensorIcon;
  label: string;
  material: MaterialIconName;
}>[] = [
  { icon: "temperature", label: "Temperature", material: "device_thermostat" },
  { icon: "wind", label: "Wind", material: "air" },
  { icon: "rain", label: "Rain", material: "rainy" },
  { icon: "air-quality", label: "Air quality", material: "masks" },
];

interface MapViewport {
  readonly left: number;
  readonly top: number;
  readonly zoom: number;
}

// render the farm-scale EcoWitt sensor geography first
function renderPropertySensorMap(state: DashboardState): string {
  const site = state.selectedSite;

  // reserve the property map until current data arrives
  if (site === null) {
    return "";
  }

  const sensors = propertySensorSnapshots(state);
  const layoutByKey = new Map(
    (state.propertySensorLayout ?? []).map(
      // index each server-wide sensor placement
      (entry) => [entry.sensorKey, entry],
    ),
  );
  const placed = sensors.flatMap((sensor) => {
    const layout = layoutByKey.get(sensor.key);
    return layout === undefined ? [] : [{ layout, sensor }];
  });
  const viewport = createFixedMapViewport(
    site.latitude,
    site.longitude,
    PROPERTY_MAP_ZOOM,
    PROPERTY_MAP_WIDTH,
    PROPERTY_MAP_HEIGHT,
  );
  const markerOffsets = propertySensorMarkerOffsets(placed, viewport);
  const markers = placed.map(
    // render each configured first-party sensor
    ({ layout, sensor }) => renderPropertySensorMarker(
      layout,
      sensor,
      viewport,
      state.units,
      state.selectedPropertySensorKey === sensor.key,
      markerOffsets.get(sensor.key) ?? { x: 0, y: 0 },
    ),
  ).join("");
  const sensorRows = placed.map(
    // render every configured sensor row
    ({ layout, sensor }) => renderPropertySensorListItem(
      layout,
      sensor,
      state.units,
      state.selectedPropertySensorKey === sensor.key,
    ),
  ).join("");

  return `
    <section class="panel property-map-panel" aria-labelledby="property-map-heading">
      <div class="section-heading">
        <div><p class="eyebrow">Ballydídean property</p><h2 id="property-map-heading">Property sensors</h2></div>
        <span class="property-map-count">${String(placed.length)} placed</span>
      </div>
      <div class="property-map-layout">
        <div class="property-map">
          <div class="property-map-canvas">
            <svg class="property-map-svg" data-property-interactive-map data-property-map-width="${String(PROPERTY_MAP_WIDTH)}" data-property-map-height="${String(PROPERTY_MAP_HEIGHT)}" viewBox="0 0 ${PROPERTY_MAP_WIDTH} ${PROPERTY_MAP_HEIGHT}" role="group" aria-label="EcoWitt sensors placed across the Ballydídean property">
              <g data-property-map-world>
                <g class="map-tile-layer" aria-hidden="true">${renderPropertyMapTiles(state.propertyMapLayer, viewport)}</g>
              </g>
              <g class="property-map-overlay">
                <g data-property-map-anchor data-property-map-x="${(PROPERTY_MAP_WIDTH / 2).toFixed(2)}" data-property-map-y="${(PROPERTY_MAP_HEIGHT / 2).toFixed(2)}" aria-hidden="true"><circle r="8" class="farm-marker"/></g>
                ${markers}
              </g>
            </svg>
            ${renderPropertyMapLayerControls(state.propertyMapLayer, viewport)}
            ${renderPropertyMapZoomControls()}
          </div>
          ${renderPropertyMapAttribution(state.propertyMapLayer)}
        </div>
        <div class="property-sensor-list-shell">
          ${placed.length === 0
            ? `<p class="empty-panel">${state.loading ? "Loading property sensors…" : "No property sensors have been placed yet."}</p>`
            : `<ol class="property-sensor-list" aria-label="Placed property sensors">${sensorRows}</ol>`}
        </div>
      </div>
      ${sensors.length > placed.length
        ? `<p class="property-map-note">${String(sensors.length - placed.length)} reporting sensor${sensors.length - placed.length === 1 ? " still needs" : "s still need"} a position in Admin.</p>`
        : ""}
    </section>
  `;
}

// space dense property markers while retaining exact anchor lines
function propertySensorMarkerOffsets(
  placed: readonly Readonly<{
    layout: PropertySensorLayout;
    sensor: PropertySensorSnapshot;
  }>[],
  viewport: MapViewport,
): ReadonlyMap<string, Readonly<{ x: number; y: number }>> {
  const spacing = 38;
  const candidates: Array<Readonly<{ x: number; y: number }>> = [{ x: 0, y: 0 }];

  // build deterministic square rings around each true position
  for (let ring = 1; ring <= 4; ring += 1) {
    // inspect every candidate row
    for (let row = -ring; row <= ring; row += 1) {
      // inspect every candidate column
      for (let column = -ring; column <= ring; column += 1) {
        // retain only the current square perimeter
        if (Math.abs(row) !== ring && Math.abs(column) !== ring) {
          continue;
        }

        candidates.push({ x: column * spacing, y: row * spacing });
      }
    }
  }

  const occupied: Array<Readonly<{ x: number; y: number }>> = [];
  const offsets = new Map<string, Readonly<{ x: number; y: number }>>();

  // assign the nearest collision-free visible offset
  for (const { layout, sensor } of placed) {
    const anchor = projectMapPoint(layout.latitude, layout.longitude, viewport);
    const offset = candidates.find(
      // retain one in-bounds point clear of earlier markers
      (candidate) => {
        const point = { x: anchor.x + candidate.x, y: anchor.y + candidate.y };

        // keep every marker head inside the original map
        if (
          point.x < spacing ||
          point.x > PROPERTY_MAP_WIDTH - spacing ||
          point.y < spacing ||
          point.y > PROPERTY_MAP_HEIGHT - spacing
        ) {
          return false;
        }

        return occupied.every(
          // preserve one complete marker diameter
          (prior) => Math.hypot(point.x - prior.x, point.y - prior.y) >= spacing,
        );
      },
    ) ?? { x: 0, y: 0 };
    offsets.set(sensor.key, offset);
    occupied.push({ x: anchor.x + offset.x, y: anchor.y + offset.y });
  }

  return offsets;
}

// render the protected name and position editor
function renderPropertySensorAdmin(state: DashboardState): string {
  const site = state.selectedSite ?? PRODUCT_SITE;
  const sensors = propertySensorSnapshots(state);

  // explain the first ingestion wait honestly
  if (sensors.length === 0) {
    return `
      <section class="panel property-admin" aria-labelledby="property-admin-heading">
        <div class="section-heading"><div><p class="eyebrow">Administration</p><h2 id="property-admin-heading">Property sensors</h2></div></div>
        <p class="empty-panel">${state.loading ? "Loading EcoWitt sensor channels…" : "No EcoWitt sensor channels are reporting yet."}</p>
      </section>
    `;
  }

  const selectedKey = state.selectedPropertySensorKey ?? sensors[0]?.key ?? "";
  const selected = sensors.find(
    // retain the selected reporting sensor
    (sensor) => sensor.key === selectedKey,
  ) ?? sensors[0];

  // preserve the checked non-empty sensor boundary
  if (selected === undefined) {
    return "";
  }

  const layout = (state.propertySensorLayout ?? []).find(
    // load the selected persisted placement
    (entry) => entry.sensorKey === selected.key,
  );
  const latitude = layout?.latitude ?? site.latitude;
  const longitude = layout?.longitude ?? site.longitude;
  const displayName = layout?.displayName ?? defaultPropertySensorName(selected);
  const icon = layout?.icon ?? defaultPropertySensorIcon(selected);
  const viewport = createFixedMapViewport(
    site.latitude,
    site.longitude,
    PROPERTY_MAP_ZOOM,
    PROPERTY_MAP_WIDTH,
    PROPERTY_MAP_HEIGHT,
  );
  const point = projectMapPoint(latitude, longitude, viewport);
  const sensorRows = sensors.map(
    // render one selectable hardware channel
    (sensor) => {
      const saved = (state.propertySensorLayout ?? []).find(
        // resolve the visible persisted name
        (entry) => entry.sensorKey === sensor.key,
      );
      const sensorIcon = saved?.icon ?? defaultPropertySensorIcon(sensor);
      return `
        <li>
          <button type="button" data-property-sensor-select="${escapeHtml(sensor.key)}" aria-pressed="${String(sensor.key === selected.key)}">
            <span class="property-admin-sensor-icon">${renderMaterialIcon(propertySensorMaterialIcon(sensorIcon))}</span>
            <span><strong>${escapeHtml(saved?.displayName ?? defaultPropertySensorName(sensor))}</strong><small>${escapeHtml(sensor.model)}${sensor.channel === null ? "" : ` · channel ${String(sensor.channel)}`} · ${saved === undefined ? "needs placement" : "placed"}</small></span>
          </button>
        </li>
      `;
    },
  ).join("");

  return `
    <section class="panel property-admin" aria-labelledby="property-admin-heading">
      <div class="section-heading"><div><p class="eyebrow">Administration</p><h2 id="property-admin-heading">Property sensors</h2></div></div>
      <p class="property-admin-intro">Select a reporting EcoWitt sensor, give it a useful name, then tap its physical location on the map.</p>
      <div class="property-admin-layout">
        <ol class="property-admin-sensors">${sensorRows}</ol>
        <div class="property-admin-editor">
          <form data-property-sensor-form data-sensor-key="${escapeHtml(selected.key)}">
            <label><span>Display name</span><input name="displayName" maxlength="80" required value="${escapeHtml(displayName)}"></label>
            ${renderPropertySensorIconPicker(icon)}
            <div class="property-coordinate-fields">
              <label><span>Latitude</span><input name="latitude" type="number" min="-85" max="85" step="0.000001" required value="${latitude.toFixed(6)}"></label>
              <label><span>Longitude</span><input name="longitude" type="number" min="-180" max="180" step="0.000001" required value="${longitude.toFixed(6)}"></label>
            </div>
            <div class="property-admin-map">
              <svg data-property-position-map data-property-interactive-map data-property-map-width="${String(PROPERTY_MAP_WIDTH)}" data-property-map-height="${String(PROPERTY_MAP_HEIGHT)}" data-viewport-left="${viewport.left.toFixed(6)}" data-viewport-top="${viewport.top.toFixed(6)}" data-viewport-zoom="${String(viewport.zoom)}" viewBox="0 0 ${PROPERTY_MAP_WIDTH} ${PROPERTY_MAP_HEIGHT}" role="application" aria-label="Tap to place ${escapeHtml(displayName)}">
                <g data-property-map-world>
                  <g class="map-tile-layer" aria-hidden="true">${renderPropertyMapTiles(state.propertyMapLayer, viewport)}</g>
                </g>
                <g data-property-map-anchor data-property-map-x="${point.x.toFixed(2)}" data-property-map-y="${point.y.toFixed(2)}" data-property-position-marker transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})" class="property-position-marker" aria-hidden="true">
                  <path class="property-position-marker-pin" d="M0 0C-2.7-4.4-14-17.2-14-27A14 14 0 1 1 14-27C14-17.2 2.7-4.4 0 0Z"/>
                  <circle class="property-position-marker-core" cy="-27" r="9"/>
                  <text data-property-position-marker-icon class="property-position-marker-icon" x="0" y="-22">${propertySensorMaterialIcon(icon)}</text>
                </g>
              </svg>
              ${renderPropertyMapLayerControls(state.propertyMapLayer, viewport)}
              ${renderPropertyMapZoomControls()}
            </div>
            ${renderPropertyMapAttribution(state.propertyMapLayer)}
            <div class="property-admin-actions"><span aria-live="polite">${layout === undefined ? "Not placed" : `Updated ${formatInstant(layout.updatedAt, site.timezone)}`}</span><button type="submit"${state.loading ? " disabled" : ""}>${renderSaveIcon()} Save sensor</button></div>
          </form>
        </div>
      </div>
    </section>
  `;
}

// render one compact illustrated map-icon selector
function renderPropertySensorIconPicker(selectedIcon: PropertySensorIcon): string {
  return `
    <fieldset class="property-icon-picker">
      <legend>Map icon</legend>
      <div class="property-icon-options">
        ${PROPERTY_SENSOR_ICON_OPTIONS.map(
          // render every supported sensor category
          (option) => `
            <label>
              <input type="radio" name="icon" value="${option.icon}" aria-label="${escapeHtml(option.label)}"${option.icon === selectedIcon ? " checked" : ""}>
              <span>${renderMaterialIcon(option.material)}<small>${escapeHtml(option.label)}</small></span>
            </label>
          `,
        ).join("")}
      </div>
    </fieldset>
  `;
}

// choose a useful initial icon from the sensor's reported measurements
function defaultPropertySensorIcon(sensor: PropertySensorSnapshot): PropertySensorIcon {
  const readings = sensor.readings;

  // prioritize dedicated particulate sensors
  if (readings.pm25MicrogramsPerCubicMeter !== undefined) {
    return "air-quality";
  }

  // represent multi-sensor weather arrays by wind
  if (readings.windSpeedMps !== undefined || readings.windGustMps !== undefined) {
    return "wind";
  }

  // represent dedicated rain gauges by precipitation
  if (
    readings.precipitationRateMmPerHour !== undefined ||
    readings.dailyPrecipitationMm !== undefined
  ) {
    return "rain";
  }

  return "temperature";
}

// map one persisted category onto the bundled Material glyph
function propertySensorMaterialIcon(icon: PropertySensorIcon): MaterialIconName {
  return PROPERTY_SENSOR_ICON_OPTIONS.find(
    // resolve the exact reviewed category
    (option) => option.icon === icon,
  )?.material ?? "device_thermostat";
}

// accept only a supported persisted sensor category
function isPropertySensorIcon(value: unknown): value is PropertySensorIcon {
  return typeof value === "string" && PROPERTY_SENSOR_ICON_OPTIONS.some(
    // match one reviewed category
    (option) => option.icon === value,
  );
}

// collect each latest EcoWitt hardware snapshot once
function propertySensorSnapshots(state: DashboardState): readonly PropertySensorSnapshot[] {
  const sensors = new Map<string, PropertySensorSnapshot>();

  // inspect current records in response priority order
  for (const record of state.current) {
    // retain every first occurrence by stable hardware key
    for (const sensor of record.metadata.provider?.propertySensors ?? []) {
      // preserve the newest response occurrence
      if (!sensors.has(sensor.key)) {
        sensors.set(sensor.key, sensor);
      }
    }
  }

  return [...sensors.values()];
}

// render one map-positioned sensor label and primary reading
function renderPropertySensorMarker(
  layout: PropertySensorLayout,
  sensor: PropertySensorSnapshot,
  viewport: MapViewport,
  units: UnitPreferences,
  selected: boolean,
  offset: Readonly<{ x: number; y: number }>,
): string {
  const point = projectMapPoint(layout.latitude, layout.longitude, viewport);
  const reading = primaryPropertySensorReading(sensor, units);
  const icon = layout.icon ?? defaultPropertySensorIcon(sensor);
  return `
    <a class="property-sensor-marker${selected ? " selected" : ""}" href="#property-sensor-details-${escapeHtml(sensor.key)}" data-property-sensor-view="${escapeHtml(sensor.key)}" data-property-map-anchor data-property-map-x="${point.x.toFixed(2)}" data-property-map-y="${point.y.toFixed(2)}" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})" aria-label="Show details for ${escapeHtml(layout.displayName)}" aria-expanded="${String(selected)}" aria-controls="property-sensor-details-${escapeHtml(sensor.key)}">
      <line class="property-sensor-marker-leader" x1="0" y1="0" x2="${offset.x.toFixed(2)}" y2="${offset.y.toFixed(2)}"/>
      <circle class="property-sensor-marker-anchor" r="3"/>
      <g class="property-sensor-marker-head" transform="translate(${offset.x.toFixed(2)} ${offset.y.toFixed(2)})">
        <circle class="property-sensor-marker-hit" r="18"/>
        <circle class="property-sensor-marker-dot" r="14"/>
        <text x="0" y="5" class="property-sensor-marker-icon">${propertySensorMaterialIcon(icon)}</text>
      </g>
      <title>${escapeHtml(layout.displayName)} · ${escapeHtml(reading)}</title>
    </a>
  `;
}

// render one selectable property sensor list row
function renderPropertySensorListItem(
  layout: PropertySensorLayout,
  sensor: PropertySensorSnapshot,
  units: UnitPreferences,
  selected: boolean,
): string {
  const icon = layout.icon ?? defaultPropertySensorIcon(sensor);
  const details = selected ? renderPropertySensorDetails(layout, sensor, units) : "";
  return `
    <li class="property-sensor-item${selected ? " selected" : ""}">
      <button class="property-sensor-select" type="button" data-property-sensor-view="${escapeHtml(sensor.key)}" aria-expanded="${String(selected)}" aria-controls="property-sensor-details-${escapeHtml(sensor.key)}">
        <span class="property-sensor-list-icon">${renderMaterialIcon(propertySensorMaterialIcon(icon))}</span>
        <span class="property-sensor-label"><strong>${escapeHtml(layout.displayName)}</strong><span>${escapeHtml(primaryPropertySensorReading(sensor, units))}</span></span>
      </button>
      ${details}
    </li>
  `;
}

// render every available reading and hardware detail
function renderPropertySensorDetails(
  layout: PropertySensorLayout,
  sensor: PropertySensorSnapshot,
  units: UnitPreferences,
): string {
  const readings = propertySensorReadingLabels(sensor, units);
  return `
    <div class="property-sensor-details" id="property-sensor-details-${escapeHtml(sensor.key)}" data-property-sensor-details="${escapeHtml(sensor.key)}" role="region" aria-live="polite" aria-label="Details for ${escapeHtml(layout.displayName)}">
      <div class="property-sensor-readings">
        ${readings.map(
          // render every current sensor measurement
          (reading) => `<span>${escapeHtml(reading)}</span>`,
        ).join("")}
      </div>
      <p class="property-sensor-meta"><strong>EcoWitt ${escapeHtml(sensor.model)}</strong>${sensor.channel === null ? "" : ` · channel ${String(sensor.channel)}`} · ${escapeHtml(sensor.key)}</p>
      <p class="property-sensor-meta"><strong>Position</strong> ${layout.latitude.toFixed(6)}, ${layout.longitude.toFixed(6)}</p>
    </div>
  `;
}

// name one unconfigured sensor from its hardware identity
function defaultPropertySensorName(sensor: PropertySensorSnapshot): string {
  return `${sensor.model}${sensor.channel === null ? "" : ` channel ${String(sensor.channel)}`}`;
}

// choose one compact reading for a map label
function primaryPropertySensorReading(
  sensor: PropertySensorSnapshot,
  units: UnitPreferences,
): string {
  return propertySensorReadingLabels(sensor, units)[0] ?? "Reporting";
}

// format every known sensor reading consistently
function propertySensorReadingLabels(
  sensor: PropertySensorSnapshot,
  units: UnitPreferences,
): readonly string[] {
  const labels: string[] = [];
  const readings = sensor.readings;
  // format one configurable measurement
  const pushMeasurement = (
    key: string,
    label: string,
    kind: keyof UnitPreferences,
  ): void => {
    const value = readings[key];

    // omit unavailable provider readings
    if (value === undefined) {
      return;
    }

    const formatted = formatMeasurement(value, kind, units);
    labels.push(`${label} ${formatted.value}${formatted.unit.length === 0 ? "" : ` ${formatted.unit}`}`);
  };
  // format one fixed-unit measurement
  const pushFixed = (key: string, label: string, unit: string): void => {
    const value = readings[key];

    // omit unavailable provider readings
    if (value === undefined) {
      return;
    }

    labels.push(`${label} ${formatNumber(value)}${unit.length === 0 ? "" : ` ${unit}`}`);
  };
  pushMeasurement("temperatureC", "Temp", "temperature");
  pushFixed("relativeHumidityPercent", "Humidity", "%");
  pushFixed("soilMoisturePercent", "Moisture", "%");
  pushFixed("soilElectricalConductivityMicrosiemensPerCm", "EC", "µS/cm");
  pushMeasurement("windSpeedMps", "Wind", "windSpeed");
  pushMeasurement("windGustMps", "Gust", "windSpeed");
  const rainRate = readings.precipitationRateMmPerHour;

  // format rain rate with the precipitation preference
  if (rainRate !== undefined) {
    const formatted = formatPrecipitationRate(rainRate, units);
    labels.push(`Rain ${formatted.value} ${formatted.unit}`);
  }
  pushMeasurement("dailyPrecipitationMm", "Accumulation", "precipitation");
  pushMeasurement("pressureHpa", "Pressure", "pressure");
  pushFixed("pm25MicrogramsPerCubicMeter", "PM2.5", "");
  pushFixed("uvIndex", "UV", "");
  pushFixed("solarRadiationWm2", "Solar", "W/m²");
  pushMeasurement("blackGlobeTemperatureC", "Globe", "temperature");
  pushMeasurement("wetBulbGlobeTemperatureC", "WBGT", "temperature");
  pushFixed("windDirectionDegrees", "Direction", "°");
  return labels;
}

// render tiled nearby station geography and latest readings
function renderStationMap(state: DashboardState): string {
  const site = state.selectedSite;

  // wait for site geometry
  if (site === null) {
    // reserve the final station geography during the first read
    if (state.loading) {
      return renderStationMapSkeleton();
    }

    return "";
  }

  const stations = site.stations.filter(
    // map physical public stations only
    (station) =>
      station.kind === "physical" &&
      station.sources.some((source) => source.kind === "physical_sensor") &&
      Number.isFinite(station.latitude) &&
      Number.isFinite(station.longitude),
  );

  // render an honest station catalog state
  if (stations.length === 0) {
    return `
      <section class="panel" aria-labelledby="map-heading">
        <div class="section-heading"><div><p class="eyebrow">Local network</p><h2 id="map-heading">Nearby station map</h2></div></div>
        <p class="empty-panel">Nearby station coordinates are not available yet.</p>
      </section>
    `;
  }

  const viewport = createMapViewport([
    { latitude: site.latitude, longitude: site.longitude },
    ...stations,
  ]);
  const sitePoint = projectMapPoint(site.latitude, site.longitude, viewport);
  const stationHitAreas = stations.map(
    // render broad touch targets below every visible marker
    (station) => renderStationHitArea(station, viewport),
  ).join("");
  const stationMarkers = stations.map(
    // render each physical station marker
    (station, index) => renderStationMarker(station, index, viewport, state),
  ).join("");
  const stationRows = stations.map(
    // render each physical station label
    (station, index) => renderStationListItem(station, index, site, state),
  ).join("");

  return `
    <section class="panel station-map-panel" aria-labelledby="map-heading">
      <div class="section-heading">
        <div><p class="eyebrow">Local network</p><h2 id="map-heading">Nearby station map</h2></div>
      </div>
      <div class="station-map-layout">
        <div class="station-map">
          <div class="station-map-canvas" role="group" aria-label="Map of nearby public weather stations with ${escapeHtml(mapLayerLabel(state.mapLayer).toLowerCase())} tiles">
            <svg class="station-map-svg" viewBox="0 0 ${STATION_MAP_WIDTH} ${STATION_MAP_HEIGHT}" role="group" aria-label="Nearby weather station markers">
              <g class="map-tile-layer" aria-hidden="true">
                ${renderMapTiles(state.mapLayer, viewport)}
              </g>
              <g class="station-map-overlay">
                <text x="610" y="28" class="map-north" aria-hidden="true">N</text>
                <path d="M616 56V34M610 42l6-8 6 8" class="map-north-arrow" aria-hidden="true"/>
                <circle cx="${sitePoint.x.toFixed(2)}" cy="${sitePoint.y.toFixed(2)}" r="10" class="farm-marker" aria-hidden="true"/>
                ${stationHitAreas}
                ${stationMarkers}
              </g>
            </svg>
            ${renderMapLayerControls(state, viewport)}
          </div>
          ${renderMapAttribution(state.mapLayer)}
        </div>
        <ol class="nearby-station-list">
          ${stationRows}
        </ol>
      </div>
    </section>
  `;
}

// reserve the complete station map layout
function renderStationMapSkeleton(): string {
  return `
    <section class="panel station-map-panel skeleton-region" aria-labelledby="map-heading" aria-busy="true">
      <div class="section-heading">
        <div><p class="eyebrow">Local network</p><h2 id="map-heading">Nearby station map</h2></div>
      </div>
      <div class="station-map-layout">
        <div class="station-map skeleton-map" aria-hidden="true">
          <div class="station-map-canvas"><span class="skeleton-map-shape"></span></div>
          <p class="map-attribution"><span class="skeleton-attribution">© OpenStreetMap contributors</span></p>
        </div>
        <ol class="nearby-station-list skeleton-station-list" aria-hidden="true">
          ${Array.from({ length: 11 },
            // reserve the visible station rows
            (_, index) => `
              <li><button class="nearby-station-select" type="button" disabled><span class="station-number">${String(index + 1)}</span><span class="station-label"><strong class="skeleton-station-name">Station name</strong><span class="station-reading skeleton-station-reading">00°F · 0.0 mi</span></span></button></li>
            `,
          ).join("")}
        </ol>
      </div>
    </section>
  `;
}

// render actual map tiles as an overlaid style picker
function renderMapLayerControls(
  state: DashboardState,
  viewport: MapViewport,
): string {
  return `
    <div class="map-style-controls" role="group" aria-label="Map style">
      ${(["roads", "topo", "satellite"] as const).map(
        // illustrate each reviewed base layer
        (layer) => {
          const sourceZoom = mapLayerSourceZoom(layer, viewport.zoom);
          const sourceScale = 2 ** (viewport.zoom - sourceZoom);
          const previewColumn = Math.floor(
            (viewport.left + STATION_MAP_WIDTH / 2) / (STATION_MAP_TILE_SIZE * sourceScale),
          );
          const previewRow = Math.floor(
            (viewport.top + STATION_MAP_HEIGHT / 2) / (STATION_MAP_TILE_SIZE * sourceScale),
          );
          return `
            <button class="map-style-button" type="button" data-map-layer="${layer}" aria-pressed="${String(state.mapLayer === layer)}">
              <img src="${escapeHtml(mapTileUrl(layer, sourceZoom, previewColumn, previewRow))}" alt="" width="96" height="64" loading="lazy" referrerpolicy="origin">
              <span>${mapLayerLabel(layer)}</span>
            </button>
          `;
        },
      ).join("")}
    </div>
  `;
}

// render farm-scale tile choices inside the bounded viewport
function renderPropertyMapLayerControls(
  selectedLayer: MapLayer,
  viewport: MapViewport,
): string {
  return `
    <div class="map-style-controls property-map-style-controls" role="group" aria-label="Property map style">
      ${(["roads", "topo", "satellite"] as const).map(
        // illustrate each property base layer
        (layer) => {
          const sourceZoom = mapLayerSourceZoom(layer, viewport.zoom);
          const sourceScale = 2 ** (viewport.zoom - sourceZoom);
          const previewColumn = Math.floor(
            (viewport.left + PROPERTY_MAP_WIDTH / 2) / (STATION_MAP_TILE_SIZE * sourceScale),
          );
          const previewRow = Math.floor(
            (viewport.top + PROPERTY_MAP_HEIGHT / 2) / (STATION_MAP_TILE_SIZE * sourceScale),
          );
          const previewUrl = layer === "satellite"
            ? propertySatelliteImageUrl(viewport)
            : mapTileUrl(layer, sourceZoom, previewColumn, previewRow);
          return `
            <button class="map-style-button" type="button" data-property-map-layer="${layer}" aria-pressed="${String(selectedLayer === layer)}">
              <img src="${escapeHtml(previewUrl)}" alt="" width="96" height="64" loading="lazy" referrerpolicy="origin">
              <span>${mapLayerLabel(layer)}</span>
            </button>
          `;
        },
      ).join("")}
    </div>
  `;
}

// render dependency-free property zoom controls
function renderPropertyMapZoomControls(): string {
  return `
    <div class="property-map-zoom-controls" role="group" aria-label="Property map zoom">
      <button type="button" data-property-map-zoom="in" aria-label="Zoom in">+</button>
      <button type="button" data-property-map-zoom="out" aria-label="Zoom out">−</button>
      <button type="button" data-property-map-zoom="reset" aria-label="Reset map">1×</button>
    </div>
  `;
}

// create one fixed Web Mercator viewport around every marker
function createMapViewport(
  coordinates: readonly Readonly<{ latitude: number; longitude: number }>[],
): MapViewport {
  const points = coordinates.map(
    // project each checked coordinate once
    (coordinate) => webMercatorPoint(
      coordinate.latitude,
      coordinate.longitude,
      STATION_MAP_ZOOM,
    ),
  );
  const xCoordinates = points.map(
    // collect horizontal pixels
    (point) => point.x,
  );
  const yCoordinates = points.map(
    // collect vertical pixels
    (point) => point.y,
  );
  const minimumX = Math.min(...xCoordinates);
  const maximumX = Math.max(...xCoordinates);
  const minimumY = Math.min(...yCoordinates);
  const maximumY = Math.max(...yCoordinates);
  return {
    left: (minimumX + maximumX - STATION_MAP_WIDTH) / 2,
    top: (minimumY + maximumY - STATION_MAP_HEIGHT) / 2,
    zoom: STATION_MAP_ZOOM,
  };
}

// create one fixed-size Web Mercator viewport around a center point
function createFixedMapViewport(
  latitude: number,
  longitude: number,
  zoom: number,
  width: number,
  height: number,
): MapViewport {
  const center = webMercatorPoint(latitude, longitude, zoom);
  return {
    left: center.x - width / 2,
    top: center.y - height / 2,
    zoom,
  };
}

// project WGS84 station coordinates into the tile viewport
function projectMapPoint(
  latitude: number,
  longitude: number,
  viewport: MapViewport,
): Readonly<{ x: number; y: number }> {
  const point = webMercatorPoint(latitude, longitude, viewport.zoom);
  return {
    x: point.x - viewport.left,
    y: point.y - viewport.top,
  };
}

// project one coordinate into global Web Mercator pixels
function webMercatorPoint(
  latitude: number,
  longitude: number,
  zoom: number,
): Readonly<{ x: number; y: number }> {
  const boundedLatitude = Math.max(-85.051_129, Math.min(85.051_129, latitude));
  const worldSize = STATION_MAP_TILE_SIZE * 2 ** zoom;
  const latitudeRadians = boundedLatitude * Math.PI / 180;
  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * worldSize,
  };
}

// invert one viewport pixel into WGS84 coordinates
function inverseMapPoint(
  x: number,
  y: number,
  viewport: MapViewport,
): Readonly<{ latitude: number; longitude: number }> {
  const worldSize = STATION_MAP_TILE_SIZE * 2 ** viewport.zoom;
  const globalX = viewport.left + x;
  const globalY = viewport.top + y;
  return {
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * globalY / worldSize))) * 180 / Math.PI,
    longitude: globalX / worldSize * 360 - 180,
  };
}

// convert one global map pixel into Web Mercator meters
function webMercatorPixelMeters(
  x: number,
  y: number,
  zoom: number,
): Readonly<{ x: number; y: number }> {
  const worldSize = STATION_MAP_TILE_SIZE * 2 ** zoom;
  const span = WEB_MERCATOR_LIMIT_METERS * 2;
  return {
    x: x / worldSize * span - WEB_MERCATOR_LIMIT_METERS,
    y: WEB_MERCATOR_LIMIT_METERS - y / worldSize * span,
  };
}

// request one retina-resolution state aerial image for the fixed farm extent
function propertySatelliteImageUrl(viewport: MapViewport): string {
  const upperLeft = webMercatorPixelMeters(viewport.left, viewport.top, viewport.zoom);
  const lowerRight = webMercatorPixelMeters(
    viewport.left + PROPERTY_MAP_WIDTH,
    viewport.top + PROPERTY_MAP_HEIGHT,
    viewport.zoom,
  );
  const parameters = new URLSearchParams({
    bbox: `${String(upperLeft.x)},${String(lowerRight.y)},${String(lowerRight.x)},${String(upperLeft.y)}`,
    bboxSR: "3857",
    f: "image",
    format: "jpg",
    imageSR: "3857",
    interpolation: "RSP_BilinearInterpolation",
    size: `${String(PROPERTY_MAP_WIDTH * 2)},${String(PROPERTY_MAP_HEIGHT * 2)}`,
  });
  return `${PROPERTY_SATELLITE_IMAGE_SERVICE}?${parameters.toString()}`;
}

// render the higher-resolution farm aerial or a normal tiled layer
function renderPropertyMapTiles(layer: MapLayer, viewport: MapViewport): string {
  // use one cacheable high-density image for the bounded farm viewport
  if (layer === "satellite") {
    return `<image href="${escapeHtml(propertySatelliteImageUrl(viewport))}" x="0" y="0" width="${String(PROPERTY_MAP_WIDTH)}" height="${String(PROPERTY_MAP_HEIGHT)}" preserveAspectRatio="none" referrerpolicy="origin"/>`;
  }

  return renderMapTiles(layer, viewport, PROPERTY_MAP_WIDTH, PROPERTY_MAP_HEIGHT);
}

// cap federal raster tiles at their highest populated cache level
function mapLayerSourceZoom(layer: MapLayer, viewportZoom: number): number {
  return layer === "roads" ? viewportZoom : Math.min(viewportZoom, 16);
}

// render only the visible tiles for the selected base layer
function renderMapTiles(
  layer: MapLayer,
  viewport: MapViewport,
  width: number = STATION_MAP_WIDTH,
  height: number = STATION_MAP_HEIGHT,
): string {
  const sourceZoom = mapLayerSourceZoom(layer, viewport.zoom);
  const sourceScale = 2 ** (viewport.zoom - sourceZoom);
  const renderedTileSize = STATION_MAP_TILE_SIZE * sourceScale;
  const firstColumn = Math.floor(viewport.left / renderedTileSize);
  const lastColumn = Math.floor(
    (viewport.left + width) / renderedTileSize,
  );
  const firstRow = Math.floor(viewport.top / renderedTileSize);
  const lastRow = Math.floor(
    (viewport.top + height) / renderedTileSize,
  );
  let tiles = "";

  // render each visible tile row
  for (let row = firstRow; row <= lastRow; row += 1) {
    // render each visible tile column
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const left = column * renderedTileSize - viewport.left;
      const top = row * renderedTileSize - viewport.top;
      tiles += `<image href="${escapeHtml(mapTileUrl(layer, sourceZoom, column, row))}" x="${left.toFixed(2)}" y="${top.toFixed(2)}" width="${renderedTileSize}" height="${renderedTileSize}" preserveAspectRatio="none" referrerpolicy="origin"/>`;
    }
  }

  return tiles;
}

// build one reviewed provider tile URL
function mapTileUrl(
  layer: MapLayer,
  zoom: number,
  column: number,
  row: number,
): string {
  // use the OSM XYZ order for labeled roads
  if (layer === "roads") {
    return `https://tile.openstreetmap.org/${String(zoom)}/${String(column)}/${String(row)}.png`;
  }

  const service = layer === "topo" ? "USGSTopo" : "USGSImageryOnly";
  return `https://basemap.nationalmap.gov/arcgis/rest/services/${service}/MapServer/tile/${String(zoom)}/${String(row)}/${String(column)}`;
}

// render visible attribution for the selected tile provider
function renderMapAttribution(layer: MapLayer): string {
  // retain the OSM copyright link with OSM tiles
  if (layer === "roads") {
    return '<p class="map-attribution">© <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap contributors</a></p>';
  }

  return '<p class="map-attribution">Map services and data available from <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" rel="noreferrer">U.S. Geological Survey, National Geospatial Program</a>.</p>';
}

// credit the farm-specific NAIP aerial separately from cached federal tiles
function renderPropertyMapAttribution(layer: MapLayer): string {
  // retain the ordinary provider credit for roads and topo
  if (layer !== "satellite") {
    return renderMapAttribution(layer);
  }

  return '<p class="map-attribution">USGS and USDA NAIP aerial imagery from <a href="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer" rel="noreferrer">The National Map</a>.</p>';
}

// label one selectable map base layer
function mapLayerLabel(layer: MapLayer): string {
  // expand the aerial layer for consumers
  if (layer === "satellite") {
    return "Satellite";
  }

  return layer === "roads" ? "Roads" : "Topo";
}

// render one background touch target below all visible markers
function renderStationHitArea(
  station: WeatherSite["stations"][number],
  viewport: MapViewport,
): string {
  const point = projectMapPoint(station.latitude, station.longitude, viewport);

  return `
    <a class="station-marker-hit-target" href="#station-current-${escapeHtml(station.slug)}" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})" data-station-select="${escapeHtml(station.slug)}" tabindex="-1" aria-hidden="true">
      <circle class="station-marker-hit" r="41"/>
    </a>
  `;
}

// render one numbered map marker
function renderStationMarker(
  station: WeatherSite["stations"][number],
  index: number,
  viewport: MapViewport,
  state: DashboardState,
): string {
  const point = projectMapPoint(station.latitude, station.longitude, viewport);
  const reading = stationReading(station.slug, state);
  const selected = state.selectedStationSlug === station.slug;

  return `
    <a class="station-marker${selected ? " selected" : ""}" href="#station-current-${escapeHtml(station.slug)}" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})" data-station-select="${escapeHtml(station.slug)}" aria-label="Show current conditions for ${escapeHtml(station.name)}" aria-expanded="${String(selected)}" aria-controls="station-current-${escapeHtml(station.slug)}">
      <circle class="station-marker-dot" r="12"/>
      <text text-anchor="middle" dominant-baseline="central">${String(index + 1)}</text>
      <title>${escapeHtml(station.name)} · ${escapeHtml(reading)}</title>
    </a>
  `;
}

// render one map legend row
function renderStationListItem(
  station: WeatherSite["stations"][number],
  index: number,
  site: WeatherSite,
  state: DashboardState,
): string {
  const distance = distanceMiles(
    site.latitude,
    site.longitude,
    station.latitude,
    station.longitude,
  );
  const selected = state.selectedStationSlug === station.slug;
  const current = selected ? renderCompactStationCurrent(station, state) : "";

  return `
    <li class="nearby-station-item${selected ? " selected" : ""}">
      <button class="nearby-station-select" type="button" data-station-select="${escapeHtml(station.slug)}" aria-expanded="${String(selected)}" aria-controls="station-current-${escapeHtml(station.slug)}">
        <span class="station-number">${String(index + 1)}</span>
        <span class="station-label"><strong>${escapeHtml(station.name)}</strong><span class="station-reading">${escapeHtml(stationReading(station.slug, state))} · ${formatNumber(distance)} mi</span></span>
      </button>
      ${current}
    </li>
  `;
}

interface CompactStationMetric {
  readonly label: string;
  readonly value: string | null;
}

// render one station-only current snapshot
function renderCompactStationCurrent(
  station: WeatherSite["stations"][number],
  state: DashboardState,
): string {
  const platform = station.sources.find(
    // identify the station's physical platform
    (source) => source.kind === "physical_sensor",
  )?.providerName ?? "Unknown platform";
  const record = currentStationRecord(station.slug, state.current);

  // retain stations without a current sample
  if (record === undefined) {
    return `
      <div class="station-current" id="station-current-${escapeHtml(station.slug)}" data-station-current="${escapeHtml(station.slug)}" role="region" aria-live="polite" aria-label="Current conditions for ${escapeHtml(station.name)}">
        <p class="station-current-empty">No current station reading is available.</p>
        <p class="station-current-meta"><strong>Platform</strong> ${escapeHtml(platform)}</p>
      </div>
    `;
  }

  const metrics: readonly CompactStationMetric[] = [
    {
      label: "Temp",
      value: compactMeasurement(formatMeasurement(record.metrics.temperatureC, "temperature", state.units)),
    },
    {
      label: "Humidity",
      value: compactMeasurement(formatFixedMeasurement(record.metrics.relativeHumidityPercent, "%")),
    },
    {
      label: "Wind",
      value: compactStationWind(record, state.units),
    },
    {
      label: "Rain",
      value: compactMeasurement(formatPrecipitationRate(record.metrics.precipitationRateMmPerHour, state.units)),
    },
    {
      label: "Pressure",
      value: compactMeasurement(formatMeasurement(record.metrics.pressureHpa, "pressure", state.units)),
    },
    {
      label: "PM2.5",
      value: compactMeasurement(formatFixedMeasurement(record.metrics.pm25MicrogramsPerCubicMeter, "µg/m³")),
    },
    {
      label: "UV",
      value: compactMeasurement(formatFixedMeasurement(record.metrics.uvIndex, "")),
    },
  ];
  const available = metrics.filter(
    // omit unavailable station measurements
    (metric): metric is Readonly<{ label: string; value: string }> => metric.value !== null,
  );

  return `
    <div class="station-current" id="station-current-${escapeHtml(station.slug)}" data-station-current="${escapeHtml(station.slug)}" role="region" aria-live="polite" aria-label="Current conditions for ${escapeHtml(station.name)}">
      <div class="station-current-metrics">
        ${available.map(
          // render every station-only measurement
          (metric) => `<span><strong>${escapeHtml(metric.label)}</strong> ${escapeHtml(metric.value)}</span>`,
        ).join("")}
      </div>
      <p class="station-current-meta"><strong>Platform</strong> ${escapeHtml(platform)} · ${escapeHtml(record.freshness.label)} · ${formatInstant(record.validAt, state.selectedSite?.timezone)}</p>
    </div>
  `;
}

// find one station's latest physical record
function currentStationRecord(
  stationSlug: string,
  records: readonly WeatherRecord[],
): WeatherRecord | undefined {
  return records.find(
    // isolate one physical station only
    (record) =>
      record.provenance.stationSlug === stationSlug &&
      record.provenance.sourceKind === "physical_sensor",
  );
}

// collapse one formatted measurement into compact text
function compactMeasurement(measurement: FormattedMeasurement): string | null {
  // omit unavailable measurements
  if (measurement.value === "—") {
    return null;
  }

  return `${measurement.value}${measurement.unit.length === 0 ? "" : ` ${measurement.unit}`}`;
}

// combine station wind and gust into one compact value
function compactStationWind(
  record: WeatherRecord,
  units: UnitPreferences,
): string | null {
  const speed = compactMeasurement(formatMeasurement(record.metrics.windSpeedMps, "windSpeed", units));
  const gust = compactMeasurement(formatMeasurement(record.metrics.windGustMps, "windSpeed", units));

  // render both available wind readings
  if (speed !== null && gust !== null) {
    return `${speed} · gust ${gust}`;
  }

  // retain one available wind reading
  if (speed !== null) {
    return speed;
  }

  return gust === null ? null : `Gust ${gust}`;
}

// format the best current station reading
function stationReading(stationSlug: string, state: DashboardState): string {
  const record = state.current.find(
    // match one station's latest normalized row
    (candidate) => candidate.provenance.stationSlug === stationSlug,
  );

  // retain stations without a current sample
  if (record === undefined) {
    return "Awaiting current data";
  }

  // prefer temperature for weather stations
  if (record.metrics.temperatureC !== null) {
    const value = formatMeasurement(
      record.metrics.temperatureC,
      "temperature",
      state.units,
    );
    return `${value.value}${value.unit}`;
  }

  // fall back to particulate concentration
  if (record.metrics.pm25MicrogramsPerCubicMeter !== null) {
    return `${formatNumber(record.metrics.pm25MicrogramsPerCubicMeter)} µg/m³ PM2.5`;
  }

  return "Current sample available";
}

// calculate a short local great-circle distance
function distanceMiles(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const left = Math.sin(deltaLatitude / 2) ** 2;
  const right = Math.cos(latitudeA * radians) *
    Math.cos(latitudeB * radians) *
    Math.sin(deltaLongitude / 2) ** 2;
  return 3_958.8 * 2 * Math.atan2(Math.sqrt(left + right), Math.sqrt(1 - left - right));
}

// render one friendly current-condition card
function renderConditionCard(options: ConditionCardOptions): string {
  // keep related readings inside one visual card
  const secondary = options.secondary === undefined
    ? ""
    : `
      <div class="condition-secondary">
        <span class="condition-secondary-divider">${escapeHtml(options.secondary.label)}</span>
        ${renderConditionMeasurement(options.secondary.measurement)}
      </div>
    `;
  // omit details promoted into a secondary statistic
  const detail = options.band.detail.length === 0
    ? ""
    : `<p class="condition-detail">${escapeHtml(options.band.detail)}</p>`;

  return `
    <article class="condition-card ${escapeHtml(options.className)}" data-condition="${escapeHtml(options.label.toLowerCase().replaceAll(" ", "-"))}">
      ${renderConditionColor(options.band.color)}
      <div class="condition-card-content">
        <div class="condition-card-heading">
          <span class="condition-label">${renderMaterialIcon(options.icon)}<span>${escapeHtml(options.label)}</span></span>
          ${renderConditionStatus(options.band)}
        </div>
        <div class="condition-body${options.secondary === undefined ? "" : " condition-body-secondary"}">
          <div class="condition-live">
            <div class="condition-primary">${renderConditionMeasurement(options.measurement)}</div>
            ${secondary}
          </div>
          ${renderConditionForecast(options.forecast)}
        </div>
        ${detail}
      </div>
    </article>
  `;
}

// render one threshold-colored forecast summary
function renderConditionForecast(forecast: ForecastCardValue): string {
  return `
    <div class="condition-forecast">
      <span class="condition-forecast-readings">
        ${forecast.readings.map(
          // render each forecast statistic
          (reading) => `<span class="condition-forecast-reading condition-forecast-tone-${reading.tone ?? "neutral"}"><span class="condition-forecast-label">${escapeHtml(reading.label)}</span> ${renderForecastMeasurement(reading.measurement)}</span>`,
        ).join("")}
      </span>
    </div>
  `;
}

// render one compact forecast value with a subordinate unit
function renderForecastMeasurement(measurement: FormattedMeasurement): string {
  // omit empty unit furniture
  if (measurement.unit.length === 0) {
    return `<strong>${escapeHtml(measurement.value)}</strong>`;
  }

  const separator = measurement.unit.startsWith("°") || measurement.unit === "%"
    ? ""
    : " ";
  return `<strong>${escapeHtml(measurement.value)}${separator}<small>${escapeHtml(measurement.unit)}</small></strong>`;
}

// render CSP-safe color behind one condition card
function renderConditionColor(color: string): string {
  return `
    <svg class="condition-color" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect width="100" height="100" fill="${escapeHtml(color)}" opacity="0.18"/>
    </svg>
  `;
}

// render one threshold-colored status pill
function renderConditionStatus(band: ConditionBand): string {
  const textClass = conditionStatusTextClass(band.color);
  return `
    <span class="condition-status ${textClass}">
      <svg class="condition-status-color" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect width="100" height="100" fill="${escapeHtml(band.color)}"/>
      </svg>
      <span>${escapeHtml(band.label)}</span>
    </span>
  `;
}

// choose readable text over one threshold color
function conditionStatusTextClass(color: string): string {
  const channels = /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(color);
  const luminance = channels === null
    ? 0
    : linearizeColorChannel(channels[1]) * 0.2126 +
      linearizeColorChannel(channels[2]) * 0.7152 +
      linearizeColorChannel(channels[3]) * 0.0722;
  return luminance > 0.179 ? "condition-status-dark" : "condition-status-light";
}

// convert one color channel to relative luminance
function linearizeColorChannel(channel: string | undefined): number {
  const normalized = Number(channel ?? 0) / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

// render one decorative Material symbol
function renderMaterialIcon(name: MaterialIconName): string {
  return `<span class="material-symbols-rounded" aria-hidden="true">${name}</span>`;
}

// render the Material save shape without a font dependency
function renderSaveIcon(): string {
  return '<svg class="material-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4Zm2 16H5V5h11.17L19 7.83V19ZM12 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 6h9v4H6V6Z"/></svg>';
}

// render one large value with its configured unit
function renderConditionMeasurement(measurement: FormattedMeasurement): string {
  // omit empty unit furniture
  if (measurement.unit.length === 0) {
    return `<strong>${escapeHtml(measurement.value)}</strong>`;
  }

  return `<strong>${escapeHtml(measurement.value)}<small>${escapeHtml(measurement.unit)}</small></strong>`;
}

// classify temperature comfort and interpolate the requested color scale
export function temperatureBand(valueC: number | null): ConditionBand {
  // preserve unavailable temperature honestly
  if (valueC === null) {
    return unavailableBand("Temperature reading unavailable");
  }

  const valueF = valueC * 9 / 5 + 32;
  const color = valueF <= 60
    ? interpolateColor([56, 120, 197], [67, 151, 86], (valueF - 32) / 28)
    : interpolateColor([67, 151, 86], [207, 67, 55], (valueF - 60) / 20);

  // label freezing conditions
  if (valueF <= 32) {
    return { color, detail: "At or below the freezing point", label: "Freezing" };
  }

  // label chilly conditions
  if (valueF < 50) {
    return { color, detail: "Cool outdoor conditions", label: "Chilly" };
  }

  // label cool conditions
  if (valueF < 60) {
    return { color, detail: "Approaching the comfort range", label: "Cool" };
  }

  // label comfortable conditions
  if (valueF <= 70) {
    return { color, detail: "Comfortable outdoor temperature", label: "Comfortable" };
  }

  // label warm conditions
  if (valueF <= 80) {
    return { color, detail: "Warm outdoor conditions", label: "Warm" };
  }

  return { color, detail: "Hot outdoor conditions", label: "Hot" };
}

// classify wind using the stronger sustained or gust speed
export function windBand(
  speedMps: number | null,
  gustMps: number | null,
  units: UnitPreferences = DEFAULT_UNIT_PREFERENCES,
): ConditionBand {
  const available = [speedMps, gustMps].filter((value): value is number => value !== null);

  // preserve unavailable wind honestly
  if (available.length === 0) {
    return unavailableBand("Wind reading unavailable");
  }

  const valueMph = Math.max(...available) * 2.236_936_292_1;
  const peak = formatMeasurement(Math.max(...available), "windSpeed", units, 0);
  const color = interpolateColor(
    [67, 151, 86],
    [207, 67, 55],
    (valueMph - 10) / 40,
  );

  // label calm air
  if (valueMph <= 3) {
    return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Calm" };
  }

  // retain green through ten miles per hour
  if (valueMph < 10) {
    return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Light" };
  }

  // label a noticeable breeze
  if (valueMph < 20) {
    return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Breezy" };
  }

  // label stronger wind
  if (valueMph < 35) {
    return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Windy" };
  }

  // label very strong wind
  if (valueMph < 50) {
    return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Very windy" };
  }

  return { color, detail: `Peak reading ${peak.value} ${peak.unit}`, label: "Dangerous" };
}

// classify PM2.5 with current EPA health-category breakpoints
export function airQualityBand(value: number | null): ConditionBand {
  // preserve unavailable particulate data honestly
  if (value === null) {
    return unavailableBand("PM2.5 reading unavailable");
  }

  // label the good PM2.5 range
  if (value <= 9) {
    return { color: "rgb(0, 146, 63)", detail: "PM2.5 health range", label: "Good" };
  }

  // label the moderate PM2.5 range
  if (value <= 35.4) {
    return { color: "rgb(230, 181, 25)", detail: "PM2.5 health range", label: "Moderate" };
  }

  // label sensitive-group risk
  if (value <= 55.4) {
    return { color: "rgb(239, 126, 31)", detail: "PM2.5 health range", label: "Sensitive groups" };
  }

  // label unhealthy particulate levels
  if (value <= 125.4) {
    return { color: "rgb(207, 67, 55)", detail: "PM2.5 health range", label: "Unhealthy" };
  }

  // label very unhealthy particulate levels
  if (value <= 225.4) {
    return { color: "rgb(124, 81, 116)", detail: "PM2.5 health range", label: "Very unhealthy" };
  }

  return { color: "rgb(114, 30, 52)", detail: "PM2.5 health range", label: "Hazardous" };
}

// classify UV exposure with the EPA scale
export function uvBand(value: number | null): ConditionBand {
  // preserve unavailable UV data honestly
  if (value === null) {
    return unavailableBand("UV reading unavailable");
  }

  // label low UV exposure
  if (value <= 2) {
    return { color: "rgb(0, 146, 63)", detail: "Minimal sun protection needed", label: "Low" };
  }

  // label moderate UV exposure
  if (value <= 5) {
    return { color: "rgb(230, 181, 25)", detail: "Sun protection recommended", label: "Moderate" };
  }

  // label high UV exposure
  if (value <= 7) {
    return { color: "rgb(239, 126, 31)", detail: "Reduce midday exposure", label: "High" };
  }

  // label very high UV exposure
  if (value <= 10) {
    return { color: "rgb(207, 67, 55)", detail: "Extra sun protection needed", label: "Very high" };
  }

  return { color: "rgb(124, 81, 116)", detail: "Avoid unprotected sun exposure", label: "Extreme" };
}

// classify pressure around the standard sea-level range
export function pressureBand(
  valueHpa: number | null,
  units: UnitPreferences = DEFAULT_UNIT_PREFERENCES,
): ConditionBand {
  // preserve unavailable pressure honestly
  if (valueHpa === null) {
    return unavailableBand("Pressure reading unavailable");
  }

  const low = formatMeasurement(1_009, "pressure", units);
  const high = formatMeasurement(1_022.7, "pressure", units);

  // label pressure below the normal display band
  if (valueHpa < 1_009) {
    return { color: "rgb(56, 120, 197)", detail: `Below ${low.value} ${low.unit}`, label: "Low" };
  }

  // label pressure above the normal display band
  if (valueHpa > 1_022.7) {
    return { color: "rgb(207, 67, 55)", detail: `Above ${high.value} ${high.unit}`, label: "High" };
  }

  return { color: "rgb(67, 151, 86)", detail: `${low.value}–${high.value} ${low.unit}`, label: "Normal" };
}

// classify relative humidity by outdoor comfort
export function humidityBand(value: number | null): ConditionBand {
  // preserve unavailable humidity honestly
  if (value === null) {
    return unavailableBand("Humidity reading unavailable");
  }

  // label dry air
  if (value < 30) {
    return { color: "rgb(200, 183, 68)", detail: "Dry air", label: "Dry" };
  }

  // label the common comfort range
  if (value <= 60) {
    return { color: "rgb(67, 151, 86)", detail: "Comfortable humidity", label: "Comfortable" };
  }

  // flag the first humid comfort band
  if (value <= 70) {
    return { color: "rgb(230, 181, 25)", detail: "Noticeably humid air", label: "Humid" };
  }

  // flag uncomfortable humidity
  if (value <= 80) {
    return { color: "rgb(239, 126, 31)", detail: "Uncomfortably humid air", label: "Very humid" };
  }

  return { color: "rgb(207, 67, 55)", detail: "Oppressively humid air", label: "Very humid" };
}

// describe the current precipitation rate
function rainBand(valueMmPerHour: number | null): ConditionBand {
  // preserve unavailable rain-rate data honestly
  if (valueMmPerHour === null) {
    return unavailableBand("Rain-rate reading unavailable");
  }

  // label dry conditions
  if (valueMmPerHour === 0) {
    return { color: "rgb(84, 84, 80)", detail: "No rain detected", label: "Dry now" };
  }

  // label light rain
  if (valueMmPerHour <= 2.5) {
    return { color: "rgb(56, 120, 197)", detail: "Light hourly rainfall", label: "Light rain" };
  }

  // label moderate rain
  if (valueMmPerHour <= 7.62) {
    return { color: "rgb(56, 120, 197)", detail: "Steady hourly rainfall", label: "Rain" };
  }

  return { color: "rgb(124, 81, 116)", detail: "Heavy hourly rainfall", label: "Heavy rain" };
}

// provide one neutral unavailable-data presentation
function unavailableBand(detail: string): ConditionBand {
  return { color: "rgb(136, 136, 130)", detail, label: "Unavailable" };
}

// interpolate and clamp one RGB color
function interpolateColor(start: RgbColor, end: RgbColor, progress: number): string {
  const boundedProgress = Math.max(0, Math.min(1, progress));
  const channels = [
    Math.round(start[0] + (end[0] - start[0]) * boundedProgress),
    Math.round(start[1] + (end[1] - start[1]) * boundedProgress),
    Math.round(start[2] + (end[2] - start[2]) * boundedProgress),
  ];
  return `rgb(${channels.join(", ")})`;
}

// map one discrete condition color to its CSP-safe text tone
function forecastToneForBand(value: number | null, band: ConditionBand): ForecastTone {
  // keep unavailable colors neutral
  if (value === null) {
    return "neutral";
  }

  // retain the approved discrete threshold palette
  switch (band.color) {
    case "rgb(56, 120, 197)": return "blue";
    case "rgb(114, 30, 52)": return "burgundy";
    case "rgb(200, 183, 68)": return "gold";
    case "rgb(84, 84, 80)": return "gray";
    case "rgb(0, 146, 63)":
    case "rgb(67, 151, 86)": return "green";
    case "rgb(239, 126, 31)": return "orange";
    case "rgb(124, 81, 116)": return "purple";
    case "rgb(207, 67, 55)": return "red";
    case "rgb(230, 181, 25)": return "yellow";
    default: return "neutral";
  }
}

// classify forecast temperature with its semantic threshold color
function forecastTemperatureTone(valueC: number | null): ForecastTone {
  // retain the requested temperature bands
  switch (temperatureBand(valueC).label) {
    case "Freezing":
    case "Chilly": return "blue";
    case "Cool":
    case "Comfortable": return "green";
    case "Warm": return "orange";
    case "Hot": return "red";
    default: return "neutral";
  }
}

// classify forecast wind with its semantic threshold color
function forecastWindTone(valueMps: number | null, units: UnitPreferences): ForecastTone {
  // retain the requested wind bands
  switch (windBand(valueMps, null, units).label) {
    case "Calm":
    case "Light": return "green";
    case "Breezy": return "yellow";
    case "Windy": return "orange";
    case "Very windy": return "red";
    case "Dangerous": return "purple";
    default: return "neutral";
  }
}

// render filters and paginated history
function renderHistory(state: DashboardState): string {
  return `
    <section class="panel" aria-labelledby="history-heading">
      <div class="section-heading">
        <div><p class="eyebrow">Past conditions</p><h2 id="history-heading">Weather history</h2></div>
        <span class="page-label">Page ${String(state.page + 1)}</span>
      </div>
      ${renderHistoryFilters(state)}
      <div class="table-scroll">
        <table>
          <caption class="sr-only">Filterable weather history for ${escapeHtml(state.selectedSite?.name ?? "the selected site")}</caption>
          <thead><tr><th scope="col">Valid time</th><th scope="col">Temperature (${escapeHtml(formatMeasurement(0, "temperature", state.units).unit)})</th><th scope="col">Humidity (%)</th><th scope="col">Wind (${escapeHtml(formatMeasurement(0, "windSpeed", state.units).unit)})</th><th scope="col">Precipitation (${escapeHtml(formatMeasurement(0, "precipitation", state.units).unit)})</th><th scope="col">Source and provenance</th></tr></thead>
          <tbody>${renderHistoryRows(state)}</tbody>
        </table>
      </div>
      ${renderHistoryCards(state)}
      <nav class="pagination" aria-label="History pages">
        <button type="button" data-page="previous"${state.page === 0 || state.loading ? " disabled" : ""}>Previous</button>
        <button type="button" data-page="next"${state.nextCursor === null || state.loading ? " disabled" : ""}>Next</button>
      </nav>
    </section>
  `;
}

// render history filter controls
function renderHistoryFilters(state: DashboardState): string {
  let stationOptions = `<option value="">All stations</option>`;
  let sourceOptions = `<option value="">All sources</option>`;
  const timezone = state.selectedSite?.timezone ?? "UTC";
  const activeFilterCount = Object.values(state.filters).filter(
    // count configured filter values
    (value) => value !== undefined,
  ).length;

  // collect the selected site's sources
  for (const station of state.selectedSite?.stations ?? []) {
    const stationSelected = station.slug === state.filters.stationSlug ? " selected" : "";
    stationOptions += `<option value="${escapeHtml(station.slug)}"${stationSelected}>${escapeHtml(station.name)}</option>`;

    // render every source option
    for (const source of station.sources) {
      const selected = source.id === state.filters.sourceId ? " selected" : "";
      sourceOptions += `<option value="${escapeHtml(source.id)}"${selected}>${escapeHtml(source.provenanceLabel)}</option>`;
    }
  }

  return `
    <details class="history-filter-disclosure" data-history-filter-disclosure data-filter-active="${String(activeFilterCount > 0)}">
      <summary>Filters${activeFilterCount === 0 ? "" : ` · ${String(activeFilterCount)} active`}</summary>
      <form class="filters" data-history-filters>
        <label><span>Station</span><select name="stationSlug">${stationOptions}</select></label>
        <label><span>Source</span><select name="sourceId">${sourceOptions}</select></label>
        <label><span>Provenance</span><select name="sourceKind">
          <option value="">All kinds</option>
          <option value="model_current"${state.filters.sourceKind === "model_current" ? " selected" : ""}>Model current</option>
          <option value="reanalysis"${state.filters.sourceKind === "reanalysis" ? " selected" : ""}>Historical reanalysis</option>
        </select></label>
        <label><span>From</span><input name="from" type="datetime-local" value="${escapeHtml(toLocalInput(state.filters.from, timezone))}"></label>
        <label><span>To</span><input name="to" type="datetime-local" value="${escapeHtml(toLocalInput(state.filters.to, timezone))}"></label>
        <button type="submit"${state.loading ? " disabled" : ""}>Apply filters</button>
      </form>
    </details>
  `;
}

// render history table rows
function renderHistoryRows(state: DashboardState): string {
  // render a useful empty row
  if (state.history.length === 0) {
    // reserve one full result page during the first read
    if (state.loading) {
      return Array.from({ length: 25 },
        // preserve every final history row
        () => `
          <tr class="skeleton-history-row" aria-hidden="true">
            ${Array.from({ length: 6 },
              // reserve each final history cell
              () => '<td><span class="skeleton-line skeleton-table-value"></span></td>',
            ).join("")}
          </tr>
        `,
      ).join("");
    }

    return `<tr><td colspan="6" class="empty">No records match these filters.</td></tr>`;
  }

  let rows = "";

  // render every visible record
  for (const record of state.history) {
    rows += `
      <tr>
        <td><time datetime="${escapeHtml(record.validAt)}">${formatInstant(record.validAt, state.selectedSite?.timezone)}</time></td>
        <td>${formatMeasurementCell(record.metrics.temperatureC, "temperature", state.units)}</td>
        <td>${formatMetricCell(record.metrics.relativeHumidityPercent, "%")}</td>
        <td>${formatMeasurementCell(record.metrics.windSpeedMps, "windSpeed", state.units)}</td>
        <td>${formatMeasurementCell(record.metrics.precipitationMm, "precipitation", state.units)}</td>
        <td><span class="source-kind">${escapeHtml(record.provenance.label)}</span><small>${escapeHtml(record.provenance.sourceKey)}</small></td>
      </tr>
    `;
  }

  return rows;
}

// render compact phone history records
function renderHistoryCards(state: DashboardState): string {
  // render one compact empty state
  if (state.history.length === 0) {
    // reserve one full mobile result page during the first read
    if (state.loading) {
      return `
        <ol class="history-cards skeleton-history-cards" aria-label="Loading weather history" aria-busy="true">
          ${Array.from({ length: 25 },
            // preserve every final mobile history card
            () => `
              <li aria-hidden="true">
                <article class="history-card skeleton-history-card">
                  <div class="history-card-primary"><span class="skeleton-line skeleton-history-time"></span><span class="skeleton-line skeleton-history-temperature"></span></div>
                  <div class="history-card-metrics"><span class="skeleton-line skeleton-history-metric"></span><span class="skeleton-line skeleton-history-metric"></span><span class="skeleton-line skeleton-history-metric"></span></div>
                  <span class="skeleton-line skeleton-history-source"></span>
                </article>
              </li>
            `,
          ).join("")}
        </ol>
      `;
    }

    return '<p class="history-cards-empty">No records match these filters.</p>';
  }

  return `
    <ol class="history-cards" aria-label="Compact weather history">
      ${state.history.map(
        // render each mobile history record
        (record) => `
          <li>
            <article class="history-card">
              <div class="history-card-primary">
                <time datetime="${escapeHtml(record.validAt)}">${formatInstant(record.validAt, state.selectedSite?.timezone)}</time>
                <strong>${formatMeasurementCell(record.metrics.temperatureC, "temperature", state.units)}</strong>
              </div>
              <div class="history-card-metrics">
                <span><strong>Humidity</strong> ${formatMetricCell(record.metrics.relativeHumidityPercent, "%")}</span>
                <span><strong>Wind</strong> ${formatMeasurementCell(record.metrics.windSpeedMps, "windSpeed", state.units)}</span>
                <span><strong>Rain</strong> ${formatMeasurementCell(record.metrics.precipitationMm, "precipitation", state.units)}</span>
              </div>
              <details><summary>Source</summary><span>${escapeHtml(record.provenance.label)}</span><small>${escapeHtml(record.provenance.sourceKey)}</small></details>
            </article>
          </li>
        `,
      ).join("")}
    </ol>
  `;
}

// connect rendered controls to controller actions
function bindDashboardControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  bindUnitSettings(root, controller);
  bindForecastCharts(root, controller);
  bindTrendMetricControl(root, controller);
  bindTrendViewControls(root, controller);
  bindTrendYearControls(root, controller);
  bindTrendCrosshair(root, controller);
  bindMapControls(root, controller);
  bindPropertyMapControls(root, controller);
  bindPropertySensorMap(root, controller);
  bindPropertySensorAdmin(root, controller);
  const filterDisclosure = root.querySelector<HTMLDetailsElement>("[data-history-filter-disclosure]");

  // expand filters on wide screens or when active
  if (filterDisclosure !== null) {
    const compact = window.matchMedia("(max-width: 42rem)").matches;
    filterDisclosure.open = !compact || filterDisclosure.dataset.filterActive === "true";
  }

  const form = root.querySelector<HTMLFormElement>("[data-history-filters]");

  // wire filter submission
  if (form !== null) {
    // parse one filter form
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const timezone = controller.state.selectedSite?.timezone ?? "UTC";
      let from: string | undefined;
      let to: string | undefined;

      try {
        from = toInstant(data.get("from"), timezone);
        to = toInstant(data.get("to"), timezone);
      } catch (error) {
        // report site-time validation only
        if (error instanceof RangeError) {
          controller.reportInvalidHistoryWallClock();
          return;
        }

        throw error;
      }

      void controller.setFilters({
        ...optionalFilter("from", from),
        ...optionalFilter("sourceId", readFormValue(data.get("sourceId"))),
        ...optionalFilter(
          "sourceKind",
          readFormValue(data.get("sourceKind")) as SiteSource["kind"] | undefined,
        ),
        ...optionalFilter("stationSlug", readFormValue(data.get("stationSlug"))),
        ...optionalFilter("to", to),
      });
    });
  }

  const previous = root.querySelector<HTMLButtonElement>("[data-page='previous']");

  // wire the previous page
  if (previous !== null) {
    // navigate backward
    previous.addEventListener("click", () => {
      void controller.previousPage();
    });
  }

  const next = root.querySelector<HTMLButtonElement>("[data-page='next']");

  // wire the next page
  if (next !== null) {
    // navigate forward
    next.addEventListener("click", () => {
      void controller.nextPage();
    });
  }
}

// keep map markers fixed-size while their coordinate anchors move
function positionPropertyMapAnchors(map: SVGSVGElement): void {
  const scale = Number(map.dataset.propertyMapScale ?? 1);
  const translateX = Number(map.dataset.propertyMapTranslateX ?? 0);
  const translateY = Number(map.dataset.propertyMapTranslateY ?? 0);

  // position every map marker from its original viewport coordinate
  for (const anchor of map.querySelectorAll<SVGGraphicsElement>("[data-property-map-anchor]")) {
    const x = Number(anchor.dataset.propertyMapX);
    const y = Number(anchor.dataset.propertyMapY);

    // reject incomplete rendered marker coordinates
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    anchor.setAttribute(
      "transform",
      `translate(${(translateX + x * scale).toFixed(3)} ${(translateY + y * scale).toFixed(3)})`,
    );
  }
}

// connect property layers and bounded pan-and-zoom behavior
function bindPropertyMapControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  // wire every farm-scale tile layer
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-property-map-layer]")) {
    // render the selected property tile source
    button.addEventListener("click", () => {
      const layer = button.dataset.propertyMapLayer;

      // reject impossible rendered values
      if (layer !== "roads" && layer !== "topo" && layer !== "satellite") {
        return;
      }

      controller.setPropertyMapLayer(layer);
    });
  }

  // bind each public or admin property viewport
  for (const map of root.querySelectorAll<SVGSVGElement>("[data-property-interactive-map]")) {
    const world = map.querySelector<SVGGElement>("[data-property-map-world]");
    const shell = map.parentElement;
    const width = Number(map.dataset.propertyMapWidth);
    const height = Number(map.dataset.propertyMapHeight);

    // reject incomplete rendered map contracts
    if (
      world === null ||
      shell === null ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let gesture: null | {
      moved: boolean;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startTranslateX: number;
      startTranslateY: number;
    } = null;

    // clamp one translation inside the original farm extent
    const clampTranslation = (value: number, dimension: number): number =>
      Math.min(0, Math.max(dimension - dimension * scale, value));

    // publish one transform to the SVG and placement editor
    const applyTransform = (): void => {
      translateX = clampTranslation(translateX, width);
      translateY = clampTranslation(translateY, height);
      world.setAttribute(
        "transform",
        `translate(${translateX.toFixed(3)} ${translateY.toFixed(3)}) scale(${scale.toFixed(4)})`,
      );
      map.dataset.propertyMapScale = String(scale);
      map.dataset.propertyMapTranslateX = String(translateX);
      map.dataset.propertyMapTranslateY = String(translateY);
      positionPropertyMapAnchors(map);
      shell.querySelector<HTMLButtonElement>('[data-property-map-zoom="out"]')
        ?.toggleAttribute("disabled", scale <= 1);
      shell.querySelector<HTMLButtonElement>('[data-property-map-zoom="reset"]')
        ?.toggleAttribute("disabled", scale <= 1);
    };

    // convert one browser point into the fixed SVG viewport
    const viewportPoint = (
      clientX: number,
      clientY: number,
    ): Readonly<{ x: number; y: number }> | null => {
      const bounds = map.getBoundingClientRect();

      // reject hidden or collapsed maps
      if (bounds.width <= 0 || bounds.height <= 0) {
        return null;
      }

      return {
        x: (clientX - bounds.left) / bounds.width * width,
        y: (clientY - bounds.top) / bounds.height * height,
      };
    };

    // zoom around one stable viewport point
    const zoomAt = (nextScale: number, x: number, y: number): void => {
      const boundedScale = Math.max(1, Math.min(4, nextScale));
      const mapX = (x - translateX) / scale;
      const mapY = (y - translateY) / scale;
      scale = boundedScale;
      translateX = x - mapX * scale;
      translateY = y - mapY * scale;
      applyTransform();
    };

    // zoom with a mouse wheel or trackpad
    map.addEventListener("wheel", (event) => {
      event.preventDefault();
      const point = viewportPoint(event.clientX, event.clientY);

      // wait for a measurable map
      if (point === null) {
        return;
      }

      zoomAt(scale * (event.deltaY < 0 ? 1.25 : 0.8), point.x, point.y);
    }, { passive: false });

    // start one bounded pointer pan
    map.addEventListener("pointerdown", (event) => {
      gesture = {
        moved: false,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startTranslateX: translateX,
        startTranslateY: translateY,
      };
      map.setPointerCapture(event.pointerId);
      map.classList.add("property-map-dragging");
    });

    // pan the zoomed content without leaving the fixed extent
    map.addEventListener("pointermove", (event) => {
      // require the active pointer
      if (gesture === null || gesture.pointerId !== event.pointerId) {
        return;
      }

      const bounds = map.getBoundingClientRect();

      // reject hidden maps during layout changes
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }

      const deltaX = (event.clientX - gesture.startClientX) / bounds.width * width;
      const deltaY = (event.clientY - gesture.startClientY) / bounds.height * height;
      gesture.moved ||= Math.hypot(deltaX, deltaY) > 3;
      translateX = gesture.startTranslateX + deltaX;
      translateY = gesture.startTranslateY + deltaY;
      applyTransform();
    });

    // finish one pointer pan and suppress its synthetic placement click
    const finishPan = (event: PointerEvent): void => {
      // require the active pointer
      if (gesture === null || gesture.pointerId !== event.pointerId) {
        return;
      }

      map.dataset.propertyMapSuppressClick = String(gesture.moved);
      gesture = null;
      map.classList.remove("property-map-dragging");

      // release only a retained pointer capture
      if (map.hasPointerCapture(event.pointerId)) {
        map.releasePointerCapture(event.pointerId);
      }
    };
    map.addEventListener("pointerup", finishPan);
    map.addEventListener("pointercancel", finishPan);

    // wire explicit mobile-friendly zoom controls
    for (const button of shell.querySelectorAll<HTMLButtonElement>("[data-property-map-zoom]")) {
      // apply one requested zoom operation
      button.addEventListener("click", () => {
        const operation = button.dataset.propertyMapZoom;

        // restore the exact original property bounds
        if (operation === "reset") {
          scale = 1;
          translateX = 0;
          translateY = 0;
          applyTransform();
          return;
        }

        const nextScale = operation === "in" ? scale * 1.5 : scale / 1.5;
        zoomAt(nextScale, width / 2, height / 2);
      });
    }

    applyTransform();
  }
}

// synchronize one list or map control with its matching peers
function bindRelatedMapHighlight(
  root: HTMLElement,
  control: HTMLElement,
  attribute: "data-property-sensor-view" | "data-station-select",
  identity: string,
): void {
  // toggle every rendered peer together
  const togglePeers = (active: boolean): void => {
    // update each matching marker and list control
    for (const peer of root.querySelectorAll<HTMLElement>(`[${attribute}="${CSS.escape(identity)}"]`)) {
      peer.classList.toggle("related-hover", active);
    }
  };

  // highlight peers from pointer navigation
  control.addEventListener("pointerenter", () => togglePeers(true));
  control.addEventListener("pointerleave", () => togglePeers(false));
  // highlight peers from keyboard navigation
  control.addEventListener("focus", () => togglePeers(true));
  control.addEventListener("blur", () => togglePeers(false));
}

// connect the public property sensor map and list
function bindPropertySensorMap(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  // wire every matching property marker and list control
  for (const control of root.querySelectorAll<HTMLElement>("[data-property-sensor-view]")) {
    const sensorKey = control.dataset.propertySensorView;

    // reject incomplete rendered identities
    if (sensorKey === undefined) {
      continue;
    }

    bindRelatedMapHighlight(root, control, "data-property-sensor-view", sensorKey);

    // keep marker clicks separate from map panning
    if (control.classList.contains("property-sensor-marker")) {
      control.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    // reveal one sensor's complete reading set
    control.addEventListener("click", (event) => {
      event.preventDefault();
      controller.setSelectedPropertySensor(sensorKey);

      // reveal list details selected from the map
      if (control.classList.contains("property-sensor-marker")) {
        root.querySelector<HTMLElement>(`[data-property-sensor-details="${CSS.escape(sensorKey)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }
}

// connect the protected property sensor editor
function bindPropertySensorAdmin(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  // wire each reporting sensor selector
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-property-sensor-select]")) {
    // open one sensor editor
    button.addEventListener("click", () => {
      const sensorKey = button.dataset.propertySensorSelect;

      // reject incomplete rendered controls
      if (sensorKey === undefined) {
        return;
      }

      controller.setSelectedPropertySensor(sensorKey);
    });
  }

  const form = root.querySelector<HTMLFormElement>("[data-property-sensor-form]");
  const map = root.querySelector<SVGSVGElement>("[data-property-position-map]");

  // skip every non-admin route and incomplete render
  if (form === null || map === null) {
    return;
  }

  const latitudeInput = form.elements.namedItem("latitude");
  const longitudeInput = form.elements.namedItem("longitude");
  const nameInput = form.elements.namedItem("displayName");
  const viewport: MapViewport = {
    left: Number(map.dataset.viewportLeft),
    top: Number(map.dataset.viewportTop),
    zoom: Number(map.dataset.viewportZoom),
  };
  const updateMarker = (): void => {
    const latitude = latitudeInput instanceof HTMLInputElement
      ? latitudeInput.valueAsNumber
      : Number.NaN;
    const longitude = longitudeInput instanceof HTMLInputElement
      ? longitudeInput.valueAsNumber
      : Number.NaN;

    // preserve the last valid marker while fields are incomplete
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    const point = projectMapPoint(latitude, longitude, viewport);
    const marker = map.querySelector<SVGGElement>("[data-property-position-marker]");

    // update the anchor before applying the current map transform
    if (marker !== null) {
      marker.dataset.propertyMapX = point.x.toFixed(2);
      marker.dataset.propertyMapY = point.y.toFixed(2);
      positionPropertyMapAnchors(map);
    }
  };

  // place the selected sensor at the tapped map point
  map.addEventListener("click", (event) => {
    const bounds = map.getBoundingClientRect();

    // suppress the placement click emitted after a pan
    if (map.dataset.propertyMapSuppressClick === "true") {
      delete map.dataset.propertyMapSuppressClick;
      return;
    }

    // reject a hidden or collapsed map
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    delete map.dataset.propertyMapSuppressClick;
    const displayX = (event.clientX - bounds.left) / bounds.width * PROPERTY_MAP_WIDTH;
    const displayY = (event.clientY - bounds.top) / bounds.height * PROPERTY_MAP_HEIGHT;
    const scale = Number(map.dataset.propertyMapScale ?? 1);
    const translateX = Number(map.dataset.propertyMapTranslateX ?? 0);
    const translateY = Number(map.dataset.propertyMapTranslateY ?? 0);
    const x = (displayX - translateX) / scale;
    const y = (displayY - translateY) / scale;
    const coordinate = inverseMapPoint(x, y, viewport);

    // update both explicit coordinate fields
    if (latitudeInput instanceof HTMLInputElement && longitudeInput instanceof HTMLInputElement) {
      latitudeInput.value = coordinate.latitude.toFixed(6);
      longitudeInput.value = coordinate.longitude.toFixed(6);
      updateMarker();
    }
  });

  // keep manual coordinate edits visible on the map
  if (latitudeInput instanceof HTMLInputElement && longitudeInput instanceof HTMLInputElement) {
    latitudeInput.addEventListener("input", updateMarker);
    longitudeInput.addEventListener("input", updateMarker);
  }

  // preview every map-icon selection immediately
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="icon"]')) {
    // reflect one checked category in the map pin
    input.addEventListener("change", () => {
      const markerIcon = map.querySelector<SVGTextElement>("[data-property-position-marker-icon]");

      // ignore unchecked or invalid rendered controls
      if (!input.checked || !isPropertySensorIcon(input.value) || markerIcon === null) {
        return;
      }

      markerIcon.textContent = propertySensorMaterialIcon(input.value);
    });
  }

  // persist one validated sensor layout
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const sensorKey = form.dataset.sensorKey;
    const icon = new FormData(form).get("icon");

    // reject incomplete rendered form contracts
    if (
      sensorKey === undefined ||
      !(nameInput instanceof HTMLInputElement) ||
      !(latitudeInput instanceof HTMLInputElement) ||
      !(longitudeInput instanceof HTMLInputElement) ||
      !isPropertySensorIcon(icon)
    ) {
      return;
    }

    void controller.savePropertySensorLayout(
      sensorKey,
      nameInput.value,
      icon,
      latitudeInput.valueAsNumber,
      longitudeInput.valueAsNumber,
    );
  });
}

// connect the synchronized forecast crosshair
function bindForecastCharts(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  bindForecastRangeControls(root, controller);
  const mapBinding = bindForecastWeatherMap(root);
  const grid = root.querySelector<HTMLElement>("[data-forecast-charts]");

  // require a rendered forecast stack
  if (grid === null) {
    return;
  }

  const parsedTimes = JSON.parse(grid.dataset.forecastTimes ?? "[]") as unknown;

  // require the rendered time contract
  if (!Array.isArray(parsedTimes) || parsedTimes.some((value) => typeof value !== "string")) {
    return;
  }

  const times = parsedTimes as string[];

  // require at least one forecast instant
  if (times.length === 0) {
    return;
  }

  const chartStates = [...grid.querySelectorAll<HTMLElement>("[data-forecast-chart]")].map(
    // cache one chart's rendered series contract
    (element) => ({
      element,
      format: element.dataset.forecastFormat as ForecastChartFormat,
      maximum: Number(element.dataset.forecastMax ?? 1),
      minimum: Number(element.dataset.forecastMin ?? 0),
      outputs: [...element.querySelectorAll<HTMLElement>("[data-forecast-value]")],
      series: JSON.parse(element.dataset.forecastSeries ?? "[]") as ForecastChartSeries[],
      value: element.querySelector<HTMLElement>(".forecast-chart-value"),
    }),
  );
  const shell = grid.closest<HTMLElement>(".forecast-chart-shell") ?? grid;
  const time = shell.querySelector<HTMLTimeElement>("[data-forecast-crosshair-time]");
  const timezone = controller.state.selectedSite?.timezone;
  let position = Math.max(0, Math.min(times.length - 1, Number(grid.dataset.forecastInitialIndex ?? 0)));
  let gesture: null | {
    horizontal: boolean;
    moved: boolean;
    pointerId: number;
    surface: HTMLElement | SVGSVGElement;
    startX: number;
    startY: number;
  } = null;
  const currentPosition = Math.max(0, Math.min(times.length - 1, Number(grid.dataset.forecastCurrentPosition ?? 0)));
  const currentRatio = times.length === 1 ? 0 : currentPosition / (times.length - 1);
  shell.style.setProperty("--forecast-current-time-position", `${String(currentRatio * 100)}%`);
  shell.classList.toggle("forecast-current-start", currentRatio < 0.1);
  shell.classList.toggle("forecast-current-end", currentRatio > 0.9);

  // render one continuous crosshair position
  const updatePosition = (nextPosition: number, immediateMap = false): void => {
    position = Math.max(0, Math.min(times.length - 1, nextPosition));
    const ratio = times.length === 1 ? 0 : position / (times.length - 1);
    const selectedIndex = Math.max(0, Math.min(times.length - 1, Math.round(position)));
    const selectedTime = interpolateForecastInstant(times, position);
    const summaries: string[] = [];
    shell.style.setProperty("--forecast-crosshair-position", `${String(ratio * 100)}%`);
    shell.classList.toggle("forecast-crosshair-start", ratio < 0.1);
    shell.classList.toggle("forecast-crosshair-end", ratio > 0.9);
    grid.setAttribute("aria-valuenow", String(selectedIndex));

    // update the shared clock
    if (time !== null) {
      time.dateTime = selectedTime;
      time.textContent = formatForecastHour(
        selectedTime,
        timezone,
        controller.state.forecastDays,
      );
    }

    // update every chart intersection
    for (const chart of chartStates) {
      const values = chart.series.map(
        // interpolate every line at the crosshair
        (series) => interpolateForecastValue(
          series.values,
          Math.min(Math.max(0, series.values.length - 1), position),
        ),
      );
      const chartSummary: string[] = [];

      // update each displayed line value
      for (const [index, output] of chart.outputs.entries()) {
        const measurement = formatForecastChartValue(values[index] ?? null, chart.format, controller.state.units);
        const compact = compactMeasurement(measurement) ?? "—";
        output.textContent = compact;
        chartSummary.push(`${chart.series[index]?.label ?? "Value"} ${compact}`);
      }

      const edge = forecastValueLabelEdge(values, chart.minimum, chart.maximum);

      // move the pill away from its line intersections
      if (chart.value !== null) {
        chart.value.classList.toggle("forecast-chart-value-top", edge === "top");
        chart.value.classList.toggle("forecast-chart-value-bottom", edge === "bottom");
      }

      const label = chart.element.querySelector("h3")?.textContent?.trim() ?? "Forecast";
      summaries.push(`${label}: ${chartSummary.join(", ")}`);
    }

    const clock = formatForecastHour(
      selectedTime,
      timezone,
      controller.state.forecastDays,
    );
    grid.setAttribute("aria-valuetext", `${clock}. ${summaries.join(". ")}`);
    mapBinding?.updateTime(selectedTime, immediateMap);
  };

  // convert one horizontal pointer coordinate to the shared index
  const positionFromPointer = (
    clientX: number,
    surface: HTMLElement | SVGSVGElement,
  ): number => {
    const bounds = surface.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    return ratio * (times.length - 1);
  };

  const scrubSurfaces: readonly (HTMLElement | SVGSVGElement)[] = mapBinding === null
    ? [grid]
    : [grid, mapBinding.scrubSurface];

  // register one typed pointer event across HTML and SVG surfaces
  const addPointerListener = (
    surface: HTMLElement | SVGSVGElement,
    type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
    listener: (event: PointerEvent) => void,
  ): void => {
    surface.addEventListener(type, listener as EventListener);
  };

  // connect every surface to the shared chart and map time
  for (const surface of scrubSurfaces) {
    // begin one undecided scrub or scroll gesture
    addPointerListener(surface, "pointerdown", (event) => {
      gesture = {
        horizontal: false,
        moved: false,
        pointerId: event.pointerId,
        surface,
        startX: event.clientX,
        startY: event.clientY,
      };
      grid.focus({ preventScroll: true });
    });

    // follow horizontal scrubbing without blocking vertical scrolling
    addPointerListener(surface, "pointermove", (event) => {
      // ignore hover and unrelated pointers
      if (
        gesture === null ||
        gesture.pointerId !== event.pointerId ||
        gesture.surface !== surface
      ) {
        return;
      }

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      // wait for an intentional gesture
      if (Math.hypot(deltaX, deltaY) < 6) {
        return;
      }

      gesture.moved = true;

      // leave vertical motion to normal page scrolling
      if (!gesture.horizontal && Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }

      gesture.horizontal = true;
      event.preventDefault();

      // capture only an established horizontal scrub
      if (!surface.hasPointerCapture(event.pointerId)) {
        try {
          surface.setPointerCapture(event.pointerId);
        } catch {
          // retain synthetic and legacy pointer support
        }
      }

      updatePosition(positionFromPointer(event.clientX, surface));
    });

    // finish one pointer gesture
    const finishGesture = (event: PointerEvent, selectTap: boolean): void => {
      // ignore unrelated pointer endings
      if (
        gesture === null ||
        gesture.pointerId !== event.pointerId ||
        gesture.surface !== surface
      ) {
        return;
      }

      // move a stationary tap directly to its thumb position
      if (selectTap && !gesture.moved) {
        updatePosition(positionFromPointer(event.clientX, surface), true);
      } else {
        // settle one completed scrub
        updatePosition(position, true);
      }

      // release an active browser capture
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId);
      }

      gesture = null;
    };
    addPointerListener(surface, "pointerup", (event) => {
      // complete a horizontal scrub or stationary tap
      finishGesture(event, true);
    });
    addPointerListener(surface, "pointercancel", (event) => {
      // preserve the crosshair during browser scrolling
      finishGesture(event, false);
    });
  }

  // provide precise keyboard scrubbing
  grid.addEventListener("keydown", (event) => {
    let nextPosition: number | null = null;

    // map horizontal navigation keys to hourly steps
    switch (event.key) {
      case "ArrowLeft":
        nextPosition = position - 1;
        break;
      case "ArrowRight":
        nextPosition = position + 1;
        break;
      case "Home":
        nextPosition = 0;
        break;
      case "End":
        nextPosition = times.length - 1;
        break;
    }

    // retain unrelated keyboard behavior
    if (nextPosition === null) {
      return;
    }

    event.preventDefault();
    updatePosition(nextPosition, true);
  });

  updatePosition(position, true);
}

// connect the Today-only Xweather timeline and layers
function bindForecastWeatherMap(root: HTMLElement): ForecastWeatherMapBinding | null {
  const map = root.querySelector<HTMLElement>("[data-forecast-weather-map]");

  // require the Today map
  if (map === null) {
    return null;
  }

  const canvas = map.querySelector<HTMLElement>(".forecast-map-canvas");
  const scrubSurface = map.querySelector<SVGSVGElement>("[data-forecast-map-scrubber]");
  const legend = map.querySelector<HTMLElement>("[data-forecast-map-legend]");
  const selectionPhase = map.querySelector<HTMLElement>("[data-forecast-map-selection-phase]");
  const selectionPhaseLabel = map.querySelector<HTMLElement>("[data-forecast-map-selection-phase-label]");
  const cacheProgress = map.querySelector<HTMLElement>("[data-forecast-map-cache-progress]");
  const cacheProgressLabel = map.querySelector<HTMLElement>("[data-forecast-map-cache-label]");
  const cacheProgressPercent = map.querySelector<HTMLElement>("[data-forecast-map-cache-percent]");
  const cacheProgressBar = map.querySelector<HTMLProgressElement>("[data-forecast-map-cache-bar]");
  const cacheProgressCount = map.querySelector<HTMLElement>("[data-forecast-map-cache-count]");
  const loading = map.querySelector<HTMLElement>("[data-forecast-map-loading]");
  const error = map.querySelector<HTMLElement>("[data-forecast-map-error]");
  const tiles = [...map.querySelectorAll<SVGImageElement>("[data-forecast-map-tile]")];
  const startMs = Number(map.dataset.forecastMapStart);
  const nowMs = Number(map.dataset.forecastMapNow);
  const endMs = Number(map.dataset.forecastMapEnd);
  const stepMs = Number(map.dataset.forecastMapStep);
  const initialMs = Number(map.dataset.forecastMapSelected);
  const timezone = map.dataset.forecastMapTimezone ?? "UTC";

  // require the rendered map contract
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(stepMs) ||
    !Number.isFinite(initialMs) ||
    endMs <= startMs ||
    stepMs <= 0 ||
    scrubSurface === null ||
    tiles.length === 0
  ) {
    return null;
  }

  const renderedFrame = tiles[0];
  const frameViewport = {
    height: Number(renderedFrame?.dataset.mapHeight),
    latitude: Number(renderedFrame?.dataset.mapLatitude),
    longitude: Number(renderedFrame?.dataset.mapLongitude),
    width: Number(renderedFrame?.dataset.mapWidth),
    zoom: Number(renderedFrame?.dataset.mapZoom),
  };

  // require one exact static-frame viewport
  if (
    tiles.length !== 1 ||
    !Number.isSafeInteger(frameViewport.height) ||
    !Number.isFinite(frameViewport.latitude) ||
    !Number.isFinite(frameViewport.longitude) ||
    !Number.isSafeInteger(frameViewport.width) ||
    !Number.isSafeInteger(frameViewport.zoom)
  ) {
    return null;
  }

  let layer = parseForecastMapLayer(map.dataset.forecastMapLayer) ?? "radar";
  let selectedMs = Math.max(startMs, Math.min(endMs, initialMs));
  let generation = 0;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  let cacheGeneration = 0;
  const cachedImages = new Map<string, HTMLImageElement>();
  const cachedDisplayUrls = new Map<string, string>();
  const cachedUrls = new Set<string>();
  const tilePromises = new Map<string, Promise<boolean>>();
  const framePromises = new Map<string, Promise<boolean>>();
  const readyFrames = new Map<ForecastMapLayer, Set<number>>();
  const storageTilePromises = new Map<string, Promise<boolean>>();
  const storageFramePromises = new Map<string, Promise<boolean>>();
  const storedFrames = new Map<ForecastMapLayer, Set<number>>();
  let cacheTargets = new Set<number>();
  const clientTileCache = "caches" in window
    ? window.caches.open(FORECAST_MAP_CLIENT_CACHE_NAME).catch(
      // degrade gracefully when storage is denied
      () => null,
    )
    : Promise.resolve(null);

  // read one bounded selected map time
  const selectedTime = (): number => selectedMs;

  // align one instant to the provider frame grid
  const frameTime = (value: number): number => {
    const bounded = Math.max(startMs, Math.min(endMs, value));
    return startMs + Math.floor((bounded - startMs) / stepMs) * stepMs;
  };

  // align forecast requests to Xweather's hourly products
  const providerFrameTime = (value: number): number =>
    value <= nowMs
      ? value
      : Math.round(value / FORECAST_MAP_FORECAST_INTERVAL_MS) * FORECAST_MAP_FORECAST_INTERVAL_MS;

  // build every visible URL for one map frame
  const frameUrls = (frameMs: number, targetLayer: ForecastMapLayer): readonly string[] => {
    const phase: ForecastMapPhase = frameMs <= nowMs ? "history" : "forecast";
    const validTime = xweatherValidTime(new Date(providerFrameTime(frameMs)).toISOString());
    const url = xweatherFrameUrl(
      phase,
      targetLayer,
      validTime,
      frameViewport.zoom,
      frameViewport.width,
      frameViewport.height,
      frameViewport.latitude,
      frameViewport.longitude,
    );
    return [url];
  };

  // build one stable persistent-cache key
  const clientTileCacheKey = (target: string): string => {
    const url = new URL(target, window.location.href);
    url.hash = "";
    url.search = "";
    return url.href;
  };

  // identify one mutable forecast tile URL
  const isForecastTileUrl = (target: string): boolean =>
    new URL(target, window.location.href).pathname.includes("/maps/xweather/forecast/");

  // read one usable persistent tile response
  const readClientTileResponse = async (target: string): Promise<Response | null> => {
    const cache = await clientTileCache;

    // skip unavailable persistent browser storage
    if (cache === null) {
      return null;
    }

    try {
      const key = clientTileCacheKey(target);
      const response = await cache.match(key);

      // miss one uncached tile
      if (response === undefined) {
        return null;
      }

      // reuse immutable historical tiles indefinitely
      if (!isForecastTileUrl(target)) {
        return response;
      }

      const cachedAt = Number(response.headers.get(FORECAST_MAP_CLIENT_CACHE_TIMESTAMP_HEADER));

      // reuse one still-current forecast tile
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < FORECAST_MAP_CLIENT_FORECAST_FRESHNESS_MS
      ) {
        return response;
      }

      await cache.delete(key);
      return null;
    } catch {
      // fall back to the same-origin proxy
      return null;
    }
  };

  // persist one freshly fetched tile response
  const writeClientTile = async (
    target: string,
    blob: Blob,
    contentType: string,
    cachedAt: number,
  ): Promise<void> => {
    const cache = await clientTileCache;

    // skip unavailable persistent browser storage
    if (cache === null) {
      return;
    }

    try {
      const headers = new Headers({
        "Content-Type": contentType,
        [FORECAST_MAP_CLIENT_CACHE_TIMESTAMP_HEADER]: String(cachedAt),
      });
      await cache.put(
        clientTileCacheKey(target),
        new Response(blob, { headers, status: 200 }),
      );
    } catch {
      // retain the decoded in-memory fallback
    }
  };

  // fetch one tile through the same-origin server cache
  const fetchTile = async (target: string): Promise<Blob> => {
    const response = await fetch(target, {
      cache: isForecastTileUrl(target) ? "no-store" : "force-cache",
      headers: { Accept: "image/png,image/*;q=0.8" },
    });

    // reject provider and proxy failures
    if (!response.ok) {
      throw new Error(`weather tile request failed with ${String(response.status)}`);
    }

    const contentType = response.headers.get("Content-Type") ?? "image/png";

    // reject a non-image proxy response
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("weather tile response was not an image");
    }

    const blob = await response.blob();

    // reject one empty tile payload
    if (blob.size === 0) {
      throw new Error("weather tile response was empty");
    }

    const serverAgeSeconds = Number(response.headers.get("X-Weather-Tile-Age"));
    const cachedAt = Number.isFinite(serverAgeSeconds) && serverAgeSeconds >= 0
      ? Date.now() - serverAgeSeconds * 1_000
      : Date.now();
    await writeClientTile(target, blob, contentType, cachedAt);
    return blob;
  };

  // load one persistent or remote tile payload
  const loadTile = async (target: string): Promise<Blob> => {
    const response = await readClientTileResponse(target);
    return response === null ? await fetchTile(target) : await response.blob();
  };

  // retain one compressed raster behind a reusable object URL
  const prepareDisplayUrl = (target: string, blob: Blob): string => {
    const existing = cachedDisplayUrls.get(target);

    // reuse one already-prepared browser payload
    if (existing !== undefined) {
      return existing;
    }

    const displayUrl = URL.createObjectURL(blob);
    cachedDisplayUrls.set(target, displayUrl);
    return displayUrl;
  };

  // report the active layer's background cache progress
  const updateCacheProgress = (targetLayer: ForecastMapLayer, state = "loading"): void => {
    // ignore stale layer progress
    if (targetLayer !== layer) {
      return;
    }

    const layerFrames = storedFrames.get(targetLayer) ?? new Set<number>();
    const ready = [...cacheTargets].filter(
      // count only the current sliding cache window
      (frame) => layerFrames.has(frame),
    ).length;
    const totalFrames = cacheTargets.size;
    const complete = totalFrames > 0 && ready === totalFrames;
    const nextState = complete ? "complete" : state;
    const percentage = totalFrames === 0 ? 100 : Math.round((ready / totalFrames) * 100);
    const layerLabel = FORECAST_MAP_LAYERS.find(
      // match the cache run's weather layer
      (option) => option.key === targetLayer,
    )?.label ?? "Weather";
    map.dataset.forecastMapCacheReady = String(ready);
    map.dataset.forecastMapCacheTotal = String(totalFrames);
    map.dataset.forecastMapCacheState = nextState;

    // synchronize the visible cache progress overlay
    if (cacheProgress !== null) {
      cacheProgress.hidden = complete;
      cacheProgress.dataset.forecastMapCacheState = nextState;
    }

    // describe the active layer cache run
    if (cacheProgressLabel !== null) {
      cacheProgressLabel.textContent = nextState === "partial"
        ? `${layerLabel} cache paused`
        : `Caching ${layerLabel}`;
    }

    // show one stable whole-number completion value
    if (cacheProgressPercent !== null) {
      cacheProgressPercent.textContent = `${String(percentage)}%`;
    }

    // expose native progress semantics
    if (cacheProgressBar !== null) {
      cacheProgressBar.max = totalFrames;
      cacheProgressBar.value = ready;
      cacheProgressBar.setAttribute("aria-label", `Cached ${layerLabel} map frames`);
    }

    // show the exact frame count beneath the bar
    if (cacheProgressCount !== null) {
      cacheProgressCount.textContent = `${String(ready)} of ${String(totalFrames)} nearby frames ready`;
    }
  };

  // persist one tile without decoding it into image memory
  const cacheTile = (target: string): Promise<boolean> => {
    const decoded = tilePromises.get(target);

    // reuse one selected-frame request
    if (decoded !== undefined) {
      return decoded;
    }

    const pending = storageTilePromises.get(target);

    // share one in-flight persistent write
    if (pending !== undefined) {
      return pending;
    }

    const request = (async (): Promise<boolean> => {
      try {
        const cached = await readClientTileResponse(target);

        // reuse one durable browser response without decoding it
        if (cached !== null) {
          prepareDisplayUrl(target, await cached.blob());
          return true;
        }

        prepareDisplayUrl(target, await fetchTile(target));
        return true;
      } catch {
        storageTilePromises.delete(target);
        return false;
      }
    })();
    storageTilePromises.set(target, request);
    return request;
  };

  // retain one decoded same-origin tile in browser storage
  const preloadTile = (target: string): Promise<boolean> => {
    // reuse one completed tile
    if (cachedUrls.has(target)) {
      return Promise.resolve(true);
    }

    const pending = tilePromises.get(target);

    // share one in-flight tile request
    if (pending !== undefined) {
      return pending;
    }

    const request = (async (): Promise<boolean> => {
      try {
        const storagePending = storageTilePromises.get(target);

        // finish one background write before reading it
        if (storagePending !== undefined && !await storagePending) {
          return false;
        }

        const displayUrl = cachedDisplayUrls.get(target) ?? prepareDisplayUrl(target, await loadTile(target));
        const image = new Image();
        image.decoding = "async";
        cachedImages.set(target, image);
        const decoded = await new Promise<boolean>((resolve) => {
          // retain one successfully decoded tile
          image.onload = () => resolve(true);
          // reject one corrupt image payload
          image.onerror = () => resolve(false);
          image.src = displayUrl;
        });

        // release one corrupt cached tile
        if (!decoded) {
          URL.revokeObjectURL(displayUrl);
          cachedImages.delete(target);
          cachedDisplayUrls.delete(target);
          tilePromises.delete(target);
          return false;
        }

        cachedUrls.add(target);
        return true;
      } catch {
        cachedImages.delete(target);
        cachedDisplayUrls.delete(target);
        tilePromises.delete(target);
        return false;
      }
    })();
    tilePromises.set(target, request);
    return request;
  };

  // cache one complete frame without decoding its raster
  const cacheFrame = (frameMs: number, targetLayer: ForecastMapLayer): Promise<boolean> => {
    const boundedFrame = frameTime(frameMs);
    const key = `${targetLayer}:${String(boundedFrame)}`;
    const existing = storageFramePromises.get(key);

    // share one in-flight or completed persistent frame
    if (existing !== undefined) {
      return existing;
    }

    const request = Promise.all(frameUrls(boundedFrame, targetLayer).map(cacheTile)).then(
      // retain only complete persistent frames
      (results) => {
        const complete = results.every(Boolean);

        // record one fully persisted frame
        if (complete) {
          const layerFrames = storedFrames.get(targetLayer) ?? new Set<number>();
          layerFrames.add(boundedFrame);
          storedFrames.set(targetLayer, layerFrames);
          const layerReadyFrames = readyFrames.get(targetLayer) ?? new Set<number>();
          layerReadyFrames.add(boundedFrame);
          readyFrames.set(targetLayer, layerReadyFrames);
        } else {
          // allow one incomplete frame to retry
          storageFramePromises.delete(key);
        }

        return complete;
      },
    );
    storageFramePromises.set(key, request);
    return request;
  };

  // cache every visible tile for one provider frame
  const preloadFrame = (frameMs: number, targetLayer: ForecastMapLayer): Promise<boolean> => {
    const boundedFrame = frameTime(frameMs);
    const key = `${targetLayer}:${String(boundedFrame)}`;
    const existing = framePromises.get(key);

    // share one in-flight or completed frame
    if (existing !== undefined) {
      return existing;
    }

    const request = Promise.all(frameUrls(boundedFrame, targetLayer).map(preloadTile)).then(
      // retain only complete frames for instant swaps
      (results) => {
        const complete = results.every(Boolean);

        // record one complete decoded frame
        if (complete) {
          const layerFrames = readyFrames.get(targetLayer) ?? new Set<number>();
          layerFrames.add(boundedFrame);
          readyFrames.set(targetLayer, layerFrames);
        } else {
          // allow one incomplete frame to retry
          framePromises.delete(key);
        }

        return complete;
      },
    );
    framePromises.set(key, request);
    return request;
  };

  // determine whether one frame can swap without network delay
  const frameIsReady = (frameMs: number, targetLayer: ForecastMapLayer): boolean =>
    readyFrames.get(targetLayer)?.has(frameTime(frameMs)) === true;

  // describe the selected frame without loading tiles
  const updateDescription = (): void => {
    const selectedMs = selectedTime();
    const selectedInstant = new Date(selectedMs).toISOString();
    const phase: ForecastMapPhase = selectedMs <= nowMs ? "history" : "forecast";
    const phaseLabel = phase === "history" ? "Observed" : "Forecast";
    const layerLabel = FORECAST_MAP_LAYERS.find(
      // match the selected weather layer
      (option) => option.key === layer,
    )?.label ?? "Weather";
    const clock = formatForecastMapTime(selectedInstant, timezone);

    map.dataset.forecastMapPhase = phase;
    map.dataset.forecastMapSelected = String(selectedMs);

    // label the shared selector inside the map
    if (selectionPhase !== null) {
      selectionPhase.dataset.forecastMapSelectionPhase = phase;
    }

    // show the selected map phase in plain language
    if (selectionPhaseLabel !== null) {
      selectionPhaseLabel.textContent = phase === "history" ? "Historical" : "Forecast";
    }

    // synchronize the active overlay legend
    if (legend !== null) {
      const presentation = forecastMapLegend(layer, phase);
      legend.dataset.forecastMapLegendLayer = layer;
      legend.dataset.forecastMapLegendPhase = phase;
      legend.setAttribute("aria-label", `${presentation.title} color legend`);
      legend.innerHTML = renderForecastMapLegendContent(presentation);
    }

    // keep the map's accessible name current
    if (canvas !== null) {
      canvas.setAttribute("aria-label", `${phaseLabel} ${layerLabel.toLowerCase()} near Ballydídean at ${clock}`);
    }
  };

  // display one fully cached frame without partial tile flashes
  const applyFrame = (frameMs: number, targetLayer: ForecastMapLayer): void => {
    const targets = frameUrls(frameMs, targetLayer);
    map.dataset.forecastMapLayer = targetLayer;
    map.setAttribute("aria-busy", "false");

    // hide the in-place loading veil
    if (loading !== null) {
      loading.hidden = true;
    }

    // clear one prior transient tile error
    if (error !== null) {
      error.hidden = true;
    }

    // swap every decoded tile in one visual frame
    for (const [index, tile] of tiles.entries()) {
      const target = targets[index] ?? "";
      tile.dataset.mapTileUrl = target;
      tile.setAttribute("href", cachedDisplayUrls.get(target) ?? target);
    }
  };

  // load one bounded set of same-origin tiles
  const updateTiles = (): void => {
    generation += 1;
    const requestGeneration = generation;
    const selectedFrame = frameTime(selectedTime());
    const targetLayer = layer;
    map.dataset.forecastMapLayer = layer;

    // swap one already-decoded frame immediately
    if (frameIsReady(selectedFrame, targetLayer)) {
      applyFrame(selectedFrame, targetLayer);
      return;
    }

    map.setAttribute("aria-busy", "true");

    // show one in-place loading veil
    if (loading !== null) {
      loading.hidden = false;
    }

    // hide one prior transient tile error
    if (error !== null) {
      error.hidden = true;
    }

    void preloadFrame(selectedFrame, targetLayer).then(
      // commit only the latest complete selected frame
      (complete) => {
        // ignore a stale, detached, or superseded frame
        if (
          !map.isConnected ||
          requestGeneration !== generation ||
          targetLayer !== layer ||
          selectedFrame !== frameTime(selectedTime())
        ) {
          return;
        }

        // retain the previous complete image after a provider failure
        if (!complete) {
          map.setAttribute("aria-busy", "false");

          // clear the in-place loading veil
          if (loading !== null) {
            loading.hidden = true;
          }

          // surface one compact provider failure
          if (error !== null) {
            error.hidden = false;
          }
          return;
        }

        applyFrame(selectedFrame, targetLayer);
        updateCacheProgress(targetLayer);
      },
    );
  };

  // debounce only uncached raster refreshes while scrubbing
  const scheduleTiles = (immediate: boolean): void => {
    // replace one pending scrub refresh
    if (updateTimer !== null) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }

    // load settled or cached changes without delay
    if (immediate || frameIsReady(selectedTime(), layer)) {
      updateTiles();
      return;
    }

    updateTimer = setTimeout(() => {
      updateTimer = null;
      updateTiles();
    }, 80);
  };

  // select one small window around the current frame
  const nearbyFrames = (): readonly number[] => {
    const frames: number[] = [];
    const selectedFrame = frameTime(selectedTime());

    // retain three frames on either side of the selection
    for (let offset = -3; offset <= 3; offset += 1) {
      const frame = selectedFrame + offset * stepMs;

      // keep the cache window inside Today
      if (frame >= startMs && frame <= endMs) {
        frames.push(frame);
      }
    }

    return frames;
  };

  // warm one small window around the current selection
  const warmWindow = async (
    targetLayer: ForecastMapLayer,
    requestGeneration: number,
  ): Promise<void> => {
    const frames = [...cacheTargets];
    let cursor = 0;
    updateCacheProgress(targetLayer);

    // cache one bounded stream of complete frames
    const worker = async (): Promise<void> => {
      // continue while this map and layer own the cache run
      while (
        cursor < frames.length &&
        map.isConnected &&
        requestGeneration === cacheGeneration &&
        targetLayer === layer
      ) {
        const frame = frames[cursor];
        cursor += 1;

        // retain the complete enumerated frame contract
        if (frame === undefined) {
          continue;
        }

        let complete = await cacheFrame(frame, targetLayer);

        // retry one transient incomplete frame once
        if (
          !complete &&
          map.isConnected &&
          requestGeneration === cacheGeneration &&
          targetLayer === layer
        ) {
          complete = await cacheFrame(frame, targetLayer);
        }

        updateCacheProgress(targetLayer, complete ? "loading" : "partial");
      }
    };

    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);

    // finalize only the active cache run
    if (
      map.isConnected &&
      requestGeneration === cacheGeneration &&
      targetLayer === layer
    ) {
      const layerFrames = storedFrames.get(targetLayer) ?? new Set<number>();
      const ready = [...cacheTargets].filter(
        // count only frames requested by this cache run
        (frame) => layerFrames.has(frame),
      ).length;
      updateCacheProgress(targetLayer, ready === cacheTargets.size ? "complete" : "partial");
    }
  };

  // schedule one cancellable nearby-frame cache
  const scheduleWindowCache = (delay: number): void => {
    cacheGeneration += 1;
    const requestGeneration = cacheGeneration;
    cacheTargets = new Set(nearbyFrames());

    // replace one pending layer cache
    if (cacheTimer !== null) {
      clearTimeout(cacheTimer);
    }

    updateCacheProgress(layer);
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      void warmWindow(layer, requestGeneration);
    }, delay);
  };

  // follow one shared chart-selected instant
  const updateTime = (value: string, immediate: boolean): void => {
    const requestedMs = new Date(value).getTime();

    // ignore an invalid shared clock
    if (!Number.isFinite(requestedMs)) {
      return;
    }

    const boundedMs = Math.max(startMs, Math.min(endMs, requestedMs));
    selectedMs = startMs + Math.floor((boundedMs - startMs) / stepMs) * stepMs;
    updateDescription();
    scheduleTiles(immediate);
    scheduleWindowCache(immediate ? 100 : 350);
  };

  // wire every weather-layer choice
  for (const button of map.querySelectorAll<HTMLButtonElement>("[data-forecast-map-layer]")) {
    button.addEventListener("click", () => {
      const selectedLayer = parseForecastMapLayer(button.dataset.forecastMapLayer);

      // reject impossible rendered layers
      if (selectedLayer === null || selectedLayer === layer) {
        return;
      }

      layer = selectedLayer;

      // reflect one selected map layer
      for (const option of map.querySelectorAll<HTMLButtonElement>("[data-forecast-map-layer]")) {
        option.setAttribute("aria-pressed", String(option === button));
      }

      updateDescription();
      scheduleTiles(true);
      scheduleWindowCache(250);
    });
  }

  updateDescription();
  scheduleWindowCache(750);
  return { scrubSurface, updateTime };
}

// validate one rendered forecast-map layer
function parseForecastMapLayer(value: string | undefined): ForecastMapLayer | null {
  // accept only the fixed public layer set
  if (
    value === "clouds" ||
    value === "precipitation" ||
    value === "radar" ||
    value === "wind"
  ) {
    return value;
  }

  return null;
}

// connect the reviewed forecast horizon buttons
function bindForecastRangeControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  // wire every rendered forecast horizon
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-forecast-days]")) {
    // load one selected forecast range
    button.addEventListener("click", () => {
      const days = Number(button.dataset.forecastDays);

      // reject impossible rendered values
      if (days !== 1 && days !== 5 && days !== 10) {
        return;
      }

      void controller.setForecastDays(days);
    });
  }
}

// interpolate one chart line at a fractional forecast index
export function interpolateForecastValue(
  values: readonly (number | null)[],
  position: number,
): number | null {
  // preserve an empty line honestly
  if (values.length === 0) {
    return null;
  }

  const bounded = Math.max(0, Math.min(values.length - 1, position));
  const lowerIndex = Math.floor(bounded);
  const upperIndex = Math.ceil(bounded);
  const lower = values[lowerIndex] ?? null;
  const upper = values[upperIndex] ?? null;

  // use the available endpoint through a sparse gap
  if (lower === null || upper === null) {
    return lower ?? upper;
  }

  // return the exact stored value
  if (lowerIndex === upperIndex) {
    return lower;
  }

  return lower + (upper - lower) * (bounded - lowerIndex);
}

// interpolate one timestamp at a fractional forecast index
export function interpolateForecastInstant(
  times: readonly string[],
  position: number,
): string {
  // preserve an empty clock honestly
  if (times.length === 0) {
    return "";
  }

  const bounded = Math.max(0, Math.min(times.length - 1, position));
  const lowerIndex = Math.floor(bounded);
  const upperIndex = Math.ceil(bounded);
  const lower = new Date(times[lowerIndex] ?? times[0] ?? "").getTime();
  const upper = new Date(times[upperIndex] ?? times.at(-1) ?? "").getTime();
  const instant = lower + (upper - lower) * (bounded - lowerIndex);
  return new Date(instant).toISOString();
}

// connect the dependency-free map layer controls
function bindMapControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  // wire every reviewed tile layer
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-map-layer]")) {
    // render the selected tile source
    button.addEventListener("click", () => {
      const layer = button.dataset.mapLayer;

      // reject impossible rendered values
      if (layer !== "roads" && layer !== "topo" && layer !== "satellite") {
        return;
      }

      controller.setMapLayer(layer);
    });
  }

  // wire every map and list station selector
  for (const control of root.querySelectorAll<HTMLElement>("[data-station-select]")) {
    const stationSlug = control.dataset.stationSelect;

    // reject incomplete rendered values
    if (stationSlug === undefined) {
      continue;
    }

    bindRelatedMapHighlight(root, control, "data-station-select", stationSlug);

    // reveal one station-only snapshot
    control.addEventListener("click", (event) => {
      event.preventDefault();
      controller.setSelectedStation(stationSlug);

      // reveal list details selected from the map
      if (control.classList.contains("station-marker")) {
        root.querySelector<HTMLElement>(`[data-station-current="${CSS.escape(stationSlug)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }
}

// connect the single-chart trend title flyover
function bindTrendMetricControl(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const control = root.querySelector<HTMLElement>("[data-trend-metric-control]");

  // skip every non-trends route
  if (control === null) {
    return;
  }

  const trigger = control.querySelector<HTMLButtonElement>("[data-trend-metric-trigger]");
  const flyover = control.querySelector<HTMLElement>(".trend-metric-flyover");
  const options = [...control.querySelectorAll<HTMLButtonElement>("[data-trend-metric-option]")];

  // require the complete title control
  if (trigger === null || flyover === null) {
    return;
  }

  // synchronize the custom flyover state
  const setOpen = (open: boolean): void => {
    trigger.setAttribute("aria-expanded", String(open));
    flyover.hidden = !open;
  };

  // toggle the flyover from the title
  trigger.addEventListener("click", () => {
    setOpen(trigger.getAttribute("aria-expanded") !== "true");
  });

  // bind every reviewed metric choice
  for (const option of options) {
    option.addEventListener("click", () => {
      const metric = option.dataset.trendMetricOption;

      // reject impossible rendered values
      if (metric === undefined || !isTrendChartMetric(metric)) {
        return;
      }

      setOpen(false);
      controller.setSelectedTrendMetric(metric);
    });
  }

  // close the flyover from the keyboard
  control.addEventListener("keydown", (event) => {
    // preserve ordinary title and option keys
    if (event.key !== "Escape" || trigger.getAttribute("aria-expanded") !== "true") {
      return;
    }

    event.preventDefault();
    setOpen(false);
    trigger.focus();
  });
}

// validate one rendered trend measurement key
function isTrendChartMetric(value: string): value is TrendChartMetric {
  return TREND_CHART_OPTIONS.some(
    // match one reviewed chart option
    (option) => option.metric === value,
  );
}

// connect aggregate and daily-detail trend controls
function bindTrendViewControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const mode = root.querySelector<HTMLButtonElement>("[data-trend-mode-toggle]");
  const detail = root.querySelector<HTMLButtonElement>("[data-trend-detail-toggle]");

  // switch between aggregate and individual lines
  mode?.addEventListener("click", () => {
    controller.toggleTrendDisplayMode();
  });

  // switch between the rolling overview and fixed daily canvas
  detail?.addEventListener("click", () => {
    controller.toggleTrendDetail();
  });
}

// connect yearly trend lines to visual emphasis
function bindTrendYearControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const controls = root.querySelectorAll<HTMLElement | SVGElement>("[data-trend-year-select]");

  // bind every visible line and its forgiving tap target
  for (const control of controls) {
    const year = Number(control.dataset.trendYearSelect);

    // reject malformed rendered years
    if (!Number.isInteger(year)) {
      continue;
    }

    // emphasize one selected year
    const selectYear = (): void => {
      controller.setSelectedTrendYear(year);
    };
    control.addEventListener("click", selectYear);

    // add keyboard semantics only to SVG line buttons
    if (control instanceof SVGElement) {
      control.addEventListener("keydown", (event) => {
        // support the SVG button from a keyboard
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectYear();
        }
      });
    }
  }
}

// connect one shared calendar-date scrubber to the visible trend lines
function bindTrendCrosshair(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const surface = root.querySelector<HTMLElement>("[data-trend-scrub-surface]");
  const chart = surface?.closest<HTMLElement>("[data-trend-chart]") ?? null;
  const viewport = surface?.closest<HTMLElement>(".trend-chart-viewport") ?? null;
  const slider = surface?.querySelector<HTMLElement>("[data-trend-crosshair-slider]") ?? null;
  const svg = surface?.querySelector<SVGSVGElement>("svg") ?? null;
  const metric = chart?.dataset.trendChart;
  const displayMode = chart?.dataset.trendDisplayMode;
  const detail = chart?.dataset.trendDetail;

  // require one complete rendered trend contract
  if (
    surface === null ||
    chart === null ||
    viewport === null ||
    slider === null ||
    svg === null ||
    metric === undefined ||
    !isTrendChartMetric(metric) ||
    (displayMode !== "aggregate" && displayMode !== "all") ||
    (detail !== "daily" && detail !== "rolling")
  ) {
    return;
  }

  const option = TREND_CHART_OPTIONS.find(
    // resolve the rendered measurement configuration
    (candidate) => candidate.metric === metric,
  );

  // reject one impossible reviewed metric
  if (option === undefined) {
    return;
  }

  const rawSeries = buildTrendYearSeries(
    controller.state.trends,
    metric,
    controller.state.selectedSite?.timezone ?? "UTC",
  );
  const currentYear = trendCurrentYear(controller.state, rawSeries);
  const series = detail === "rolling"
    ? smoothTrendYearSeries(rawSeries, TREND_ROLLING_WINDOW_DAYS)
    : rawSeries;
  const historicalSeries = series.filter(
    // exclude the incomplete current year from historical statistics
    (year) => year.year !== currentYear,
  );
  const aggregate = buildTrendAggregateSeries(
    // retain a useful fallback before a second calendar year exists
    historicalSeries.length === 0 ? series : historicalSeries,
  );
  const renderedSelectedYear = Number(chart.dataset.selectedTrendYear);
  const selectedYear = Number.isInteger(renderedSelectedYear) ? renderedSelectedYear : null;
  const visibleSeries = buildTrendCrosshairSeries(
    series,
    aggregate,
    displayMode,
    selectedYear,
    currentYear,
  );
  const newestFirst = [...visibleSeries].reverse();
  const outputs = new Map(
    [...surface.querySelectorAll<HTMLOutputElement>("[data-trend-crosshair-value]")].flatMap(
      // index every rendered line output
      (output) => {
        const key = output.dataset.trendCrosshairValue;
        return key === undefined ? [] : [[key, output] as const];
      },
    ),
  );
  const date = surface.querySelector<HTMLTimeElement>("[data-trend-crosshair-date]");
  const summary = surface.querySelector<HTMLElement>(".trend-crosshair-summary");

  // require the rendered comparison card
  if (summary === null) {
    return;
  }

  let position = Math.max(0, Math.min(1, Number(surface.dataset.trendInitialPosition ?? 0)));
  const expanded = detail === "daily";
  let gesture: null | {
    mode: "pan" | "scrub";
    moved: boolean;
    pointerId: number;
    startScrollLeft: number;
    startScrollTop: number;
    startX: number;
    startY: number;
    targetWasYear: boolean;
  } = null;
  let suppressYearClick = false;

  // convert one screen coordinate through the rotated SVG transform
  const positionFromPointer = (clientX: number, clientY: number): number => {
    const matrix = svg.getScreenCTM();

    // fall back to an unrotated bounding box
    if (matrix === null) {
      const bounds = svg.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    }

    try {
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const local = point.matrixTransform(matrix.inverse());
      const plotWidth = TREND_CHART_WIDTH - TREND_CHART_PADDING_LEFT - TREND_CHART_PADDING_RIGHT;
      return Math.max(0, Math.min(1, (local.x - TREND_CHART_PADDING_LEFT) / plotWidth));
    } catch {
      // preserve pointer input during a transient browser transform
      return position;
    }
  };

  // detect the rotated phone chart interaction axis
  const isMobileTrend = (): boolean => window.matchMedia("(max-width: 42rem)").matches;

  // place the comparison column beside the visible line without clipping
  const updateSummarySide = (): void => {
    const linePosition = (trendChartPercentage(position) / 100) * surface.clientWidth;
    const viewportEnd = isMobileTrend()
      ? viewport.scrollTop + viewport.clientHeight
      : viewport.scrollLeft + viewport.clientWidth;
    const rightSpace = viewportEnd - linePosition;
    summary.classList.toggle("trend-crosshair-summary-left", rightSpace < summary.offsetWidth + 8);
  };

  // update the line, date, and every visible value without rerendering
  const updatePosition = (nextPosition: number): void => {
    position = Math.max(0, Math.min(1, nextPosition));
    const percentage = trendChartPercentage(position);
    const selectedDate = trendCalendarDate(position);
    const summaries: string[] = [];
    surface.style.setProperty("--trend-crosshair-position", `${percentage.toFixed(4)}%`);
    surface.classList.toggle("trend-crosshair-start", position < 0.1);
    surface.classList.toggle("trend-crosshair-end", position > 0.9);
    slider.setAttribute("aria-valuenow", String(Math.round(position * 365)));

    // update the visible shared calendar date
    if (date !== null) {
      date.dateTime = selectedDate.key;
      date.textContent = selectedDate.label;
    }

    // update every visible line intersection
    for (const entry of newestFirst) {
      const measurement = formatTrendMeasurement(
        interpolateTrendValue(entry.points, position),
        option.format,
        controller.state.units,
      );
      const compact = compactMeasurement(measurement) ?? "—";
      outputs.get(entry.key)?.replaceChildren(compact);
      summaries.push(`${entry.label} ${compact === "—" ? "unavailable" : compact}`);
    }

    slider.setAttribute("aria-valuetext", `${selectedDate.label}. ${summaries.join(". ")}`);
    updateSummarySide();
  };

  // begin one calendar scrub or fixed-detail pan
  surface.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;

    // retain native chart controls
    if (target?.closest("[data-trend-metric-control], [data-trend-mode-toggle], [data-trend-detail-toggle], .trend-chart-legend") !== null) {
      return;
    }

    const targetWasYear = target?.closest("[data-trend-year-select]") !== null;
    gesture = {
      mode: expanded && target?.closest("[data-trend-crosshair-slider]") === null && !targetWasYear
        ? "pan"
        : "scrub",
      moved: false,
      pointerId: event.pointerId,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
      startX: event.clientX,
      startY: event.clientY,
      targetWasYear,
    };
    slider.focus({ preventScroll: true });
  });

  // follow one deliberate swipe along the rendered chart axis
  surface.addEventListener("pointermove", (event) => {
    // ignore hover and unrelated pointers
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }

    // wait for intentional pointer travel
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) {
      return;
    }

    gesture.moved = true;
    event.preventDefault();

    // capture only an established chart gesture
    if (!surface.hasPointerCapture(event.pointerId)) {
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        // retain synthetic pointer support
      }
    }

    // pan the fixed daily canvas instead of moving its selected date
    if (gesture.mode === "pan") {
      // pan along the rotated phone's annual axis
      if (isMobileTrend()) {
        viewport.scrollTop = gesture.startScrollTop - (event.clientY - gesture.startY);
      } else {
        // pan the expanded desktop chart horizontally
        viewport.scrollLeft = gesture.startScrollLeft - (event.clientX - gesture.startX);
      }

      updateSummarySide();
      return;
    }

    updatePosition(positionFromPointer(event.clientX, event.clientY));
  });

  // finish one swipe or stationary date selection
  const finishGesture = (event: PointerEvent, selectTap: boolean): void => {
    // ignore unrelated pointer endings
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }

    suppressYearClick = gesture.moved && gesture.targetWasYear;

    // move a stationary expanded-chart tap without interrupting panning
    if (
      selectTap &&
      gesture.mode === "pan" &&
      !gesture.moved &&
      !gesture.targetWasYear
    ) {
      updatePosition(positionFromPointer(event.clientX, event.clientY));
    }

    // preserve stationary yearly-line selection during date scrubbing
    if (
      selectTap &&
      gesture.mode === "scrub" &&
      (!gesture.targetWasYear || gesture.moved)
    ) {
      updatePosition(positionFromPointer(event.clientX, event.clientY));
    }

    // release one active browser capture
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }

    gesture = null;
  };
  surface.addEventListener("pointerup", (event) => {
    // complete one date selection
    finishGesture(event, true);
  });
  surface.addEventListener("pointercancel", (event) => {
    // retain the latest date during cancellation
    finishGesture(event, false);
  });

  // suppress a synthetic yearly-line click after a swipe
  surface.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;

    // preserve stationary line selection and unrelated clicks
    if (!suppressYearClick || target?.closest("[data-trend-year-select]") === null) {
      suppressYearClick = false;
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    suppressYearClick = false;
  }, true);

  // pan only the fixed daily canvas with a wheel
  surface.addEventListener("wheel", (event) => {
    // retain ordinary page and browser zoom behavior in overview mode
    if (!expanded || event.ctrlKey) {
      return;
    }

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;

    // preserve zero-delta wheel events
    if (delta === 0) {
      return;
    }

    event.preventDefault();

    // scroll the rotated phone chart along its annual axis
    if (isMobileTrend()) {
      viewport.scrollTop += delta;
    } else {
      // scroll the desktop chart along its annual axis
      viewport.scrollLeft += delta;
    }

    updateSummarySide();
  }, { passive: false });

  // provide exact daily keyboard steps
  slider.addEventListener("keydown", (event) => {
    let nextPosition: number | null = null;

    // map horizontal navigation to one calendar day
    switch (event.key) {
      case "ArrowLeft":
        nextPosition = position - 1 / 365;
        break;
      case "ArrowRight":
        nextPosition = position + 1 / 365;
        break;
      case "Home":
        nextPosition = 0;
        break;
      case "End":
        nextPosition = 1;
        break;
    }

    // preserve unrelated keyboard controls
    if (nextPosition === null) {
      return;
    }

    event.preventDefault();
    updatePosition(nextPosition);
  });

  viewport.addEventListener("scroll", updateSummarySide, { passive: true });
  window.addEventListener("resize", updateSummarySide);
  const todayPosition = Math.max(0, Math.min(1, Number(surface.dataset.trendTodayPosition ?? 0)));
  surface.style.setProperty("--trend-today-position", `${trendChartPercentage(todayPosition).toFixed(4)}%`);
  updatePosition(position);

  // center the selected day when opening the fixed daily canvas
  if (expanded) {
    window.requestAnimationFrame(() => {
      const linePosition = (trendChartPercentage(position) / 100) * surface.clientWidth;

      // center along the rotated phone's annual axis
      if (isMobileTrend()) {
        viewport.scrollTop = Math.max(0, linePosition - viewport.clientHeight / 2);
      } else {
        // center along the desktop annual axis
        viewport.scrollLeft = Math.max(0, linePosition - viewport.clientWidth / 2);
      }

      updateSummarySide();
    });
  }
}

// connect the unit settings page to browser preferences
function bindUnitSettings(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const form = root.querySelector<HTMLFormElement>("[data-unit-settings-form]");

  // skip every non-settings route
  if (form === null) {
    return;
  }

  // persist one complete preference form
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    controller.setUnitPreferences({
      precipitation: data.get("precipitation"),
      pressure: data.get("pressure"),
      temperature: data.get("temperature"),
      waterLevel: data.get("waterLevel"),
      windSpeed: data.get("windSpeed"),
    });
  });
}

// create an exact optional filter property
function optionalFilter<Key extends keyof HistoryFilters>(
  key: Key,
  value: HistoryFilters[Key],
): Partial<HistoryFilters> {
  // omit empty filter values
  if (value === undefined) {
    return {};
  }

  return { [key]: value };
}

// require the fixed product location from route responses
function requireProductSite(site: WeatherSite): WeatherSite {
  // reject a mismatched route payload
  if (site.slug !== PRODUCT_SITE.slug) {
    throw new Error("Ballydídean weather is not available");
  }

  return site;
}

// read a non-empty form string
function readFormValue(value: FormDataEntryValue | null): string | undefined {
  // reject files and empty strings
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

// convert a site wall clock input to UTC
function toInstant(
  value: FormDataEntryValue | null,
  timezone: string,
): string | undefined {
  const text = readFormValue(value);

  // preserve an empty input
  if (text === undefined) {
    return undefined;
  }

  return fromSiteWallClock(text, timezone);
}

// format a value and unit for table cells
function formatMetricCell(value: number | null, unit: string): string {
  // render missing values consistently
  if (value === null) {
    return "—";
  }

  return `${escapeHtml(formatNumber(value))} ${escapeHtml(unit)}`;
}

// format one configurable measurement table cell
function formatMeasurementCell(
  value: number | null,
  kind: keyof UnitPreferences,
  preferences: UnitPreferences,
): string {
  const measurement = formatMeasurement(value, kind, preferences);

  // omit the unit for unavailable measurements
  if (measurement.unit.length === 0) {
    return measurement.value;
  }

  return `${escapeHtml(measurement.value)} ${escapeHtml(measurement.unit)}`;
}

// format one measurement with a fixed unit
function formatFixedMeasurement(
  value: number | null,
  unit: string,
  maximumFractionDigits = 1,
): FormattedMeasurement {
  // preserve unavailable measurements
  if (value === null) {
    return { unit: "", value: "—" };
  }

  return { unit, value: formatNumber(value, maximumFractionDigits) };
}

// find the first available current metric
function findMetric(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
): number | null {
  const record = records.find(
    // retain one non-null normalized value
    (candidate) => candidate.metrics[metric] !== null,
  );
  return record?.metrics[metric] ?? null;
}

// find the largest available metric value
function maximumMetric(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
): number | null {
  const values = records.flatMap((record) => {
    const value = record.metrics[metric];
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : Math.max(...values);
}

// find the smallest available metric value
function minimumMetric(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
): number | null {
  const values = records.flatMap((record) => {
    const value = record.metrics[metric];
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : Math.min(...values);
}

// retain forecast hours inside one site-local calendar day
export function forecastForSiteDay(
  records: readonly WeatherRecord[],
  reference: string,
  timezone: string,
): readonly WeatherRecord[] {
  return forecastForSiteDays(records, reference, timezone, 1);
}

// retain forecast hours inside reviewed site-local calendar days
export function forecastForSiteDays(
  records: readonly WeatherRecord[],
  reference: string,
  timezone: string,
  days: ForecastDays,
): readonly WeatherRecord[] {
  const referenceParts = formatWallClockParts(new Date(reference), timezone);
  const targetDates = new Set<string>();

  // collect every requested local calendar date
  for (let index = 0; index < days; index += 1) {
    const date = new Date(Date.UTC(
      referenceParts.year,
      referenceParts.month - 1,
      referenceParts.day + index,
    ));
    targetDates.add(date.toISOString().slice(0, 10));
  }

  return records.filter(
    // exclude every prior and following local date
    (record) => targetDates.has(forecastSiteDateKey(record.validAt, timezone)),
  );
}

// format one site-local date key
function forecastSiteDateKey(value: string, timezone: string): string {
  const parts = formatWallClockParts(new Date(value), timezone);
  return [parts.year, parts.month, parts.day]
    .map(
      // retain stable two-digit calendar fields
      (part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");
}

// format one high and low forecast pair
function forecastRange(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
  kind: keyof UnitPreferences,
  units: UnitPreferences,
  maximumFractionDigits: number,
  classify: (value: number | null) => ConditionBand,
): ForecastCardValue {
  const maximumValue = maximumMetric(records, metric);
  const minimumValue = minimumMetric(records, metric);
  const maximum = formatMeasurement(maximumValue, kind, units, maximumFractionDigits);
  const minimum = formatMeasurement(minimumValue, kind, units, maximumFractionDigits);
  return {
    readings: [
      {
        label: "Max",
        measurement: maximum,
        tone: forecastRangeTone(maximumValue, kind, classify),
      },
      {
        label: "Min",
        measurement: minimum,
        tone: forecastRangeTone(minimumValue, kind, classify),
      },
    ],
  };
}

// format air and apparent temperature ranges
function forecastTemperature(
  records: readonly WeatherRecord[],
  units: UnitPreferences,
): ForecastCardValue {
  const air = forecastRange(
    records,
    "temperatureC",
    "temperature",
    units,
    0,
    temperatureBand,
  );
  const apparent = forecastRange(
    records,
    "apparentTemperatureC",
    "temperature",
    units,
    0,
    temperatureBand,
  );
  return { readings: [...air.readings, ...apparent.readings] };
}

// select one range tone without mixing metric palettes
function forecastRangeTone(
  value: number | null,
  kind: keyof UnitPreferences,
  classify: (value: number | null) => ConditionBand,
): ForecastTone {
  // preserve semantic temperature bands over interpolated colors
  if (kind === "temperature") {
    return forecastTemperatureTone(value);
  }

  return forecastToneForBand(value, classify(value));
}

// format forecast wind and gust maxima
function forecastWind(
  records: readonly WeatherRecord[],
  units: UnitPreferences,
): ForecastCardValue {
  const windValue = maximumMetric(records, "windSpeedMps");
  const gustValue = maximumMetric(records, "windGustMps");
  const wind = formatMeasurement(windValue, "windSpeed", units, 0);
  const gust = formatMeasurement(gustValue, "windSpeed", units, 0);
  return {
    readings: [
      { label: "Max", measurement: wind, tone: forecastWindTone(windValue, units) },
      { label: "Max", measurement: gust, tone: forecastWindTone(gustValue, units) },
    ],
  };
}

// format forecast rain rate and day-end accumulation
function forecastRain(
  records: readonly WeatherRecord[],
  units: UnitPreferences,
): ForecastCardValue {
  const maximumRate = maximumMetric(records, "precipitationRateMmPerHour");
  const accumulation = totalMetric(records, "precipitationMm");
  return {
    readings: [
      {
        label: "Max",
        measurement: formatPrecipitationRate(maximumRate, units),
        tone: forecastToneForBand(maximumRate, rainBand(maximumRate)),
      },
      {
        label: "Total",
        measurement: formatPrecipitationAccumulation(accumulation, units),
      },
    ],
  };
}

// total one normalized metric
function totalMetric(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
): number | null {
  const values = records.flatMap((record) => {
    const value = record.metrics[metric];
    return value === null ? [] : [value];
  });
  return values.length === 0
    ? null
    : values.reduce(
      // add one interval accumulation
      (total, value) => total + value,
      0,
    );
}

// format one fixed-unit forecast maximum
function forecastMaximumFixed(
  records: readonly WeatherRecord[],
  metric: WeatherMetricKey,
  unit: string,
  maximumFractionDigits: number,
  classify: (value: number | null) => ConditionBand,
): ForecastCardValue {
  const value = maximumMetric(records, metric);
  const measurement = formatFixedMeasurement(
    value,
    unit,
    maximumFractionDigits,
  );
  return {
    readings: [{ label: "Max", measurement, tone: forecastToneForBand(value, classify(value)) }],
  };
}

// format one daily precipitation accumulation
function formatPrecipitationAccumulation(
  value: number | null,
  units: UnitPreferences,
): FormattedMeasurement {
  // preserve useful small-rain precision
  const maximumFractionDigits = units.precipitation === "inches" ? 2 : 1;
  return formatMeasurement(
    value,
    "precipitation",
    units,
    maximumFractionDigits,
  );
}

// format one hourly precipitation rate preference
function formatPrecipitationRate(
  value: number | null,
  units: UnitPreferences,
): FormattedMeasurement {
  const measurement = formatMeasurement(value, "precipitation", units);
  return {
    unit: measurement.unit.length === 0 ? "" : `${measurement.unit}/h`,
    value: measurement.value,
  };
}

// format one forecast clock time in the site timezone
function formatForecastTime(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone ?? "UTC",
  }).format(new Date(value));
}

// format compact metric precision
function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

// format an instant in the site timezone
function formatInstant(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone ?? "UTC",
  }).format(new Date(value));
}

// format one compact forecast hour
function formatForecastHour(
  value: string,
  timezone: string | undefined,
  days: ForecastDays,
): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: timezone ?? "UTC",
    weekday: days === 1 ? undefined : "short",
  }).format(new Date(value));
}

// format one compact multi-day panel label
function formatForecastDayPanel(value: string, timezone?: string): string {
  const instant = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    timeZone: timezone ?? "UTC",
  }).format(instant);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone ?? "UTC",
    weekday: "short",
  }).format(instant);
  return `${weekday} ${day}`;
}

// format one compact axis hour
function formatForecastAxisHour(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    timeZone: timezone ?? "UTC",
  }).format(new Date(value));
}

// format one compact multi-day axis date
function formatForecastAxisDate(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: timezone ?? "UTC",
  }).format(new Date(value));
}

// render an ISO value for a site input
function toLocalInput(value: string | undefined, timezone: string): string {
  // preserve an empty filter
  if (value === undefined) {
    return "";
  }

  return toSiteWallClock(value, timezone);
}

interface WallClockParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly year: number;
}

// convert one site wall clock to UTC
export function fromSiteWallClock(value: string, timezone: string): string {
  const requested = parseWallClock(value);
  const requestedEpoch = wallClockEpoch(requested);
  const requestedWallClock = formatWallClock(requested);
  const matches = new Set<number>();

  // collect nearby timezone offsets
  for (
    let delta = -WALL_CLOCK_OFFSET_WINDOW_MS;
    delta <= WALL_CLOCK_OFFSET_WINDOW_MS;
    delta += WALL_CLOCK_OFFSET_SAMPLE_MS
  ) {
    const sampleEpoch = requestedEpoch + delta;
    const represented = formatWallClockParts(new Date(sampleEpoch), timezone);
    const offset = wallClockEpoch(represented) - sampleEpoch;
    const candidateEpoch = requestedEpoch - offset;
    const candidate = new Date(candidateEpoch);

    // retain exact round-trip matches
    if (
      Number.isFinite(candidateEpoch) &&
      formatWallClock(formatWallClockParts(candidate, timezone)) ===
        requestedWallClock
    ) {
      matches.add(candidateEpoch);
    }
  }

  // require one unambiguous instant
  if (matches.size !== 1) {
    throw new RangeError("history wall clock is not valid in the site timezone");
  }

  const candidateEpoch = [...matches][0]!;
  return new Date(candidateEpoch).toISOString();
}

// convert one UTC instant to a site wall clock
export function toSiteWallClock(value: string, timezone: string): string {
  const instant = new Date(value);

  // reject invalid stored instants
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("history instant must be valid");
  }

  return formatWallClock(formatWallClockParts(instant, timezone));
}

// parse one minute-precision wall clock
function parseWallClock(value: string): WallClockParts {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/u.exec(
      value,
    );

  // require the browser datetime shape
  if (match?.groups === undefined) {
    throw new RangeError("history wall clock must use YYYY-MM-DDTHH:mm");
  }

  const parts = {
    day: Number(match.groups.day),
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute),
    month: Number(match.groups.month),
    year: Number(match.groups.year),
  };
  const normalized = new Date(wallClockEpoch(parts));

  // reject normalized calendar overflow
  if (
    normalized.getUTCFullYear() !== parts.year ||
    normalized.getUTCMonth() + 1 !== parts.month ||
    normalized.getUTCDate() !== parts.day ||
    normalized.getUTCHours() !== parts.hour ||
    normalized.getUTCMinutes() !== parts.minute
  ) {
    throw new RangeError("history wall clock must be a valid calendar value");
  }

  return parts;
}

// format one instant in a site timezone
function formatWallClockParts(
  instant: Date,
  timezone: string,
): WallClockParts {
  const values = new Map<string, string>();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

  // collect named calendar parts
  for (const part of formatter.formatToParts(instant)) {
    // ignore locale punctuation
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }

  return {
    day: requireWallClockPart(values, "day"),
    hour: requireWallClockPart(values, "hour"),
    minute: requireWallClockPart(values, "minute"),
    month: requireWallClockPart(values, "month"),
    year: requireWallClockPart(values, "year"),
  };
}

// require one formatted calendar part
function requireWallClockPart(
  values: ReadonlyMap<string, string>,
  name: string,
): number {
  const value = values.get(name);

  // fail closed on incomplete formatting
  if (value === undefined) {
    throw new RangeError(`site timezone omitted ${name}`);
  }

  return Number(value);
}

// compare one minute-precision wall clock
function formatWallClock(parts: WallClockParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

// project wall clock fields onto a UTC epoch
function wallClockEpoch(parts: WallClockParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

// escape untrusted text for HTML contexts
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// load one JSON contract
async function getJson<ResponseBody>(
  fetcher: typeof fetch,
  url: string,
): Promise<ResponseBody> {
  const response = await fetcher(url, { headers: { accept: "application/json" } });

  // expose a bounded browser error
  if (!response.ok) {
    throw new Error(`Weather request failed with status ${String(response.status)}`);
  }

  return (await response.json()) as ResponseBody;
}

// write one authenticated JSON contract
async function putJson<ResponseBody>(
  fetcher: typeof fetch,
  url: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ResponseBody> {
  const response = await fetcher(url, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "PUT",
  });

  // expose a bounded browser error
  if (!response.ok) {
    throw new Error(`Weather request failed with status ${String(response.status)}`);
  }

  return (await response.json()) as ResponseBody;
}

// normalize an optional API base URL
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/u, "");
}
