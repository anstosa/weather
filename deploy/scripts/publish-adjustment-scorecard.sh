#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# accept exactly one local sanitized scorecard
if (($# != 1)); then
  die "usage: publish-adjustment-scorecard.sh SCORECARD.json"
fi
scorecard=$1
require_file "$scorecard"
[[ ! -L "$scorecard" ]] || die "scorecard input must not be linked"
require_command node
require_file "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs"
require_file "$deploy_dir/scripts/ssh-run.sh"

# capture, validate, and transport one immutable bounded byte sequence
node --input-type=module - \
  "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs" \
  "$deploy_dir/scripts/ssh-run.sh" "$scorecard" <<'NODE'
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const [, , contractPath, sshRunPath, scorecardPath] = process.argv;
const {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
  FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION,
  parseForecastAdjustmentScorecard,
} = await import(pathToFileURL(contractPath));
const handle = await open(scorecardPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let content;

try {
  const before = await handle.stat({ bigint: true });

  // reject links, special files, and oversize input before allocation or read
  if (!before.isFile() ||
    before.size > BigInt(FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES)) {
    throw new Error("forecast adjustment scorecard is not a bounded regular file");
  }

  content = Buffer.alloc(Number(before.size));
  let offset = 0;

  // read only the size proven through the no-follow handle
  while (offset < content.length) {
    const { bytesRead } = await handle.read(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  const probe = Buffer.alloc(1);
  const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
  const after = await handle.stat({ bigint: true });

  // reject mutation during capture
  if (offset !== content.length || extraBytes !== 0 ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs) {
    throw new Error("forecast adjustment scorecard changed while reading");
  }
} finally {
  await handle.close();
}

const scorecard = parseForecastAdjustmentScorecard(content, { now: new Date().toISOString() });
const scorecardSha256 = createHash("sha256").update(content).digest("hex");
const installOperation = scorecard.contractVersion === FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION
  ? "install-adjustment-scorecard-v2"
  : "install-adjustment-scorecard";
const publisher = spawn(
  sshRunPath,
  [installOperation, scorecardSha256],
  { stdio: ["pipe", "inherit", "inherit"] },
);

// transport the exact captured buffer once
await new Promise((resolvePublish, rejectPublish) => {
  publisher.once("error", rejectPublish);
  publisher.stdin.once("error", rejectPublish);
  publisher.once("close", (code, signal) => {
    if (code !== 0) {
      rejectPublish(new Error(
        signal === null
          ? `scorecard publisher exited with status ${String(code)}`
          : `scorecard publisher exited from signal ${signal}`,
      ));
      return;
    }
    resolvePublish();
  });
  publisher.stdin.end(content);
});
NODE
