import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { discoverHomeIpv4, HomeNetworkMatcher, readTraceIpv4 } from "../scripts/home-network.mjs";

const homeAddress = "203.0.113.20";
const tunnelAddress = "172.20.0.2";

// construct a request without granting trust through forwarded headers
function request(visitor = homeAddress, peer = tunnelAddress, headers = {}) {
  return { headers: { "cf-connecting-ip": visitor, ...headers }, socket: { remoteAddress: peer } };
}

// inject deterministic discovery while retaining production matching behavior
function matcher(options = {}) {
  return new HomeNetworkMatcher({
    // emulate the home router's public ipv4
    discover: async () => homeAddress,
    // emulate only the isolated cloudflared service address
    peers: async () => [tunnelAddress],
    // suppress expected discovery failures in ordinary test output
    warn: () => {},
    ...options,
  });
}

// recognize only an exact visitor address arriving through the tunnel peer
test("home matching requires both the home public ip and exact tunnel peer", async () => {
  const detector = matcher();
  assert.equal(await detector.matches(request()), true);
  assert.equal(await detector.matches(request(homeAddress, `::ffff:${tunnelAddress}`)), true);
  assert.equal(await detector.matches(request("198.51.100.80")), false);
  assert.equal(await detector.matches(request(homeAddress, "172.20.0.3")), false);
  assert.equal(await detector.matches(request(homeAddress, "127.0.0.1")), false);
  assert.equal(await detector.matches({ ...request(), socket: {} }), false);
});

// reject malformed visitor identities before invoking any discovery
test("home matching ignores spoofable chains, worker requests and ipv6 visitors", async () => {
  let lookups = 0;
  const detector = matcher({
    // make unexpected identity discovery observable
    peers: async () => { lookups += 1; return [tunnelAddress]; },
  });
  // reject ambiguous headers rather than choosing a favorable address
  for (const visitor of [undefined, null, [homeAddress], `${homeAddress}, ${homeAddress}`, "192.168.11.4, 1.1.1.1", "not-an-ip", "203.0.113.020", "2001:db8::1"]) {
    assert.equal(await detector.matches({ ...request(), headers: { "cf-connecting-ip": visitor } }), false);
  }
  assert.equal(await detector.matches({ ...request(), headers: { "x-forwarded-for": homeAddress, "x-real-ip": homeAddress } }), false);
  assert.equal(await detector.matches(request(homeAddress, tunnelAddress, { "cf-worker": "untrusted.example" })), false);
  assert.equal(await detector.matches(request(homeAddress, tunnelAddress, { "cf-connecting-ipv6": "2001:db8::1" })), false);
  assert.equal(lookups, 0);
});

// prevent a direct-origin request from triggering external ip discovery
test("untrusted origin peers never invoke public-address discovery", async () => {
  let discoveries = 0;
  const detector = matcher({
    // count external discovery attempts without making any network request
    discover: async () => { discoveries += 1; return homeAddress; },
  });
  assert.equal(await detector.matches(request(homeAddress, "127.0.0.1")), false);
  assert.equal(discoveries, 0);
});

// expire old home addresses and fail closed on refresh errors
test("home matching refreshes changing wan addresses and discards stale evidence", async () => {
  let now = 0;
  let address = homeAddress;
  let fail = false;
  let discoveries = 0;
  const detector = matcher({
    // advance the cache independently of real wall time
    now: () => now,
    // emulate router address changes and temporary discovery failure
    discover: async () => {
      discoveries += 1;
      // fail without returning the previously valid address
      if (fail) throw new Error("offline");
      return address;
    },
  });
  assert.equal(await detector.matches(request()), true);
  assert.equal(await detector.matches(request()), true);
  assert.equal(discoveries, 1);
  now = 60_000;
  address = "203.0.113.21";
  assert.equal(await detector.matches(request()), false);
  assert.equal(await detector.matches(request(address)), true);
  now = 120_000;
  fail = true;
  assert.equal(await detector.matches(request(address)), false);
  assert.equal(await detector.matches(request(address)), false);
  assert.equal(discoveries, 3);
  now = 180_000;
  fail = false;
  assert.equal(await detector.matches(request(address)), true);
});

// coalesce simultaneous home and off-network checks behind one discovery
test("concurrent visitors share one bounded home-network refresh", async () => {
  let discoveries = 0;
  const detector = matcher({
    // yield once to expose overlapping caller requests
    discover: async () => { discoveries += 1; await Promise.resolve(); return homeAddress; },
  });
  assert.deepEqual(await Promise.all([
    detector.matches(request()),
    detector.matches(request("198.51.100.80")),
    detector.matches(request()),
  ]), [true, false, true]);
  assert.equal(discoveries, 1);
});

// expose discovery outages without logging visitor addresses or repeated failures
test("discovery failures emit one sanitized diagnostic per refresh interval", async () => {
  const warnings = [];
  const detector = matcher({
    // emulate an upstream failure containing details that must not escape
    discover: async () => { throw new Error(`private diagnostic ${homeAddress}`); },
    // collect only the bounded production warning
    warn: (message) => warnings.push(message),
  });
  assert.equal(await detector.matches(request()), false);
  assert.equal(await detector.matches(request()), false);
  assert.deepEqual(warnings, ["home network discovery unavailable"]);
});

// reject failures at either discovery boundary without propagating them to weather
test("invalid address or peer discovery never grants home visibility", async () => {
  // cover incomplete and malformed tunnel dns evidence
  for (const peers of [[], null, ["not-an-ip"], ["172.20.0.3"], [tunnelAddress, null]]) {
    assert.equal(await matcher({ peers: async () => peers }).matches(request()), false);
  }
  assert.equal(await matcher({ peers: async () => { throw new Error("dns unavailable"); } }).matches(request()), false);
  // reject trace fields that cannot be an exact public ipv4 identity
  for (const address of [null, "", "not-an-ip", "2001:db8::1", `${homeAddress}, 1.1.1.1`]) {
    assert.equal(await matcher({ discover: async () => address }).matches(request()), false);
  }
});

// prevent slow or late network results from resurrecting expired trust
test("home discovery times out and a late result cannot restore access", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const detector = matcher({
    // hold peer resolution past the overall discovery deadline
    peers: () => new Promise((resolve) => { finish = resolve; }),
  });
  const pending = detector.matches(request());
  t.mock.timers.tick(2_501);
  assert.equal(await pending, false);
  finish([tunnelAddress]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await detector.matches(request()), false);
});

// model an incoming streamed https diagnostic response
function trace(body, statusCode = 200) {
  const response = Readable.from([Buffer.from(body)]);
  response.statusCode = statusCode;
  return response;
}

// retain only one bounded address field from the documented trace format
test("trace parsing rejects errors, redirects, oversized or ambiguous responses", async () => {
  assert.equal(await readTraceIpv4(trace(`fl=123\nip=${homeAddress}\ncolo=SEA\n`)), homeAddress);
  assert.equal(await readTraceIpv4(trace(`ip=${homeAddress}\r\n`)), homeAddress);
  // reject every malformed or incomplete response instead of guessing an identity
  for (const body of ["", "colo=SEA\n", "ip=bad\n", "ip=2001:db8::1\n", `ip=${homeAddress} \n`, `ip=${homeAddress}\nip=${homeAddress}\n`, `ip=${homeAddress}\n${"x".repeat(4_096)}`]) {
    await assert.rejects(readTraceIpv4(trace(body)));
  }
  await assert.rejects(readTraceIpv4(trace(`ip=${homeAddress}`, 302)));
  await assert.rejects(readTraceIpv4(trace(`ip=${homeAddress}`, 503)));
});

// freeze the discovery destination, ipv4 family and abortable transport
test("home discovery uses fixed https transport with a real abort signal", async () => {
  const discovered = await discoverHomeIpv4(
    // replace only the transport while checking its production options
    (url, options, callback) => {
      assert.equal(url, "https://www.cloudflare.com/cdn-cgi/trace");
      assert.equal(options.family, 4);
      assert.ok(options.signal instanceof AbortSignal);
      queueMicrotask(() => callback(trace(`ip=${homeAddress}\n`)));
      return new EventEmitter();
    },
  );
  assert.equal(discovered, homeAddress);
  await assert.rejects(discoverHomeIpv4(
    // propagate a failed transport without manufacturing a response
    () => {
      const outgoing = new EventEmitter();
      queueMicrotask(() => outgoing.emit("error", new Error("offline")));
      return outgoing;
    },
  ));
});
