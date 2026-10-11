import type { Env } from "./index";

export const MB = 1024 * 1024;
export const BOT_DOWNLOAD_LIMIT = 20 * MB;
export const TOO_BIG_TO_DOWNLOAD =
  "File is larger than 20 MB, the most a Telegram bot can download. Ask for a smaller file.";

export interface TelegramApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

export async function callTelegram(
  env: Env,
  method: string,
  payload: Record<string, unknown> | FormData,
): Promise<TelegramApiResult> {
  if (!env.BOT_TOKEN) return { ok: false, description: "BOT_TOKEN is not configured" };
  const body =
    payload instanceof FormData
      ? { body: payload }
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      ...body,
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

export type GetFileResult =
  | { ok: true; file_path: string; file_size?: number }
  | { ok: false; error: string };

export async function getFile(env: Env, fileId: string): Promise<GetFileResult> {
  const res = await callTelegram(env, "getFile", { file_id: fileId });
  const file = res.result as { file_path?: unknown; file_size?: unknown } | undefined;
  if (!res.ok) {
    const tooBig = /too big/i.test(res.description ?? "");
    return { ok: false, error: tooBig ? TOO_BIG_TO_DOWNLOAD : "Telegram could not find this file." };
  }
  if (typeof file?.file_path !== "string") {
    return { ok: false, error: "Telegram did not return a download path for this file." };
  }
  if (typeof file.file_size === "number" && file.file_size > BOT_DOWNLOAD_LIMIT) {
    return { ok: false, error: TOO_BIG_TO_DOWNLOAD };
  }
  return {
    ok: true,
    file_path: file.file_path,
    ...(typeof file.file_size === "number" ? { file_size: file.file_size } : {}),
  };
}
