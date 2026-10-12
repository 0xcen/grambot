import { afterEach, describe, expect, it, vi } from "vitest";
import { constantTimeEqual, envInt, isListed, parseAllowlist, sha256Hex } from "../src/util";

describe("envInt", () => {
  it.each([
    ["5", 5],
    ["4000", 4000],
    [" 12 ", 12],
    ["12\n", 12],
    ["007", 7],
  ])("parses %j as %i", (raw, expected) => {
    expect(envInt(raw, 99)).toBe(expected);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["padded zero", "000"],
    ["negative", "-1"],
    ["explicit plus", "+5"],
    ["decimal", "1.5"],
    ["exponent", "1e3"],
    ["hex", "0x10"],
    ["trailing junk", "5abc"],
    ["inner space", "1 000"],
    ["full-width digit", "５"],
  ])("falls back on %s (%j)", (_, raw) => {
    expect(envInt(raw, 99)).toBe(99);
  });
});

describe("parseAllowlist", () => {
  it("parses one id", () => {
    expect(parseAllowlist("111")).toEqual(new Set(["111"]));
  });

  it("trims entries and keeps negative group ids", () => {
    expect(parseAllowlist(" 111 , -100123 ,222")).toEqual(new Set(["111", "-100123", "222"]));
  });

  it("collapses duplicates", () => {
    expect(parseAllowlist("111,111")).toEqual(new Set(["111"]));
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "  "],
    ["empty entry", "111,,222"],
    ["trailing comma", "111,"],
    ["leading comma", ",111"],
    ["non-numeric entry", "111,abc"],
    ["username", "@someone"],
    ["explicit plus", "+111"],
    ["double minus", "--1"],
    ["decimal", "1.5"],
    ["semicolon separator", "111;222"],
    ["space separator", "111 222"],
  ])("rejects the whole list when %s (%j)", (_, raw) => {
    expect(parseAllowlist(raw)).toBeNull();
  });
});

describe("isListed", () => {
  const allowlist = new Set(["111", "-100123"]);

  it.each([111, "111", " 111 ", "111\n", -100123, "-100123"])("matches %j", (id) => {
    expect(isListed(allowlist, id)).toBe(true);
  });

  it.each([222, "222", "1111", "11", 0, Number.NaN, -111])("does not match %j", (id) => {
    expect(isListed(allowlist, id)).toBe(false);
  });

  it.each([undefined, null, true, 111n, { id: 111 }, [111]])("rejects non-string, non-number %s", (id) => {
    expect(isListed(allowlist, id)).toBe(false);
  });

  it("matches nothing against an empty allowlist", () => {
    expect(isListed(new Set(), 111)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches the standard SHA-256 test vectors", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the UTF-8 bytes of non-ASCII input", async () => {
    const hex = await sha256Hex("héllo 👋");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).not.toBe(await sha256Hex("hello 👋"));
  });
});

describe("constantTimeEqual", () => {
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: unknown };

  afterEach(() => {
    delete subtle.timingSafeEqual;
  });

  it.each([
    ["identical", "s3cret", "s3cret"],
    ["both empty", "", ""],
    ["unicode", "clé-🔑", "clé-🔑"],
  ])("is true for %s strings", async (_, a, b) => {
    expect(await constantTimeEqual(a, b)).toBe(true);
  });

  it.each([
    ["one character off", "s3cret", "s3creT"],
    ["case differs", "Secret", "secret"],
    ["prefix", "s3cret", "s3cre"],
    ["extra trailing space", "s3cret", "s3cret "],
    ["empty vs non-empty", "", "s3cret"],
    ["different unicode normalization", "caf\u00e9", "cafe\u0301"],
  ])("is false for %s", async (_, a, b) => {
    expect(await constantTimeEqual(a, b)).toBe(false);
    expect(await constantTimeEqual(b, a)).toBe(false);
  });

  it("uses crypto.subtle.timingSafeEqual on equal-length digests when the runtime has it", async () => {
    const timingSafeEqual = vi.fn((a: ArrayBuffer, b: ArrayBuffer) => {
      const va = new Uint8Array(a);
      const vb = new Uint8Array(b);
      return va.length === vb.length && va.every((byte, i) => byte === vb[i]);
    });
    subtle.timingSafeEqual = timingSafeEqual;

    expect(await constantTimeEqual("short", "a much longer secret")).toBe(false);
    expect(await constantTimeEqual("same", "same")).toBe(true);

    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const [a, b] of timingSafeEqual.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it("returns whatever timingSafeEqual decides", async () => {
    subtle.timingSafeEqual = vi.fn(() => false);
    expect(await constantTimeEqual("same", "same")).toBe(false);
  });
});
