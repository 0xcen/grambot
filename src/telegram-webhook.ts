import type { Env } from "./index";
import { bufferMessage } from "./chat-buffer";
import { signedFileUrl } from "./file-url";
import { BOT_DOWNLOAD_LIMIT, getFile, TOO_BIG_TO_DOWNLOAD } from "./telegram-api";
import { constantTimeEqual, isAllowed, parseAllowlist } from "./util";

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramFile;
  audio?: TelegramFile;
  document?: TelegramFile;
  from?: TelegramUser;
  chat: { id: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type MediaType = "photo" | "voice" | "audio" | "document";
type IncomingMedia = TelegramFile & { type: MediaType };

export type ForwardedMedia = Omit<IncomingMedia, "file_id"> &
  ({ url: string; expires_at: number } | { error: string });

/** One allowlisted message as the chat buffer stores it, before its media is resolved. */
export interface BufferedMessage {
  message_id: number;
  date: number;
  from: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  media?: IncomingMedia;
}

/** One entry in a forwarded batch. An album becomes one entry holding every item. */
export interface BatchMessage {
  message_id: number;
  date: number;
  from: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  media?: ForwardedMedia[];
}

export interface BatchPayload {
  chat_id: number;
  messages: BatchMessage[];
}

// Telegram sends every photo in several sizes. Only the largest is worth forwarding,
// and Telegram always serves photos as JPEG.
function largestPhoto(sizes: TelegramPhotoSize[] | undefined): TelegramFile | undefined {
  if (!sizes?.length) return undefined;
  const area = (p: TelegramPhotoSize) => p.width * p.height;
  const best = sizes.reduce((a, b) =>
    area(b) > area(a) || (area(b) === area(a) && (b.file_size ?? 0) > (a.file_size ?? 0)) ? b : a,
  );
  return { file_id: best.file_id, file_size: best.file_size, mime_type: "image/jpeg" };
}

const MEDIA_KINDS: Record<MediaType, (m: TelegramMessage) => TelegramFile | undefined> = {
  photo: (m) => largestPhoto(m.photo),
  voice: (m) => m.voice,
  audio: (m) => m.audio,
  document: (m) => m.document,
};

function extractMedia(message: TelegramMessage): IncomingMedia | undefined {
  for (const [type, pick] of Object.entries(MEDIA_KINDS) as [MediaType, (typeof MEDIA_KINDS)[MediaType]][]) {
    const file = pick(message);
    if (typeof file?.file_id === "string") {
      const { file_id, file_size, mime_type, file_name } = file;
      return { type, file_id, file_size, mime_type, file_name };
    }
  }
  return undefined;
}

export async function resolveMedia(env: Env, origin: string, media: IncomingMedia): Promise<ForwardedMedia> {
  const { file_id, ...info } = media;
  if ((info.file_size ?? 0) > BOT_DOWNLOAD_LIMIT) return { ...info, error: TOO_BIG_TO_DOWNLOAD };
  const file = await getFile(env, file_id);
  if (!file.ok) return { ...info, error: file.error };
  return { ...info, file_size: info.file_size ?? file.file_size, ...(await signedFileUrl(env, origin, file_id)) };
}

const ok = () => new Response("ok", { status: 200 });

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TG_WEBHOOK_SECRET || !(await constantTimeEqual(provided, env.TG_WEBHOOK_SECRET))) {
    console.log("telegram: rejected update, webhook secret header missing or wrong");
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    console.log("telegram: update body is not JSON");
    return ok();
  }

  const allowlist = parseAllowlist(env.ALLOWED_USER_IDS);
  if (!allowlist) {
    console.error("config error: ALLOWED_USER_IDS is empty or invalid, dropping update");
    return ok();
  }

  const message = update.message;
  if (!message?.from) return ok();
  if (!isAllowed(allowlist, message.from.id)) {
    console.log("telegram: sender is not allowlisted, dropping");
    return ok();
  }

  const media = extractMedia(message);
  if (typeof message.text !== "string" && !media) return ok();

  const buffered: BufferedMessage = {
    message_id: message.message_id,
    date: message.date,
    from: message.from,
    text: message.text,
    caption: media ? message.caption : undefined,
    media_group_id: media ? message.media_group_id : undefined,
    media,
  };

  // A non-200 makes Telegram redeliver, and the buffer keys messages by id, so a
  // retry after a failed hand-off cannot duplicate a message.
  try {
    await bufferMessage(env, new URL(request.url).origin, message.chat.id, buffered);
  } catch (err) {
    console.error(`telegram: could not buffer message: ${err instanceof Error ? err.message : "unknown error"}`);
    return new Response("Service Unavailable", { status: 503 });
  }
  return ok();
}

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

function stripQuotes(value: string): string {
  let v = value.trim();
  while (v.length >= 2 && /^["'`].*["'`]$/s.test(v) && v[0] === v[v.length - 1]) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Accepts whatever a human pasted from the routine panel (bare key, "Bearer <key>",
 * a full "Authorization: Bearer <key>" line, quoted, with stray newlines) and returns
 * the exact header value. For the Authorization header that is always "Bearer <key>".
 */
function normalizeAuth(headerName: string, raw: string): string {
  let v = stripQuotes(raw.replace(INVISIBLE, ""));
  const prefix = `${headerName.toLowerCase()}:`;
  if (v.toLowerCase().startsWith(prefix)) v = stripQuotes(v.slice(prefix.length));
  if (headerName.toLowerCase() !== "authorization") return v;

  const key = stripQuotes(v.replace(/^bearer(\s+|$)/i, "")).replace(/\s+/g, "");
  return key ? `Bearer ${key}` : "";
}

export async function forwardToGrokBot(env: Env, payload: BatchPayload): Promise<void> {
  if (!env.GROKBOT_WEBHOOK_URL) {
    console.error("forward skipped: GROKBOT_WEBHOOK_URL is not set");
    return;
  }

  const headerName = env.GROKBOT_WEBHOOK_AUTH_HEADER?.trim() || "Authorization";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = env.GROKBOT_WEBHOOK_AUTH ? normalizeAuth(headerName, env.GROKBOT_WEBHOOK_AUTH) : "";
  if (auth) headers[headerName] = auth;

  try {
    const res = await fetch(env.GROKBOT_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const line = `forward ${res.ok ? "ok" : "failed"}: Grok Bot webhook returned HTTP ${res.status}`;
    if (res.ok) console.log(line);
    else console.error(line);
  } catch (err) {
    console.error(`forward failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}
