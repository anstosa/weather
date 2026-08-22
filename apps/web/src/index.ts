export interface SiteSource {
  readonly attribution: {
    readonly label: string;
    readonly url: string;
  };
  readonly id: string;
  readonly key: string;
  readonly kind: "forecast" | "model_current" | "physical_sensor" | "reanalysis";
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
    readonly cloudCoverPercent: number | null;
    readonly precipitationMm: number | null;
    readonly pressureHpa: number | null;
    readonly relativeHumidityPercent: number | null;
    readonly temperatureC: number | null;
    readonly windDirectionDegrees: number | null;
    readonly windGustMps: number | null;
    readonly windSpeedMps: number | null;
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

export interface HistoryFilters {
  readonly from?: string;
  readonly sourceId?: string;
  readonly sourceKind?: SiteSource["kind"];
  readonly stationSlug?: string;
  readonly to?: string;
}

export interface DashboardState {
  readonly current: readonly WeatherRecord[];
  readonly error: string | null;
  readonly filters: HistoryFilters;
  readonly history: readonly WeatherRecord[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly page: number;
  readonly selectedSite: WeatherSite | null;
  readonly sites: readonly WeatherSite[];
}

export interface DashboardOptions {
  readonly apiBaseUrl?: string;
  readonly fetcher?: typeof fetch;
}

interface SitesResponse {
  readonly data: readonly WeatherSite[];
}

interface RecordsResponse {
  readonly data: readonly WeatherRecord[];
  readonly page?: {
    readonly limit: number;
    readonly nextCursor: string | null;
  };
  readonly site: WeatherSite;
}

type DashboardListener = (state: DashboardState) => void;

const EMPTY_STATE: DashboardState = {
  current: [],
  error: null,
  filters: {},
  history: [],
  loading: false,
  nextCursor: null,
  page: 0,
  selectedSite: null,
  sites: [],
};

// coordinate browser reads and pagination
export class WeatherDashboardController {
  readonly #apiBaseUrl: string;
  readonly #cursors: Array<string | undefined> = [undefined];
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<DashboardListener>();
  #state: DashboardState = EMPTY_STATE;

  // retain injectable browser boundaries
  constructor(options: DashboardOptions = {}) {
    this.#apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl ?? "/api/v1");
    this.#fetcher = options.fetcher ?? fetch;
  }

  // expose the latest immutable view
  get state(): DashboardState {
    return this.#state;
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

  // load site metadata and the preferred Ballydidean view
  async initialize(): Promise<void> {
    this.patch({ error: null, loading: true });

    try {
      const response = await getJson<SitesResponse>(
        this.#fetcher,
        `${this.#apiBaseUrl}/sites`,
      );

      // require at least one configured site
      if (response.data.length === 0) {
        throw new Error("No weather sites are available");
      }

      const preferred =
        response.data.find(
          // prefer the approved launch site
          (site) => site.slug === "ballydidean",
        ) ?? response.data[0];

      // guard the non-empty invariant for TypeScript
      if (preferred === undefined) {
        throw new Error("No weather sites are available");
      }

      this.#state = {
        ...this.#state,
        selectedSite: preferred,
        sites: response.data,
      };
      this.emit();
      await this.loadSelectedSite();
    } catch (error) {
      this.fail(error);
    }
  }

  // switch the dashboard site
  async selectSite(siteSlug: string): Promise<void> {
    const site = this.#state.sites.find(
      // match a configured option
      (candidate) => candidate.slug === siteSlug,
    );

    // reject stale selector values
    if (site === undefined) {
      this.patch({ error: "The selected site is no longer available" });
      return;
    }

    this.resetPagination();
    this.#state = {
      ...this.#state,
      current: [],
      error: null,
      history: [],
      selectedSite: site,
    };
    this.emit();
    await this.loadSelectedSite();
  }

  // apply new history filters
  async setFilters(filters: HistoryFilters): Promise<void> {
    this.resetPagination();
    this.#state = { ...this.#state, filters };
    this.emit();
    await this.loadSelectedSite();
  }

  // advance to the next cursor page
  async nextPage(): Promise<void> {
    // stop at the final page
    if (this.#state.nextCursor === null || this.#state.loading) {
      return;
    }

    this.#cursors.push(this.#state.nextCursor);
    this.#state = { ...this.#state, page: this.#state.page + 1 };
    this.emit();
    await this.loadHistory();
  }

  // return to the preceding cursor page
  async previousPage(): Promise<void> {
    // stop at the first page
    if (this.#state.page === 0 || this.#state.loading) {
      return;
    }

    this.#cursors.pop();
    this.#state = { ...this.#state, page: this.#state.page - 1 };
    this.emit();
    await this.loadHistory();
  }

  // load current and history panels together
  async loadSelectedSite(): Promise<void> {
    const site = this.#state.selectedSite;

    // wait for initialization
    if (site === null) {
      return;
    }

    this.patch({ error: null, loading: true });

    try {
      const historyUrl = buildHistoryUrl(
        this.#apiBaseUrl,
        site.slug,
        this.#state.filters,
        this.#cursors[this.#state.page],
      );
      const [current, history] = await Promise.all([
        getJson<RecordsResponse>(
          this.#fetcher,
          buildCurrentUrl(
            this.#apiBaseUrl,
            site.slug,
            this.#state.filters,
          ),
        ),
        getJson<RecordsResponse>(this.#fetcher, historyUrl),
      ]);
      this.#state = {
        ...this.#state,
        current: current.data,
        error: null,
        history: history.data,
        loading: false,
        nextCursor: history.page?.nextCursor ?? null,
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
      this.#state = {
        ...this.#state,
        error: null,
        history: response.data,
        loading: false,
        nextCursor: response.page?.nextCursor ?? null,
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
  const parameters = new URLSearchParams({ limit: "100" });

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

// mount the interactive dashboard
export function mountWeatherDashboard(
  root: HTMLElement,
  options: DashboardOptions = {},
): WeatherDashboardController {
  const controller = new WeatherDashboardController(options);

  // redraw and wire one state snapshot
  controller.subscribe((state) => {
    root.innerHTML = renderWeatherDashboard(state);
    bindDashboardControls(root, controller);
  });
  void controller.initialize();
  return controller;
}

// render the complete accessible dashboard
export function renderWeatherDashboard(state: DashboardState): string {
  const site = state.selectedSite;
  const heading = site === null ? "Weather" : `${site.name} weather`;
  return `
    <main class="shell">
      <header class="masthead">
        <div>
          <p class="eyebrow">Whidbey Island weather</p>
          <h1>${escapeHtml(heading)}</h1>
          <p class="lede">Nearby model-derived conditions and historical reanalysis for the selected location.</p>
        </div>
        ${renderSiteSelector(state)}
      </header>
      ${renderStatus(state)}
      ${renderAttribution(state)}
      ${renderCurrent(state)}
      ${renderHistory(state)}
    </main>
  `;
}

// render permanent provider and license attribution
function renderAttribution(state: DashboardState): string {
  const source = state.selectedSite?.stations
    .flatMap(
      // collect every site source
      (station) => station.sources,
    )
    .find(
      // select the configured provider
      (candidate) => candidate.providerKey === "open-meteo",
    );

  // preserve an honest pre-initialization shell
  if (source === undefined) {
    return "";
  }

  return `
    <aside class="attribution" aria-label="Weather data attribution">
      <span>${escapeHtml(source.attribution.label)}.</span>
      <a href="${escapeHtml(source.attribution.url)}" rel="license noreferrer">Open-Meteo</a>
      <span>data is available under</span>
      <a href="https://creativecommons.org/licenses/by/4.0/" rel="license noreferrer">CC BY 4.0</a>.
    </aside>
  `;
}

// render the site selector
function renderSiteSelector(state: DashboardState): string {
  let options = "";

  // render every active site
  for (const site of state.sites) {
    const selected = site.slug === state.selectedSite?.slug ? " selected" : "";
    options += `<option value="${escapeHtml(site.slug)}"${selected}>${escapeHtml(site.name)}</option>`;
  }

  return `
    <label class="site-picker">
      <span>Location</span>
      <select data-site-selector aria-label="Weather location"${state.loading ? " disabled" : ""}>
        ${options}
      </select>
    </label>
  `;
}

// render loading and error feedback
function renderStatus(state: DashboardState): string {
  // prioritize errors
  if (state.error !== null) {
    return `<p class="notice error" role="alert">${escapeHtml(state.error)}</p>`;
  }

  // announce pending reads
  if (state.loading) {
    return `<p class="notice" role="status">Refreshing weather data…</p>`;
  }

  return `<p class="sr-only" role="status">Weather data is up to date.</p>`;
}

// render the current summary
function renderCurrent(state: DashboardState): string {
  const current =
    state.current.find(
      // prefer the current-model source
      (record) => record.provenance.sourceKind === "model_current",
    ) ?? state.current[0];

  // render an honest empty state
  if (current === undefined) {
    return `
      <section class="panel" aria-labelledby="current-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Right now</p><h2 id="current-heading">Current conditions</h2></div>
        </div>
        <p>No current model value is available yet.</p>
      </section>
    `;
  }

  return `
    <section class="panel current-panel" aria-labelledby="current-heading">
      <div class="section-heading">
        <div><p class="eyebrow">Right now</p><h2 id="current-heading">Current conditions</h2></div>
        <span class="freshness ${escapeHtml(current.freshness.status)}">${escapeHtml(current.freshness.label)}</span>
      </div>
      <div class="current-grid">
        ${renderMetric("Temperature", current.metrics.temperatureC, "°C", "primary")}
        ${renderMetric("Feels like", current.metrics.apparentTemperatureC, "°C")}
        ${renderMetric("Humidity", current.metrics.relativeHumidityPercent, "%")}
        ${renderMetric("Wind", current.metrics.windSpeedMps, "m/s")}
        ${renderMetric("Precipitation", current.metrics.precipitationMm, "mm")}
        ${renderMetric("Pressure", current.metrics.pressureHpa, "hPa")}
      </div>
      <div class="provenance">
        <p><strong>Nearby model value</strong> valid ${formatInstant(current.validAt, state.selectedSite?.timezone)}. This is ${escapeHtml(current.provenance.label)}, not an on-site sensor reading.${current.metadata.upstream.model === null ? "" : ` Upstream model: ${escapeHtml(current.metadata.upstream.model)}.`}</p>
        <a href="${escapeHtml(current.provenance.attribution.url)}" rel="noreferrer">${escapeHtml(current.provenance.attribution.label)}</a>
      </div>
    </section>
  `;
}

// render one metric tile
function renderMetric(
  label: string,
  value: number | null,
  unit: string,
  emphasis = "",
): string {
  return `
    <div class="metric ${escapeHtml(emphasis)}">
      <span>${escapeHtml(label)}</span>
      <strong>${value === null ? "—" : escapeHtml(formatNumber(value))}<small>${value === null ? "" : escapeHtml(unit)}</small></strong>
    </div>
  `;
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
          <thead><tr><th scope="col">Valid time</th><th scope="col">Temperature (°C)</th><th scope="col">Humidity (%)</th><th scope="col">Wind (m/s)</th><th scope="col">Precipitation (mm)</th><th scope="col">Source and provenance</th></tr></thead>
          <tbody>${renderHistoryRows(state)}</tbody>
        </table>
      </div>
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
    <form class="filters" data-history-filters>
      <label><span>Station</span><select name="stationSlug">${stationOptions}</select></label>
      <label><span>Source</span><select name="sourceId">${sourceOptions}</select></label>
      <label><span>Provenance</span><select name="sourceKind">
        <option value="">All kinds</option>
        <option value="model_current"${state.filters.sourceKind === "model_current" ? " selected" : ""}>Model current</option>
        <option value="reanalysis"${state.filters.sourceKind === "reanalysis" ? " selected" : ""}>Historical reanalysis</option>
      </select></label>
      <label><span>From</span><input name="from" type="datetime-local" value="${escapeHtml(toLocalInput(state.filters.from))}"></label>
      <label><span>To</span><input name="to" type="datetime-local" value="${escapeHtml(toLocalInput(state.filters.to))}"></label>
      <button type="submit"${state.loading ? " disabled" : ""}>Apply filters</button>
    </form>
  `;
}

// render history table rows
function renderHistoryRows(state: DashboardState): string {
  // render a useful empty row
  if (state.history.length === 0) {
    return `<tr><td colspan="6" class="empty">No records match these filters.</td></tr>`;
  }

  let rows = "";

  // render every visible record
  for (const record of state.history) {
    rows += `
      <tr>
        <td><time datetime="${escapeHtml(record.validAt)}">${formatInstant(record.validAt, state.selectedSite?.timezone)}</time></td>
        <td>${formatMetricCell(record.metrics.temperatureC, "°C")}</td>
        <td>${formatMetricCell(record.metrics.relativeHumidityPercent, "%")}</td>
        <td>${formatMetricCell(record.metrics.windSpeedMps, "m/s")}</td>
        <td>${formatMetricCell(record.metrics.precipitationMm, "mm")}</td>
        <td><span class="source-kind">${escapeHtml(record.provenance.label)}</span><small>${escapeHtml(record.provenance.sourceKey)}</small></td>
      </tr>
    `;
  }

  return rows;
}

// connect rendered controls to controller actions
function bindDashboardControls(
  root: HTMLElement,
  controller: WeatherDashboardController,
): void {
  const selector = root.querySelector<HTMLSelectElement>("[data-site-selector]");

  // wire location changes
  if (selector !== null) {
    // load the selected site
    selector.addEventListener("change", () => {
      void controller.selectSite(selector.value);
    });
  }

  const form = root.querySelector<HTMLFormElement>("[data-history-filters]");

  // wire filter submission
  if (form !== null) {
    // parse one filter form
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      void controller.setFilters({
        ...optionalFilter("from", toInstant(data.get("from"))),
        ...optionalFilter("sourceId", readFormValue(data.get("sourceId"))),
        ...optionalFilter(
          "sourceKind",
          readFormValue(data.get("sourceKind")) as SiteSource["kind"] | undefined,
        ),
        ...optionalFilter("stationSlug", readFormValue(data.get("stationSlug"))),
        ...optionalFilter("to", toInstant(data.get("to"))),
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

// read a non-empty form string
function readFormValue(value: FormDataEntryValue | null): string | undefined {
  // reject files and empty strings
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

// convert a local browser input to UTC
function toInstant(value: FormDataEntryValue | null): string | undefined {
  const text = readFormValue(value);

  // preserve an empty input
  if (text === undefined) {
    return undefined;
  }

  return new Date(text).toISOString();
}

// format a value and unit for table cells
function formatMetricCell(value: number | null, unit: string): string {
  // render missing values consistently
  if (value === null) {
    return "—";
  }

  return `${escapeHtml(formatNumber(value))} ${escapeHtml(unit)}`;
}

// format compact metric precision
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

// format an instant in the site timezone
function formatInstant(value: string, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone ?? "UTC",
  }).format(new Date(value));
}

// render an ISO value for a local input
function toLocalInput(value?: string): string {
  // preserve an empty filter
  if (value === undefined) {
    return "";
  }

  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
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

// normalize an optional API base URL
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/u, "");
}
