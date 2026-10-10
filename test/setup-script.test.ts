import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../scripts/setup.sh");

const FAKE_NPX = `#!/usr/bin/env bash
[ "$1" = "--yes" ] && shift
[ "$1" = "wrangler" ] && shift
case "$1" in
  deploy) echo "DEPLOY $*" >> "$FAKE_LOG"; echo "  https://grokbot-telegram.fake.workers.dev" ;;
  secret) echo "PUT $3 $4 $5 value=$(cat)" >> "$FAKE_LOG"; echo "Success! Uploaded secret $3" ;;
  *) echo "UNEXPECTED $*" >> "$FAKE_LOG"; exit 1 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "CURL $* config=$(cat | tr '\\n' ' ')" >> "$FAKE_LOG"
echo "\${FAKE_SETUP_RESPONSE:-{\\"ok\\":true,\\"description\\":\\"Webhook was set\\"}}"
`;

const SECRETS = {
  BOT_TOKEN: "123456:AAfakeBotTokenValue",
  GROKBOT_WEBHOOK_URL: "https://grokbot.example/hooks/routine-secret-path",
  GROKBOT_WEBHOOK_AUTH: "Bearer routine-auth-value",
};

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grokbot-setup-"));
  log = join(dir, "calls.log");
  writeFileSync(log, "");
  for (const [name, body] of [["npx", FAKE_NPX], ["curl", FAKE_CURL]]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
});

function run(env: Record<string, string>) {
  const res = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      FAKE_LOG: log,
      SETUP_RETRY_DELAY: "0",
      ...env,
    },
    encoding: "utf8",
  });
  return { code: res.status, out: res.stdout + res.stderr, calls: readFileSync(log, "utf8") };
}

describe("scripts/setup.sh", () => {
  it("passes shellcheck", () => {
    const res = spawnSync(resolve(__dirname, "../node_modules/.bin/shellcheck"), [SCRIPT], {
      encoding: "utf8",
    });
    // Assert the exit code only: on first run the npm wrapper prints a download notice to stdout.
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });

  it("fails clearly and does nothing when required env vars are missing", () => {
    const r = run({ BOT_TOKEN: SECRETS.BOT_TOKEN });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(
      "missing required env vars: GROKBOT_WEBHOOK_URL GROKBOT_WEBHOOK_AUTH ALLOWED_USER_IDS",
    );
    expect(r.calls).toBe("");
  });

  it("rejects an invalid allowlist", () => {
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111,abc" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ALLOWED_USER_IDS must be numeric");
    expect(r.calls).toBe("");
  });

  it("new worker: deploys, sets every secret through stdin, calls /setup, never prints the token", () => {
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "123456789" });
    expect(r.code).toBe(0);

    expect(r.calls).toContain("DEPLOY deploy --name grokbot-telegram");
    for (const name of [
      "ALLOWED_USER_IDS",
      "TG_WEBHOOK_SECRET",
      "MCP_BEARER_TOKEN",
      "BOT_TOKEN",
      "GROKBOT_WEBHOOK_URL",
      "GROKBOT_WEBHOOK_AUTH",
    ]) {
      expect(r.calls).toMatch(new RegExp(`PUT ${name} --name grokbot-telegram value=\\S+`));
    }
    expect(r.calls).toContain(`PUT BOT_TOKEN --name grokbot-telegram value=${SECRETS.BOT_TOKEN}`);
    expect(r.calls).toContain("PUT ALLOWED_USER_IDS --name grokbot-telegram value=123456789");

    const token = r.calls.match(/PUT MCP_BEARER_TOKEN --name \S+ value=([0-9a-f]{64})/)![1];
    expect(r.calls).toContain(`-X POST --config - https://grokbot-telegram.fake.workers.dev/setup`);
    expect(r.calls).toContain(`header = "Authorization: Bearer ${token}"`);

    expect(r.out).toContain("MCP URL: https://grokbot-telegram.fake.workers.dev/mcp");
    expect(r.out).not.toContain(token);
    for (const value of Object.values(SECRETS)) expect(r.out).not.toContain(value);
    const tgSecret = r.calls.match(/PUT TG_WEBHOOK_SECRET --name \S+ value=(\S+)/)![1];
    expect(r.out).not.toContain(tgSecret);

    const defaultFile = join(dir, ".grokbot-telegram-mcp");
    expect(readFileSync(defaultFile, "utf8")).toBe(
      `MCP_URL=https://grokbot-telegram.fake.workers.dev/mcp\nMCP_BEARER_TOKEN=${token}\n`,
    );
    expect(statSync(defaultFile).mode & 0o777).toBe(0o600);
  });

  it.each(["new", "existing"])("%s worker: refuses a non-https WORKER_URL before doing anything", (mode) => {
    const r = run({
      ...SECRETS,
      ALLOWED_USER_IDS: "111",
      WORKER_URL: "http://w.example",
      ...(mode === "existing" ? { MCP_BEARER_TOKEN: "existing-bearer-token" } : {}),
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("WORKER_URL must start with https://");
    expect(r.calls).toBe("");
  });

  it("never passes secret values as command line arguments", () => {
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111" });
    const argvLines = r.calls
      .split("\n")
      .map((line) => line.replace(/ value=.*$/, "").replace(/ config=.*$/, ""));
    for (const value of Object.values(SECRETS)) {
      expect(argvLines.join("\n")).not.toContain(value);
    }
  });

  it("writes the MCP URL and token to SECRETS_FILE with mode 600 instead of printing the token", () => {
    const file = join(dir, "out", "..", "secrets.env");
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111", SECRETS_FILE: file });
    expect(r.code).toBe(0);
    const token = r.calls.match(/PUT MCP_BEARER_TOKEN --name \S+ value=(\S+)/)![1];
    expect(readFileSync(file, "utf8")).toBe(
      `MCP_URL=https://grokbot-telegram.fake.workers.dev/mcp\nMCP_BEARER_TOKEN=${token}\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.out).not.toContain(token);
  });

  it("replaces a pre-existing SECRETS_FILE with a fresh mode 600 file", () => {
    const file = join(dir, "secrets.env");
    writeFileSync(file, "old\n", { mode: 0o644 });
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111", SECRETS_FILE: file });
    expect(r.code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toMatch(/^MCP_URL=\S+\nMCP_BEARER_TOKEN=[0-9a-f]{64}\n$/);
  });

  it("refuses a symlinked SECRETS_FILE before doing anything", () => {
    const target = join(dir, "synced-dotfile");
    writeFileSync(target, "");
    const link = join(dir, "link.env");
    symlinkSync(target, link);
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111", SECRETS_FILE: link });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("SECRETS_FILE must not be a symlink");
    expect(r.calls).toBe("");
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("refuses a SECRETS_FILE in a missing directory before doing anything", () => {
    const r = run({ ...SECRETS, ALLOWED_USER_IDS: "111", SECRETS_FILE: join(dir, "nope", "s.env") });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not exist or is not writable");
    expect(r.calls).toBe("");
  });

  it("new worker: keeps the generated token in SECRETS_FILE when /setup fails", () => {
    const file = join(dir, "secrets.env");
    const r = run({
      ...SECRETS,
      ALLOWED_USER_IDS: "111",
      SECRETS_FILE: file,
      FAKE_SETUP_RESPONSE: '{"ok":false,"description":"nope"}',
    });
    expect(r.code).not.toBe(0);
    const token = r.calls.match(/PUT MCP_BEARER_TOKEN --name \S+ value=(\S+)/)![1];
    expect(readFileSync(file, "utf8")).toContain(`MCP_BEARER_TOKEN=${token}\n`);
    expect(r.out).toContain(`already saved in ${file}`);
    expect(r.out).not.toContain(token);
  });

  it("existing worker: refuses an MCP_BEARER_TOKEN that would break the curl config", () => {
    const r = run({ ...SECRETS, MCP_BEARER_TOKEN: 'ab"cd', WORKER_URL: "https://w.example" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("MCP_BEARER_TOKEN contains characters");
    expect(r.calls).toBe("");
  });

  it("existing worker: no deploy, keeps TG_WEBHOOK_SECRET and MCP_BEARER_TOKEN, uses WORKER_NAME and WORKER_URL", () => {
    const r = run({
      ...SECRETS,
      MCP_BEARER_TOKEN: "existing-bearer-token",
      WORKER_NAME: "my-bridge",
      WORKER_URL: "https://my-bridge.example.workers.dev/",
    });
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain("DEPLOY");
    expect(r.calls).not.toContain("PUT TG_WEBHOOK_SECRET");
    expect(r.calls).not.toContain("PUT MCP_BEARER_TOKEN");
    expect(r.calls).not.toContain("PUT ALLOWED_USER_IDS");
    for (const name of ["BOT_TOKEN", "GROKBOT_WEBHOOK_URL", "GROKBOT_WEBHOOK_AUTH"]) {
      expect(r.calls).toContain(`PUT ${name} --name my-bridge value=`);
    }
    expect(r.calls).toContain("--config - https://my-bridge.example.workers.dev/setup");
    expect(r.calls).toContain('header = "Authorization: Bearer existing-bearer-token"');
    expect(r.out).toContain("MCP URL: https://my-bridge.example.workers.dev/mcp");
    expect(r.out).not.toContain("existing-bearer-token");
    expect(existsSync(join(dir, "secrets.env"))).toBe(false);
    expect(existsSync(join(dir, ".grokbot-telegram-mcp"))).toBe(false);
  });

  it("existing worker mode requires WORKER_URL", () => {
    const r = run({ ...SECRETS, MCP_BEARER_TOKEN: "existing-bearer-token" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("missing required env vars: WORKER_URL");
    expect(r.calls).toBe("");
  });

  it("sets GROKBOT_WEBHOOK_AUTH_HEADER only when provided", () => {
    const r = run({
      ...SECRETS,
      MCP_BEARER_TOKEN: "t",
      WORKER_URL: "https://w.example",
      GROKBOT_WEBHOOK_AUTH_HEADER: "X-Routine-Key",
    });
    expect(r.calls).toContain("PUT GROKBOT_WEBHOOK_AUTH_HEADER --name grokbot-telegram value=X-Routine-Key");
  });

  it("fails when /setup keeps failing, after retrying", () => {
    const r = run({
      ...SECRETS,
      MCP_BEARER_TOKEN: "t",
      WORKER_URL: "https://w.example",
      FAKE_SETUP_RESPONSE: '{"ok":false,"description":"Missing or invalid secrets: BOT_TOKEN"}',
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("POST /setup failed");
    expect(r.calls.match(/^CURL /gm)).toHaveLength(5);
  });
});
