import { constantTimeEqual } from "./util";

export async function bearerMatches(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : "";
  return constantTimeEqual(token, expected);
}
