#!/usr/bin/env bash
# Non-interactive setup. All input comes from environment variables and
# secrets only travel through stdin pipes, never argv or logs. The only
# secret written to disk is the MCP bearer token, in SECRETS_FILE (mode 600).
#
# New worker (run from a clone):
#   BOT_TOKEN, GROKBOT_WEBHOOK_URL, GROKBOT_WEBHOOK_AUTH
#   Deploys, generates TG_WEBHOOK_SECRET and MCP_BEARER_TOKEN, sets every
#   secret, registers the Telegram webhook through POST /setup, and writes
#   MCP_URL and MCP_BEARER_TOKEN to SECRETS_FILE.
#
# Existing worker (MCP_BEARER_TOKEN already set in env, no clone needed):
#   BOT_TOKEN, GROKBOT_WEBHOOK_URL, GROKBOT_WEBHOOK_AUTH, MCP_BEARER_TOKEN, WORKER_URL
#   Skips deploy, leaves TG_WEBHOOK_SECRET and MCP_BEARER_TOKEN alone, sets the
#   three Telegram/routine secrets, then calls POST /setup.
#
# Optional: ALLOWED_USER_IDS (new worker mode only; without it the bot answers
#   nobody until its owner claims it with a setup code), WORKER_NAME (default grambot; in existing worker mode, the first
#   label of a workers.dev WORKER_URL), WORKER_URL,
#   GROKBOT_WEBHOOK_AUTH_HEADER, SECRETS_FILE (default
#   $HOME/.grambot-mcp in new worker mode, unused otherwise unless set).
# Without a wrangler login, export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
set +x

die() { printf 'setup: %s\n' "$1" >&2; exit 1; }

for bin in node npx curl; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required"
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node 22 or newer is required (found $(node -v))"

WORKER_NAME="${WORKER_NAME:-}"
WORKER_URL="${WORKER_URL:-}"
SECRETS_FILE="${SECRETS_FILE:-}"
GROKBOT_WEBHOOK_AUTH_HEADER="${GROKBOT_WEBHOOK_AUTH_HEADER:-}"

if [ -n "${MCP_BEARER_TOKEN:-}" ]; then MODE=existing; else MODE=new; fi
# Workers installed before the rename are called grokbot-telegram, so an
# existing worker's workers.dev URL names it better than the new default.
if [ -z "$WORKER_NAME" ] && [ "$MODE" = existing ] \
  && [[ "$WORKER_URL" =~ ^https://([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev/?$ ]]; then
  WORKER_NAME="${BASH_REMATCH[1]}"
fi
WORKER_NAME="${WORKER_NAME:-grambot}"
[ "$MODE" = existing ] || SECRETS_FILE="${SECRETS_FILE:-${HOME:?set HOME or SECRETS_FILE}/.grambot-mcp}"
saved_note=""

missing=()
for var in BOT_TOKEN GROKBOT_WEBHOOK_URL GROKBOT_WEBHOOK_AUTH; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
[ "$MODE" = new ] || [ -n "$WORKER_URL" ] || missing+=("WORKER_URL")
[ "${#missing[@]}" -eq 0 ] || die "missing required env vars: ${missing[*]}"

[[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "BOT_TOKEN does not look like a BotFather token"
[[ "$GROKBOT_WEBHOOK_URL" == https://* ]] || die "GROKBOT_WEBHOOK_URL must start with https://"
[ -z "$WORKER_URL" ] || [[ "$WORKER_URL" == https://* ]] \
  || die "WORKER_URL must start with https:// so the bearer token is never sent in clear text"
ALLOWED_USER_IDS="${ALLOWED_USER_IDS:-}"
if [ "$MODE" = new ]; then
  ALLOWED_USER_IDS="${ALLOWED_USER_IDS// /}"
  [ -z "$ALLOWED_USER_IDS" ] || [[ "$ALLOWED_USER_IDS" =~ ^-?[0-9]+(,-?[0-9]+)*$ ]] \
    || die "ALLOWED_USER_IDS must be numeric Telegram user ids separated by commas"
else
  [[ "$MCP_BEARER_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] \
    || die "MCP_BEARER_TOKEN contains characters a bearer token cannot have"
fi
if [ -n "$SECRETS_FILE" ]; then
  [ ! -L "$SECRETS_FILE" ] || die "SECRETS_FILE must not be a symlink"
  secrets_dir="$(dirname "$SECRETS_FILE")"
  if [ ! -d "$secrets_dir" ] || [ ! -w "$secrets_dir" ]; then
    die "the directory for SECRETS_FILE ($secrets_dir) does not exist or is not writable"
  fi
fi

wrangler() { npx --yes wrangler "$@"; }

put_secret() {
  local name="$1" value="$2" out
  if ! out="$(printf '%s' "$value" | wrangler secret put "$name" --name "$WORKER_NAME" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "could not set $name.$saved_note"
  fi
  echo "  set $name"
}

# mktemp creates the file with mode 600, and mv replaces the target instead of
# writing through an existing file's looser permissions.
save_secrets() {
  local tmp
  tmp="$(mktemp "$(dirname "$SECRETS_FILE")/.grambot-mcp.XXXXXX")"
  printf 'MCP_URL=%s\nMCP_BEARER_TOKEN=%s\n' "$WORKER_URL/mcp" "$MCP_BEARER_TOKEN" > "$tmp"
  mv -f "$tmp" "$SECRETS_FILE"
  saved_note=" The MCP URL and bearer token are already saved in $SECRETS_FILE."
}

if [ "$MODE" = new ]; then
  for bin in npm openssl; do
    command -v "$bin" >/dev/null 2>&1 || die "$bin is required"
  done
  cd "$(dirname "$0")/.."
  [ -f wrangler.toml ] || die "run new-worker setup from a clone of the repo"
  [ -d node_modules ] || npm install --no-fund --no-audit >/dev/null

  echo "Deploying $WORKER_NAME..."
  deploy_out="$(wrangler deploy --name "$WORKER_NAME" 2>&1)" || { printf '%s\n' "$deploy_out" >&2; die "deploy failed"; }
  if [ -z "$WORKER_URL" ]; then
    WORKER_URL="$(printf '%s' "$deploy_out" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n1 || true)"
  fi
  [ -n "$WORKER_URL" ] || die "could not find the Worker URL in the deploy output; set WORKER_URL"

  TG_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
else
  echo "Existing worker mode: skipping deploy, keeping TG_WEBHOOK_SECRET and MCP_BEARER_TOKEN."
fi
WORKER_URL="${WORKER_URL%/}"
[ -z "$SECRETS_FILE" ] || save_secrets

echo "Setting secrets on $WORKER_NAME..."
if [ "$MODE" = new ]; then
  [ -z "$ALLOWED_USER_IDS" ] || put_secret ALLOWED_USER_IDS "$ALLOWED_USER_IDS"
  put_secret TG_WEBHOOK_SECRET "$TG_WEBHOOK_SECRET"
  put_secret MCP_BEARER_TOKEN "$MCP_BEARER_TOKEN"
fi
put_secret BOT_TOKEN "$BOT_TOKEN"
put_secret GROKBOT_WEBHOOK_URL "$GROKBOT_WEBHOOK_URL"
put_secret GROKBOT_WEBHOOK_AUTH "$GROKBOT_WEBHOOK_AUTH"
[ -z "$GROKBOT_WEBHOOK_AUTH_HEADER" ] || put_secret GROKBOT_WEBHOOK_AUTH_HEADER "$GROKBOT_WEBHOOK_AUTH_HEADER"

echo "Registering the Telegram webhook..."
setup_out=""
for attempt in 1 2 3 4 5; do
  # Secrets can take a few seconds to reach the running Worker, so retry.
  setup_out="$(printf 'header = "Authorization: Bearer %s"\n' "$MCP_BEARER_TOKEN" \
    | curl -sS --max-time 30 -X POST --config - "$WORKER_URL/setup" 2>&1 || true)"
  [[ "$setup_out" == *'"ok":true'* ]] && break
  if [ "$attempt" -lt 5 ]; then sleep "${SETUP_RETRY_DELAY:-3}"; fi
done
[[ "$setup_out" == *'"ok":true'* ]] || die "POST /setup failed: $setup_out.$saved_note"
echo "  $setup_out"

if [ -n "$SECRETS_FILE" ]; then
  printf '\nDone.\nMCP URL: %s/mcp\nMCP URL and bearer token written to %s (mode 600).\n' "$WORKER_URL" "$SECRETS_FILE"
else
  printf '\nDone.\nMCP URL: %s/mcp\nThe MCP bearer token is unchanged.\n' "$WORKER_URL"
fi
