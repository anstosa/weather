// retain bounded Xweather raster tiles in one server process
export class XweatherTileMemoryCache {
  #entries = new Map();
  #inflight = new Map();
  #loadTile;
  #maximumBytes;
  #now;
  #storedBytes = 0;
  #forecastFreshnessMs;

  // configure one bounded cache with an injected provider loader
  constructor({ loadTile, maximumBytes, forecastFreshnessMs, now = Date.now }) {
    // reject unsafe cache construction
    if (
      typeof loadTile !== "function" ||
      typeof now !== "function" ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      !Number.isSafeInteger(forecastFreshnessMs) ||
      forecastFreshnessMs < 1
    ) {
      throw new TypeError("invalid Xweather tile cache configuration");
    }

    this.#loadTile = loadTile;
    this.#maximumBytes = maximumBytes;
    this.#now = now;
    this.#forecastFreshnessMs = forecastFreshnessMs;
  }

  // load one tile from memory or the provider
  async get(tile) {
    const key = tileCacheKey(tile);
    const cached = this.#entries.get(key);

    // return immutable history or a fresh forecast entry
    if (cached !== undefined && this.#isFresh(tile, cached)) {
      this.#touch(key, cached);
      return { ...cached, cacheStatus: "hit" };
    }

    const pending = this.#inflight.get(key);

    // coalesce concurrent misses and refreshes
    if (pending !== undefined) {
      return await pending;
    }

    const request = Promise.resolve(this.#loadTile(tile)).then(
      // retain one successful provider response
      (loaded) => {
        // require one bounded binary provider response
        if (!Buffer.isBuffer(loaded?.body) || loaded.body.byteLength < 1) {
          throw new TypeError("Xweather tile loader returned an invalid body");
        }

        const entry = {
          body: loaded.body,
          fetchedAt: this.#now(),
          phase: tile.phase,
        };
        this.#store(key, entry);
        return { ...entry, cacheStatus: "miss" };
      },
    ).finally(
      // release one completed provider request
      () => {
        this.#inflight.delete(key);
      },
    );
    this.#inflight.set(key, request);
    return await request;
  }

  // expose bounded operational counters without tile material
  stats() {
    return {
      entries: this.#entries.size,
      inflight: this.#inflight.size,
      maximumBytes: this.#maximumBytes,
      storedBytes: this.#storedBytes,
    };
  }

  // apply phase-specific freshness rules
  #isFresh(tile, entry) {
    // historical frame URLs are immutable for this process lifetime
    if (tile.phase === "history") {
      return true;
    }

    return this.#now() - entry.fetchedAt < this.#forecastFreshnessMs;
  }

  // promote one cache hit for bounded LRU eviction
  #touch(key, entry) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  // store one provider response within the memory budget
  #store(key, entry) {
    const prior = this.#entries.get(key);

    // replace one prior body without double-counting bytes
    if (prior !== undefined) {
      this.#storedBytes -= prior.body.byteLength;
      this.#entries.delete(key);
    }

    // skip bodies that cannot fit by themselves
    if (entry.body.byteLength > this.#maximumBytes) {
      return;
    }

    this.#entries.set(key, entry);
    this.#storedBytes += entry.body.byteLength;

    // evict forecast entries before immutable historical frames
    while (this.#storedBytes > this.#maximumBytes) {
      const oldest = this.#evictionCandidate();

      // preserve a consistent empty-cache boundary
      if (oldest === undefined) {
        this.#storedBytes = 0;
        break;
      }

      const [oldestKey, oldestEntry] = oldest;
      this.#entries.delete(oldestKey);
      this.#storedBytes -= oldestEntry.body.byteLength;
    }
  }

  // preserve historical frames while forecast entries remain evictable
  #evictionCandidate() {
    // select the least-recently-used forecast entry first
    for (const candidate of this.#entries.entries()) {
      const [, entry] = candidate;

      // prefer mutable forecast data for eviction
      if (entry.phase === "forecast") {
        return candidate;
      }
    }

    return this.#entries.entries().next().value;
  }
}

// create one canonical in-memory map-image identity
function tileCacheKey(tile) {
  const geometry = tile.kind === "frame"
    ? [String(tile.width), String(tile.height), String(tile.latitude), String(tile.longitude)]
    : [String(tile.column), String(tile.row)];
  return [tile.kind ?? "tile", tile.phase, tile.layer, tile.validTime, String(tile.zoom), ...geometry].join("/");
}
