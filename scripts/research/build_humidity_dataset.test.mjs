import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { humidityTarget, validatePrivateResearchOutputRoot } from "./build_humidity_dataset.mjs";

// supply metric-specific station availability
function row(physicalStationKey, relativeHumidityPercent) {
  return { physicalStationKey, metrics: { temperatureC: null, relativeHumidityPercent } };
}

// missing temperature must not discard a valid humidity target
test("humidity target uses humidity availability independently", () => {
  const result = humidityTarget([
    row("tempest-64255", 80),
    row("tempest-38270", 70),
    row("tempest-126537", 90),
  ]);
  assert.equal(result.stationCount, 3);
  assert.equal(result.value, 80);
});

// missing humidity and sparse near-station support remain missing
test("humidity target preserves the canonical station gate", () => {
  assert.equal(humidityTarget([
    row("tempest-64255", null),
    row("tempest-38270", 70),
    row("tempest-126537", 90),
  ]), null);
  assert.equal(humidityTarget([
    row("tempest-203055", 80),
    row("tempest-38270", 70),
    row("tempest-126537", 90),
  ]), null);
});

// create one private disk-backed humidity output path
async function diskOutputRoot() {
  const temporary = await mkdtemp(join(tmpdir(), "humidity-root-test-"));
  const home = join(temporary, "home");
  const base = join(home, ".weather", "research-work");
  const root = join(base, "weather-moisture-research-test");
  await mkdir(root, { mode: 0o700, recursive: true });
  await chmod(join(home, ".weather"), 0o700);
  await chmod(base, 0o700);
  return { home, output: join(root, "humidity"), root, temporary };
}

// accept the exact disk-backed humidity child
test("humidity output accepts a private disk-backed research root", async () => {
  const fixture = await diskOutputRoot();
  try {
    assert.equal(await validatePrivateResearchOutputRoot(fixture.output, fixture.home), fixture.output);
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true });
  }
});

// preserve the existing tmpfs humidity child
test("humidity output accepts a private tmpfs research root", async () => {
  const root = await mkdtemp("/dev/shm/weather-moisture-research-");
  try {
    await chmod(root, 0o700);
    const output = join(root, "humidity");
    assert.equal(await validatePrivateResearchOutputRoot(output), output);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// reject prefix spoofing, traversal, symlinks and unsafe modes
test("humidity output rejects private-root boundary bypasses", async () => {
  const fixture = await diskOutputRoot();
  try {
    const outside = join(fixture.home, ".weather", "research-work-escape", "weather-moisture-research-test");
    await mkdir(outside, { mode: 0o700, recursive: true });
    const linked = join(fixture.home, ".weather", "research-work", "weather-moisture-research-linked");
    await symlink(fixture.root, linked, "dir");
    const linkedOutputTarget = join(fixture.root, "linked-humidity-target");
    await mkdir(linkedOutputTarget, { mode: 0o700 });
    await symlink(linkedOutputTarget, fixture.output, "dir");
    const candidates = [join(outside, "humidity"), join(linked, "humidity"), `${fixture.root}/unused/../humidity`, fixture.output];
    // check each disallowed output
    for (const candidate of candidates) {
      await assert.rejects(validatePrivateResearchOutputRoot(candidate, fixture.home));
    }
    await chmod(fixture.root, 0o750);
    await assert.rejects(validatePrivateResearchOutputRoot(fixture.output, fixture.home));
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true });
  }
});
