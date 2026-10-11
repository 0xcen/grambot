import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { fakeChatBuffers } from "./fake-chat-buffer";
import { fakeOwnerStore } from "./fake-owner-store";

const BASE = "https://worker.example";
const buffers = fakeChatBuffers();
const ownerStore = fakeOwnerStore();

const env: Omit<Env, "CHAT_BUFFER" | "OWNER_STORE"> = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key",
};

let fetchMock: ReturnType<typeof vi.fn>;

function send(messageId: number, fields: Record<string, unknown>) {
  const e = { ...env } as Env;
  e.CHAT_BUFFER = buffers.namespace(e);
  e.OWNER_STORE = ownerStore.namespace;
  return worker.fetch(
    new Request(`${BASE}/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "tg-secret" },
      body: JSON.stringify({
        update_id: messageId,
        message: { message_id: messageId, date: 1_700_000_000, from: { id: 111, first_name: "Ada" }, chat: { id: 111, type: "private" }, ...fields },
      }),
    }),
    e,
  );
}

const original = (fields: Record<string, unknown>) => ({
  message_id: 40,
  date: 1_699_999_000,
  from: { id: 999, is_bot: true, first_name: "Grambot" },
  chat: { id: 111, type: "private" },
  ...fields,
});

async function flushed(): Promise<any[]> {
  await vi.advanceTimersByTimeAsync(2000);
  await buffers.settled();
  return fetchMock.mock.calls
    .filter(([url]) => url === env.GROKBOT_WEBHOOK_URL)
    .flatMap(([, init]) => JSON.parse(init.body).messages);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.UTC(2026, 9, 11, 12));
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes("api.telegram.org")
      ? Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 10 } })
      : new Response("ok"),
  );
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

describe("reply_to on forwarded messages", () => {
  it("carries the replied-to message's id and text", async () => {
    await send(50, { text: "yes, do that", reply_to_message: original({ text: "Shall I book the 9am train?" }) });
    expect(await flushed()).toEqual([
      {
        message_id: 50,
        date: 1_700_000_000,
        from: { id: 111, first_name: "Ada" },
        text: "yes, do that",
        reply_to: { message_id: 40, text: "Shall I book the 9am train?" },
      },
    ]);
  });

  it("uses the caption when the replied-to message has no text", async () => {
    await send(51, { text: "where is this?", reply_to_message: original({ photo: [{ file_id: "p", width: 1, height: 1 }], caption: "Sunset at the pier" }) });
    expect((await flushed())[0].reply_to).toEqual({ message_id: 40, text: "Sunset at the pier" });
  });

  it("prefers text over caption", async () => {
    await send(52, { text: "ok", reply_to_message: original({ text: "the text", caption: "a caption" }) });
    expect((await flushed())[0].reply_to).toEqual({ message_id: 40, text: "the text" });
  });

  it("keeps only message_id when the replied-to message has no text or caption", async () => {
    await send(53, { text: "what's this?", reply_to_message: original({ voice: { file_id: "v" } }) });
    await send(54, { text: "and this?", reply_to_message: original({ message_id: 41, text: "" }) });
    const entries = await flushed();
    expect(entries.map((m) => m.reply_to)).toEqual([{ message_id: 40 }, { message_id: 41 }]);
    expect(entries[0].reply_to).not.toHaveProperty("text");
  });

  it("truncates long replied-to text to 300 characters ending in an ellipsis", async () => {
    await send(55, { text: "summarise", reply_to_message: original({ text: "a".repeat(1000) }) });
    await send(56, { text: "exact", reply_to_message: original({ message_id: 41, text: "b".repeat(300) }) });
    await send(57, { text: "emoji", reply_to_message: original({ message_id: 42, text: "😀".repeat(301) }) });
    const [long, exact, emoji] = (await flushed()).map((m) => m.reply_to.text);
    expect(long).toBe(`${"a".repeat(299)}…`);
    expect([...long]).toHaveLength(300);
    expect(exact).toBe("b".repeat(300));
    expect(emoji).toBe(`${"😀".repeat(299)}…`);
  });

  it("omits reply_to on messages that are not replies", async () => {
    await send(58, { text: "plain" });
    expect((await flushed())[0]).not.toHaveProperty("reply_to");
  });

  it("keeps each message's reply_to inside one debounced batch", async () => {
    await send(60, { text: "first, no reply" });
    await vi.advanceTimersByTimeAsync(500);
    await send(61, { text: "yes to this", reply_to_message: original({ message_id: 44, text: "Want the summary?" }) });
    await vi.advanceTimersByTimeAsync(500);
    await send(62, { photo: [{ file_id: "p1", width: 1, height: 1 }], caption: "and this one", reply_to_message: original({ message_id: 45, caption: "Old photo" }) });
    const entries = await flushed();
    const batches = fetchMock.mock.calls.filter(([url]) => url === env.GROKBOT_WEBHOOK_URL);
    expect(batches).toHaveLength(1);
    expect(entries.map((m) => [m.message_id, m.reply_to ?? null])).toEqual([
      [60, null],
      [61, { message_id: 44, text: "Want the summary?" }],
      [62, { message_id: 45, text: "Old photo" }],
    ]);
  });
});
