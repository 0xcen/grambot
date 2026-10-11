import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const BASE = "https://worker.example";
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const NOW_S = NOW / 1000;
const MB = 1024 * 1024;

const env: Env = {
  BOT_TOKEN: "123:test-bot-token",
  TG_WEBHOOK_SECRET: "tg-secret",
  MCP_BEARER_TOKEN: "mcp-token",
  ALLOWED_USER_IDS: "111, 222",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/abc",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-key-xyz",
};

const FILES: Record<string, { file_path: string; file_size: number; bytes: string }> = {
  "photo-big": { file_path: "photos/file_9.jpg", file_size: 120_000, bytes: "JPEG-BIG" },
  "voice-1": { file_path: "voice/file_3.oga", file_size: 9_000, bytes: "OGG-VOICE" },
  "audio-1": { file_path: "music/file_4.mp3", file_size: 3_000_000, bytes: "MP3-AUDIO" },
  "doc-1": { file_path: "documents/file_5.pdf", file_size: 52_000, bytes: "%PDF-1.7" },
  "huge-at-proxy": { file_path: "documents/file_6.bin", file_size: 25 * MB, bytes: "" },
};

let fetchMock: ReturnType<typeof vi.fn>;
let pending: Promise<unknown>[];

const tgJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeNetwork(url: string, init?: RequestInit): Response {
  const api = "https://api.telegram.org/bot123:test-bot-token/";
  const files = "https://api.telegram.org/file/bot123:test-bot-token/";
  if (url === `${api}getFile`) {
    const { file_id } = JSON.parse(String(init?.body));
    const file = FILES[file_id];
    if (!file) return tgJson({ ok: false, description: "Bad Request: invalid file_id" }, 400);
    return tgJson({ ok: true, result: { file_id, file_path: file.file_path, file_size: file.file_size } });
  }
  if (url.startsWith(files)) {
    const file = Object.values(FILES).find((f) => url === files + f.file_path);
    return file ? new Response(file.bytes, { headers: { "Content-Type": "application/octet-stream" } }) : new Response("", { status: 404 });
  }
  if (url.startsWith(api)) return tgJson({ ok: true, result: { message_id: 77 } });
  return new Response("ok");
}

function ctx(): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
}

async function call(req: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const res = await worker.fetch(req, { ...env, ...overrides }, ctx());
  await Promise.all(pending);
  return res;
}

function update(fromId: number, fields: Record<string, unknown>) {
  return {
    update_id: 9,
    message: {
      message_id: 42,
      date: 1_700_000_000,
      from: { id: fromId, is_bot: false, first_name: "Ada" },
      chat: { id: fromId, type: "private" },
      ...fields,
    },
  };
}

function webhook(body: unknown, secret: string | null = env.TG_WEBHOOK_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request(`${BASE}/telegram`, { method: "POST", headers, body: JSON.stringify(body) });
}

function forwarded(): any {
  const calls = fetchMock.mock.calls.filter(([url]) => url === env.GROKBOT_WEBHOOK_URL);
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0][1].body);
}

const telegramCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("api.telegram.org"));

const MEDIA_UPDATES: [string, Record<string, unknown>][] = [
  ["photo", { photo: [{ file_id: "photo-big", width: 1280, height: 960 }] }],
  ["voice", { voice: { file_id: "voice-1", duration: 3, mime_type: "audio/ogg" } }],
  ["audio", { audio: { file_id: "audio-1", duration: 200, mime_type: "audio/mpeg", file_name: "song.mp3" } }],
  ["document", { document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "report.pdf" } }],
];

beforeEach(() => {
  pending = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => fakeNetwork(url, init));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /telegram with media", () => {
  it.each(MEDIA_UPDATES)("%s: returns 401 without the secret header and calls nothing", async (_, fields) => {
    const res = await call(webhook(update(111, fields), null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(MEDIA_UPDATES)("%s: returns 401 with a wrong secret header and calls nothing", async (_, fields) => {
    const res = await call(webhook(update(111, fields), "wrong"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(MEDIA_UPDATES)("%s: drops a non-allowlisted sender before calling getFile", async (_, fields) => {
    const res = await call(webhook(update(999, fields)));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(MEDIA_UPDATES)("%s: never forwards when the allowlist is misconfigured", async (_, fields) => {
    const res = await call(webhook(update(111, fields)), { ALLOWED_USER_IDS: "" });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the largest photo size with its caption and a signed Worker URL", async () => {
    const res = await call(
      webhook(
        update(222, {
          caption: "what is this?",
          photo: [
            { file_id: "photo-small", width: 90, height: 67, file_size: 1_200 },
            { file_id: "photo-big", width: 1280, height: 960, file_size: 120_000 },
            { file_id: "photo-mid", width: 320, height: 240, file_size: 14_000 },
          ],
        }),
      ),
    );
    expect(res.status).toBe(200);

    const getFileBody = JSON.parse(fetchMock.mock.calls.find(([u]) => String(u).endsWith("/getFile"))![1].body);
    expect(getFileBody).toEqual({ file_id: "photo-big" });

    const body = forwarded();
    expect(body).toEqual({
      chat_id: 222,
      message_id: 42,
      date: 1_700_000_000,
      from: { id: 222, is_bot: false, first_name: "Ada" },
      caption: "what is this?",
      media: {
        type: "photo",
        mime_type: "image/jpeg",
        file_size: 120_000,
        url: expect.stringMatching(/^https:\/\/worker\.example\/file\/photo-big\?exp=\d+&sig=[0-9a-f]{64}$/),
        expires_at: NOW_S + 900,
      },
    });
    expect(body.media.url).toContain(`exp=${NOW_S + 900}`);
  });

  it.each([
    ["voice", MEDIA_UPDATES[1][1], { type: "voice", mime_type: "audio/ogg", file_size: 9_000 }],
    ["audio", MEDIA_UPDATES[2][1], { type: "audio", mime_type: "audio/mpeg", file_name: "song.mp3", file_size: 3_000_000 }],
    ["document", MEDIA_UPDATES[3][1], { type: "document", mime_type: "application/pdf", file_name: "report.pdf", file_size: 52_000 }],
  ])("forwards a %s with its metadata and caption", async (_, fields, expected) => {
    await call(webhook(update(111, { ...fields, caption: "listen" })));
    const body = forwarded();
    expect(body.caption).toBe("listen");
    expect(body.text).toBeUndefined();
    const { url, expires_at, ...meta } = body.media;
    expect(meta).toEqual(expected);
    expect(url).toMatch(/^https:\/\/worker\.example\/file\/[\w-]+\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect(expires_at).toBe(NOW_S + 900);
  });

  it("forwards media without a caption", async () => {
    await call(webhook(update(111, MEDIA_UPDATES[3][1])));
    expect("caption" in forwarded()).toBe(false);
  });

  it("never puts BOT_TOKEN or the Telegram file path in the forwarded payload", async () => {
    await call(webhook(update(111, MEDIA_UPDATES[3][1])));
    const raw = JSON.stringify(forwarded());
    expect(raw).not.toContain(env.BOT_TOKEN);
    expect(raw).not.toContain("documents/file_5.pdf");
    expect(raw).not.toContain("api.telegram.org");
  });

  it("forwards a clear error instead of a URL for a file over 20 MB, without calling getFile", async () => {
    await call(
      webhook(update(111, { caption: "big", document: { file_id: "doc-huge", file_name: "x.zip", file_size: 21 * MB } })),
    );
    expect(telegramCalls()).toEqual([]);
    expect(forwarded().media).toEqual({
      type: "document",
      file_name: "x.zip",
      file_size: 21 * MB,
      error: "File is larger than 20 MB, the most a Telegram bot can download. Ask for a smaller file.",
    });
  });

  it("forwards the 20 MB error when getFile says the file is too big", async () => {
    fetchMock.mockImplementationOnce(async () => tgJson({ ok: false, description: "Bad Request: file is too big" }, 400));
    await call(webhook(update(111, { document: { file_id: "doc-1", file_name: "a.bin" } })));
    expect(forwarded().media.error).toBe(
      "File is larger than 20 MB, the most a Telegram bot can download. Ask for a smaller file.",
    );
  });

  it("forwards a lookup error when getFile fails", async () => {
    await call(webhook(update(111, { voice: { file_id: "missing", duration: 1 } })));
    expect(forwarded().media).toEqual({ type: "voice", error: "Telegram could not find this file." });
  });

  it("still ignores updates that have neither text nor supported media", async () => {
    await call(webhook(update(111, { sticker: { file_id: "s" } })));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /file/<file_id>", () => {
  async function linkFor(fields: Record<string, unknown>): Promise<string> {
    await call(webhook(update(111, fields)));
    const url = forwarded().media.url as string;
    fetchMock.mockClear();
    pending = [];
    return url;
  }

  const get = (url: string, overrides: Partial<Env> = {}) => call(new Request(url), overrides);

  it("streams the file bytes for a valid link, fetching from Telegram with the token only server side", async () => {
    const url = await linkFor(MEDIA_UPDATES[3][1]);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.7");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(telegramCalls()).toEqual([
      "https://api.telegram.org/bot123:test-bot-token/getFile",
      "https://api.telegram.org/file/bot123:test-bot-token/documents/file_5.pdf",
    ]);
  });

  it("still works just before the 15 minute expiry", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    vi.setSystemTime(NOW + 899_000);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("JPEG-BIG");
  });

  it("returns 403 once the link has expired", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    vi.setSystemTime(NOW + 900_000);
    const res = await get(url);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden: this file link has expired.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a flipped signature character", (u: URL) => u.searchParams.set("sig", flip(u.searchParams.get("sig")!))],
    ["a later exp", (u: URL) => u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 3600))],
    ["another file_id", (u: URL) => (u.pathname = "/file/voice-1")],
    ["no sig", (u: URL) => u.searchParams.delete("sig")],
    ["no exp", (u: URL) => u.searchParams.delete("exp")],
    ["a non-numeric exp", (u: URL) => u.searchParams.set("exp", "1e99")],
    ["a truncated signature", (u: URL) => u.searchParams.set("sig", u.searchParams.get("sig")!.slice(0, 32))],
  ])("returns 403 for a link with %s", async (_, tamper) => {
    const url = new URL(await linkFor(MEDIA_UPDATES[0][1]));
    tamper(url);
    const res = await get(url.toString());
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a link signed before BOT_TOKEN was rotated", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    const res = await get(url, { BOT_TOKEN: "123:rotated-token" });
    expect(res.status).toBe(403);
  });

  it("returns 413 with the 20 MB message when Telegram reports the file is too big", async () => {
    const url = await linkFor({ document: { file_id: "doc-1" } });
    fetchMock.mockImplementationOnce(async () =>
      tgJson({ ok: true, result: { file_id: "huge-at-proxy", file_path: "documents/file_6.bin", file_size: 25 * MB } }),
    );
    const res = await get(url);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe(
      "File is larger than 20 MB, the most a Telegram bot can download. Ask for a smaller file.",
    );
  });

  it("returns 503 and serves nothing when the allowlist is misconfigured", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    const res = await get(url, { ALLOWED_USER_IDS: "" });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 405 for POST", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    const res = await call(new Request(url, { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("returns 502 without leaking the token when the download fails", async () => {
    const url = await linkFor(MEDIA_UPDATES[0][1]);
    fetchMock.mockImplementationOnce(async (u: string, i?: RequestInit) => fakeNetwork(u, i));
    fetchMock.mockImplementationOnce(async () => new Response("gone", { status: 404 }));
    const res = await get(url);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Could not download the file from Telegram.");
  });
});

function flip(sig: string): string {
  return (sig[0] === "a" ? "b" : "a") + sig.slice(1);
}

function mcp(name: string, args: Record<string, unknown>, token: string | null = env.MCP_BEARER_TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function tool(name: string, args: Record<string, unknown>, overrides: Partial<Env> = {}) {
  const body = await (await call(mcp(name, args), overrides)).json<any>();
  return body.result as { isError?: boolean; content: { text: string }[] };
}

const OUTBOUND = [
  ["send_telegram_photo", "sendPhoto", "photo", "photo.jpg", "image/jpeg"],
  ["send_telegram_voice", "sendVoice", "voice", "voice.ogg", "audio/ogg"],
  ["send_telegram_document", "sendDocument", "document", "notes.txt", "application/octet-stream"],
] as const;

describe("outbound media tools", () => {
  it.each(OUTBOUND)("%s with url sends JSON to %s", async (name, method, field) => {
    const result = await tool(name, { chat_id: 111, url: "https://cdn.example/a.bin", caption: "here" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, message_id: 77 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot123:test-bot-token/${method}`);
    expect(JSON.parse(init.body)).toEqual({ chat_id: 111, [field]: "https://cdn.example/a.bin", caption: "here" });
  });

  it.each(OUTBOUND)("%s with base64 uploads multipart to %s", async (name, method, field, defaultName, defaultMime) => {
    const filename = name === "send_telegram_document" ? "notes.txt" : undefined;
    const result = await tool(name, {
      chat_id: "222",
      base64: btoa("hello media"),
      caption: "cap",
      ...(filename ? { filename } : {}),
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, message_id: 77 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot123:test-bot-token/${method}`);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("222");
    expect(form.get("caption")).toBe("cap");
    const file = form.get(field) as File;
    expect(file.name).toBe(defaultName);
    expect(file.type).toBe(defaultMime);
    expect(await file.text()).toBe("hello media");
  });

  it("takes the mime type from a data: URL and honours filename and mime_type overrides", async () => {
    await tool("send_telegram_photo", { chat_id: 111, base64: `data:image/png;base64,${btoa("png")}` });
    expect(((fetchMock.mock.calls[0][1].body as FormData).get("photo") as File).type).toBe("image/png");

    await tool("send_telegram_document", {
      chat_id: 111,
      base64: btoa("a,b"),
      filename: "t.csv",
      mime_type: "text/csv",
    });
    const file = (fetchMock.mock.calls[1][1].body as FormData).get("document") as File;
    expect([file.name, file.type, await file.text()]).toEqual(["t.csv", "text/csv", "a,b"]);
  });

  it.each(OUTBOUND)("%s refuses a chat outside the allowlist", async (name) => {
    for (const args of [
      { chat_id: 999, url: "https://cdn.example/a.jpg" },
      { chat_id: "999", base64: btoa("x"), filename: "x.bin" },
    ]) {
      const result = await tool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("chat_id is not in the allowlist");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(OUTBOUND)("%s refuses with a config error when the allowlist is empty", async (name) => {
    const result = await tool(name, { chat_id: 111, url: "https://cdn.example/a.jpg" }, { ALLOWED_USER_IDS: "" });
    expect(result.content[0].text).toContain("Server misconfigured: ALLOWED_USER_IDS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(OUTBOUND)("%s returns 401 without the bearer token", async (name) => {
    const res = await call(mcp(name, { chat_id: 111, url: "https://cdn.example/a.jpg" }, null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["both url and base64", { url: "https://cdn.example/a", base64: "eA==" }, "Pass exactly one of url or base64"],
    ["neither url nor base64", {}, "Pass exactly one of url or base64"],
    ["a non-http url", { url: "file:///etc/passwd" }, "url must be an http or https URL"],
    ["filename with a url", { url: "https://cdn.example/a", filename: "a.jpg" }, "filename and mime_type only apply to base64 uploads"],
    ["invalid base64", { base64: "not base64!" }, "base64 is empty or not valid base64"],
    ["empty base64", { base64: "" }, "base64 is empty or not valid base64"],
    ["a bad mime_type", { base64: "eA==", mime_type: "png" }, "mime_type must look like type/subtype, for example image/png"],
    ["a long caption", { url: "https://cdn.example/a", caption: "x".repeat(1025) }, "caption is 1025 characters. Telegram allows at most 1024."],
  ])("rejects %s with a clear error", async (_, args, message) => {
    const result = await tool("send_telegram_photo", { chat_id: 111, ...args });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a filename for base64 documents", async () => {
    const result = await tool("send_telegram_document", { chat_id: 111, base64: btoa("x") });
    expect(result.content[0].text).toBe("filename is required when sending a file as base64");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["send_telegram_photo", 10, "photo"],
    ["send_telegram_voice", 20, "voice message"],
    ["send_telegram_document", 20, "file"],
  ] as const)("%s rejects base64 over %i MB before calling Telegram", async (name, capMb, noun) => {
    const base64 = "A".repeat(Math.ceil(((capMb * MB + 1) * 4) / 3 / 4) * 4);
    const result = await tool(name, { chat_id: 111, base64, filename: "big.bin" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`The ${noun} is ${capMb.toFixed(1)} MB. base64 uploads are capped at ${capMb} MB.`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Telegram errors without the bot token", async () => {
    fetchMock.mockImplementationOnce(async () => tgJson({ ok: false, description: "Bad Request: wrong file identifier/HTTP URL specified" }, 400));
    const result = await tool("send_telegram_voice", { chat_id: 111, url: "https://cdn.example/v.ogg" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Telegram sendVoice failed: Bad Request: wrong file identifier/HTTP URL specified");
  });
});
