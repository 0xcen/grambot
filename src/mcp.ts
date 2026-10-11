import type { Env } from "./index";
import { bearerMatches } from "./auth";
import { toReactionEmoji } from "./reactions";
import { resolveAccess, sendRefusal } from "./access";
import { SETUP_CODE_TTL_MS, storeSetupCode } from "./owner-store";
import { callTelegram, MB } from "./telegram-api";
import { sha256Hex } from "./util";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: "grambot", version: "0.1.0" };
const TELEGRAM_MAX_TEXT = 4096;
const TELEGRAM_MAX_CAPTION = 1024;
const PARSE_MODES = ["MarkdownV2", "HTML", "Markdown"] as const;

interface MediaTool {
  method: string;
  field: string;
  noun: string;
  maxBytes: number;
  urlNote: string;
  defaultMime: string;
  defaultFilename?: string;
}

// Upload caps follow Telegram's limits (10 MB for photos) and keep a decoded
// file well inside a Worker's 128 MB of memory for everything else.
const MEDIA_TOOLS: Record<string, MediaTool> = {
  send_telegram_photo: {
    method: "sendPhoto",
    field: "photo",
    noun: "photo",
    maxBytes: 10 * MB,
    urlNote: "Telegram fetches it itself, up to 5 MB.",
    defaultMime: "image/jpeg",
    defaultFilename: "photo.jpg",
  },
  send_telegram_voice: {
    method: "sendVoice",
    field: "voice",
    noun: "voice message",
    maxBytes: 20 * MB,
    urlNote: "Telegram fetches it itself, up to 20 MB. Use OGG/Opus, MP3 or M4A.",
    defaultMime: "audio/ogg",
    defaultFilename: "voice.ogg",
  },
  send_telegram_document: {
    method: "sendDocument",
    field: "document",
    noun: "file",
    maxBytes: 20 * MB,
    urlNote: "Telegram fetches it itself, up to 20 MB.",
    defaultMime: "application/octet-stream",
  },
};

function mediaToolSchema(name: string, tool: MediaTool) {
  const capMb = tool.maxBytes / MB;
  return {
    name,
    description: `Send a ${tool.noun} from the bot to an allowlisted chat. Pass exactly one of url or base64.`,
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: ["integer", "string"],
          description: "Target chat id. Must be in the allowlist.",
        },
        url: { type: "string", description: `Public http(s) URL of the ${tool.noun}. ${tool.urlNote}` },
        base64: {
          type: "string",
          description: `The ${tool.noun} bytes as base64, up to ${capMb} MB decoded. A data: URL prefix is accepted.`,
        },
        filename: {
          type: "string",
          description: tool.defaultFilename
            ? `File name for base64 uploads. Defaults to ${tool.defaultFilename}.`
            : "File name for base64 uploads. Required with base64.",
        },
        mime_type: {
          type: "string",
          description: `MIME type for base64 uploads. Defaults to the data: URL type, then ${tool.defaultMime}.`,
        },
        caption: { type: "string", description: `Optional caption, up to ${TELEGRAM_MAX_CAPTION} characters.` },
      },
      required: ["chat_id"],
      additionalProperties: false,
    },
  };
}

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
  ...Object.entries(MEDIA_TOOLS).map(([name, tool]) => mediaToolSchema(name, tool)),
  {
    name: "send_telegram_reaction",
    description:
      "Set the bot's reaction on a message in an allowlisted chat, or clear it. Use it instead of a reply for a plain acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: ["integer", "string"],
          description: "Target chat id. Must be in the allowlist.",
        },
        message_id: { type: "integer", description: "Id of the message to react to." },
        emoji: {
          type: "string",
          description: "One of Telegram's standard reaction emoji, for example 👍 ❤ 🔥 🎉 👀 🙏. Omit or pass an empty string to clear the bot's reaction.",
        },
      },
      required: ["chat_id", "message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_setup_code",
    description:
      "Create a one time setup link that makes whoever opens it in Telegram and taps Start the bot's owner, replacing any current owner. Expires in 10 minutes. Only call it while setting up or re-pairing the bot in the Grok Bot chat, and show the link only there. Never call it from the Telegram routine and never send the link or code over Telegram.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

  if (!(await bearerMatches(request, env.MCP_BEARER_TOKEN))) {
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
          "Send Telegram messages, photos, voice messages, files and reactions as the bot. Once an owner is bound, only the owner's chat is accepted; before that, only allowlisted chat ids. create_setup_code makes a one time link that binds the owner.",
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
      if (name === "send_telegram_reaction") return rpcResult(id, await sendReaction(args, env));
      if (name === "create_setup_code") return rpcResult(id, await createSetupCode(env));
      if (typeof name === "string" && Object.hasOwn(MEDIA_TOOLS, name)) {
        return rpcResult(id, await sendMedia(MEDIA_TOOLS[name], args, env));
      }
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

async function checkChat(args: Record<string, unknown>, env: Env): Promise<string | null> {
  try {
    return sendRefusal(await resolveAccess(env), args.chat_id);
  } catch (err) {
    console.error(`mcp: could not load the owner: ${err instanceof Error ? err.message : "unknown error"}`);
    return "Could not check who owns the bot. Try again later.";
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function createSetupCode(env: Env): Promise<ToolResult> {
  // 32 random bytes are 43 base64url characters, inside Telegram's 64 character start parameter.
  const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
  let expiresAt: number;
  try {
    expiresAt = await storeSetupCode(env, await sha256Hex(code));
  } catch (err) {
    console.error(`mcp: could not store the setup code: ${err instanceof Error ? err.message : "unknown error"}`);
    return toolError("Could not store the setup code. Try again later.");
  }
  const me = await callTelegram(env, "getMe", {});
  const username = (me.result as { username?: unknown } | undefined)?.username;
  const link = me.ok && typeof username === "string" ? `https://t.me/${username}?start=${code}` : null;
  return toolOk(
    JSON.stringify({
      code,
      link,
      expires_at: new Date(expiresAt).toISOString(),
      expires_in_seconds: SETUP_CODE_TTL_MS / 1000,
      note: link
        ? "Show the link only in this Grok Bot chat. Opening it in Telegram and tapping Start makes that account the bot's owner. It works once and expires in 10 minutes."
        : `Could not look up the bot's username (${me.description ?? "getMe failed"}). Your human can send /start followed by the code to the bot instead. Show the code only in this Grok Bot chat.`,
    }),
  );
}

async function sendMessage(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const chatError = await checkChat(args, env);
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
  const chatError = await checkChat(args, env);
  if (chatError) return toolError(chatError);

  const result = await callTelegram(env, "sendChatAction", {
    chat_id: args.chat_id,
    action: "typing",
  });
  if (!result.ok) return toolError(`Telegram sendChatAction failed: ${result.description}`);
  return toolOk(JSON.stringify({ ok: true }));
}

async function sendReaction(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const chatError = await checkChat(args, env);
  if (chatError) return toolError(chatError);

  const { chat_id, message_id, emoji } = args;
  if (typeof message_id !== "number" || !Number.isInteger(message_id) || message_id <= 0) {
    return toolError("message_id must be a positive integer");
  }
  if (emoji !== undefined && typeof emoji !== "string") return toolError("emoji must be a string");

  let reaction: { type: "emoji"; emoji: string }[] = [];
  if (emoji?.trim()) {
    const allowed = toReactionEmoji(emoji);
    if (!allowed) {
      return toolError(
        `emoji must be exactly one of Telegram's standard reaction emoji, for example 👍 ❤ 🔥 🎉 👀 🙏. Got ${JSON.stringify(emoji)}.`,
      );
    }
    reaction = [{ type: "emoji", emoji: allowed }];
  }

  const result = await callTelegram(env, "setMessageReaction", { chat_id, message_id, reaction });
  if (!result.ok) return toolError(`Telegram setMessageReaction failed: ${result.description}`);
  return toolOk(JSON.stringify({ ok: true, cleared: reaction.length === 0 }));
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[^,;]*)*;base64,/i;

type Upload = { blob: Blob; filename: string } | { error: string };

function decodeUpload(tool: MediaTool, args: Record<string, unknown>): Upload {
  const { base64, filename, mime_type } = args;
  if (typeof base64 !== "string") return { error: "base64 must be a string" };
  if (filename !== undefined && (typeof filename !== "string" || filename.trim() === "")) {
    return { error: "filename must be a non-empty string" };
  }
  if (mime_type !== undefined && (typeof mime_type !== "string" || !mime_type.includes("/"))) {
    return { error: "mime_type must look like type/subtype, for example image/png" };
  }

  const dataUrlMime = DATA_URL.exec(base64)?.[1];
  const data = base64.replace(DATA_URL, "").replace(/\s+/g, "");
  if (data === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: "base64 is empty or not valid base64" };

  const bytes = Math.floor((data.length * 3) / 4) - (data.match(/=+$/)?.[0].length ?? 0);
  if (bytes > tool.maxBytes) {
    const mb = (bytes / MB).toFixed(1);
    return { error: `The ${tool.noun} is ${mb} MB. base64 uploads are capped at ${tool.maxBytes / MB} MB.` };
  }

  const name = (filename as string | undefined) ?? tool.defaultFilename;
  if (!name) return { error: `filename is required when sending a ${tool.noun} as base64` };

  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return { error: "base64 is empty or not valid base64" };
  }
  const buffer = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const type = (mime_type as string | undefined) ?? dataUrlMime ?? tool.defaultMime;
  return { blob: new Blob([buffer], { type }), filename: name };
}

async function sendMedia(tool: MediaTool, args: Record<string, unknown>, env: Env): Promise<ToolResult> {
  const chatError = await checkChat(args, env);
  if (chatError) return toolError(chatError);

  const { chat_id, url, base64, filename, mime_type, caption } = args;
  if ((url === undefined) === (base64 === undefined)) return toolError("Pass exactly one of url or base64");
  if (caption !== undefined && typeof caption !== "string") return toolError("caption must be a string");
  if (typeof caption === "string" && caption.length > TELEGRAM_MAX_CAPTION) {
    return toolError(`caption is ${caption.length} characters. Telegram allows at most ${TELEGRAM_MAX_CAPTION}.`);
  }

  let result;
  if (url !== undefined) {
    if (filename !== undefined || mime_type !== undefined) {
      return toolError("filename and mime_type only apply to base64 uploads");
    }
    if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
      return toolError("url must be an http or https URL");
    }
    result = await callTelegram(env, tool.method, {
      chat_id,
      [tool.field]: url,
      ...(caption ? { caption } : {}),
    });
  } else {
    const upload = decodeUpload(tool, args);
    if ("error" in upload) return toolError(upload.error);
    const form = new FormData();
    form.set("chat_id", String(chat_id));
    if (caption) form.set("caption", caption);
    form.set(tool.field, upload.blob, upload.filename);
    result = await callTelegram(env, tool.method, form);
  }

  if (!result.ok) return toolError(`Telegram ${tool.method} failed: ${result.description}`);
  const messageId = (result.result as { message_id?: number } | undefined)?.message_id;
  return toolOk(JSON.stringify({ ok: true, message_id: messageId }));
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
