import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readAdjustmentInertV14SettingsSnapshot,
  selectAdjustmentInertV14RestorationSchema,
} from "../scripts/adjustment-evaluation-package.mjs";

const update = resolve(import.meta.dirname, "../scripts/update.sh");
const sourceValues = {
  WEATHER_RELEASE: "2026.10.09-1",
  WEATHER_CONTROL_PLANE_VERSION: "13",
  WEATHER_CONTROL_PLANE_SHA256: "603eb8f488ba78be3d7ecf76b0d587346d1c36432255d390d86d2b768c8fecba",
  WEATHER_SERVER_IMAGE: "ghcr.io/anstosa/weather-server@sha256:fb140b46d6eaea463ba2d10dc74303eac515135a37c21ddb746cdce744fd23ab",
  WEATHER_WEB_IMAGE: "ghcr.io/anstosa/weather-web@sha256:fdcb2d10da4c9ed5ec8651bafa96c9d2b240b66b85db85619b909d6e144e2d7b",
};

// write only the exact literal identity fields exercised by the source gate
async function writeEnvironment(path, values) {
  await writeFile(path, Object.entries(values).map(
    // retain literal environment keys and values without shell evaluation
    ([key, value]) => `${key}=${value}\n`,
  ).join(""), { mode: 0o600 });
}

// the separate inactive handoff cannot reuse either another source or the family scope
test("inactive v14 source gate pins current v13 images, controls and distinct target", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-inert-v14-source-"));
  const source = join(root, "source.env");
  const target = join(root, "target.env");
  // invoke the real closed Bash identity gate without Docker or host mutation
  const verify = () => spawnSync("bash", ["-c",
    'source "$1"; require_fixed_v14_source_identity "$2" "$3"',
    "v14-source-test", update, target, source], { encoding: "utf8" });
  try {
    await writeEnvironment(source, sourceValues);
    await writeEnvironment(target, { WEATHER_RELEASE: "2026.10.09-2", WEATHER_CONTROL_PLANE_VERSION: "14" });
    assert.equal(verify().status, 0);
    // every independently pinned predecessor field rejects drift
    for (const [key, value] of Object.entries(sourceValues)) {
      await writeEnvironment(source, { ...sourceValues, [key]: `${value}x` });
      assert.notEqual(verify().status, 0, key);
    }
    await writeEnvironment(source, sourceValues);
    await writeEnvironment(target, { WEATHER_RELEASE: "2026.10.09-1", WEATHER_CONTROL_PLANE_VERSION: "14" });
    assert.notEqual(verify().status, 0);
    await writeEnvironment(target, { WEATHER_RELEASE: "2026.10.09-2", WEATHER_CONTROL_PLANE_VERSION: "13" });
    assert.notEqual(verify().status, 0);
    const bytes = await readFile(update, "utf8");
    assert.match(bytes, /inert-v14\)/u);
    assert.match(bytes, /verify_fixed_v14_source_compatibility/u);
    assert.match(bytes, /require_literal_inert_v14_release_capacity/u);
    assert.match(bytes, /discard-failed-inert-v14-current/u);
    assert.match(bytes, /bootstrap-inert-v14-current/u);
    const bridge = bytes.split("inert_v14_release() (")[1].split("# activate one forward release")[0];
    assert.ok(bridge.indexOf("--revision-capture-epoch-init-v1") < bridge.indexOf('start_exact_release "$target"'));
    assert.ok(bridge.indexOf("--revision-capture-epoch-init-v1") > bridge.indexOf('verify_runtime_database_acl "$target"'));
    assert.match(bridge, /migration \\\n\s+node deploy\/scripts\/migrate\.mjs --atomic-maintenance-v14/u);
    assert.ok(bridge.indexOf("inert-v14-settings-snapshot") < bridge.indexOf('start_exact_release "$target"'));
    assert.ok(bridge.indexOf("verify-inert-v14-settings-snapshot") > bridge.indexOf('start_exact_release "$target"'));

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// freeze operator intent from the real descriptor without accepting alternate writers
test("inactive v14 settings snapshot binds bytes, inode, ownership and no aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-inert-v14-settings-"));
  const path = join(root, "settings.json");
  const options = { path, owners: [process.getuid()] };
  const initial = '{"version":1,"temperature":true,"wind":true,"rain":false}\n';
  try {
    await writeFile(path, initial, { mode: 0o600 });
    const before = await readAdjustmentInertV14SettingsSnapshot(options);
    assert.match(before.identity, /^[0-9]+:[0-9]+$/u);
    assert.match(before.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await readAdjustmentInertV14SettingsSnapshot(options), before);
    await assert.rejects(readAdjustmentInertV14SettingsSnapshot({ path, owners: [] }), /unsafe/u);
    await chmod(path, 0o644);
    await assert.rejects(readAdjustmentInertV14SettingsSnapshot(options), /unsafe/u);
    await chmod(path, 0o600);
    await symlink(path, join(root, "alias.json"));
    await assert.rejects(readAdjustmentInertV14SettingsSnapshot({ ...options, path: join(root, "alias.json") }));
    await link(path, join(root, "hardlink.json"));
    await assert.rejects(readAdjustmentInertV14SettingsSnapshot(options), /unsafe/u);
    await rm(join(root, "hardlink.json"));
    await writeFile(path, initial.replace('"temperature":true', '"temperature":false'));
    const changed = await readAdjustmentInertV14SettingsSnapshot(options);
    assert.equal(changed.identity, before.identity);
    assert.notEqual(changed.sha256, before.sha256);
    await writeFile(join(root, "replacement.json"), initial, { mode: 0o600 });
    await rename(join(root, "replacement.json"), path);
    const replaced = await readAdjustmentInertV14SettingsSnapshot(options);
    assert.equal(replaced.sha256, before.sha256);
    assert.notEqual(replaced.identity, before.identity);
    await writeFile(path, initial.replace('"rain":false', '"rain":false,"approval":true'));
    await assert.rejects(readAdjustmentInertV14SettingsSnapshot(options));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// compensation selects authorization only after observing the real complete ledger
test("inactive v14 restoration refuses partial history and uses source or target exactly", () => {
  const input = { actualHistorySha256: "1".repeat(64), sourceHistorySha256: "1".repeat(64),
    sourceRelease: "2026.10.09-1", targetHistorySha256: "2".repeat(64), targetRelease: "2026.10.09-2" };
  assert.equal(selectAdjustmentInertV14RestorationSchema(input), input.sourceRelease);
  assert.equal(selectAdjustmentInertV14RestorationSchema({ ...input,
    actualHistorySha256: input.targetHistorySha256 }), input.targetRelease);
  assert.throws(() => selectAdjustmentInertV14RestorationSchema({ ...input,
    actualHistorySha256: "3".repeat(64) }), /not recognized/u);
  assert.throws(() => selectAdjustmentInertV14RestorationSchema({ ...input,
    actualHistorySha256: "" }), /invalid/u);
});
