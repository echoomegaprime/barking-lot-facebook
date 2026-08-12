import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
  timingSafeEqual,
  timingSafeEqualHex,
  isAllowedImageHost,
  verifyFacebookSignature,
  verifyMessengerWebhook,
  handleMessengerWebhook,
  type Env,
} from "../src/index";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    AI: { run: vi.fn().mockResolvedValue({ response: "AI reply" }) } as unknown as Ai,
    FB_PAGE_ID: "105558179275338",
    FB_APP_ID: "1806111116775315",
    FB_PAGE_TOKEN: "test-page-token",
    FB_APP_SECRET: "test-app-secret",
    FB_VERIFY_TOKEN: "test-verify-token",
    ALLOWED_ORIGINS: "https://barkinglot.org",
    ...overrides,
  };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("timingSafeEqual / timingSafeEqualHex", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });

  it("rejects mismatched strings", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });

  it("rejects mismatched lengths without throwing", () => {
    expect(timingSafeEqual("short", "longerstring")).toBe(false);
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });

  it("rejects empty/missing inputs", () => {
    expect(timingSafeEqual("", "")).toBe(false);
    expect(timingSafeEqual("abc", "")).toBe(false);
  });
});

describe("Messenger webhook -- X-Hub-Signature-256 verification (CRITICAL fix)", () => {
  it("REGRESSION: this repo previously had NO signature check at all on POST /webhook", () => {
    // This test exists to make the regression unmistakable in a diff/review:
    // any POST to /webhook used to be processed unconditionally, letting an
    // attacker trigger a paid Workers AI call and a real Messenger send from
    // the page's own token to an arbitrary recipient id.
    expect(typeof verifyFacebookSignature).toBe("function");
  });

  it("accepts a correctly signed body", async () => {
    const env = fakeEnv();
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const sig = await hmacSha256Hex(env.FB_APP_SECRET, rawBody);
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${sig}` },
      body: rawBody,
    });
    expect(await verifyFacebookSignature(request, rawBody, env)).toBe(true);
  });

  it("rejects a missing signature header", async () => {
    const env = fakeEnv();
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const request = new Request("https://worker.example/webhook", { method: "POST", body: rawBody });
    expect(await verifyFacebookSignature(request, rawBody, env)).toBe(false);
  });

  it("rejects a forged/incorrect signature", async () => {
    const env = fakeEnv();
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
      body: rawBody,
    });
    expect(await verifyFacebookSignature(request, rawBody, env)).toBe(false);
  });

  it("rejects a signature computed over a DIFFERENT body than the one sent (tamper detection)", async () => {
    const env = fakeEnv();
    const signedBody = JSON.stringify({ object: "page", entry: [] });
    const sig = await hmacSha256Hex(env.FB_APP_SECRET, signedBody);
    const tamperedBody = JSON.stringify({ object: "page", entry: [{ messaging: [] }] });
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${sig}` },
      body: tamperedBody,
    });
    expect(await verifyFacebookSignature(request, tamperedBody, env)).toBe(false);
  });

  it("fails closed when FB_APP_SECRET is unconfigured -- never silently accepts", async () => {
    const env = fakeEnv({ FB_APP_SECRET: "" });
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const sig = await hmacSha256Hex("some-secret", rawBody);
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${sig}` },
      body: rawBody,
    });
    expect(await verifyFacebookSignature(request, rawBody, env)).toBe(false);
  });

  it("rejects a non-sha256 algorithm prefix", async () => {
    const env = fakeEnv();
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": "sha1=deadbeef" },
      body: rawBody,
    });
    expect(await verifyFacebookSignature(request, rawBody, env)).toBe(false);
  });
});

describe("handleMessengerWebhook -- end to end auth gate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a forged POST with no signature is REJECTED with 403 and never reaches the AI/send path", async () => {
    const env = fakeEnv();
    const body = JSON.stringify({
      object: "page",
      entry: [{ messaging: [{ sender: { id: "attacker-id" }, recipient: { id: env.FB_PAGE_ID }, timestamp: 0, message: { mid: "m1", text: "hi" } }] }],
    });
    const request = new Request("https://worker.example/webhook", { method: "POST", body });

    const response = await handleMessengerWebhook(request, env);

    expect(response.status).toBe(403);
    expect((env.AI.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a correctly signed POST is accepted and processed", async () => {
    const env = fakeEnv();
    const body = JSON.stringify({
      object: "page",
      entry: [{ messaging: [{ sender: { id: "real-user" }, recipient: { id: env.FB_PAGE_ID }, timestamp: 0, message: { mid: "m1", text: "hi" } }] }],
    });
    const sig = await hmacSha256Hex(env.FB_APP_SECRET, body);
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${sig}` },
      body,
    });

    const response = await handleMessengerWebhook(request, env);

    expect(response.status).toBe(200);
    expect((env.AI.run as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

describe("verifyMessengerWebhook (hub.verify_token challenge)", () => {
  it("echoes the challenge for a correct token", () => {
    const env = fakeEnv();
    const request = new Request(
      `https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=${env.FB_VERIFY_TOKEN}&hub.challenge=1234`
    );
    const response = verifyMessengerWebhook(request, env);
    expect(response.status).toBe(200);
  });

  it("rejects an incorrect token with 403", () => {
    const env = fakeEnv();
    const request = new Request(
      `https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234`
    );
    const response = verifyMessengerWebhook(request, env);
    expect(response.status).toBe(403);
  });

  it("fails closed 503 when FB_VERIFY_TOKEN is unconfigured", () => {
    const env = fakeEnv({ FB_VERIFY_TOKEN: "" });
    const request = new Request(`https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=1234`);
    const response = verifyMessengerWebhook(request, env);
    expect(response.status).toBe(503);
  });
});

describe("isAllowedImageHost -- SSRF fix on /api/image-proxy", () => {
  it("REGRESSION: this repo previously fetched ANY url the caller supplied with no host allowlist", () => {
    expect(typeof isAllowedImageHost).toBe("function");
  });

  it("allows real Facebook CDN hosts", () => {
    expect(isAllowedImageHost("https://scontent.xx.fbcdn.net/v/photo.jpg")).toBe(true);
    expect(isAllowedImageHost("https://graph.facebook.com/photo.jpg")).toBe(true);
    expect(isAllowedImageHost("https://scontent.cdninstagram.com/photo.jpg")).toBe(true);
  });

  it("rejects arbitrary external hosts (the SSRF vector)", () => {
    expect(isAllowedImageHost("https://attacker.example/steal")).toBe(false);
    expect(isAllowedImageHost("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedImageHost("https://192.168.1.49:9000/minio")).toBe(false);
  });

  it("rejects a lookalike host that merely contains the allowed domain as a substring", () => {
    expect(isAllowedImageHost("https://fbcdn.net.attacker.example/x")).toBe(false);
    expect(isAllowedImageHost("https://notfbcdn.net/x")).toBe(false);
  });

  it("rejects non-https schemes", () => {
    expect(isAllowedImageHost("http://scontent.xx.fbcdn.net/v/photo.jpg")).toBe(false);
    expect(isAllowedImageHost("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed URLs without throwing", () => {
    expect(isAllowedImageHost("not-a-url")).toBe(false);
  });
});

describe("GET /api/image-proxy -- end-to-end route enforcement (not just the pure function)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(4), { status: 200, headers: { "Content-Type": "image/jpeg" } })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SSRF: a disallowed host is rejected by the actual route with 400, and the Worker never fetches it", async () => {
    const env = fakeEnv();
    const request = new Request(
      "https://worker.example/api/image-proxy?url=" + encodeURIComponent("http://169.254.169.254/latest/meta-data/")
    );
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an allowed Facebook CDN host is proxied through the real route", async () => {
    const env = fakeEnv();
    const request = new Request(
      "https://worker.example/api/image-proxy?url=" + encodeURIComponent("https://scontent.xx.fbcdn.net/v/photo.jpg")
    );
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://scontent.xx.fbcdn.net/v/photo.jpg");
  });
});
