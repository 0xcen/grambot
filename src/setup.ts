import type { Env } from "./index";
import { bearerMatches } from "./auth";

const json = (body: { ok: boolean; description: string }, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Registers this Worker's /telegram route as the bot's webhook, so callers never need BOT_TOKEN. */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!(await bearerMatches(request, env.MCP_BEARER_TOKEN))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="setup"' },
    });
  }

  const missing = [
    !env.BOT_TOKEN && "BOT_TOKEN",
    !env.TG_WEBHOOK_SECRET && "TG_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    return json({ ok: false, description: `Missing or invalid secrets: ${missing.join(", ")}` }, 503);
  }

  const webhookUrl = `${new URL(request.url).origin}/telegram`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TG_WEBHOOK_SECRET,
        allowed_updates: ["message", "message_reaction"],
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: unknown; description?: unknown } | null;
    const ok = data?.ok === true;
    const description =
      typeof data?.description === "string" ? data.description : `Telegram returned HTTP ${res.status}`;
    if (!ok) console.error(`setup: setWebhook failed: HTTP ${res.status} ${description}`);
    return json({ ok, description }, ok ? 200 : 502);
  } catch (err) {
    console.error(`setup: setWebhook failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return json({ ok: false, description: "Could not reach Telegram" }, 502);
  }
}
