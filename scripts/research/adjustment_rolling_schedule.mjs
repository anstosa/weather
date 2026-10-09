import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";

const DAY = 24 * 60 * 60 * 1_000;
const ZONE = "America/Los_Angeles";
const FAMILIES = new Set(["temperature", "wind", "rain"]);
const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit", month: "2-digit", timeZone: ZONE, year: "numeric",
});
const WALL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
  month: "2-digit", second: "2-digit", timeZone: ZONE, year: "numeric",
});

// preserve existing support spans while replacing obsolete absolute dates
export const ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT = Object.freeze({
  calibrationGapDays: 7,
  contractVersion: "forecast-adjustment-rolling-registration-schedule/v3",
  horizonExtension: "successful_registered_member_terminal_only",
  lateClosureDays: 7,
  maximumMonthAlignmentDays: 62,
  rainCalibrationDays: 90,
  rainConfirmationDays: 334,
  rainMinimumCalibrationDates: 60,
  rainMinimumTrainingDates: 180,
  sourceHistory: "post_epoch_and_post_predecessor_terminal_only",
  temperatureConfirmationDays: 366,
  temperatureMinimumTrainingDates: 60,
  timeZone: ZONE,
  trainingGapDays: 7,
  windConfirmationDays: 366,
  windMinimumTrainingDates: 60,
});
export const ADJUSTMENT_ROLLING_SCHEDULE_SHA256 = adjustmentSha256(
  canonicalJsonBytes(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT),
);

// derive a finite initial horizon without claiming that sufficient observations exist
export function buildAdjustmentRollingScheduleBootstrap(input) {
  exactKeys(input, ["epochAt", "epochWitnessSha256"]);
  instant(input.epochAt);
  hash(input.epochWitnessSha256);
  const firstCompleteLocalDate = addLocalDates(localDateAt(input.epochAt), 1);
  const minimumRainHistory = 180 + 7 + 90 + 7;
  // allow the full earlier-only annual development population before future confirmation
  const finiteDays = minimumRainHistory + 366 + 334 + 7 + 62;
  const unsigned = {
    contractVersion: "adjustment-registration-schedule-bootstrap/v3",
    epochAt: input.epochAt,
    epochWitnessSha256: input.epochWitnessSha256,
    firstCompleteLocalDate,
    horizonEndAt: localMidnightAt(addLocalDates(firstCompleteLocalDate, finiteDays)),
    scheduleContractSha256: ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
  };
  return Object.freeze({ ...unsigned, bootstrapSha256: adjustmentSha256(canonicalJsonBytes(unsigned)) });
}

// plan a value-blind rolling member from authenticated epoch and actual fit-month clocks
export function buildAdjustmentRollingWindow(input) {
  exactKeys(input, [
    "epochAt", "epochWitnessSha256", "family", "fitMonth", "predecessorTerminalAt", "requestedAt",
  ]);
  instant(input.epochAt);
  instant(input.requestedAt);
  hash(input.epochWitnessSha256);
  month(input.fitMonth);

  // never infer family authority or substitute a legacy fit month
  if (!FAMILIES.has(input.family) || Date.parse(input.requestedAt) < Date.parse(input.epochAt)) {
    throw new TypeError("rolling schedule family or request clock is invalid");
  }
  const epochFloor = localMidnightAt(addLocalDates(localDateAt(input.epochAt), 1));
  let sourceFloorAt = epochFloor;

  // successors cannot recycle a previously reserved member as new training history
  if (input.predecessorTerminalAt !== null) {
    instant(input.predecessorTerminalAt);
    if (Date.parse(input.predecessorTerminalAt) < Date.parse(input.epochAt) ||
      Date.parse(input.predecessorTerminalAt) > Date.parse(input.requestedAt)) {
      throw new TypeError("rolling schedule predecessor clock is invalid");
    }
    sourceFloorAt = Date.parse(input.predecessorTerminalAt) > Date.parse(epochFloor)
      ? input.predecessorTerminalAt : epochFloor;
  }
  const fitCutoff = Date.parse(`${input.fitMonth}-01T00:00:00.000Z`);
  const requestMonth = localDateAt(input.requestedAt).slice(0, 7);

  // an original-cutoff fitter cannot see a month that has not arrived yet
  if (input.fitMonth > requestMonth || fitCutoff > Date.parse(input.requestedAt)) {
    throw new TypeError("rolling schedule fit month is in the future");
  }
  const intervalStartDate = `${nextMonth(requestMonth)}-01`;
  const intervalDays = input.family === "rain" ? 334 : 366;
  const intervalStartAt = localMidnightAt(intervalStartDate);
  const intervalEndAt = localMidnightAt(addLocalDates(intervalStartDate, intervalDays));
  const terminalAt = new Date(Date.parse(intervalEndAt) + 7 * DAY).toISOString();
  const calibrationEndAt = input.family === "rain"
    ? new Date(fitCutoff - 7 * DAY).toISOString() : null;
  const calibrationStartAt = input.family === "rain"
    ? new Date(Date.parse(calibrationEndAt) - 90 * DAY).toISOString() : null;
  const trainingEndAt = new Date(input.family === "rain"
    ? Date.parse(calibrationStartAt) - 7 * DAY : fitCutoff - 7 * DAY).toISOString();
  const minimumTrainingDays = input.family === "rain" ? 180 : 60;

  // potential calendar support never replaces the actual fitter date, hour and wet-event gates
  if (Date.parse(trainingEndAt) - Date.parse(sourceFloorAt) < minimumTrainingDays * DAY ||
    (calibrationStartAt !== null && Date.parse(calibrationStartAt) < Date.parse(sourceFloorAt)) ||
    Date.parse(intervalStartAt) <= Date.parse(input.requestedAt) ||
    (calibrationEndAt !== null && Date.parse(intervalStartAt) - Date.parse(calibrationEndAt) < 7 * DAY)) {
    throw new RangeError("rolling schedule lacks post-epoch calendar support");
  }
  const unsigned = {
    calibrationEndAt,
    calibrationStartAt,
    contractVersion: "adjustment-shadow-registration-window-plan/v3",
    epochWitnessSha256: input.epochWitnessSha256,
    family: input.family,
    fitMonth: input.fitMonth,
    intervalEndAt,
    intervalStartAt,
    plannedAt: input.requestedAt,
    predecessorTerminalAt: input.predecessorTerminalAt,
    scheduleContractSha256: ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
    sourceFloorAt,
    targetCutoffAt: terminalAt,
    terminalAt,
    trainingEndAt,
  };
  return Object.freeze({ ...unsigned, planSha256: adjustmentSha256(canonicalJsonBytes(unsigned)) });
}

// extend only to the terminal clock of an already authenticated registered member
export function extendAdjustmentRollingCaptureHorizon(input) {
  exactKeys(input, ["currentEndAt", "memberTerminalAt"]);
  instant(input.currentEndAt);
  instant(input.memberTerminalAt);
  return Date.parse(input.memberTerminalAt) > Date.parse(input.currentEndAt)
    ? input.memberTerminalAt : input.currentEndAt;
}

// expose the fixed local calendar for shared controller scheduling
export function adjustmentRollingLocalDateAt(value) {
  instant(value);
  return localDateAt(value);
}

// derive one strict local date without changing utc instants
function localDateAt(value) {
  return DATE_FORMATTER.format(new Date(value));
}

// advance month labels through the gregorian calendar
function nextMonth(value) {
  month(value);
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 1))
    .toISOString().slice(0, 7);
}

// advance local dates without assuming that a local day contains twenty-four hours
function addLocalDates(value, days) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

// resolve a los angeles midnight independently of daylight-saving offset changes
function localMidnightAt(localDate) {
  let guess = Date.parse(`${localDate}T08:00:00.000Z`);
  const target = Date.parse(`${localDate}T00:00:00.000Z`);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(WALL_FORMATTER.formatToParts(new Date(guess)).map(
      // retain the named wall-clock fields only
      (part) => [part.type, part.value],
    ));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1,
      Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - observed;
  }
  const result = new Date(guess).toISOString();
  if (localDateAt(result) !== localDate) {
    throw new RangeError("rolling schedule local midnight is invalid");
  }
  return result;
}

// reject unknown date-policy knobs and missing lineage fields
function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("rolling schedule fields are invalid");
  }
}

// require a canonical bounded month label
function month(value) {
  if (typeof value !== "string" || !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw new TypeError("rolling schedule month is invalid");
  }
}

// preserve the exact utc clock framing used by server receipts
function instant(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("rolling schedule instant is invalid");
  }
}

// require the actual epoch witness or schedule identity hash
function hash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("rolling schedule hash is invalid");
  }
}
