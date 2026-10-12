import { describe, expect, it } from "vitest";
import { bearerMatches } from "../src/auth";

function req(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return new Request("https://w.example/mcp", { method: "POST", headers });
}

describe("bearerMatches", () => {
  it.each([undefined, ""])("rejects every request when the expected token is %j", async (expected) => {
    expect(await bearerMatches(req("Bearer "), expected)).toBe(false);
    expect(await bearerMatches(req(), expected)).toBe(false);
    expect(await bearerMatches(req(""), expected)).toBe(false);
  });

  it("accepts the exact token", async () => {
    expect(await bearerMatches(req("Bearer mcp-token"), "mcp-token")).toBe(true);
  });

  it.each([
    ["lowercase scheme", "bearer mcp-token"],
    ["uppercase scheme", "BEARER mcp-token"],
    ["several spaces", "Bearer    mcp-token"],
    ["a tab", "Bearer\tmcp-token"],
    ["trailing whitespace trimmed by Headers", "Bearer mcp-token  "],
    ["leading whitespace trimmed by Headers", "  Bearer mcp-token"],
  ])("accepts %s", async (_, header) => {
    expect(await bearerMatches(req(header), "mcp-token")).toBe(true);
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["the scheme with no token", "Bearer"],
    ["the scheme and a space only", "Bearer "],
    ["a bare token without the scheme", "mcp-token"],
    ["the scheme glued to the token", "Bearermcp-token"],
    ["another scheme", "Basic mcp-token"],
    ["a doubled scheme", "Bearer Bearer mcp-token"],
    ["a different token", "Bearer other-token"],
    ["a token that differs in case", "Bearer MCP-TOKEN"],
    ["a prefix of the token", "Bearer mcp-tok"],
    ["the token with a suffix", "Bearer mcp-token2"],
    ["the token with an inner space", "Bearer mcp -token"],
  ])("rejects %s", async (_, header) => {
    expect(await bearerMatches(req(header), "mcp-token")).toBe(false);
  });

  it("does not trim the expected token", async () => {
    expect(await bearerMatches(req("Bearer mcp-token"), " mcp-token")).toBe(false);
  });
});
