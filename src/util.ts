const encoder = new TextEncoder();

type SubtleWithTimingSafeEqual = SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
};

// Hashing both sides first gives equal-length inputs, so neither the length
// nor the content of the secret leaks through timing.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const subtle = crypto.subtle as SubtleWithTimingSafeEqual;
  const [ha, hb] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(a)),
    subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ha, hb);
  }
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export const ALLOWLIST_CONFIG_ERROR =
  "Server misconfigured: ALLOWED_USER_IDS is empty or invalid. Set it to a comma separated list of numeric Telegram user ids.";

/** Returns null when the allowlist is missing, empty, or has any non-numeric entry. */
export function parseAllowlist(raw: string | undefined): Set<string> | null {
  if (typeof raw !== "string") return null;
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !/^-?\d+$/.test(id))) return null;
  return new Set(ids);
}

export function isAllowed(allowlist: Set<string>, id: unknown): boolean {
  if (typeof id !== "number" && typeof id !== "string") return false;
  return allowlist.has(String(id).trim());
}
