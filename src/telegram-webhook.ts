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
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return ok();
  }

  const allowlist = parseAllowlist(env.ALLOWED_USER_IDS);
  if (!allowlist) {
    console.error("config error: ALLOWED_USER_IDS is empty or invalid, dropping update");
    return ok();
  }

  const message = update.message;
  if (!message?.from || typeof message.text !== "string") return ok();
  if (!isAllowed(allowlist, message.from.id)) return ok();

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

async function forwardToGrokBot(env: Env, payload: ForwardPayload): Promise<void> {
  if (!env.GROKBOT_WEBHOOK_URL) {
    console.error("forward skipped: GROKBOT_WEBHOOK_URL is not set");
    return;
  }

  const headerName = env.GROKBOT_WEBHOOK_AUTH_HEADER?.trim() || "Authorization";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.GROKBOT_WEBHOOK_AUTH) headers[headerName] = env.GROKBOT_WEBHOOK_AUTH;

  try {
    const res = await fetch(env.GROKBOT_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`forward failed: Grok Bot webhook returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`forward failed: ${err instanceof Error ? err.name : "unknown error"}`);
  }
}
