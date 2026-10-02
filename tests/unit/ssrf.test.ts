import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { put } from "@vercel/blob";
import type { LookupOptions } from "node:dns";
import * as dns from "node:dns/promises";

import { copyRemoteFileToBlob } from "@/lib/server/blob";
import {
  assertPublicUrl,
  fetchGuarded,
  isBlockedAddress,
  SsrfError,
  ssrfSafeLookup,
} from "@/lib/server/ssrf";

// SSRF guards resolve hostnames and upload via Vercel Blob; both are mocked so the
// tests exercise the egress logic deterministically without real DNS or network.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

const lookupMock = dns.lookup as unknown as Mock;
const putMock = put as unknown as Mock;
const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL) => impl(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  lookupMock.mockReset();
  putMock.mockReset();
  if (originalBlobToken === undefined) {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  } else {
    process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
  }
});

describe("isBlockedAddress", () => {
  it("blocks loopback, link-local, RFC1918, and IPv6 internal addresses", () => {
    const blocked = [
      "127.0.0.1",
      "127.5.6.7",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.0.1",
      "169.254.169.254", // cloud metadata endpoint
      "::1",
      "::",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
    ];
    for (const ip of blocked) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    const allowed = [
      "8.8.8.8",
      "93.184.216.34",
      "172.15.0.1", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "192.169.0.1", // adjacent to 192.168/16
      "1.1.1.1",
      "2606:4700:4700::1111",
    ];
    for (const ip of allowed) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects loopback IP literals", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("http://[::1]/")).rejects.toBeInstanceOf(SsrfError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects the cloud metadata endpoint", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it("rejects a hostname that resolves to loopback (localhost)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicUrl("http://localhost/")).rejects.toBeInstanceOf(SsrfError);
    expect(lookupMock).toHaveBeenCalledWith("localhost", { all: true });
  });

  it("rejects a public hostname that resolves to a private IP", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicUrl("https://evil.example.com/payload")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("ftp://example.com/file")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertPublicUrl("https://cdn.example.com/a.png");
    expect(url.hostname).toBe("cdn.example.com");
  });
});

describe("fetchGuarded", () => {
  it("blocks a redirect to a private IP and never fetches the internal target", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = stubFetch(() =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    await expect(fetchGuarded("https://cdn.example.com/file")).rejects.toBeInstanceOf(SsrfError);
    // Only the first (public) hop is fetched; the metadata host is rejected before any request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn.example.com/file");
  });

  it("returns the body for an allowed URL", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetch(() => new Response("hello", { status: 200, headers: { "content-type": "image/png" } }));

    const response = await fetchGuarded("https://cdn.example.com/a.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("hello");
  });

  it("follows an allowed redirect to a public host", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = stubFetch((url) => {
      if (url === "https://cdn.example.com/start") {
        return new Response(null, { status: 302, headers: { location: "https://files.example.com/final" } });
      }
      return new Response("final-bytes", { status: 200, headers: { "content-type": "audio/mpeg" } });
    });

    const response = await fetchGuarded("https://cdn.example.com/start");
    expect(await response.text()).toBe("final-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response whose declared content-length exceeds the cap", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetch(() => new Response("a".repeat(50), { status: 200, headers: { "content-length": "50" } }));

    await expect(fetchGuarded("https://cdn.example.com/big", { maxBytes: 10 })).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it("rejects a streamed body that exceeds the cap with no declared length", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    stubFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a".repeat(50)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    await expect(fetchGuarded("https://cdn.example.com/stream", { maxBytes: 10 })).rejects.toBeInstanceOf(
      SsrfError,
    );
  });
});

describe("copyRemoteFileToBlob SSRF wiring", () => {
  it("rejects an internal URL and never uploads when allowUntrustedHost is false", async () => {
    const fetchMock = stubFetch(() => new Response("should-not-be-fetched"));

    await expect(
      copyRemoteFileToBlob({
        url: "http://169.254.169.254/latest/meta-data/",
        pathname: "library/user/metadata.bin",
        contentType: "application/octet-stream",
        allowUntrustedHost: false,
      }),
    ).rejects.toBeInstanceOf(SsrfError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it("also guards provider URLs before downloading", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    putMock.mockResolvedValue({ url: "https://blob.test/videos/x.mp4" });
    const fetchMock = stubFetch(() =>
      new Response("video-bytes", { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const result = await copyRemoteFileToBlob({
      url: "https://provider.example.com/result.mp4",
      pathname: "videos/x.mp4",
      contentType: "video/mp4",
    });

    expect(result.url).toBe("https://blob.test/videos/x.mp4");
    expect(fetchMock).toHaveBeenCalledWith("https://provider.example.com/result.mp4", expect.objectContaining({ redirect: "manual" }));
    expect(lookupMock).toHaveBeenCalled();
  });
});

// ssrfSafeLookup is the DNS lookup undici's dispatcher uses at connect time: it
// resolves AND validates in the same place the socket is opened, so a host that
// passed assertPublicUrl cannot rebind to an internal address before connecting.
describe("ssrfSafeLookup (connect-time validation)", () => {
  function invokeLookup(hostname: string, options: LookupOptions) {
    return new Promise<{ err: unknown; address: unknown; family: unknown }>((resolve) => {
      ssrfSafeLookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it("refuses when the host resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const { err } = await invokeLookup("evil.example.com", { all: true });
    expect(err).toBeInstanceOf(SsrfError);
  });

  it("refuses if ANY resolved address is internal, even when others are public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 }, // cloud metadata endpoint mixed in
    ]);
    const { err } = await invokeLookup("mixed.example.com", { all: true });
    expect(err).toBeInstanceOf(SsrfError);
  });

  it("returns every resolved address when they are all public (all:true)", async () => {
    const records = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    lookupMock.mockResolvedValue(records);
    const { err, address } = await invokeLookup("cdn.example.com", { all: true });
    expect(err).toBeNull();
    expect(address).toEqual(records);
  });

  it("returns a single address and family when all is false", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const { err, address, family } = await invokeLookup("cdn.example.com", { all: false });
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });
});

describe("fetchGuarded DNS-rebinding protection", () => {
  it("refuses the connection when the host rebinds to a private IP between check and connect", async () => {
    // The pre-check (assertPublicUrl) sees a public IP on the 1st resolution; the
    // connect-time lookup our dispatcher runs sees the rebind to the metadata
    // address on the 2nd and must refuse the socket. Global fetch is intentionally
    // NOT stubbed here so the real undici dispatcher (and ssrfSafeLookup) execute.
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(fetchGuarded("http://rebind.test/asset")).rejects.toBeInstanceOf(SsrfError);
  });
});
