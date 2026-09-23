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
  ["01-sunny.svg", "1538a8f66e35466b9a0dca63002aa0fa8763b0adf5a26afbc46c14867f2aaceb"],
  ["02-sunny-wind.svg", "f19e34d8735007aa83c83fa43c07eb0a65e99d619ba72e70365a3ccecb5da82a"],
  ["03-partly-cloudy.svg", "1e71c885a93614c0f25f3aec2346fd4aa068a19e774f20c93f07a1540dad8246"],
  ["04-partly-cloudy-wind.svg", "639b7ae22c22b8bc6c2dc6c488fe384a2ae0d2881a9b0ede16c9d74fadfcbc1e"],
  ["05-cloudy.svg", "2506ec126175ceb8a4894a32984e9fc9a6b87d0ceb5f26881e79475a77e8a79e"],
  ["06-cloudy-wind.svg", "66a9619e673a0a809d51126ceaf67528c58cdf7249da199da3709cedc58229c8"],
  ["07-light-rain.svg", "7a9928bddb2a0387846cd071e428ba88619229620097e3231f9bb17a687a6ab4"],
  ["08-light-rain-wind.svg", "010b7c1875c4b40294304cd2fafda741629e4a81478a7397e93552355628c38a"],
  ["09-heavy-rain.svg", "f30d590dd6cd8f9063196dda88d533c79090af72efbfc86608081a88b221b097"],
  ["10-heavy-rain-wind.svg", "381070d394f026a506b3f7c9394e69965d0c155ffb1980e73f53148240782f90"],
  ["12-unavailable.svg", "01f4fb0efd030f4e02b3b3e1addabcaf65e1541b2b8b2831811f25b3fc57d49c"],
  ["13-clear-night.svg", "25209cc97769833d3c23e8859c8d3e6676e5ea905f2d4a45e25deae90e02b96e"],
  ["14-clear-night-wind.svg", "5b924f11a5f72e16688257611a814b6e02b6b3c0c0f7d14468afa4cc959905b4"],
  ["15-partly-cloudy-night.svg", "a50cd55c2d3f972fd38cffbcca7310a9db089cbf8b6c0a94008b3e679dce0052"],
  ["16-partly-cloudy-night-wind.svg", "c1aa525396fbd69881804964665f209a6198528e9a98e96f3f6d6071e33e3661"],
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

  // verify every response against the approved high-contrast handoff
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
