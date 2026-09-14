import { lookup } from "node:dns/promises";
import { get } from "node:https";
import { isIPv4 } from "node:net";

const discoveryUrl = "https://www.cloudflare.com/cdn-cgi/trace";
const maximumTraceBytes = 4_096;
const refreshIntervalMs = 60_000;
const discoveryDeadlineMs = 2_500;

// compare only fresh home egress evidence behind the isolated tunnel peer
export class HomeNetworkMatcher {
  #snapshot = null;
  #pending = null;
  #retryAt = 0;
  #discover;
  #peers;
  #now;
  #warn;

  // retain injectable network boundaries without runtime authorization overrides
  constructor({ discover = discoverHomeIpv4, peers = tunnelPeers, now = Date.now, warn = console.warn } = {}) {
    this.#discover = discover;
    this.#peers = peers;
    this.#now = now;
    this.#warn = warn;
  }

  // expose display eligibility without granting an administrator identity
  async matches(request) {
    const visitor = request.headers["cf-connecting-ip"];
    const peer = normalizePeer(request.socket.remoteAddress);

    // reject spoofable forwarding chains, worker subrequests and non-ipv4 visitors
    if (typeof visitor !== "string" || !isIPv4(visitor) || peer === null ||
        request.headers["cf-worker"] !== undefined || request.headers["cf-connecting-ipv6"] !== undefined) {
      return false;
    }

    const snapshot = await this.#current(peer);
    return snapshot !== null && snapshot.expiresAt > this.#now() &&
      snapshot.peers.includes(peer) && snapshot.address === visitor;
  }

  // coalesce bounded discovery and never reuse expired or failed evidence
  async #current(peer) {
    // share an in-flight refresh across simultaneous visitors
    if (this.#pending !== null) {
      return this.#pending;
    }

    // retain successful evidence or a short failed-discovery backoff
    if (this.#now() < this.#retryAt) {
      return this.#snapshot;
    }

    this.#snapshot = null;
    this.#pending = this.#refresh(peer);
    try {
      return await this.#pending;
    } finally {
      this.#pending = null;
    }
  }

  // require both a current tunnel address and the host's observed public ipv4
  async #refresh(peer) {
    let deadline;
    try {
      this.#snapshot = await Promise.race([
        // establish the trusted ingress before making an external discovery request
        (async () => {
          const peers = await this.#peers();
          // reject incomplete or malformed peer discovery
          if (!Array.isArray(peers) || peers.length === 0 || !peers.every(isIPv4)) {
            throw new Error("home network peer discovery invalid");
          }
          // reject direct-origin header spoofing without treating it as discovery failure
          if (!peers.includes(peer)) {
            return null;
          }
          const address = await this.#discover();
          // retain only a complete valid address snapshot
          if (!isIPv4(address)) {
            throw new Error("home network address discovery invalid");
          }
          return { address, peers, expiresAt: this.#now() + refreshIntervalMs };
        })(),
        new Promise(
          // bound dns and discovery together even if either transport stalls
          (_, reject) => {
            deadline = setTimeout(() => reject(new Error("home network discovery timed out")), discoveryDeadlineMs);
          },
        ),
      ]);

      return this.#snapshot;
    } catch {
      // log once per refresh without visitor addresses or upstream error details
      this.#warn("home network discovery unavailable");
      return null;
    } finally {
      clearTimeout(deadline);
      this.#retryAt = this.#now() + refreshIntervalMs;
    }
  }
}

// normalize node's ipv4-mapped socket addresses without accepting forwarded text
function normalizePeer(address) {
  // preserve absent or non-string socket addresses as untrusted
  if (typeof address !== "string") {
    return null;
  }

  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIPv4(ipv4) ? ipv4 : null;
}

// resolve only the isolated compose service rather than arbitrary private peers
async function tunnelPeers() {
  const addresses = await lookup("cloudflared", { all: true, family: 4 });
  return addresses.map(
    // retain the exact resolved tunnel endpoints
    (entry) => entry.address,
  );
}

// discover the host's ipv4 egress without depending on a visitor-supplied address
export function discoverHomeIpv4(request = get) {
  return new Promise((resolve, reject) => {
    const outgoing = request(discoveryUrl, {
      family: 4,
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(2_000),
    },
    // bound and validate the diagnostic response before trusting its ip field
    (response) => {
      readTraceIpv4(response).then(resolve, reject);
    });
    outgoing.once("error", reject);
  });
}

// read only one small successful trace and reject ambiguous address fields
export async function readTraceIpv4(response) {
  try {
    // never follow redirects or accept diagnostic error bodies
    if (response.statusCode !== 200) {
      throw new Error("home network discovery failed");
    }

    const chunks = [];
    let bytes = 0;
    // enforce the limit while streaming instead of after buffering
    for await (const chunk of response) {
      bytes += chunk.length;
      // stop oversized bodies before retaining additional data
      if (bytes > maximumTraceBytes) {
        throw new Error("home network discovery response too large");
      }
      chunks.push(Buffer.from(chunk));
    }

    const addresses = Buffer.concat(chunks).toString("utf8").split(/\r?\n/u).filter(
      // keep only the documented egress address field
      (line) => line.startsWith("ip="),
    );
    const address = addresses[0]?.slice(3);
    // reject missing, duplicate, malformed and ipv6-only discovery
    if (addresses.length !== 1 || typeof address !== "string" || !isIPv4(address)) {
      throw new Error("home network discovery address invalid");
    }
    return address;
  } finally {
    response.destroy();
  }
}
