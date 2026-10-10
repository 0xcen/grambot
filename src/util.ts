const encoder = new TextEncoder();

// Hashing both sides first gives equal-length inputs, so neither the length
// nor the content of the secret leaks through timing.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAllowed(allowlist: Set<string>, id: unknown): boolean {
  if (typeof id !== "number" && typeof id !== "string") return false;
  return allowlist.has(String(id).trim());
}
