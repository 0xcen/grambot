import { handleFile } from "./file-url";
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
  DEBOUNCE_MS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  RATE_LIMIT_PER_DAY?: string;
  MAX_MESSAGE_CHARS?: string;
  CHAT_BUFFER: DurableObjectNamespace;
  OWNER_STORE: DurableObjectNamespace;
}

export { ChatBuffer } from "./chat-buffer";
export { OwnerStore } from "./owner-store";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/telegram") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return handleTelegramWebhook(request, env);
    }

    if (pathname === "/mcp") {
      return handleMcp(request, env);
    }

    if (pathname === "/setup") {
      return handleSetup(request, env);
    }

    if (pathname.startsWith("/file/")) {
      return handleFile(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
