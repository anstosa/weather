import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// retain provider usage across web process restarts
export class XweatherUsageBudget {
  #dailyLimit;
  #monthlyLimit;
  #now;
  #path;
  #state;

  // configure one persistent calendar budget
  constructor({ dailyLimit, monthlyLimit, path = null, now = Date.now }) {
    // reject unsafe budget construction
    if (
      !Number.isSafeInteger(dailyLimit) ||
      dailyLimit < 1 ||
      !Number.isSafeInteger(monthlyLimit) ||
      monthlyLimit < dailyLimit ||
      (path !== null && (typeof path !== "string" || path.length < 1)) ||
      typeof now !== "function"
    ) {
      throw new TypeError("invalid Xweather usage budget configuration");
    }

    this.#dailyLimit = dailyLimit;
    this.#monthlyLimit = monthlyLimit;
    this.#now = now;
    this.#path = path;
    this.#state = this.#load();
  }

  // reserve units before one provider request
  reserve(units) {
    // require one exact positive unit count
    if (!Number.isSafeInteger(units) || units < 1) {
      throw new TypeError("Xweather map units must be a positive integer");
    }

    this.#rollCalendarWindows();

    // stop before crossing either provider budget
    if (
      this.#state.dayUnits + units > this.#dailyLimit ||
      this.#state.monthUnits + units > this.#monthlyLimit
    ) {
      const error = new Error("Xweather map-unit budget exhausted");
      error.code = "xweather_budget_exhausted";
      throw error;
    }

    const prior = this.#state;
    this.#state = {
      ...prior,
      dayUnits: prior.dayUnits + units,
      monthUnits: prior.monthUnits + units,
    };

    try {
      this.#persist();
    } catch (cause) {
      this.#state = prior;
      const error = new Error("Xweather usage budget could not be persisted", { cause });
      error.code = "xweather_budget_unavailable";
      throw error;
    }
  }

  // expose one redacted usage snapshot
  snapshot() {
    this.#rollCalendarWindows();
    return {
      day: this.#state.day,
      dailyLimit: this.#dailyLimit,
      dayUnits: this.#state.dayUnits,
      month: this.#state.month,
      monthlyLimit: this.#monthlyLimit,
      monthUnits: this.#state.monthUnits,
    };
  }

  // load one exact persisted counter
  #load() {
    const current = this.#calendar();

    // start empty when persistence is optional or absent
    if (this.#path === null) {
      return { ...current, dayUnits: 0, monthUnits: 0 };
    }

    let raw;

    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      // accept only a missing first-run ledger
      if (error?.code === "ENOENT") {
        return { ...current, dayUnits: 0, monthUnits: 0 };
      }

      throw error;
    }

    const parsed = JSON.parse(raw);

    // fail closed on a corrupt persisted ledger
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.day) ||
      !/^\d{4}-\d{2}$/u.test(parsed.month) ||
      !Number.isSafeInteger(parsed.dayUnits) ||
      parsed.dayUnits < 0 ||
      !Number.isSafeInteger(parsed.monthUnits) ||
      parsed.monthUnits < 0
    ) {
      throw new TypeError("invalid persisted Xweather usage budget");
    }

    return {
      day: parsed.day,
      dayUnits: parsed.dayUnits,
      month: parsed.month,
      monthUnits: parsed.monthUnits,
    };
  }

  // reset elapsed UTC calendar windows
  #rollCalendarWindows() {
    const current = this.#calendar();
    let next = this.#state;

    // reset both counters in a new month
    if (current.month !== next.month) {
      next = { ...current, dayUnits: 0, monthUnits: 0 };
    } else if (current.day !== next.day) {
      // reset only the daily counter
      next = { ...next, day: current.day, dayUnits: 0 };
    }

    // persist only a changed calendar boundary
    if (next !== this.#state) {
      const prior = this.#state;
      this.#state = next;

      try {
        this.#persist();
      } catch (cause) {
        this.#state = prior;
        throw new Error("Xweather usage budget could not be persisted", { cause });
      }
    }
  }

  // derive UTC budget identities
  #calendar() {
    const instant = new Date(this.#now()).toISOString();
    return { day: instant.slice(0, 10), month: instant.slice(0, 7) };
  }

  // replace one ledger atomically
  #persist() {
    // keep development callers memory-only
    if (this.#path === null) {
      return;
    }

    const directory = dirname(this.#path);
    const temporary = `${this.#path}.${String(process.pid)}.tmp`;
    mkdirSync(directory, { mode: 0o750, recursive: true });
    writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, { flag: "w", mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
