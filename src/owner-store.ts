import type { Env } from "./index";
import { constantTimeEqual, envInt } from "./util";

export const SETUP_CODE_TTL_MS = 10 * 60_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const DEFAULT_RATE_LIMIT_PER_DAY = 1000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface PendingCode {
  hash: string;
  expires_at: number;
}

interface RateRecord {
  minute: number;
  minute_count: number;
  day: number;
  day_count: number;
}

export type ClaimResult = { ok: true } | { ok: false; reason: "no code" | "wrong" | "expired" };
export type RateResult = { ok: true } | { ok: false; reason: "per minute" | "per day" };

export interface RateLimits {
  per_minute: number;
  per_day: number;
}

export function rateLimits(env: Env): RateLimits {
  return {
    per_minute: envInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE),
    per_day: envInt(env.RATE_LIMIT_PER_DAY, DEFAULT_RATE_LIMIT_PER_DAY),
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/**
 * One global instance. Once an owner is bound it is the source of truth for who may use the bot.
 * It also holds the one pending setup code, as a SHA-256 hash only, and per user rate counters.
 */
export class OwnerStore implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const storage = this.state.storage;

    if (pathname === "/owner") return json({ owner: (await storage.get<number>("owner")) ?? null });

    const body = await request.json<Record<string, unknown>>();

    if (pathname === "/code") {
      const pending: PendingCode = { hash: String(body.hash), expires_at: Date.now() + SETUP_CODE_TTL_MS };
      await storage.put({ code: pending });
      return json({ expires_at: pending.expires_at });
    }

    if (pathname === "/claim") {
      const pending = await storage.get<PendingCode>("code");
      if (!pending) return json({ ok: false, reason: "no code" } satisfies ClaimResult);
      // A wrong guess leaves the pending code alone, so nobody can burn it by spamming /start.
      if (!(await constantTimeEqual(String(body.hash), pending.hash))) {
        return json({ ok: false, reason: "wrong" } satisfies ClaimResult);
      }
      await storage.delete(["code"]);
      if (Date.now() > pending.expires_at) return json({ ok: false, reason: "expired" } satisfies ClaimResult);
      await storage.put({ owner: Number(body.user_id) });
      return json({ ok: true } satisfies ClaimResult);
    }

    if (pathname === "/rate") {
      const key = `rate:${Number(body.user_id)}`;
      const limits = body.limits as RateLimits;
      const now = Date.now();
      const minute = Math.floor(now / MINUTE_MS);
      const day = Math.floor(now / DAY_MS);
      const prev = await storage.get<RateRecord>(key);
      const record: RateRecord = {
        minute,
        minute_count: prev?.minute === minute ? prev.minute_count : 0,
        day,
        day_count: prev?.day === day ? prev.day_count : 0,
      };
      if (record.day_count >= limits.per_day) return json({ ok: false, reason: "per day" } satisfies RateResult);
      if (record.minute_count >= limits.per_minute) return json({ ok: false, reason: "per minute" } satisfies RateResult);
      record.minute_count++;
      record.day_count++;
      await storage.put({ [key]: record });
      return json({ ok: true } satisfies RateResult);
    }

    return new Response("Not Found", { status: 404 });
  }
}

async function call<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const stub = env.OWNER_STORE.get(env.OWNER_STORE.idFromName("owner"));
  const res = await stub.fetch(`https://owner-store${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`owner store returned HTTP ${res.status}`);
  return res.json<T>();
}

export const getOwner = async (env: Env): Promise<number | null> => (await call<{ owner: number | null }>(env, "/owner")).owner;

export const storeSetupCode = async (env: Env, hash: string): Promise<number> =>
  (await call<{ expires_at: number }>(env, "/code", { hash })).expires_at;

export const claimOwner = (env: Env, hash: string, userId: number) => call<ClaimResult>(env, "/claim", { hash, user_id: userId });

export const takeRateToken = (env: Env, userId: number) =>
  call<RateResult>(env, "/rate", { user_id: userId, limits: rateLimits(env) });
