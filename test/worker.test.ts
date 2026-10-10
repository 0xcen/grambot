import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { splitText } from "../src/mcp";

const BASE = "https://worker.example";

const env: Env = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111, 222",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key-xyz",
};

let fetchMock: ReturnType<typeof vi.fn>;
let pending: Promise<unknown>[];

function ctx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

async function call(req: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const res = await worker.fetch(req, { ...env, ...overrides }, ctx());
  await Promise.all(pending);
  return res;
}

function telegramUpdate(fromId: number, text = "hello bot") {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: 1_700_000_000,
      text,
      from: { id: fromId, is_bot: false, first_name: "Ada", username: "ada" },
      chat: { id: fromId, type: "private" },
    },
  };
}

function webhookRequest(body: unknown, secret: string | null = env.TG_WEBHOOK_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request(`${BASE}/telegram`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function mcpRequest(body: unknown, token: string | null = env.MCP_BEARER_TOKEN) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

function rpc(method: string, params?: unknown, id: number = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function telegramOk(result: unknown = true) {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  pending = [];
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /telegram", () => {
  it("returns 401 when the secret header is missing", async () => {
    const res = await call(webhookRequest(telegramUpdate(111), null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the secret header is wrong", async () => {
    const res = await call(webhookRequest(telegramUpdate(111), "nope"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when TG_WEBHOOK_SECRET is not configured", async () => {
    const res = await call(webhookRequest(telegramUpdate(111), ""), { TG_WEBHOOK_SECRET: "" });
    expect(res.status).toBe(401);
  });

  it("returns 200 silently and forwards nothing for a non-allowlisted sender", async () => {
    const res = await call(webhookRequest(telegramUpdate(999)));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores updates without a text message", async () => {
    const res = await call(webhookRequest({ update_id: 2, edited_message: {} }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards allowlisted messages with the Authorization header sent verbatim", async () => {
    const res = await call(webhookRequest(telegramUpdate(222, "what's on my calendar?")));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(env.GROKBOT_WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer routine-key-xyz");
    expect(JSON.parse(init.body)).toEqual({
      chat_id: 222,
      message_id: 42,
      text: "what's on my calendar?",
      date: 1_700_000_000,
      from: { id: 222, is_bot: false, first_name: "Ada", username: "ada" },
    });
  });

  it("adds the Bearer scheme when GROKBOT_WEBHOOK_AUTH is a bare key", async () => {
    await call(webhookRequest(telegramUpdate(111)), { GROKBOT_WEBHOOK_AUTH: "bare-routine-key" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer bare-routine-key");
  });

  it.each(["Authorization: Bearer pasted-key", "authorization:Bearer pasted-key", "Authorization: pasted-key"])(
    "strips a pasted header name from %j",
    async (value) => {
      await call(webhookRequest(telegramUpdate(111)), { GROKBOT_WEBHOOK_AUTH: value });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer pasted-key");
    },
  );

  it.each([
    ["bare key", "k3y-123", { hadBearer: false, hadHeaderName: false, hadQuotes: false }],
    ["Bearer key", "Bearer k3y-123", { hadBearer: true }],
    ["lowercase bearer, extra spaces", "bearer    k3y-123", { hadBearer: true }],
    ["trailing newline", "Bearer k3y-123\n", { hadEdgeWhitespace: true }],
    ["CRLF and spaces", "  k3y-123\r\n", { hadEdgeWhitespace: true }],
    ["double quoted", '"Bearer k3y-123"', { hadQuotes: true, hadBearer: true }],
    ["single quoted bare key", "'k3y-123'", { hadQuotes: true }],
    ["full header line", "Authorization: Bearer k3y-123", { hadHeaderName: true, hadBearer: true }],
    ["header line, no space", "authorization:Bearer k3y-123", { hadHeaderName: true }],
    ["header line with bare key", "Authorization: k3y-123", { hadHeaderName: true, hadBearer: false }],
    ["quoted header line + newline", '"Authorization: Bearer k3y-123"\n', { hadQuotes: true, hadHeaderName: true }],
    ["header line with quoted value", 'Authorization: "Bearer k3y-123"', { hadQuotes: true, hadHeaderName: true }],
    ["quoted key after Bearer", 'Bearer "k3y-123"', { hadQuotes: true, hadBearer: true }],
    ["zero-width and BOM", "\uFEFFBearer k3y-123\u200B", { hadInvisibleChars: true }],
  ])("normalizes %s to exactly 'Bearer <key>' and logs only the shape", async (_, value, shape) => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await call(webhookRequest(telegramUpdate(111)), { GROKBOT_WEBHOOK_AUTH: value });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer k3y-123");

    const shapeLine = logSpy.mock.calls.flat().find((l) => String(l).startsWith("forward auth shape:"));
    expect(shapeLine).toBeDefined();
    expect(shapeLine).not.toContain("k3y-123");
    const logged = JSON.parse(String(shapeLine).match(/(\{.*\})/)![1]);
    expect(logged).toMatchObject({ length: value.length, ...shape });
  });

  it("uses GROKBOT_WEBHOOK_AUTH_HEADER as the header name when set", async () => {
    await call(webhookRequest(telegramUpdate(111)), {
      GROKBOT_WEBHOOK_AUTH_HEADER: "X-Routine-Key",
      GROKBOT_WEBHOOK_AUTH: "raw-key-value",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Routine-Key"]).toBe("raw-key-value");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("logs forward failures without leaking secrets", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const res = await call(webhookRequest(telegramUpdate(111)));
    expect(res.status).toBe(200);
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(logged).toContain("500");
    expect(logged).not.toContain("routine-key-xyz");
    expect(logged).not.toContain("hooks/abc");
  });

  it("returns 405 for GET", async () => {
    const res = await call(new Request(`${BASE}/telegram`));
    expect(res.status).toBe(405);
  });
});

describe("/mcp", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await call(mcpRequest(rpc("initialize"), null));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await call(mcpRequest(rpc("tools/list"), "wrong"));
    expect(res.status).toBe(401);
  });

  it("returns 405 for GET", async () => {
    const res = await call(
      new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` } }),
    );
    expect(res.status).toBe(405);
  });

  it("handles initialize", async () => {
    const res = await call(
      mcpRequest(
        rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("grokbot-telegram");
  });

  it("falls back to the latest protocol version for unknown versions", async () => {
    const res = await call(mcpRequest(rpc("initialize", { protocolVersion: "1999-01-01" })));
    const body = await res.json<any>();
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("accepts notifications/initialized with 202 and no body", async () => {
    const res = await call(mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists both tools", async () => {
    const res = await call(mcpRequest(rpc("tools/list")));
    const body = await res.json<any>();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["send_telegram_message", "send_typing"]);
  });

  it("returns method not found for unknown methods", async () => {
    const res = await call(mcpRequest(rpc("resources/list")));
    const body = await res.json<any>();
    expect(body.error.code).toBe(-32601);
  });

  it("returns a parse error for invalid JSON", async () => {
    const res = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe(-32700);
  });

  it("send_telegram_message calls Telegram sendMessage", async () => {
    fetchMock.mockResolvedValueOnce(telegramOk({ message_id: 7 }));
    const res = await call(
      mcpRequest(
        rpc("tools/call", {
          name: "send_telegram_message",
          arguments: { chat_id: 111, text: "hi", reply_to_message_id: 42, parse_mode: "HTML" },
        }),
      ),
    );
    const body = await res.json<any>();
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true, message_ids: [7] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:test-bot-token/sendMessage");
    expect(JSON.parse(init.body)).toEqual({
      chat_id: 111,
      text: "hi",
      parse_mode: "HTML",
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
  });

  it("send_telegram_message accepts a string chat_id from the allowlist", async () => {
    fetchMock.mockResolvedValueOnce(telegramOk({ message_id: 8 }));
    const res = await call(
      mcpRequest(
        rpc("tools/call", { name: "send_telegram_message", arguments: { chat_id: "222", text: "yo" } }),
      ),
    );
    expect((await res.json<any>()).result.isError).toBeUndefined();
  });

  it("send_telegram_message splits long text into several messages", async () => {
    fetchMock
      .mockResolvedValueOnce(telegramOk({ message_id: 1 }))
      .mockResolvedValueOnce(telegramOk({ message_id: 2 }));
    const text = "a".repeat(4000) + "\n" + "b".repeat(200);
    const res = await call(
      mcpRequest(rpc("tools/call", { name: "send_telegram_message", arguments: { chat_id: 111, text } })),
    );
    const body = await res.json<any>();
    expect(JSON.parse(body.result.content[0].text).message_ids).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("send_telegram_message refuses chats outside the allowlist", async () => {
    const res = await call(
      mcpRequest(
        rpc("tools/call", { name: "send_telegram_message", arguments: { chat_id: 999, text: "hi" } }),
      ),
    );
    const body = await res.json<any>();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("send_telegram_message surfaces Telegram errors as tool errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
        status: 400,
      }),
    );
    const res = await call(
      mcpRequest(
        rpc("tools/call", { name: "send_telegram_message", arguments: { chat_id: 111, text: "hi" } }),
      ),
    );
    const body = await res.json<any>();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("chat not found");
    expect(body.result.content[0].text).not.toContain(env.BOT_TOKEN);
  });

  it("send_typing calls Telegram sendChatAction", async () => {
    fetchMock.mockResolvedValueOnce(telegramOk(true));
    const res = await call(
      mcpRequest(rpc("tools/call", { name: "send_typing", arguments: { chat_id: 222 } })),
    );
    const body = await res.json<any>();
    expect(body.result.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:test-bot-token/sendChatAction");
    expect(JSON.parse(init.body)).toEqual({ chat_id: 222, action: "typing" });
  });

  it("send_typing refuses chats outside the allowlist", async () => {
    const res = await call(
      mcpRequest(rpc("tools/call", { name: "send_typing", arguments: { chat_id: 333 } })),
    );
    const body = await res.json<any>();
    expect(body.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an error for unknown tools", async () => {
    const res = await call(mcpRequest(rpc("tools/call", { name: "delete_everything", arguments: {} })));
    expect((await res.json<any>()).error.code).toBe(-32602);
  });
});

describe("ALLOWED_USER_IDS is required", () => {
  const badValues: [string, string | undefined][] = [
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
    ["non-numeric", "abc"],
    ["trailing comma", "111,"],
    ["one bad entry", "111,@ada"],
  ];

  it.each(badValues)("/telegram never forwards when the allowlist is %s", async (_, value) => {
    const res = await call(webhookRequest(telegramUpdate(111)), {
      ALLOWED_USER_IDS: value as string,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(logged).toContain("ALLOWED_USER_IDS");
  });

  it.each(badValues)("MCP tools refuse with a config error when the allowlist is %s", async (_, value) => {
    for (const [name, args] of [
      ["send_telegram_message", { chat_id: 111, text: "hi" }],
      ["send_typing", { chat_id: 111 }],
    ] as const) {
      const res = await call(mcpRequest(rpc("tools/call", { name, arguments: args })), {
        ALLOWED_USER_IDS: value as string,
      });
      const body = await res.json<any>();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Server misconfigured: ALLOWED_USER_IDS");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the lowercase bearer scheme", async () => {
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `bearer ${env.MCP_BEARER_TOKEN}` },
      body: JSON.stringify(rpc("tools/list")),
    });
    expect((await call(req)).status).toBe(200);
  });
});

describe("POST /setup", () => {
  function setupRequest(token: string | null = env.MCP_BEARER_TOKEN, method = "POST") {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://grokbot-telegram.someone.workers.dev/setup`, { method, headers });
  }

  it("returns 401 without the bearer token", async () => {
    const res = await call(setupRequest(null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 with the wrong bearer token", async () => {
    const res = await call(setupRequest("wrong"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "DELETE"])("returns 405 for %s", async (method) => {
    const res = await call(setupRequest(env.MCP_BEARER_TOKEN, method));
    expect(res.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls setWebhook with this Worker's /telegram URL, the secret and message updates only", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true, description: "Webhook was set" })),
    );
    const res = await call(setupRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, description: "Webhook was set" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:test-bot-token/setWebhook");
    expect(JSON.parse(init.body)).toEqual({
      url: "https://grokbot-telegram.someone.workers.dev/telegram",
      secret_token: "tg-secret",
      allowed_updates: ["message"],
    });
  });

  it("returns only ok and description when Telegram fails, never the token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
        status: 401,
      }),
    );
    const res = await call(setupRequest());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, description: "Unauthorized" });
    expect(text).not.toContain(env.BOT_TOKEN);
    expect(text).not.toContain(env.TG_WEBHOOK_SECRET);
  });

  it.each([
    ["BOT_TOKEN", { BOT_TOKEN: "" }],
    ["TG_WEBHOOK_SECRET", { TG_WEBHOOK_SECRET: "" }],
    ["ALLOWED_USER_IDS", { ALLOWED_USER_IDS: "" }],
  ])("refuses without calling Telegram when %s is missing", async (name, overrides) => {
    const res = await call(setupRequest(), overrides as Partial<Env>);
    expect(res.status).toBe(503);
    expect((await res.json<any>()).description).toContain(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it.each(["/", "/telegram/extra", "/mcp/", "/admin"])("returns 404 for %s", async (path) => {
    const res = await call(new Request(`${BASE}${path}`, { method: "POST" }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("splitText", () => {
  it("keeps short text intact and splits long text on whitespace", () => {
    expect(splitText("short", 10)).toEqual(["short"]);
    expect(splitText("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
    expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
