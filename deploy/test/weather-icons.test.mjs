import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const weatherIcons = new Map([
  ["01-sunny.svg", "0b37c600bc58d1b7e05dcfaca1c7f5039ceddf333d9b7ecc714a79cf0ec8bbcf"],
  ["02-sunny-wind.svg", "713c0ec46a91347f0b61b0f69eccf855c4655ce70ebec06d1a292ec4b23a590f"],
  ["03-partly-cloudy.svg", "8aebc0b7c3c811d62ef50418f648a060407e216748103ef8c8620a5db4c80649"],
  ["04-partly-cloudy-wind.svg", "ba520680ea49ae4bb47db325cde1e0a5996c21ae12d7749f1f3d06562b9ce626"],
  ["05-cloudy.svg", "94b324b582625e22c06172c2ee62349b3873dd0db0d9db06c50c40091201bde1"],
  ["06-cloudy-wind.svg", "987f63d815f0b3d1cedc57a5efd44f0a41e334845bcd135be36daee07cafe756"],
  ["07-light-rain.svg", "46a2f9d6629b5722691c5b2aef588768ff30bfd7cc1eaffaa6f7d946a379e986"],
  ["08-light-rain-wind.svg", "ca5691e47f040c72738995a2ff90743ed836b3bf5e856fb1adc796db15340da4"],
  ["09-heavy-rain.svg", "9a994a9d250a92d83754fc99f4a22b3e183871d6da6cac6f08b21d4e702152b2"],
  ["10-heavy-rain-wind.svg", "24acd44b11d1f683b7b75f3792adf15f2b59899b86300a5f475f2d81cc70a17c"],
  ["12-unavailable.svg", "14a4bd0bf38b89946291a658d0a27ce437cfcfdd3e59a6959cf5b5d9946d1146"],
  ["13-clear-night.svg", "91b1718427ca04bcdd28e3f926db115ed9305c246a9c7174c0fea1393f237419"],
  ["14-clear-night-wind.svg", "d378bc8974b2d997012ee313d963be9fd5ef8ab00bec811aa7542ece76a4e4e0"],
  ["15-partly-cloudy-night.svg", "ad2b5c8621c8e38da29259bb445df9a52cac950ab7a2e9e37bc133a508f90a78"],
  ["16-partly-cloudy-night-wind.svg", "4082ac532e74ee5574d7f9419430c251def7e9a4155b0d2ad26f6dcfca3c068e"],
]);

// identify one exact approved asset
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// reserve one disposable loopback port
async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();

  // require a tcp listener address
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a tcp port");
  }

  listener.close();
  await once(listener, "close");
  return address.port;
}

// wait for the disposable edge process
async function waitForServer(url, diagnostics) {
  // retry only the bounded local startup
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);

      // accept the first completed response
      if (response.status > 0) {
        return;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  throw new Error(`server did not start: ${url}\n${diagnostics.join("")}`);
}

// prove each approved master is served through the closed static boundary
test("web edge serves only the approved homepage weather SVGs", async (t) => {
  const port = await reservePort();
  const diagnostics = [];
  const edge = spawn(process.execPath, [join(repoRoot, "deploy/scripts/web-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      WEATHER_API_ORIGIN: "http://127.0.0.1:1",
      WEATHER_RELEASE: "development",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(edge, "exit");
  edge.stderr.on(
    "data",
    // retain startup diagnostics for actionable failures
    (chunk) => diagnostics.push(String(chunk)),
  );
  t.after(async () => {
    // stop only the disposable edge process
    if (edge.exitCode === null) {
      edge.kill("SIGTERM");
    }

    await exited;
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(`${origin}/weather-icons/01-sunny.svg`, diagnostics);

  // verify every response against the unchanged mobile master
  for (const [name, approvedSha256] of weatherIcons) {
    const published = await readFile(join(repoRoot, "apps/web/public/weather-icons", name));
    const response = await fetch(`${origin}/weather-icons/${name}`);
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(sha256(published), approvedSha256, `${name} must preserve the approved SVG bytes`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), "image/svg+xml", name);
    assert.equal(response.headers.get("cache-control"), "no-cache", name);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", name);
    assert.deepEqual(body, published, name);
  }

  const sunnyMaster = await readFile(
    join(repoRoot, "apps/web/public/weather-icons/01-sunny.svg"),
  );
  const head = await fetch(`${origin}/weather-icons/01-sunny.svg`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "image/svg+xml");
  assert.equal(head.headers.get("content-length"), String(sunnyMaster.byteLength));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const rejectedPaths = [
    "/weather-icons",
    "/weather-icons/",
    "/weather-icons/01-sunny.svg.bak",
    "/weather-icons/11-bedtime.svg",
    "/weather-icons/README.md",
    "/weather-icons/nested/01-sunny.svg",
  ];

  // reject directories, near-matches, excluded states, and documentation
  for (const path of rejectedPaths) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
  }

  const mutation = await fetch(`${origin}/weather-icons/01-sunny.svg`, { method: "POST" });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET, HEAD");
});

// keep offline availability aligned with the exact public allowlist
test("service worker precaches the approved weather SVG allowlist", async () => {
  const serviceWorker = await readFile(
    join(repoRoot, "apps/web/public/service-worker.js"),
    "utf8",
  );

  // require each approved path exactly once
  for (const name of weatherIcons.keys()) {
    const path = `"/weather-icons/${name}"`;
    assert.equal(serviceWorker.split(path).length - 1, 1, name);
  }

  assert.doesNotMatch(serviceWorker, /weather-icons\/11-bedtime\.svg/u);
});
