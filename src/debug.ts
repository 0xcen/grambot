import { bearerMatches } from "./auth";
import type { Env } from "./index";
import { normalizeAuth } from "./telegram-webhook";

const FIELDS = ["url", "pending_update_count", "last_error_date", "last_error_message", "allowed_updates"];

export async function handleDebug(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!(await bearerMatches(request, env.MCP_BEARER_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!env.BOT_TOKEN) return Response.json({ ok: false, description: "BOT_TOKEN is not configured" });

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: Record<string, unknown> }
    | null;
  const info = Object.fromEntries(FIELDS.map((f) => [f, data?.result?.[f] ?? null]));
  return Response.json({
    ok: data?.ok === true,
    description: data?.description ?? null,
    webhook: info,
    config: {
      grokbot_webhook_url_set: Boolean(env.GROKBOT_WEBHOOK_URL),
      grokbot_webhook_auth_set: Boolean(env.GROKBOT_WEBHOOK_AUTH),
      grokbot_webhook_auth_shape: env.GROKBOT_WEBHOOK_AUTH
        ? (() => {
            const { value, shape } = normalizeAuth(
              env.GROKBOT_WEBHOOK_AUTH_HEADER?.trim() || "Authorization",
              env.GROKBOT_WEBHOOK_AUTH,
            );
            return { ...shape, sentLength: value.length };
          })()
        : null,
      grokbot_webhook_auth_header: env.GROKBOT_WEBHOOK_AUTH_HEADER || "Authorization",
      grokbot_webhook_host: URL.canParse(env.GROKBOT_WEBHOOK_URL ?? "")
        ? new URL(env.GROKBOT_WEBHOOK_URL).host
        : "unparsable",
    },
  });
}
