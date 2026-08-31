import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AUTH_VERSION = 1;
const LAYOUT_VERSION = 1;
const SENSOR_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SENSOR_ICONS = new Set(["air-quality", "rain", "temperature", "wind"]);

export class WeatherAdminStore {
  #authPath;
  #bootstrapTokenPath;
  #center;
  #layoutPath;

  // retain only explicit persistence paths
  constructor(options) {
    this.#authPath = requirePath(options.authPath, "authPath");
    this.#bootstrapTokenPath = requirePath(
      options.bootstrapTokenPath,
      "bootstrapTokenPath",
    );
    this.#layoutPath = requirePath(options.layoutPath, "layoutPath");
    this.#center = validateCoordinate(options.center, "center");
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

  // verify one HTTP Basic credential pair
  async authenticate(authorization) {
    const credentials = parseBasicAuthorization(authorization);

    // reject missing or malformed credentials uniformly
    if (credentials === null || credentials.username !== "admin") {
      return false;
    }

    const state = await readOptionalJson(this.#authPath);

    // keep admin disabled until the one-time bootstrap completes
    if (state === null) {
      return false;
    }

    const parsed = parseAuthState(state);
    const actual = await derivePasswordHash(credentials.password, parsed.salt);
    return actual.byteLength === parsed.hash.byteLength && timingSafeEqual(actual, parsed.hash);
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

// parse bounded HTTP Basic credentials
function parseBasicAuthorization(value) {
  // require the Basic scheme
  if (typeof value !== "string" || !value.startsWith("Basic ")) {
    return null;
  }

  let decoded;

  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");

  // require username and password boundaries
  if (separator < 1 || decoded.length > 320) {
    return null;
  }

  return {
    password: decoded.slice(separator + 1),
    username: decoded.slice(0, separator),
  };
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
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

// test plain object membership
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
