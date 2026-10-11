import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { fakeChatBuffers } from "./fake-chat-buffer";

const BASE = "https://worker.example";
const buffers = fakeChatBuffers();

const env: Omit<Env, "CHAT_BUFFER"> = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111,222",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key",
};

let fetchMock: ReturnType<typeof vi.fn>;

const emoji = (e: string) => ({ type: "emoji", emoji: e });

function withEnv(overrides: Partial<Env> = {}): Env {
  const e = { ...env, ...overrides } as Env;
  e.CHAT_BUFFER = buffers.namespace(e);
  return e;
}

function post(update: Record<string, unknown>, secret: string | null = "tg-secret") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return worker.fetch(
    new Request(`${BASE}/telegram`, { method: "POST", headers, body: JSON.stringify({ update_id: 1, ...update }) }),
    withEnv(),
  );
}

function react(fromId: number, messageId: number, newReaction: unknown[], oldReaction: unknown[] = [], extra = {}) {
  return post({
    message_reaction: {
      chat: { id: fromId, type: "private" },
      message_id: messageId,
      user: { id: fromId, first_name: "Ada" },
      date: 1_700_000_000 + messageId,
      old_reaction: oldReaction,
      new_reaction: newReaction,
      ...extra,
    },
  });
}

const text = (fromId: number, messageId: number, value: string) =>
  post({
    message: { message_id: messageId, date: 1_700_000_000, text: value, from: { id: fromId, first_name: "Ada" }, chat: { id: fromId } },
  });

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await buffers.settled();
}

const forwards = (): any[] =>
  fetchMock.mock.calls.filter(([url]) => url === env.GROKBOT_WEBHOOK_URL).map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.UTC(2026, 9, 11, 12));
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes("api.telegram.org")
      ? new Response(JSON.stringify({ ok: true, result: true }), { headers: { "Content-Type": "application/json" } })
      : new Response("ok"),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  buffers.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inbound reactions", () => {
  it("forwards a single reaction as exactly one batch after the debounce window", async () => {
    expect((await react(111, 42, [emoji("👍")])).status).toBe(200);
    await advance(1999);
    expect(forwards()).toEqual([]);
    await advance(1);
    expect(forwards()).toEqual([
      {
        chat_id: 111,
        messages: [
          { type: "reaction", message_id: 42, date: 1_700_000_042, from: { id: 111, first_name: "Ada" }, emoji: "👍", removed: false },
        ],
      },
    ]);
  });

  it("merges a burst of 3 reactions on different messages into exactly one forward, in message order", async () => {
    await react(111, 30, [emoji("🔥")]);
    await advance(300);
    await react(111, 10, [emoji("👍")]);
    await advance(300);
    await react(111, 20, [emoji("❤")]);
    await advance(2000);
    const batches = forwards();
    expect(batches).toHaveLength(1);
    expect(batches[0].messages.map((m: any) => [m.message_id, m.emoji])).toEqual([
      [10, "👍"],
      [20, "❤"],
      [30, "🔥"],
    ]);
  });

  it("collapses changes to one message's reaction into its latest state", async () => {
    await react(111, 5, [emoji("👍")]);
    await react(111, 5, [emoji("🔥")], [emoji("👍")]);
    await react(111, 5, [emoji("🎉")], [emoji("🔥")]);
    await advance(2000);
    expect(forwards().map((b) => b.messages.map((m: any) => m.emoji))).toEqual([["🎉"]]);
  });

  it("flags a removal with removed: true and the emoji that was removed", async () => {
    await react(111, 8, [], [emoji("👍")]);
    await advance(2000);
    expect(forwards()[0].messages).toEqual([
      { type: "reaction", message_id: 8, date: 1_700_000_008, from: { id: 111, first_name: "Ada" }, emoji: "👍", removed: true },
    ]);
  });

  it("puts a reaction right after the message it is on, in the same batch as new text", async () => {
    await text(111, 50, "done yet?");
    await react(111, 49, [emoji("👀")]);
    await text(111, 51, "also this");
    await advance(2000);
    expect(forwards()[0].messages.map((m: any) => m.text ?? `${m.type}:${m.message_id}:${m.emoji}`)).toEqual([
      "reaction:49:👀",
      "done yet?",
      "also this",
    ]);
  });

  it("keeps both a message and a reaction on that same message in one batch", async () => {
    await text(111, 60, "is this right?");
    await react(111, 60, [emoji("🤔")]);
    await advance(2000);
    expect(forwards()[0].messages.map((m: any) => m.text ?? `${m.type}:${m.emoji}`)).toEqual([
      "is this right?",
      "reaction:🤔",
    ]);
  });

  it("drops a reaction from a non-allowlisted user before buffering", async () => {
    expect((await react(999, 1, [emoji("👍")])).status).toBe(200);
    await advance(5000);
    expect(buffers.chats()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the allowlist against the reacting user, not the chat", async () => {
    await react(999, 1, [emoji("👍")], [], { chat: { id: 111 } });
    await react(111, 2, [emoji("🔥")], [], { chat: { id: -100555 } });
    await advance(2000);
    expect(forwards().map((b) => [b.chat_id, b.messages[0].emoji])).toEqual([[-100555, "🔥"]]);
  });

  it("checks an anonymous reaction's actor_chat against the allowlist", async () => {
    await post({
      message_reaction: { chat: { id: -1001 }, actor_chat: { id: -1001 }, message_id: 3, date: 1, old_reaction: [], new_reaction: [emoji("👍")] },
    });
    await advance(5000);
    expect(buffers.chats()).toEqual([]);
  });

  it("rejects a reaction without the webhook secret before buffering", async () => {
    const res = await post({ message_reaction: { chat: { id: 111 }, user: { id: 111 }, message_id: 1, date: 1, new_reaction: [emoji("👍")] } }, "wrong");
    expect(res.status).toBe(401);
    await advance(5000);
    expect(buffers.chats()).toEqual([]);
  });

  it("ignores custom emoji and paid reactions", async () => {
    await react(111, 1, [{ type: "custom_emoji", custom_emoji_id: "5368" }]);
    await react(111, 2, [{ type: "paid" }]);
    await advance(5000);
    expect(forwards()).toEqual([]);
  });

  it("uses the standard emoji when a reaction mixes custom and standard ones", async () => {
    await react(111, 1, [{ type: "custom_emoji", custom_emoji_id: "5368" }, emoji("🙏")]);
    await advance(2000);
    expect(forwards()[0].messages[0].emoji).toBe("🙏");
  });
});

function tool(args: Record<string, unknown>, overrides: Partial<Env> = {}, token = "mcp-token") {
  return worker
    .fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_telegram_reaction", arguments: args } }),
      }),
      withEnv(overrides),
    )
    .then(async (res) => (res.status === 200 ? ((await res.json<any>()).result as { isError?: boolean; content: { text: string }[] }) : res.status));
}

const sentBody = () => {
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.telegram.org/bot123:test-bot-token/setMessageReaction");
  return JSON.parse(init.body);
};

describe("send_telegram_reaction", () => {
  it("sets one standard emoji with setMessageReaction", async () => {
    const result = await tool({ chat_id: 111, message_id: 42, emoji: "👍" });
    expect(result).toEqual({ content: [{ type: "text", text: '{"ok":true,"cleared":false}' }] });
    expect(sentBody()).toEqual({ chat_id: 111, message_id: 42, reaction: [{ type: "emoji", emoji: "👍" }] });
  });

  it("accepts an emoji with a U+FE0F variation selector and sends Telegram's spelling", async () => {
    await tool({ chat_id: "222", message_id: 7, emoji: "❤\uFE0F" });
    expect(sentBody().reaction).toEqual([{ type: "emoji", emoji: "❤" }]);
  });

  it.each([["omitted", {}], ["empty", { emoji: "" }], ["blank", { emoji: "  " }]])(
    "clears the reaction when emoji is %s",
    async (_, extra) => {
      const result = await tool({ chat_id: 111, message_id: 42, ...extra });
      expect((result as any).content[0].text).toBe('{"ok":true,"cleared":true}');
      expect(sentBody()).toEqual({ chat_id: 111, message_id: 42, reaction: [] });
    },
  );

  it.each([["not a reaction emoji", "🦖"], ["two emoji", "👍🔥"], ["text", "thumbs up"], ["custom emoji id", "5368"]])(
    "rejects %s without calling Telegram",
    async (_, value) => {
      const result = (await tool({ chat_id: 111, message_id: 42, emoji: value })) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `emoji must be exactly one of Telegram's standard reaction emoji, for example 👍 ❤ 🔥 🎉 👀 🙏. Got ${JSON.stringify(value)}.`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a chat outside the allowlist without calling Telegram", async () => {
    const result = (await tool({ chat_id: 999, message_id: 42, emoji: "👍" })) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("chat_id is not in the allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses with a config error when the allowlist is empty", async () => {
    const result = (await tool({ chat_id: 111, message_id: 42, emoji: "👍" }, { ALLOWED_USER_IDS: "" })) as any;
    expect(result.content[0].text).toContain("Server misconfigured: ALLOWED_USER_IDS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 without the bearer token", async () => {
    expect(await tool({ chat_id: 111, message_id: 42 }, {}, "wrong")).toBe(401);
  });

  it.each([["missing", undefined], ["zero", 0], ["fractional", 1.5], ["a string", "42"]])(
    "rejects a %s message_id",
    async (_, value) => {
      const result = (await tool({ chat_id: 111, message_id: value, emoji: "👍" })) as any;
      expect(result.content[0].text).toBe("message_id must be a positive integer");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("surfaces Telegram errors as tool errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: REACTION_INVALID" }), { status: 400 }),
    );
    const result = (await tool({ chat_id: 111, message_id: 42, emoji: "👍" })) as any;
    expect(result.content[0].text).toBe("Telegram setMessageReaction failed: Bad Request: REACTION_INVALID");
  });
});
