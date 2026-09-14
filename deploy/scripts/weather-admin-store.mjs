import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AUTH_VERSION = 1;
const LAYOUT_VERSION = 1;
const ADJUSTMENT_SETTINGS_VERSION = 1;
const ADJUSTMENT_SETTINGS_MARKER = "forecast-adjustment-settings/v1";
const DEFAULT_ADJUSTMENT_SETTINGS = Object.freeze({
  version: ADJUSTMENT_SETTINGS_VERSION,
  temperature: true,
  wind: true,
  rain: true,
});
const DISABLED_ADJUSTMENT_SETTINGS = Object.freeze({
  version: ADJUSTMENT_SETTINGS_VERSION,
  temperature: false,
  wind: false,
  rain: false,
});
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAXIMUM_ADMIN_SESSIONS = 64;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SENSOR_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SENSOR_ICONS = new Set(["air-quality", "rain", "temperature", "wind"]);

export class WeatherAdminStore {
  #authPath;
  #adjustmentSettingsPath;
  #adjustmentSettingsMarkerPath;
  #adjustmentSettingsInitialized = false;
  #bootstrapTokenPath;
  #center;
  #layoutPath;
  #now;
  #sessions = new Map();

  // retain only explicit persistence paths
  constructor(options) {
    this.#authPath = requirePath(options.authPath, "authPath");
    this.#bootstrapTokenPath = requirePath(
      options.bootstrapTokenPath,
      "bootstrapTokenPath",
    );
    this.#layoutPath = requirePath(options.layoutPath, "layoutPath");
    this.#adjustmentSettingsPath = requirePath(
      options.adjustmentSettingsPath ?? join(dirname(this.#layoutPath), "forecast-adjustment-settings.json"),
      "adjustmentSettingsPath",
    );
    this.#adjustmentSettingsMarkerPath = `${this.#adjustmentSettingsPath}.initialized`;
    this.#center = validateCoordinate(options.center, "center");
    this.#now = options.now ?? Date.now;

    // require one deterministic clock boundary
    if (typeof this.#now !== "function") {
      throw new RangeError("now must be a function");
    }
  }

  // bootstrap exactly one password hash
  async bootstrap(providedToken, password) {
    const existing = await readOptionalJson(this.#authPath);

    // prevent password replacement through the bootstrap route
    if (existing !== null) {
      return { status: "already_configured" };
    }

    const expectedToken = await readOptionalText(this.#bootstrapTokenPath);

    // disable bootstrap without a build-provided one-time token
    if (
      expectedToken === null ||
      !secureTextEqual(expectedToken, requireSecret(providedToken, "bootstrap token", 32, 256))
    ) {
      return { status: "unauthorized" };
    }

    const validatedPassword = requireSecret(password, "password", 8, 256);
    const salt = randomBytes(16);
    const hash = await derivePasswordHash(validatedPassword, salt);
    await atomicWriteJson(this.#authPath, {
      hash: hash.toString("base64"),
      salt: salt.toString("base64"),
      username: "admin",
      version: AUTH_VERSION,
    });
    return { status: "configured" };
  }

  // exchange one valid password for a bounded opaque session
  async startSession(username, password) {
    // reject every invalid credential pair
    if (!(await this.#authenticateCredentials(username, password))) {
      return null;
    }

    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    this.#pruneSessions(now);

    // cap retained sessions even for authenticated callers
    if (this.#sessions.size >= MAXIMUM_ADMIN_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;

      // remove only one concrete oldest session
      if (typeof oldest === "string") {
        this.#sessions.delete(oldest);
      }
    }

    this.#sessions.set(sessionTokenDigest(token), now + ADMIN_SESSION_TTL_SECONDS * 1_000);
    return { maximumAgeSeconds: ADMIN_SESSION_TTL_SECONDS, token };
  }

  // verify one active opaque browser session
  authenticateSession(token) {
    // reject missing or malformed cookies uniformly
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) {
      return false;
    }

    const digest = sessionTokenDigest(token);
    const expiresAt = this.#sessions.get(digest);

    // reject unknown sessions without retaining attacker input
    if (expiresAt === undefined) {
      return false;
    }

    // expire one session at its absolute deadline
    if (expiresAt <= this.#now()) {
      this.#sessions.delete(digest);
      return false;
    }

    return true;
  }

  // revoke one presented browser session
  revokeSession(token) {
    // ignore malformed logout cookies
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) {
      return;
    }

    this.#sessions.delete(sessionTokenDigest(token));
  }

  // verify one submitted login form against the stored hash
  async #authenticateCredentials(username, password) {
    // reject malformed form fields before touching persistent state
    if (
      username !== "admin" ||
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(password)
    ) {
      return false;
    }

    const state = await readOptionalJson(this.#authPath);

    // keep admin disabled until the one-time bootstrap completes
    if (state === null) {
      return false;
    }

    const parsed = parseAuthState(state);
    const actual = await derivePasswordHash(password, parsed.salt);
    return actual.byteLength === parsed.hash.byteLength && timingSafeEqual(actual, parsed.hash);
  }

  // remove every expired in-memory session
  #pruneSessions(now) {
    // inspect the bounded session registry
    for (const [digest, expiresAt] of this.#sessions) {
      // retain only future expirations
      if (expiresAt <= now) {
        this.#sessions.delete(digest);
      }
    }
  }

  // read the server-wide property layout
  async readLayout() {
    const state = await readOptionalJson(this.#layoutPath);

    // return an empty first-run layout
    if (state === null) {
      return [];
    }

    return parseLayoutState(state);
  }

  // read a complete persistent adjustment switch snapshot
  async readAdjustmentSettingsStatus() {
    try {
      await this.#initializeAdjustmentSettings();
      const state = await readOptionalJson(this.#adjustmentSettingsPath);

      // distinguish a lost file from a first-run default
      if (state === null) {
        throw new Error("forecast adjustment settings file is missing");
      }

      return { settings: parseAdjustmentSettings(state), error: null };
    } catch {
      // fail closed when persisted state cannot be trusted
      return {
        settings: { ...DISABLED_ADJUSTMENT_SETTINGS },
        error: "adjustment_settings_unavailable",
      };
    }
  }

  // replace all three independently chosen admin switches
  async writeAdjustmentSettings(input) {
    const settings = parseAdjustmentSettings(input);
    const marker = await readOptionalText(this.#adjustmentSettingsMarkerPath);

    // let an authenticated update repair a damaged marker last
    if (marker !== ADJUSTMENT_SETTINGS_MARKER &&
      (marker !== null || this.#adjustmentSettingsInitialized)) {
      await atomicWriteJson(this.#adjustmentSettingsPath, settings);
      await atomicWriteText(this.#adjustmentSettingsMarkerPath, `${ADJUSTMENT_SETTINGS_MARKER}\n`);
      this.#adjustmentSettingsInitialized = true;
      return settings;
    }

    await this.#initializeAdjustmentSettings();
    await atomicWriteJson(this.#adjustmentSettingsPath, settings);
    return settings;
  }

  // record first initialization before making defaults visible
  async #initializeAdjustmentSettings() {
    const marker = await readOptionalText(this.#adjustmentSettingsMarkerPath);

    // never recreate defaults after initialization or marker damage
    if (marker !== null) {
      if (marker !== ADJUSTMENT_SETTINGS_MARKER) {
        throw new Error("forecast adjustment settings marker is invalid");
      }
      this.#adjustmentSettingsInitialized = true;
      return;
    }

    // reject an in-process loss of both persistent switch files
    if (this.#adjustmentSettingsInitialized) {
      throw new Error("forecast adjustment settings marker is missing");
    }

    // distinguish a configured first release from a lost whole web volume
    const auth = await readOptionalJson(this.#authPath);
    if (auth === null) {
      throw new Error("admin authentication is not configured");
    }
    parseAuthState(auth);

    await mkdir(dirname(this.#adjustmentSettingsPath), { mode: 0o700, recursive: true });
    try {
      await writeFile(this.#adjustmentSettingsMarkerPath, `${ADJUSTMENT_SETTINGS_MARKER}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      // another first reader owns default initialization
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const installedMarker = await readOptionalText(this.#adjustmentSettingsMarkerPath);

      // reject a raced or invalid marker instead of assuming authority
      if (installedMarker !== ADJUSTMENT_SETTINGS_MARKER) {
        throw new Error("forecast adjustment settings marker is invalid");
      }
      this.#adjustmentSettingsInitialized = true;
      return;
    }

    // link a complete default only if no concurrent admin value exists
    await atomicCreateJsonIfMissing(this.#adjustmentSettingsPath, DEFAULT_ADJUSTMENT_SETTINGS);
    this.#adjustmentSettingsInitialized = true;
  }

  // update one sensor without overwriting other placements
  async upsertSensor(sensorKey, input) {
    const key = validateSensorKey(sensorKey);
    const displayName = requireDisplayName(input?.displayName);
    const icon = requireSensorIcon(input?.icon);
    const coordinate = validateCoordinate(input, "sensor position");

    // constrain placements to the farm vicinity
    if (
      Math.abs(coordinate.latitude - this.#center.latitude) > 0.025 ||
      Math.abs(coordinate.longitude - this.#center.longitude) > 0.04
    ) {
      throw new RangeError("sensor position must be within the property map bounds");
    }

    const current = await this.readLayout();
    const next = current.filter(
      // replace only the selected stable sensor key
      (entry) => entry.sensorKey !== key,
    );
    const saved = {
      displayName,
      icon,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      sensorKey: key,
      updatedAt: new Date().toISOString(),
    };
    next.push(saved);
    next.sort(
      // keep deterministic public responses and disk state
      (left, right) => left.sensorKey.localeCompare(right.sensorKey),
    );
    await atomicWriteJson(this.#layoutPath, {
      sensors: next,
      version: LAYOUT_VERSION,
    });
    return saved;
  }
}

// require one exact versioned switch record
function parseAdjustmentSettings(value) {
  // reject missing, extra, or non-boolean fields
  if (
    !isObject(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== ADJUSTMENT_SETTINGS_VERSION ||
    typeof value.temperature !== "boolean" ||
    typeof value.wind !== "boolean" ||
    typeof value.rain !== "boolean"
  ) {
    throw new RangeError("forecast adjustment settings are invalid");
  }

  return {
    version: ADJUSTMENT_SETTINGS_VERSION,
    temperature: value.temperature,
    wind: value.wind,
    rain: value.rain,
  };
}

// parse one immutable auth record
function parseAuthState(value) {
  // require the exact supported record shape
  if (
    !isObject(value) ||
    value.version !== AUTH_VERSION ||
    value.username !== "admin" ||
    typeof value.hash !== "string" ||
    typeof value.salt !== "string"
  ) {
    throw new Error("admin auth state is invalid");
  }

  const hash = Buffer.from(value.hash, "base64");
  const salt = Buffer.from(value.salt, "base64");

  // reject truncated or malformed cryptographic material
  if (hash.byteLength !== 64 || salt.byteLength !== 16) {
    throw new Error("admin auth state is invalid");
  }

  return { hash, salt };
}

// parse one immutable layout record
function parseLayoutState(value) {
  // require a supported layout envelope
  if (!isObject(value) || value.version !== LAYOUT_VERSION || !Array.isArray(value.sensors)) {
    throw new Error("property sensor layout is invalid");
  }

  return value.sensors.slice(0, 64).map(
    // validate every persisted entry before exposure
    (entry) => parseLayoutEntry(entry),
  );
}

// parse one persisted layout entry
function parseLayoutEntry(value) {
  // require one plain persisted object
  if (!isObject(value)) {
    throw new Error("property sensor layout entry is invalid");
  }

  const coordinate = validateCoordinate(value, "sensor position");
  return {
    displayName: requireDisplayName(value.displayName),
    icon: optionalSensorIcon(value.icon),
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    sensorKey: validateSensorKey(value.sensorKey),
    updatedAt: requireIsoInstant(value.updatedAt),
  };
}

// validate one explicit map icon category
function requireSensorIcon(value) {
  // reject arbitrary persisted icon names
  if (typeof value !== "string" || !SENSOR_ICONS.has(value)) {
    throw new RangeError("sensor icon is invalid");
  }

  return value;
}

// preserve layouts saved before icon selection existed
function optionalSensorIcon(value) {
  // default legacy persisted entries in the browser
  if (value === undefined || value === null) {
    return null;
  }

  return requireSensorIcon(value);
}

// derive one memory-hard password verifier
async function derivePasswordHash(password, salt) {
  return await scrypt(password, salt, 64, {
    N: 16_384,
    maxmem: 32 * 1_024 * 1_024,
    p: 1,
    r: 8,
  });
}

// hash one opaque token before retaining it in memory
function sessionTokenDigest(token) {
  return createHash("sha256").update(token).digest("base64url");
}

// compare secret text without length-dependent early returns
function secureTextEqual(left, right) {
  const leftHash = Buffer.from(left);
  const rightHash = Buffer.from(right);

  // normalize unequal lengths before the constant-time compare
  if (leftHash.byteLength !== rightHash.byteLength) {
    const padding = Buffer.alloc(leftHash.byteLength);
    timingSafeEqual(leftHash, padding);
    return false;
  }

  return timingSafeEqual(leftHash, rightHash);
}

// validate one public coordinate object
function validateCoordinate(value, field) {
  // require one plain coordinate object
  if (!isObject(value)) {
    throw new RangeError(`${field} must be an object`);
  }

  const latitude = value.latitude;
  const longitude = value.longitude;

  // enforce geographic coordinate ranges
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -85 ||
    latitude > 85 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new RangeError(`${field} coordinates are invalid`);
  }

  return { latitude, longitude };
}

// validate one stable sensor identity
function validateSensorKey(value) {
  // reject path-like and unbounded keys
  if (typeof value !== "string" || value.length > 64 || !SENSOR_KEY_PATTERN.test(value)) {
    throw new RangeError("sensor key is invalid");
  }

  return value;
}

// validate one user-facing sensor name
function requireDisplayName(value) {
  // require readable bounded text without controls
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.trim().length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError("displayName must be between 1 and 80 characters");
  }

  return value.trim();
}

// validate one ISO update instant
function requireIsoInstant(value) {
  // reject non-canonical timestamps
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error("property sensor update time is invalid");
  }

  return value;
}

// require one private bounded credential
function requireSecret(value, field, minimum, maximum) {
  // reject whitespace and control-bearing secret files
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${field} is invalid`);
  }

  return value;
}

// require one absolute or relative filesystem path
function requirePath(value, field) {
  // reject absent or null-bearing paths
  if (typeof value !== "string" || value.length < 1 || value.includes("\u0000")) {
    throw new RangeError(`${field} is invalid`);
  }

  return value;
}

// read optional JSON state
async function readOptionalJson(path) {
  const text = await readOptionalText(path);
  return text === null ? null : JSON.parse(text);
}

// read an optional UTF-8 file
async function readOptionalText(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    // preserve a first-run missing file
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

// replace one state file atomically
async function atomicWriteJson(path, value) {
  await atomicWriteText(path, `${JSON.stringify(value)}\n`);
}

// replace one bounded text state file atomically
async function atomicWriteText(path, content) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

// publish a complete first-run file without replacing an admin write
async function atomicCreateJsonIfMissing(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    try {
      await link(temporaryPath, path);
    } catch (error) {
      // preserve a concurrently committed administrator value
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(
      // tolerate a write failure before the temporary file existed
      (error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      },
    );
  }
}

// test plain object membership
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
