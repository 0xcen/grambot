import type { Env } from "./index";
import { BOT_DOWNLOAD_LIMIT, getFile, TOO_BIG_TO_DOWNLOAD } from "./telegram-api";
import { constantTimeEqual } from "./util";

export const FILE_URL_TTL_SECONDS = 15 * 60;
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const encoder = new TextEncoder();

// The signing key is derived from BOT_TOKEN with a fixed label, so no new secret is
// needed, the token itself never leaves the Worker, and rotating it revokes every link.
async function signingKey(botToken: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(botToken), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode("grambot file url v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function signature(botToken: string, fileId: string, exp: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await signingKey(botToken), encoder.encode(`${fileId}.${exp}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signedFileUrl(
  env: Env,
  origin: string,
  fileId: string,
  nowMs = Date.now(),
): Promise<{ url: string; expires_at: number }> {
  const exp = Math.floor(nowMs / 1000) + FILE_URL_TTL_SECONDS;
  const sig = await signature(env.BOT_TOKEN, fileId, exp);
  return { url: `${origin}/file/${fileId}?exp=${exp}&sig=${sig}`, expires_at: exp };
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** Streams a Telegram file to whoever holds a valid, unexpired link, so BOT_TOKEN stays here. */
export async function handleFile(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  }
  if (!env.BOT_TOKEN) return text("Server misconfigured: BOT_TOKEN is not set.", 503);

  const url = new URL(request.url);
  const fileId = url.pathname.slice("/file/".length);
  const expRaw = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!FILE_ID.test(fileId) || !/^\d{1,12}$/.test(expRaw)) return text("Forbidden", 403);

  const exp = Number(expRaw);
  if (!(await constantTimeEqual(sig, await signature(env.BOT_TOKEN, fileId, exp)))) {
    return text("Forbidden", 403);
  }
  if (Math.floor(Date.now() / 1000) >= exp) return text("Forbidden: this file link has expired.", 403);

  const file = await getFile(env, fileId);
  if (!file.ok) return text(file.error, file.error === TOO_BIG_TO_DOWNLOAD ? 413 : 502);

  let upstream: Response;
  try {
    upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  } catch (err) {
    console.error(`file: download failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return text("Could not download the file from Telegram.", 502);
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`file: download failed: HTTP ${upstream.status}`);
    return text("Could not download the file from Telegram.", 502);
  }
  const length = upstream.headers.get("Content-Length");
  if (Number(length) > BOT_DOWNLOAD_LIMIT) {
    await upstream.body.cancel();
    return text(TOO_BIG_TO_DOWNLOAD, 413);
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
    "Cache-Control": "private, no-store",
  });
  if (length) headers.set("Content-Length", length);
  return new Response(upstream.body, { status: 200, headers });
}
