import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type ForecastAdjustmentMaintenanceMode = "--daily" | "--monthly";

export interface ForecastAdjustmentMaintenanceProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ForecastAdjustmentMaintenanceDependencies {
  readonly execute?: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<ForecastAdjustmentMaintenanceProcessResult>;
  readonly homeDirectory?: string;
}

// parse one fixed installed maintenance mode
export function parseForecastAdjustmentMaintenanceArguments(
  arguments_: readonly string[],
): ForecastAdjustmentMaintenanceMode {
  // reject paths, combined modes and caller controls
  if (
    arguments_.length !== 1 ||
    (arguments_[0] !== "--daily" && arguments_[0] !== "--monthly")
  ) {
    throw new Error("forecast-adjustment maintenance requires exactly --daily or --monthly");
  }

  return arguments_[0];
}

// launch only the immutable installed controller path
export async function runForecastAdjustmentMaintenanceCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: ForecastAdjustmentMaintenanceDependencies = {},
): Promise<0> {
  const mode = parseForecastAdjustmentMaintenanceArguments(arguments_);
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const executable = join(homeDirectory, "n", "bin", "node");
  const controller = join(
    homeDirectory,
    ".weather",
    "adjustment-maintenance",
    "runner",
    "current",
    "scripts",
    "research",
    "adjustment_maintenance_controller.mjs",
  );
  const execute = dependencies.execute ?? executeMaintenanceController;
  const result = await execute(executable, [controller, mode]);

  // accept only an ordinary successful exit
  if (result.code !== 0 || result.signal !== null) {
    throw new Error("forecast-adjustment maintenance controller failed");
  }

  return 0;
}

// execute one child without a shell or inherited control arguments
async function executeMaintenanceController(
  executable: string,
  arguments_: readonly string[],
): Promise<ForecastAdjustmentMaintenanceProcessResult> {
  return await new Promise(
    // settle from one exact child lifecycle
    (resolvePromise, rejectPromise) => {
      const child = spawn(executable, arguments_, {
        shell: false,
        stdio: "inherit",
      });
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    },
  );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

// run the fixed maintenance wrapper
async function main(): Promise<void> {
  try {
    await runForecastAdjustmentMaintenanceCli();
  } catch {
    process.stderr.write("forecast-adjustment maintenance failed\n");
    process.exitCode = 1;
  }
}

// execute only as the maintenance command
if (isEntrypoint) {
  void main();
}
