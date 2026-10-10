import type { Env } from "./index";
import { constantTimeEqual, isAllowed, parseAllowlist } from "./util";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: "grokbot-telegram", version: "0.1.0" };
const TELEGRAM_MAX_TEXT = 4096;
const PARSE_MODES = ["MarkdownV2", "HTML", "Markdown"] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const TOOLS = [
  {
    name: "send_telegram_message",
    description:
      "Send a Telegram message from the bot to an allowlisted chat. Texts longer than 4096 characters are split into several messages.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: ["integer", "string"],
          description: "Target chat id. Must be in the allowlist.",
        },
        text: { type: "string", description: "Message text." },
        reply_to_message_id: {
          type: "integer",
          description: "Optional id of the message to reply to.",
        },
        parse_mode: {
          type: "string",
          enum: PARSE_MODES,
          description: "Optional Telegram parse mode.",
        },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_typing",
    description:
      "Show the 'typing...' indicator in an allowlisted chat for about 5 seconds. Call it before slower work.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: ["integer", "string"],
          description: "Target chat id. Must be in the allowlist.",
        },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.MCP_BEARER_TOKEN || !(await constantTimeEqual(token, env.MCP_BEARER_TOKEN))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  const response = await handleMessage(body, env);
  return response ? json(response) : new Response(null, { status: 202 });
}

async function handleMessage(msg: unknown, env: Env): Promise<object | null> {
  if (!msg || typeof msg !== "object" || (msg as JsonRpcRequest).jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg as JsonRpcRequest;
  const isNotification = id === undefined;

  if (typeof method !== "string") {
    return isNotification ? null : rpcError(id ?? null, -32600, "Invalid Request");
  }

  // Notifications and client responses get no reply in a stateless server.
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Send Telegram messages as the bot. Only allowlisted chat ids are accepted.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "send_telegram_message") return rpcResult(id, await sendMessage(args, env));
      if (name === "send_typing") return rpcResult(id, await sendTyping(args, env));
      return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const toolError = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
const toolOk = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

function checkChat(args: Record<string, unknown>, env: Env): string | null {
  const chatId = args.chat_id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return "chat_id is required";
  if (!isAllowed(parseAllowlist(env.ALLOWED_USER_IDS), chatId)) {
    return "chat_id is not in the allowlist";
  }
  return null;
}

async function sendMessage(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const chatError = checkChat(args, env);
  if (chatError) return toolError(chatError);

  const { chat_id, text, reply_to_message_id, parse_mode } = args;
  if (typeof text !== "string" || text.length === 0) return toolError("text is required");
  if (reply_to_message_id !== undefined && typeof reply_to_message_id !== "number") {
    return toolError("reply_to_message_id must be an integer");
  }
  if (
    parse_mode !== undefined &&
    !(PARSE_MODES as readonly unknown[]).includes(parse_mode)
  ) {
    return toolError(`parse_mode must be one of ${PARSE_MODES.join(", ")}`);
  }

  const messageIds: number[] = [];
  const chunks = splitText(text, TELEGRAM_MAX_TEXT);
  for (let i = 0; i < chunks.length; i++) {
    const result = await callTelegram(env, "sendMessage", {
      chat_id,
      text: chunks[i],
      ...(parse_mode ? { parse_mode } : {}),
      ...(i === 0 && reply_to_message_id !== undefined
        ? { reply_parameters: { message_id: reply_to_message_id, allow_sending_without_reply: true } }
        : {}),
    });
    if (!result.ok) return toolError(`Telegram sendMessage failed: ${result.description}`);
    const messageId = (result.result as { message_id?: number } | undefined)?.message_id;
    if (typeof messageId === "number") messageIds.push(messageId);
  }

  return toolOk(JSON.stringify({ ok: true, message_ids: messageIds }));
}

async function sendTyping(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const chatError = checkChat(args, env);
  if (chatError) return toolError(chatError);

  const result = await callTelegram(env, "sendChatAction", {
    chat_id: args.chat_id,
    action: "typing",
  });
  if (!result.ok) return toolError(`Telegram sendChatAction failed: ${result.description}`);
  return toolOk(JSON.stringify({ ok: true }));
}

interface TelegramApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

async function callTelegram(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramApiResult> {
  if (!env.BOT_TOKEN) return { ok: false, description: "BOT_TOKEN is not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => null)) as TelegramApiResult | null;
    if (!data) {
      console.error(`telegram ${method} failed: HTTP ${res.status} with non-JSON body`);
      return { ok: false, description: `HTTP ${res.status}` };
    }
    if (!data.ok) console.error(`telegram ${method} failed: HTTP ${res.status} ${data.description ?? ""}`);
    return data;
  } catch (err) {
    console.error(`telegram ${method} failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return { ok: false, description: "network error" };
  }
}

export function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  chunks.push(rest);
  return chunks;
}
