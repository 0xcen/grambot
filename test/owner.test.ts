import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { sha256Hex } from "../src/util";
import { fakeChatBuffers } from "./fake-chat-buffer";
import { fakeOwnerStore } from "./fake-owner-store";

const BASE = "https://worker.example";
const OWNER = 333;
const buffers = fakeChatBuffers();
const ownerStore = fakeOwnerStore();

const env: Omit<Env, "CHAT_BUFFER" | "OWNER_STORE"> = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111,222",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key",
};

let fetchMock: ReturnType<typeof vi.fn>;
let overrides: Partial<Env> = {};
let nextId = 1;

function withEnv(): Env {
  const e = { ...env, ...overrides } as Env;
  e.CHAT_BUFFER = buffers.namespace(e);
  e.OWNER_STORE = ownerStore.namespace;
  return e;
}

function post(update: Record<string, unknown>, secret: string | null = "tg-secret") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return worker.fetch(
    new Request(`${BASE}/telegram`, { method: "POST", headers, body: JSON.stringify({ update_id: nextId, ...update }) }),
    withEnv(),
  );
}

type Chat = { id: number; type: string };
const privateChat = (id: number): Chat => ({ id, type: "private" });

function message(fromId: number, text: string, chat: Chat = privateChat(fromId), extra: Record<string, unknown> = {}) {
  return post({
    message: { message_id: nextId++, date: 1_700_000_000, text, from: { id: fromId, first_name: "U" }, chat, ...extra },
  });
}

function react(fromId: number, messageId: number, chatId = fromId) {
  return post({
    message_reaction: {
      chat: { id: chatId, type: chatId === fromId ? "private" : "group" },
      message_id: messageId,
      user: { id: fromId, first_name: "U" },
      date: 1_700_000_000,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
  });
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mcp-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    withEnv(),
  );
  return (await res.json<any>()).result as { isError?: boolean; content: { text: string }[] };
}

async function createCode(): Promise<{ code: string; link: string | null; expires_in_seconds: number; note: string }> {
  const result = await tool("create_setup_code");
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await buffers.settled();
}

const telegramCalls = (method: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === `https://api.telegram.org/bot123:test-bot-token/${method}`)
    .map(([, init]) => JSON.parse(init.body));
const forwards = (): any[] =>
  fetchMock.mock.calls.filter(([url]) => url === env.GROKBOT_WEBHOOK_URL).map(([, init]) => JSON.parse(init.body));
const forwardedTexts = () => forwards().flatMap((b) => b.messages.map((m: any) => `${b.chat_id}:${m.text ?? m.type}`));
const logs = () => (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
const storedOwner = () => ownerStore.storage().get<number>("owner");

async function claim(userId = OWNER) {
  const { code } = await createCode();
  expect((await message(userId, `/start ${code}`)).status).toBe(200);
  expect(await storedOwner()).toBe(userId);
  fetchMock.mockClear();
  (console.log as ReturnType<typeof vi.fn>).mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.UTC(2026, 9, 11, 12));
  overrides = {};
  fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "grambot_test_bot" } });
    if (u.includes("api.telegram.org")) return Response.json({ ok: true, result: true });
    return new Response("ok");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  buffers.reset();
  ownerStore.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A1 create_setup_code and /start claims", () => {
  it("returns a long random code and a t.me deep link from getMe, and stores only the code's hash", async () => {
    const { code, link, expires_in_seconds, note } = await createCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toBe(`https://t.me/grambot_test_bot?start=${code}`);
    expect(expires_in_seconds).toBe(600);
    expect(note).toContain("only in this Grok Bot chat");

    const stored = await ownerStore.storage().list<unknown>();
    expect(stored.get("code")).toEqual({ hash: await sha256Hex(code), expires_at: Date.now() + 600_000 });
    expect(JSON.stringify([...stored])).not.toContain(code);
    expect((await createCode()).code).not.toBe(code);
  });

  it("still returns the code when getMe fails, with /start instructions instead of a link", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }));
    const { code, link, note } = await createCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toBeNull();
    expect(note).toContain("send /start followed by the code");
  });

  it("binds the sender of a valid /start code in a private chat, burns the code, and replies once", async () => {
    const { code } = await createCode();
    fetchMock.mockClear();
    expect((await message(OWNER, `/start ${code}`)).status).toBe(200);
    expect(await storedOwner()).toBe(OWNER);
    expect(await ownerStore.storage().get("code")).toBeUndefined();
    expect(telegramCalls("sendMessage")).toEqual([{ chat_id: OWNER, text: "Done. This Telegram account now owns the bot." }]);
    expect(logs()).toContain("claim: owner bound");
    await advance(5000);
    expect(forwards()).toEqual([]);
  });

  it("drops a reused code silently, even from another user", async () => {
    const { code } = await createCode();
    await message(OWNER, `/start ${code}`);
    fetchMock.mockClear();
    expect((await message(444, `/start ${code}`)).status).toBe(200);
    expect(await storedOwner()).toBe(OWNER);
    expect(telegramCalls("sendMessage")).toEqual([]);
    expect(logs()).toContain("claim: dropped /start, setup code missing or already used");
    await advance(5000);
    expect(forwards()).toEqual([]);
  });

  it("drops a wrong code silently without burning the pending one", async () => {
    const { code } = await createCode();
    fetchMock.mockClear();
    await message(OWNER, "/start wrongwrongwrongwrongwrongwrongwrongwro");
    expect(await storedOwner()).toBeUndefined();
    expect(telegramCalls("sendMessage")).toEqual([]);
    expect(logs()).toContain("claim: dropped /start, setup code wrong");
    await message(OWNER, `/start ${code}`);
    expect(await storedOwner()).toBe(OWNER);
  });

  it("accepts a code just inside 10 minutes", async () => {
    const { code } = await createCode();
    vi.setSystemTime(Date.now() + 600_000);
    await message(OWNER, `/start ${code}`);
    expect(await storedOwner()).toBe(OWNER);
  });

  it("drops an expired code silently and burns it", async () => {
    const { code } = await createCode();
    vi.setSystemTime(Date.now() + 600_001);
    fetchMock.mockClear();
    await message(OWNER, `/start ${code}`);
    expect(await storedOwner()).toBeUndefined();
    expect(telegramCalls("sendMessage")).toEqual([]);
    expect(logs()).toContain("claim: dropped /start, setup code expired");
    await message(OWNER, `/start ${code}`);
    expect(logs()).toContain("setup code missing or already used");
  });

  it("replaces an older code with a newer one", async () => {
    const first = await createCode();
    const second = await createCode();
    await message(OWNER, `/start ${first.code}`);
    expect(await storedOwner()).toBeUndefined();
    await message(OWNER, `/start ${second.code}`);
    expect(await storedOwner()).toBe(OWNER);
  });

  it("drops /start with no code pending", async () => {
    await message(OWNER, "/start abc");
    expect(await storedOwner()).toBeUndefined();
    expect(logs()).toContain("setup code missing or already used");
  });

  it("lets a new code move ownership to another account", async () => {
    await claim(OWNER);
    await claim(444);
    await message(OWNER, "still me?");
    await message(444, "new owner");
    await advance(2000);
    expect(forwardedTexts()).toEqual(["444:new owner"]);
  });

  it("forwards a plain /start without a code like any other message", async () => {
    await message(111, "/start");
    await advance(2000);
    expect(forwardedTexts()).toEqual(["111:/start"]);
  });
});

describe("A6 /start in groups", () => {
  it.each([
    ["group", { id: -100, type: "group" }],
    ["supergroup", { id: -1001234, type: "supergroup" }],
    ["channel", { id: -1009, type: "channel" }],
  ])("ignores a valid code sent in a %s and keeps it pending", async (_, chat) => {
    const { code } = await createCode();
    fetchMock.mockClear();
    expect((await message(OWNER, `/start@grambot_test_bot ${code}`, chat)).status).toBe(200);
    expect(await storedOwner()).toBeUndefined();
    expect(telegramCalls("sendMessage")).toEqual([]);
    expect(logs()).toContain("claim: ignored /start with a code outside a private chat");
    await advance(5000);
    expect(forwards()).toEqual([]);
    await message(OWNER, `/start ${code}`);
    expect(await storedOwner()).toBe(OWNER);
  });

  it("ignores a private chat whose id is not the sender's", async () => {
    const { code } = await createCode();
    await message(OWNER, `/start ${code}`, { id: 999, type: "private" });
    expect(await storedOwner()).toBeUndefined();
  });
});

describe("A2 no owner bound: ALLOWED_USER_IDS works exactly as before", () => {
  it("forwards allowlisted senders, including in groups, and drops others", async () => {
    await message(111, "hello");
    await message(222, "from a group", { id: -100, type: "group" });
    await message(999, "stranger");
    await advance(2000);
    expect(forwardedTexts().sort()).toEqual(["-100:from a group", "111:hello"]);
    expect(logs()).toContain("telegram: sender is not allowlisted, dropping");
  });

  it("lets the send tools reach allowlisted chats only", async () => {
    expect((await tool("send_typing", { chat_id: 111 })).isError).toBeUndefined();
    expect((await tool("send_typing", { chat_id: 999 })).content[0].text).toBe("chat_id is not in the allowlist");
  });

  it("with no owner and no ALLOWED_USER_IDS, drops messages but still processes a /start claim", async () => {
    overrides = { ALLOWED_USER_IDS: "" };
    await message(111, "anyone?");
    await advance(2000);
    expect(forwards()).toEqual([]);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ")).toContain(
      "no owner is bound and ALLOWED_USER_IDS is empty or invalid",
    );
    expect((await tool("send_typing", { chat_id: 111 })).content[0].text).toContain("Call create_setup_code");

    await claim(OWNER);
    await message(OWNER, "now?");
    await advance(2000);
    expect(forwardedTexts()).toEqual([`${OWNER}:now?`]);
  });

  it("keeps working with ALLOWED_USER_IDS unset once an owner is bound", async () => {
    overrides = { ALLOWED_USER_IDS: undefined as unknown as string };
    await claim(OWNER);
    await message(OWNER, "works");
    await advance(2000);
    expect(forwardedTexts()).toEqual([`${OWNER}:works`]);
    expect((await tool("send_typing", { chat_id: OWNER })).isError).toBeUndefined();
  });
});

describe("A3 a bound owner beats ALLOWED_USER_IDS", () => {
  it("only accepts the owner in their own private chat, for messages and reactions", async () => {
    await claim(OWNER);
    await message(111, "env listed");
    await message(OWNER, "owner in a group", { id: -100, type: "group" });
    await react(111, 5);
    await react(OWNER, 6, -100);
    await message(OWNER, "owner");
    await react(OWNER, 7);
    await advance(2000);
    expect(forwardedTexts().sort()).toEqual([`${OWNER}:owner`, `${OWNER}:reaction`]);
    expect(logs().match(/not the owner's private chat, dropping/g)).toHaveLength(4);
  });

  it.each([["bad rows", "abc,,111"], ["a trailing comma", "111,"], ["whitespace", "   "]])(
    "ignores ALLOWED_USER_IDS with %s",
    async (_, value) => {
      overrides = { ALLOWED_USER_IDS: value };
      await claim(OWNER);
      await message(OWNER, "fine");
      await message(111, "no");
      await advance(2000);
      expect(forwardedTexts()).toEqual([`${OWNER}:fine`]);
    },
  );

  it("gates every send tool to the owner's chat", async () => {
    await claim(OWNER);
    const calls: [string, Record<string, unknown>][] = [
      ["send_telegram_message", { text: "hi" }],
      ["send_typing", {}],
      ["send_telegram_reaction", { message_id: 1, emoji: "👍" }],
      ["send_telegram_photo", { url: "https://example.com/a.jpg" }],
      ["send_telegram_voice", { url: "https://example.com/a.ogg" }],
      ["send_telegram_document", { url: "https://example.com/a.pdf" }],
    ];
    for (const [name, args] of calls) {
      const refused = await tool(name, { chat_id: 111, ...args });
      expect(refused.content[0].text, name).toBe("chat_id is not the owner's chat");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    for (const [name, args] of calls) {
      expect((await tool(name, { chat_id: String(OWNER), ...args })).isError, name).toBeUndefined();
    }
  });

  it("logs once per isolate that ALLOWED_USER_IDS is ignored", async () => {
    vi.resetModules();
    const fresh = (await import("../src/index")).default;
    await claim(OWNER);
    for (const text of ["one", "two", "three"]) {
      await fresh.fetch(
        new Request(`${BASE}/telegram`, {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" },
          body: JSON.stringify({ update_id: 1, message: { message_id: nextId++, date: 1, text, from: { id: OWNER }, chat: privateChat(OWNER) } }),
        }),
        withEnv(),
      );
    }
    expect(logs().match(/an owner is bound, so ALLOWED_USER_IDS is ignored/g)).toHaveLength(1);
  });
});

describe("A4 webhook secret", () => {
  it.each([["missing", null], ["wrong", "guess"]])("rejects a /start claim with a %s secret before checking the code", async (_, secret) => {
    const { code } = await createCode();
    const res = await post({ message: { message_id: 1, date: 1, text: `/start ${code}`, from: { id: OWNER }, chat: privateChat(OWNER) } }, secret);
    expect(res.status).toBe(401);
    expect(await storedOwner()).toBeUndefined();
    expect(await ownerStore.storage().get("code")).toBeDefined();
  });
});

describe("A5 rate limits and truncation", () => {
  it("drops and logs messages over the per minute cap, never answering them", async () => {
    overrides = { RATE_LIMIT_PER_MINUTE: "3" };
    await claim(OWNER);
    for (const text of ["1", "2", "3", "4", "5"]) expect((await message(OWNER, text)).status).toBe(200);
    await advance(2000);
    expect(forwardedTexts()).toEqual(["1", "2", "3"].map((t) => `${OWNER}:${t}`));
    expect(logs().match(/per minute rate limit reached, dropping/g)).toHaveLength(2);
    expect(telegramCalls("sendMessage")).toEqual([]);

    vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 1));
    await message(OWNER, "next minute");
    await advance(2000);
    expect(forwardedTexts().at(-1)).toBe(`${OWNER}:next minute`);
  });

  it("drops over the daily cap until the next UTC day, counting reactions too", async () => {
    overrides = { RATE_LIMIT_PER_DAY: "3" };
    await claim(OWNER);
    await message(OWNER, "1");
    await react(OWNER, 1);
    vi.setSystemTime(Date.UTC(2026, 9, 11, 18));
    await message(OWNER, "2");
    await message(OWNER, "3");
    await advance(2000);
    expect(forwardedTexts().sort()).toEqual([`${OWNER}:1`, `${OWNER}:2`, `${OWNER}:reaction`]);
    expect(logs()).toContain("telegram: per day rate limit reached, dropping");

    vi.setSystemTime(Date.UTC(2026, 9, 12, 0, 0, 1));
    await message(OWNER, "tomorrow");
    await advance(2000);
    expect(forwardedTexts().at(-1)).toBe(`${OWNER}:tomorrow`);
  });

  it("does not count updates from senders who are not allowed", async () => {
    overrides = { RATE_LIMIT_PER_MINUTE: "1" };
    await message(999, "spam");
    await message(111, "real");
    await advance(2000);
    expect(forwardedTexts()).toEqual(["111:real"]);
    expect(await ownerStore.storage().get("rate:999")).toBeUndefined();
  });

  it("uses the defaults of 60 per minute when the vars are malformed", async () => {
    overrides = { RATE_LIMIT_PER_MINUTE: "lots", RATE_LIMIT_PER_DAY: "-1" };
    for (let i = 0; i < 61; i++) await message(111, `m${i}`);
    await advance(2000);
    expect(forwards().flatMap((b) => b.messages)).toHaveLength(60);
    expect(logs()).toContain("per minute rate limit reached");
  });

  it("truncates long text and captions by character and marks the entry", async () => {
    overrides = { MAX_MESSAGE_CHARS: "5" };
    await message(111, "hello world");
    await message(111, "😀😀😀😀😀😀😀");
    await message(111, "short");
    await advance(2000);
    const entries = forwards()[0].messages;
    expect(entries.map((m: any) => [m.text, m.truncated])).toEqual([
      ["hello", true],
      ["😀😀😀😀😀", true],
      ["short", undefined],
    ]);
    expect(logs()).toContain("telegram: truncated a message to 5 characters");
  });
});
