import type { Env } from "./index";
import { constantTimeEqual, isAllowed, parseAllowlist } from "./util";

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  from?: TelegramUser;
  chat: { id: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ForwardPayload {
  chat_id: number;
  message_id: number;
  text: string;
  date: number;
  from: TelegramUser;
}

const ok = () => new Response("ok", { status: 200 });

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  const kinds = Object.keys(update).filter((k) => k !== "update_id");
  const fromId = (update as unknown as Record<string, { from?: { id?: unknown } } | undefined>)[kinds[0] ?? ""]
    ?.from?.id;
  console.log(
    `telegram: update kinds=${kinds.join(",") || "none"} from.id=${String(fromId)} has_text=${typeof update.message?.text === "string"}`,
  );

  const allowlist = parseAllowlist(env.ALLOWED_USER_IDS);
  if (!allowlist) {
    console.error("config error: ALLOWED_USER_IDS is empty or invalid, dropping update");
    return ok();
  }

  const message = update.message;
  if (!message?.from || typeof message.text !== "string") return ok();
  if (!isAllowed(allowlist, message.from.id)) {
    console.log(`telegram: from.id=${message.from.id} not allowlisted, dropping`);
    return ok();
  }

  const payload: ForwardPayload = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: message.text,
    date: message.date,
    from: message.from,
  };

  ctx.waitUntil(forwardToGrokBot(env, payload));
  return ok();
}

export interface AuthShape {
  length: number;
  hadEdgeWhitespace: boolean;
  hadQuotes: boolean;
  hadHeaderName: boolean;
  hadBearer: boolean;
  hadInvisibleChars: boolean;
}

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

function stripQuotes(value: string): { value: string; stripped: boolean } {
  let stripped = false;
  let v = value.trim();
  while (v.length >= 2 && /^["'`].*["'`]$/s.test(v) && v[0] === v[v.length - 1]) {
    v = v.slice(1, -1).trim();
    stripped = true;
  }
  return { value: v, stripped };
}

/**
 * Accepts whatever a human pasted from the routine panel (bare key, "Bearer <key>",
 * a full "Authorization: Bearer <key>" line, quoted, with stray newlines) and returns
 * the exact header value. For the Authorization header that is always "Bearer <key>".
 */
export function normalizeAuth(headerName: string, raw: string): { value: string; shape: AuthShape } {
  const shape: AuthShape = {
    length: raw.length,
    hadEdgeWhitespace: raw !== raw.trim(),
    hadQuotes: false,
    hadHeaderName: false,
    hadBearer: false,
    hadInvisibleChars: raw.replace(INVISIBLE, "") !== raw,
  };
  let v = raw.replace(INVISIBLE, "").trim();

  let q = stripQuotes(v);
  v = q.value;
  shape.hadQuotes = q.stripped;

  const prefix = `${headerName.toLowerCase()}:`;
  if (v.toLowerCase().startsWith(prefix)) {
    shape.hadHeaderName = true;
    q = stripQuotes(v.slice(prefix.length));
    v = q.value;
    shape.hadQuotes ||= q.stripped;
  }

  if (headerName.toLowerCase() !== "authorization") return { value: v, shape };

  const bearer = /^bearer\s+/i.exec(v);
  if (bearer) {
    shape.hadBearer = true;
    v = v.slice(bearer[0].length);
  }
  q = stripQuotes(v);
  shape.hadQuotes ||= q.stripped;
  const key = q.value.replace(/\s+/g, "");
  return { value: key ? `Bearer ${key}` : "", shape };
}

async function forwardToGrokBot(env: Env, payload: ForwardPayload): Promise<void> {
  if (!env.GROKBOT_WEBHOOK_URL) {
    console.error("forward skipped: GROKBOT_WEBHOOK_URL is not set");
    return;
  }

  const headerName = env.GROKBOT_WEBHOOK_AUTH_HEADER?.trim() || "Authorization";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.GROKBOT_WEBHOOK_AUTH) {
    const { value, shape } = normalizeAuth(headerName, env.GROKBOT_WEBHOOK_AUTH);
    console.log(`forward auth shape: header=${headerName} ${JSON.stringify(shape)} sentLength=${value.length}`);
    if (value) headers[headerName] = value;
  }

  try {
    const res = await fetch(env.GROKBOT_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const snippet = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    const line = `forward ${res.ok ? "ok" : "failed"}: Grok Bot webhook returned HTTP ${res.status} body=${snippet}`;
    if (res.ok) console.log(line);
    else console.error(line);
  } catch (err) {
    console.error(`forward failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}
