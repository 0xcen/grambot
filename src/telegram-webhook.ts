import type { Env } from "./index";
import { bufferMessage } from "./chat-buffer";
import { signedFileUrl } from "./file-url";
import { isAllowed, resolveAccess } from "./access";
import { claimOwner, takeRateToken } from "./owner-store";
import { BOT_DOWNLOAD_LIMIT, callTelegram, getFile, TOO_BIG_TO_DOWNLOAD } from "./telegram-api";
import { constantTimeEqual, envInt, sha256Hex } from "./util";

export const DEFAULT_MAX_MESSAGE_CHARS = 4000;
export const REPLY_TO_MAX_CHARS = 300;
export const CLAIM_CONFIRMATION = "Done. This Telegram account now owns the bot.";

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
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  from?: TelegramUser;
  chat: { id: number; type?: string };
}

type TelegramReactionType = { type: "emoji"; emoji: string } | { type: "custom_emoji" | "paid" };

interface TelegramMessageReaction {
  chat: { id: number };
  message_id: number;
  user?: TelegramUser;
  actor_chat?: { id: number };
  date: number;
  old_reaction?: TelegramReactionType[];
  new_reaction?: TelegramReactionType[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  message_reaction?: TelegramMessageReaction;
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
  /** Set when text or caption was cut to MAX_MESSAGE_CHARS. */
  truncated?: boolean;
  reply_to?: ReplyTo;
}

/** The message this one replies to: its id, and an excerpt of its text or caption when it has one. */
export interface ReplyTo {
  message_id: number;
  text?: string;
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
  truncated?: boolean;
  reply_to?: ReplyTo;
}

/** A reaction change on one message. removed is true when the user cleared their reaction, and emoji is then the one they removed. */
export interface BufferedReaction {
  type: "reaction";
  message_id: number;
  date: number;
  from?: TelegramUser;
  emoji: string;
  removed: boolean;
}

export type BufferedEntry = BufferedMessage | BufferedReaction;
export type BatchEntry = BatchMessage | BufferedReaction;

export const isReaction = (entry: object): entry is BufferedReaction =>
  (entry as { type?: unknown }).type === "reaction";

export interface BatchPayload {
  chat_id: number;
  messages: BatchEntry[];
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

function messageEntry(message: TelegramMessage): BufferedMessage | undefined {
  const media = extractMedia(message);
  if (!message.from || (typeof message.text !== "string" && !media)) return undefined;
  return {
    message_id: message.message_id,
    date: message.date,
    from: message.from,
    text: message.text,
    caption: media ? message.caption : undefined,
    media_group_id: media ? message.media_group_id : undefined,
    media,
    reply_to: replyTo(message.reply_to_message),
  };
}

function replyTo(original: TelegramMessage["reply_to_message"]): ReplyTo | undefined {
  if (typeof original?.message_id !== "number") return undefined;
  const source = typeof original.text === "string" && original.text ? original.text : original.caption;
  if (typeof source !== "string" || !source) return { message_id: original.message_id };
  const chars = [...source];
  const text = chars.length > REPLY_TO_MAX_CHARS ? `${chars.slice(0, REPLY_TO_MAX_CHARS - 1).join("")}…` : source;
  return { message_id: original.message_id, text };
}

const firstEmoji = (reactions: TelegramReactionType[] | undefined) =>
  reactions?.find((r): r is { type: "emoji"; emoji: string } => r.type === "emoji" && typeof r.emoji === "string")
    ?.emoji;

// Custom and paid reactions carry no standard emoji, so they are not forwarded.
function reactionEntry(reaction: TelegramMessageReaction): BufferedReaction | undefined {
  const removed = !reaction.new_reaction?.length;
  const emoji = firstEmoji(removed ? reaction.old_reaction : reaction.new_reaction);
  if (!emoji) return undefined;
  return {
    type: "reaction",
    message_id: reaction.message_id,
    date: reaction.date,
    from: reaction.user,
    emoji,
    removed,
  };
}

interface Inbound {
  /** The user (or anonymous actor chat) the allowlist is checked against. */
  actor: number | undefined;
  chat_id: number;
  entry: BufferedEntry | undefined;
}

function parseUpdate(update: TelegramUpdate): Inbound | undefined {
  const { message, message_reaction: reaction } = update;
  if (message?.chat) return { actor: message.from?.id, chat_id: message.chat.id, entry: messageEntry(message) };
  if (reaction?.chat) {
    return { actor: reaction.user?.id ?? reaction.actor_chat?.id, chat_id: reaction.chat.id, entry: reactionEntry(reaction) };
  }
  return undefined;
}

function truncate(entry: BufferedEntry, max: number): BufferedEntry {
  if (isReaction(entry)) return entry;
  const cut = (value: string | undefined) => {
    if (value === undefined || value.length <= max) return value;
    const chars = [...value];
    return chars.length <= max ? value : chars.slice(0, max).join("");
  };
  const text = cut(entry.text);
  const caption = cut(entry.caption);
  if (text === entry.text && caption === entry.caption) return entry;
  console.log(`telegram: truncated a message to ${max} characters`);
  return { ...entry, text, caption, truncated: true };
}

const START_WITH_CODE = /^\/start(?:@\w+)?\s+(\S+)\s*$/;

/** Handles "/start <code>": binds the sender as owner when the code is valid. Every failure is dropped silently. */
async function handleClaim(env: Env, message: TelegramMessage, code: string): Promise<void> {
  const { chat, from } = message;
  if (chat.type !== "private" || !from || chat.id !== from.id) {
    console.log("claim: ignored /start with a code outside a private chat");
    return;
  }
  const result = await claimOwner(env, await sha256Hex(code), from.id);
  if (!result.ok) {
    console.log(`claim: dropped /start, setup code ${result.reason === "no code" ? "missing or already used" : result.reason}`);
    return;
  }
  console.log("claim: owner bound, ALLOWED_USER_IDS no longer applies");
  await callTelegram(env, "sendMessage", { chat_id: chat.id, text: CLAIM_CONFIRMATION });
}

const ok = () => new Response("ok", { status: 200 });
const unavailable = (what: string, err: unknown) => {
  console.error(`telegram: could not ${what}: ${err instanceof Error ? err.message : "unknown error"}`);
  return new Response("Service Unavailable", { status: 503 });
};

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

  // Claims run before the access check, so a fresh install with no owner and no
  // ALLOWED_USER_IDS can still be claimed. They are never forwarded to the routine.
  const code = update.message?.chat && update.message.text?.match(START_WITH_CODE)?.[1];
  if (code) {
    try {
      await handleClaim(env, update.message!, code);
    } catch (err) {
      return unavailable("check the setup code", err);
    }
    return ok();
  }

  const inbound = parseUpdate(update);
  if (!inbound) return ok();

  let access;
  try {
    access = await resolveAccess(env);
  } catch (err) {
    return unavailable("load the owner", err);
  }
  if (access.mode === "closed") {
    console.error("config error: no owner is bound and ALLOWED_USER_IDS is empty or invalid, dropping update");
    return ok();
  }
  if (!isAllowed(access, inbound.actor, inbound.chat_id)) {
    console.log(access.mode === "owner" ? "telegram: not the owner's private chat, dropping" : "telegram: sender is not allowlisted, dropping");
    return ok();
  }
  if (!inbound.entry) return ok();

  // A non-200 makes Telegram redeliver, and the buffer keys entries by message id, so a
  // retry after a failed hand-off cannot duplicate one.
  try {
    const rate = await takeRateToken(env, inbound.actor!);
    if (!rate.ok) {
      console.log(`telegram: ${rate.reason} rate limit reached, dropping`);
      return ok();
    }
    const entry = truncate(inbound.entry, envInt(env.MAX_MESSAGE_CHARS, DEFAULT_MAX_MESSAGE_CHARS));
    await bufferMessage(env, new URL(request.url).origin, inbound.chat_id, entry);
  } catch (err) {
    return unavailable("buffer message", err);
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
