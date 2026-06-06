import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

export interface AgentcookieStatus {
  installed: boolean;
  binaryPath?: string;
  plainCookiesPath: string;
  plainCookiesExists: boolean;
  frontCookiesAvailable?: boolean;
  adoptionManifest: {
    recommendedPath: string;
    present: boolean;
  };
}

export function defaultAgentcookiePlainCookiesPath(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENTCOOKIE_PLAIN_COOKIES
    ?? env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH
    ?? join(homedir(), ".agentcookie", "cookies-plain.db");
}

export async function agentcookieStatus(env: NodeJS.ProcessEnv = process.env): Promise<AgentcookieStatus> {
  const binary = await findAgentcookieBinary();
  const plainCookiesPath = defaultAgentcookiePlainCookiesPath(env);
  const plainCookiesExists = existsSync(plainCookiesPath);
  return {
    installed: Boolean(binary),
    binaryPath: binary,
    plainCookiesPath,
    plainCookiesExists,
    frontCookiesAvailable: plainCookiesExists ? await plainCookieDbHasFrontCookies(plainCookiesPath).catch(() => false) : undefined,
    adoptionManifest: {
      recommendedPath: "agentcookie.toml",
      present: existsSync("agentcookie.toml"),
    },
  };
}

export async function readAgentcookieFrontCookies(path = defaultAgentcookiePlainCookiesPath()) {
  const sql = [
    "select host_key, name, value, expires_utc",
    "from cookies",
    "where host_key in ('app.frontapp.com', '.frontapp.com') and name in ('front.id', 'front.id.sig')",
    "order by name, expires_utc desc;",
  ].join(" ");
  const { stdout } = await run("sqlite3", ["-json", path, sql], 1024 * 1024);
  return stdout.trim()
    ? JSON.parse(stdout) as Array<{ host_key: string; name: string; value: string; expires_utc: number }>
    : [];
}

async function plainCookieDbHasFrontCookies(path: string) {
  const rows = await readAgentcookieFrontCookies(path);
  return new Set(rows.map((row) => row.name)).size >= 2;
}

async function findAgentcookieBinary() {
  const candidates = [
    join(homedir(), "go", "bin", "agentcookie"),
    "/opt/homebrew/bin/agentcookie",
    "/usr/local/bin/agentcookie",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const { stdout } = await run("/usr/bin/env", ["which", "agentcookie"], 1024 * 1024);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

