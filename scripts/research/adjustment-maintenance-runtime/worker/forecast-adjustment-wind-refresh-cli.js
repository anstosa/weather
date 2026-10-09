import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ADJUSTMENT_ARCHIVE_WIND_FIT_MAXIMUM_MEMBERS, canonicalJsonBytes, fitWindMaintenanceDevelopment, } from "@weather/forecast-adjustment";
const INPUT_PATH = "/input/data/wind.json";
const OUTPUT_PATH = "/output/wind.json";
const INPUT_MAX_BYTES = 512 * 1_024 * 1_024;
const OUTPUT_MAX_BYTES = 8 * 1_024 * 1_024;
const LEGACY_WIND_OPENED_MEMBER_MAXIMUM = 65_536;
// accept only the fixed credential-isolated fitter entry
export function parseWindRefreshArguments(arguments_) {
    // no caller path, confirmation or source override is permitted
    if (arguments_.length !== 1 || arguments_[0] !== "--fit-only") {
        throw new RangeError("wind refresh requires exactly --fit-only");
    }
}
// reject additional search or qualification knobs before numerical work
export function parseWindRefreshInput(value) {
    const keys = ["contractVersion", "manifest", "rows", "snapshotManifestSha256", "dueMonth", "openedMembers"];
    // require the closed same-family input contract
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== keys.sort().join() ||
        value.contractVersion !== "wind-maintenance-fit-input/v2") {
        throw new RangeError("invalid wind fit input contract");
    }
    const { contractVersion: _version, ...input } = value;
    const openedMemberMaximum = input.manifest?.contractVersion ===
        "adjustment-wind-archive-fit-manifest/v2"
        ? ADJUSTMENT_ARCHIVE_WIND_FIT_MAXIMUM_MEMBERS
        : LEGACY_WIND_OPENED_MEMBER_MAXIMUM;
    // reject unbounded arrays before the shared robust hierarchy is constructed
    if (!Array.isArray(input.rows) || input.rows.length > 4_000_000 ||
        !Array.isArray(input.openedMembers) || input.openedMembers.length > openedMemberMaximum) {
        throw new RangeError("wind fit input row ceiling exceeded");
    }
    return input;
}
// read only the fixed regular sandbox input with no symlink traversal
async function readSandboxInput() {
    const metadata = await lstat(INPUT_PATH);
    // stop file substitution and overflow before parsing
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > INPUT_MAX_BYTES) {
        throw new RangeError("invalid wind sandbox input");
    }
    const handle = await open(INPUT_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        // require the same regular identity after open
        if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size !== metadata.size) {
            throw new RangeError("wind input identity changed");
        }
        return JSON.parse(await handle.readFile("utf8"));
    }
    finally {
        await handle.close();
    }
}
// return sanitized development material without a legacy qualification receipt
export async function runWindRefreshCli(arguments_ = process.argv.slice(2), dependencies = {}) {
    parseWindRefreshArguments(arguments_);
    const input = parseWindRefreshInput(await (dependencies.readInput ?? readSandboxInput)());
    const result = await (dependencies.fit ?? fitWindMaintenanceDevelopment)(input);
    const publication = result.state === "insufficient_data"
        ? { ...result, contractVersion: "wind-maintenance-fit/v2", state: "no_candidate",
            dueMonth: input.dueMonth, confirmationOpened: false, reason: "insufficient_development_support" }
        : result;
    const bytes = Buffer.from(canonicalJsonBytes(publication));
    // never persist raw rows or a large private native result
    if (bytes.length > OUTPUT_MAX_BYTES) {
        throw new RangeError("wind candidate ceiling exceeded");
    }
    // inject a memory sink only for bounded tests
    if (dependencies.writeOutput !== undefined) {
        await dependencies.writeOutput(bytes);
    }
    else {
        const handle = await open(OUTPUT_PATH, constants.O_WRONLY | constants.O_CREAT |
            constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        process.stdout.write(bytes);
    }
    return result.state === "insufficient_data" ? 2 : 0;
}
// isolate command execution from imported numerical helpers
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
    // honest support refusal is a completed fit attempt rather than a process crash
    runWindRefreshCli().then(() => { process.exitCode = 0; }).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : "wind fit failed"}\n`);
        process.exitCode = 1;
    });
}
