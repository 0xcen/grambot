import type { Env } from "./index";
import { getOwner } from "./owner-store";
import { isListed, parseAllowlist } from "./util";

/**
 * Who may use the bot. A bound owner wins. Without one, ALLOWED_USER_IDS applies exactly as
 * before owners existed, so installs from before setup codes keep working until they claim.
 * With neither, only /start setup code claims are processed.
 */
export type Access =
  | { mode: "owner"; owner: number }
  | { mode: "allowlist"; ids: Set<string> }
  | { mode: "closed" };

export const ACCESS_CLOSED_ERROR =
  "Server misconfigured: no owner is bound and ALLOWED_USER_IDS is empty or invalid. Call create_setup_code and have your human open the link in Telegram.";

let loggedEnvIgnored = false;

export async function resolveAccess(env: Env): Promise<Access> {
  const owner = await getOwner(env);
  if (owner !== null) {
    if (env.ALLOWED_USER_IDS?.trim() && !loggedEnvIgnored) {
      loggedEnvIgnored = true;
      console.log("access: an owner is bound, so ALLOWED_USER_IDS is ignored");
    }
    return { mode: "owner", owner };
  }
  const ids = parseAllowlist(env.ALLOWED_USER_IDS);
  return ids ? { mode: "allowlist", ids } : { mode: "closed" };
}

/** The one rule for inbound updates, messages and reactions alike. */
export function isAllowed(access: Access, actor: number | undefined, chatId: number): boolean {
  switch (access.mode) {
    case "owner":
      return actor === access.owner && chatId === access.owner;
    case "allowlist":
      return isListed(access.ids, actor);
    case "closed":
      return false;
  }
}

/** The rule for the send tools. Returns an error message, or null when the chat may be sent to. */
export function sendRefusal(access: Access, chatId: unknown): string | null {
  if (access.mode === "closed") return ACCESS_CLOSED_ERROR;
  if (typeof chatId !== "number" && typeof chatId !== "string") return "chat_id is required";
  if (access.mode === "owner") {
    return String(chatId).trim() === String(access.owner) ? null : "chat_id is not the owner's chat";
  }
  return isListed(access.ids, chatId) ? null : "chat_id is not in the allowlist";
}
