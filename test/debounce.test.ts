import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { fakeChatBuffers } from "./fake-chat-buffer";
import { fakeOwnerStore } from "./fake-owner-store";

const BASE = "https://worker.example";
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
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

function send(fromId: number, messageId: number, fields: Record<string, unknown>, overrides: Partial<Env> = {}, secret = "tg-secret") {
  const e = { ...env, ...overrides } as Env;
  e.CHAT_BUFFER = buffers.namespace(e);
  e.OWNER_STORE = ownerStore.namespace;
  const body = {
    update_id: messageId,
    message: { message_id: messageId, date: 1_700_000_000 + messageId, from: { id: fromId, first_name: "Ada" }, chat: { id: fromId }, ...fields },
  };
  return worker.fetch(
    new Request(`${BASE}/telegram`, {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(body),
    }),
    e,
  );
}

const text = (fromId: number, messageId: number, value: string, overrides?: Partial<Env>) =>
  send(fromId, messageId, { text: value }, overrides);

const photo = (fileId: string) => [{ file_id: fileId, width: 800, height: 600, file_size: 50_000 }];

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await buffers.settled();
}

function forwards(): any[] {
  return fetchMock.mock.calls.filter(([url]) => url === env.GROKBOT_WEBHOOK_URL).map(([, init]) => JSON.parse(init.body));
}

const shape = (batch: any) =>
  batch.messages.map((m: any) => m.text ?? `${m.caption ?? ""}[${(m.media ?? []).map((x: any) => x.url.match(/file\/([\w-]+)/)[1]).join(",")}]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/getFile")) {
      const { file_id } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { file_id, file_path: `photos/${file_id}.jpg` } }));
    }
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

describe("inbound debounce", () => {
  it("flushes a single message once the 2 second window passes", async () => {
    expect((await text(111, 1, "hello")).status).toBe(200);
    await advance(1999);
    expect(forwards()).toEqual([]);
    await advance(1);
    expect(forwards()).toEqual([
      { chat_id: 111, messages: [{ message_id: 1, date: 1_700_000_001, from: { id: 111, first_name: "Ada" }, text: "hello" }] },
    ]);
  });

  it("merges a burst into one forward, in message order", async () => {
    await text(111, 1, "first");
    await advance(500);
    await text(111, 2, "second");
    await advance(500);
    await send(111, 3, { caption: "and this", photo: photo("p3") });
    await advance(2000);
    const batches = forwards();
    expect(batches).toHaveLength(1);
    expect(shape(batches[0])).toEqual(["first", "second", "and this[p3]"]);
  });

  it("resets the timer on every new message", async () => {
    await text(111, 1, "one");
    await advance(1900);
    await text(111, 2, "two");
    await advance(1900);
    expect(forwards()).toEqual([]);
    await advance(100);
    expect(forwards().map(shape)).toEqual([["one", "two"]]);
  });

  it("flushes from the alarm alone, with no further requests, and only once", async () => {
    const res = await text(111, 7, "still there?");
    expect(await res.text()).toBe("ok");
    expect(forwards()).toEqual([]);
    await advance(2000);
    await advance(60_000);
    expect(forwards().map(shape)).toEqual([["still there?"]]);
  });

  it("groups an album by media_group_id, even when its parts arrive out of order", async () => {
    await text(111, 9, "look at these");
    await send(111, 12, { media_group_id: "alb1", photo: photo("p12") });
    await send(111, 10, { media_group_id: "alb1", caption: "trip", photo: photo("p10") });
    await send(111, 11, { media_group_id: "alb1", photo: photo("p11") });
    await send(111, 13, { document: { file_id: "d13", file_name: "plan.pdf" } });
    await advance(2000);
    const [batch] = forwards();
    expect(shape(batch)).toEqual(["look at these", "trip[p10,p11,p12]", "[d13]"]);
    expect(batch.messages[1]).toMatchObject({ message_id: 10, media_group_id: "alb1", caption: "trip" });
  });

  it("signs media links at flush time, so they outlast the debounce window", async () => {
    await send(111, 1, { photo: photo("p1") }, { DEBOUNCE_MS: "30000" });
    await advance(30_000);
    const media = forwards()[0].messages[0].media[0];
    expect(media.expires_at).toBe(NOW / 1000 + 30 + 900);
  });

  it("keeps separate chats in separate batches", async () => {
    await text(111, 1, "from ada");
    await text(222, 1, "from bob");
    await advance(2000);
    expect(forwards().map((b) => [b.chat_id, ...shape(b)]).sort()).toEqual([
      [111, "from ada"],
      [222, "from bob"],
    ]);
  });

  it("forwards a redelivered update only once", async () => {
    await text(111, 5, "same");
    await text(111, 5, "same");
    await advance(2000);
    expect(forwards().map(shape)).toEqual([["same"]]);
  });

  it.each([
    ["500", 500],
    ["0", 0],
    ["not a number", 2000],
    ["999999", 60_000],
  ])("DEBOUNCE_MS=%j waits %i ms", async (value, wait) => {
    await text(111, 1, "hi", { DEBOUNCE_MS: value });
    if (wait > 0) {
      await advance(wait - 1);
      expect(forwards()).toEqual([]);
    }
    await advance(1);
    expect(forwards()).toHaveLength(1);
  });

  it("flushes at once when 20 messages are waiting", async () => {
    for (let id = 1; id <= 20; id++) await text(111, id, `m${id}`);
    await advance(0);
    const [batch] = forwards();
    expect(batch.messages).toHaveLength(20);
  });

  it("drops a non-allowlisted sender before buffering", async () => {
    expect((await text(999, 1, "let me in")).status).toBe(200);
    expect((await send(999, 2, { photo: photo("x") })).status).toBe(200);
    await advance(5000);
    expect(buffers.chats()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bad secret before buffering", async () => {
    expect((await send(111, 1, { text: "hi" }, {}, "wrong")).status).toBe(401);
    await advance(5000);
    expect(buffers.chats()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 so Telegram retries when the buffer is unavailable", async () => {
    const e = { ...env, OWNER_STORE: ownerStore.namespace, CHAT_BUFFER: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("", { status: 500 }) }) } } as unknown as Env;
    const res = await worker.fetch(
      new Request(`${BASE}/telegram`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-secret" },
        body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, text: "hi", from: { id: 111 }, chat: { id: 111 } } }),
      }),
      e,
    );
    expect(res.status).toBe(503);
  });
});
