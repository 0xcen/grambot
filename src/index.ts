import { handleMcp } from "./mcp";
import { handleSetup } from "./setup";
import { handleTelegramWebhook } from "./telegram-webhook";

export interface Env {
  BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  MCP_BEARER_TOKEN: string;
  ALLOWED_USER_IDS: string;
  GROKBOT_WEBHOOK_URL: string;
  GROKBOT_WEBHOOK_AUTH: string;
  GROKBOT_WEBHOOK_AUTH_HEADER?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/telegram") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleTelegramWebhook(request, env, ctx);
    }

    if (pathname === "/mcp") {
      return handleMcp(request, env);
    }

    if (pathname === "/setup") {
      return handleSetup(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
