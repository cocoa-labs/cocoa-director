import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { Agent, type Dispatcher } from "undici";

/**
 * Server-Side Request Forgery (SSRF) egress controls for all remote assets,
 * including URLs returned by providers and URLs recovered from saved projects.
 */

/** Thrown when a URL is refused by the SSRF egress controls. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// Private / internal / link-local ranges an untrusted fetch must never reach.
// Notably 169.254.0.0/16 covers the cloud metadata endpoint (169.254.169.254).
const blockedRanges = new BlockList();
blockedRanges.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network (incl. 0.0.0.0)
blockedRanges.addSubnet("100.64.0.0", 10, "ipv4"); // shared carrier space
blockedRanges.addSubnet("224.0.0.0", 3, "ipv4"); // multicast and reserved
blockedRanges.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
blockedRanges.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blockedRanges.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (cloud metadata)
blockedRanges.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
blockedRanges.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
blockedRanges.addAddress("::1", "ipv6"); // loopback
blockedRanges.addAddress("::", "ipv6"); // unspecified
blockedRanges.addSubnet("ff00::", 8, "ipv6"); // multicast
blockedRanges.addSubnet("fc00::", 7, "ipv6"); // unique local addresses (ULA)
blockedRanges.addSubnet("fe80::", 10, "ipv6"); // link-local

// IPv4-mapped IPv6 in dotted form, e.g. ::ffff:169.254.169.254 — normalize to the
// embedded IPv4 so it is checked against the IPv4 ranges above.
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * True if `ip` (a numeric IPv4/IPv6 literal) is in a private, loopback,
 * link-local, or otherwise internal range. Fails closed: anything that is not a
 * parseable public IP literal is treated as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const mapped = IPV4_MAPPED.exec(ip);
  const candidate = mapped ? mapped[1] : ip;
  const family = isIP(candidate);
  if (family === 0) return true; // not a valid IP literal — refuse
  return blockedRanges.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Parse and validate an untrusted URL for server-side fetching. Requires an
 * absolute http(s) URL and verifies the host does not resolve to an internal
 * address. The hostname is resolved via DNS (getaddrinfo) and EVERY returned
 * address is checked, so a public hostname that resolves to a private IP — the
 * classic DNS-based SSRF bypass — is rejected. Returns the parsed URL or throws
 * {@link SsrfError}.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported URL scheme: ${url.protocol}`);
  }

  if (url.username || url.password) throw new SsrfError("URL credentials are not allowed.");

  // URL hostnames keep the brackets on IPv6 literals (e.g. http://[::1]/ ->
  // "[::1]"); strip them so isIP / DNS see a bare address.
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new SsrfError(`Refusing to fetch internal address: ${host}`);
    }
    return url;
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  if (records.length === 0) {
    throw new SsrfError(`Host did not resolve: ${host}`);
  }
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`Host ${host} resolves to internal address ${address}`);
    }
  }
  return url;
}

/**
 * DNS lookup used by undici's dispatcher ({@link ssrfAgent}) so the SSRF check is
 * authoritative for the socket undici actually opens. It resolves the hostname AND
 * validates every candidate address with {@link isBlockedAddress} in the same place
 * undici then connects, closing the time-of-check/time-of-use (DNS-rebinding) window
 * a separate pre-resolution leaves open: an attacker's DNS can return a public IP to
 * a prior {@link assertPublicUrl} check and a private one (e.g. 169.254.169.254) at
 * connect time. The IP is pinned via this lookup — NOT by rewriting the URL to the
 * IP — so TLS still validates the certificate against the original hostname (SNI).
 */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  // Resolve every address (all:true) so we can refuse when ANY is internal — the
  // same fail-closed rule as assertPublicUrl — then answer in the caller's shape:
  // all:true => the address array; all:false => a single address + family.
  lookup(hostname, { all: true, family: options.family, hints: options.hints })
    .then((records) => {
      for (const { address } of records) {
        if (isBlockedAddress(address)) {
          callback(new SsrfError(`Host ${hostname} resolves to internal address ${address}`), []);
          return;
        }
      }
      if (records.length === 0) {
        callback(new SsrfError(`Host did not resolve: ${hostname}`), []);
        return;
      }
      if (options.all) {
        callback(null, records);
      } else {
        callback(null, records[0].address, records[0].family);
      }
    })
    .catch((error: unknown) => {
      callback(
        error instanceof Error ? (error as NodeJS.ErrnoException) : new SsrfError(`Could not resolve host: ${hostname}`),
        [],
      );
    });
};

/**
 * undici dispatcher whose connector resolves and validates the destination IP via
 * {@link ssrfSafeLookup} at connect time. Passed as the `dispatcher` option to
 * fetch in {@link fetchGuarded} so a host that passed {@link assertPublicUrl} cannot
 * rebind to an internal address before the socket opens.
 */
const ssrfAgent = new Agent({ connect: { lookup: ssrfSafeLookup } });

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface GuardedFetchOptions {
  /** Maximum redirect hops to follow. */
  maxRedirects?: number;
  /** Wall-clock timeout (ms) covering connect + redirects + body download. */
  timeoutMs?: number;
  /** Maximum response body size (bytes). */
  maxBytes?: number;
}

/**
 * A fetch failure caused by ssrfAgent's connector refusing a blocked/rebound IP
 * surfaces as a TypeError whose `cause` is our SsrfError; unwrap it so callers see
 * the SsrfError directly. Anything else (genuine network/timeout errors) passes
 * through unchanged. (A timeout aborts with an SsrfError reason, handled by the
 * first branch.)
 */
function asSsrfError(error: unknown): unknown {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (current instanceof SsrfError) return current;
    current = current.cause;
  }
  return error;
}

/**
 * Fetch an untrusted URL with SSRF egress controls:
 *  - the host is re-validated on EVERY redirect hop (a public URL cannot 302 to
 *    e.g. http://169.254.169.254/...), with redirects followed manually,
 *  - a wall-clock timeout bounds the whole operation, and
 *  - the response body is capped at `maxBytes`.
 *
 * Returns a fully-buffered Response (body already read within the timeout window).
 */
export async function fetchGuarded(
  rawUrl: string,
  { maxRedirects = 5, timeoutMs = 30_000, maxBytes = 100 * 1024 * 1024 }: GuardedFetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SsrfError(`Timed out fetching ${rawUrl}`)), timeoutMs);
  try {
    let currentUrl = rawUrl;
    for (let hop = 0; ; hop += 1) {
      if (hop > maxRedirects) {
        throw new SsrfError(`Too many redirects while fetching ${rawUrl}`);
      }
      // Fast pre-check (scheme + DNS + IP) immediately before each request, including
      // hops. ssrfAgent below makes the IP the socket actually connects to
      // authoritative, closing the DNS-rebinding window between this check and connect.
      await Promise.race([
        assertPublicUrl(currentUrl),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      ]);
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
          cache: "no-store",
          // Node forwards `dispatcher` to undici; the DOM RequestInit type omits it.
          dispatcher: ssrfAgent,
        } as RequestInit & { dispatcher: Dispatcher });
      } catch (error) {
        // When ssrfAgent's connector refuses a rebound/blocked IP, fetch rejects with
        // a TypeError whose `cause` is our SsrfError — surface it as the SsrfError
        // callers (and the import route's 400 handling) expect.
        throw asSsrfError(error);
      }
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get("location");
        if (location) {
          await response.body?.cancel();
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
      }
      return await bufferResponse(response, maxBytes);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body into memory, refusing anything larger than `maxBytes`. */
async function bufferResponse(response: Response, maxBytes: number): Promise<Response> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new SsrfError(`Response exceeds ${maxBytes}-byte limit`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new SsrfError(`Response exceeds ${maxBytes}-byte limit`);
    }
    return rebuild(response, bytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SsrfError(`Response exceeds ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return rebuild(response, merged);
}

function rebuild(response: Response, body: Uint8Array<ArrayBuffer>): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(body.byteLength));
  return new Response([204, 205, 304].includes(response.status) ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
