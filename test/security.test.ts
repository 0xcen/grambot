import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compareSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util")>();
  compareSpy.mockImplementation(actual.constantTimeEqual);
  return { ...actual, constantTimeEqual: compareSpy };
});

const { default: worker } = await import("../src/index");
const { constantTimeEqual, parseAllowlist } = await vi.importActual<typeof import("../src/util")>(
  "../src/util",
);

const env = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key",
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

beforeEach(() => {
  compareSpy.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("secret comparisons go through constantTimeEqual", () => {
  it("checks the Telegram webhook secret with constantTimeEqual", async () => {
    const req = new Request("https://w.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "guess" },
      body: "{}",
    });
    expect((await worker.fetch(req, env, ctx)).status).toBe(401);
    expect(compareSpy).toHaveBeenCalledWith("guess", "tg-secret");
  });

  it("checks the MCP bearer token with constantTimeEqual", async () => {
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer guess" },
      body: "{}",
    });
    expect((await worker.fetch(req, env, ctx)).status).toBe(401);
    expect(compareSpy).toHaveBeenCalledWith("guess", "mcp-token");
  });
});

describe("constantTimeEqual", () => {
  it.each([
    ["same", "same", true],
    ["", "", true],
    ["Bearer abc", "Bearer abc", true],
    ["kéy🔑", "kéy🔑", true],
    ["secret", "secreT", false],
    ["secret", "secret-but-longer", false],
    ["", "x", false],
    ["abc", "", false],
  ])("constantTimeEqual(%j, %j) is %s", async (a, b, expected) => {
    expect(await constantTimeEqual(a, b)).toBe(expected);
  });

  it("hashes both inputs even when lengths differ, so there is no early length exit", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    await constantTimeEqual("a", "a much longer candidate value");
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("uses crypto.subtle.timingSafeEqual on equal-length digests when the runtime has it", async () => {
    const timingSafeEqual = vi.fn((a: ArrayBuffer, b: ArrayBuffer) => {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
      return true;
    });
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: timingSafeEqual,
      configurable: true,
    });
    try {
      expect(await constantTimeEqual("short", "a different length")).toBe(true);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    } finally {
      delete (crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });
});

describe("parseAllowlist", () => {
  it("parses numeric ids, including negative group ids, and trims spaces", () => {
    expect(parseAllowlist("111, 222,-1003")).toEqual(new Set(["111", "222", "-1003"]));
  });

  it.each([undefined, "", " ", ",", "111,", "abc", "111,abc", "1.5"])(
    "rejects %j",
    (raw) => {
      expect(parseAllowlist(raw)).toBeNull();
    },
  );
});
