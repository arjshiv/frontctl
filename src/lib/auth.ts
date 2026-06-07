import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./process.js";
import { cookieSecretRowSchema, frontSessionFileSchema, frontSessionPayloadSchema, plainFrontCookieRowSchema } from "./schemas.js";

const CHROME_MAC_SALT = "saltysalt";
const CHROME_MAC_ITERATIONS = 1003;
const CHROME_MAC_IV = Buffer.alloc(16, " ");
const FRONT_COOKIE_HOST = "app.frontapp.com";
const FRONT_COOKIE_HOSTS = ["app.frontapp.com", ".frontapp.com"] as const;
const REQUIRED_FRONT_COOKIE_NAMES = ["front.id", "front.id.sig"] as const;
const OPTIONAL_FRONT_COOKIE_NAMES = ["front.csrf"] as const;
const FRONT_SESSION_COOKIE_NAMES = [...REQUIRED_FRONT_COOKIE_NAMES, ...OPTIONAL_FRONT_COOKIE_NAMES] as const;
const FRONT_KEYCHAIN_SERVICE = "Front Safe Storage";
const SESSION_CRYPTO_VERSION = 1;
const SESSION_ENCRYPTION_MODE = "local-derived-v1";

export interface FrontSessionSecurity {
  authorizationModel: "one-time-keychain-unlock";
  sessionEncryptionMode: typeof SESSION_ENCRYPTION_MODE;
  keychainService: string;
  supportedSources: string[];
  keychainBackedSessionKey: false;
  promptsOnCheck: false;
  promptsOnUnlock: boolean;
  promptsOnLiveRead: false;
  touchIdOrPasswordExpected: boolean;
  note: string;
}

export interface FrontSessionStatus {
  sessionPath: string;
  exists: boolean;
  valid: boolean;
  host?: string;
  source?: string;
  keychainServiceUsedForUnlock?: string;
  cookieNames?: string[];
  createdAt?: string;
  expiresAt?: string;
  security: FrontSessionSecurity;
  note: string;
}

export interface FrontSessionUnlockResult extends FrontSessionStatus {
  unlocked: boolean;
  keychainAccessed: boolean;
  reusedExisting: boolean;
}

export interface FrontSession {
  host: string;
  source?: string;
  keychainServiceUsedForUnlock?: string;
  cookieHeader: string;
  cookieNames: string[];
  csrfToken?: string;
  createdAt: string;
  expiresAt: string;
}

export interface PlainFrontCookieRow {
  host_key: string;
  name: string;
  value: string;
  expires_utc: number;
}

interface SessionFile {
  version: 1;
  encryption?: {
    mode: typeof SESSION_ENCRYPTION_MODE;
    keychainBackedSessionKey: false;
  };
  host: string;
  source?: string;
  keychainServiceUsedForUnlock?: string;
  cookieNames: string[];
  createdAt: string;
  expiresAt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

interface CookieSecretRow {
  host_key: string;
  name: string;
  encrypted_value: string;
  expires_utc: number;
}

export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_SESSION_PATH ?? join(homedir(), ".frontctl", "session.json");
}

export function sessionSecurityStatus(): FrontSessionSecurity {
  return {
    authorizationModel: "one-time-keychain-unlock",
    sessionEncryptionMode: SESSION_ENCRYPTION_MODE,
    keychainService: FRONT_KEYCHAIN_SERVICE,
    supportedSources: ["front-app", "chrome", "edge", "default-browser", "agentcookie"],
    keychainBackedSessionKey: false,
    promptsOnCheck: false,
    promptsOnUnlock: true,
    promptsOnLiveRead: false,
    touchIdOrPasswordExpected: true,
    note: [
      "`frontctl auth unlock` may prompt once for the selected local app or browser Keychain item.",
      "After unlock, frontctl reads its short-lived local session cache and normal status/live-read commands do not access Keychain.",
    ].join(" "),
  };
}

export async function checkFrontSession(sessionPath = defaultSessionPath()): Promise<FrontSessionStatus> {
  const defaultSecurity = sessionSecurityStatus();
  const session = await readFrontSession(sessionPath);
  if (!session) {
    return {
      sessionPath,
      exists: false,
      valid: false,
      security: defaultSecurity,
      note: "No unlocked frontctl session. Run `frontctl auth unlock` once before live private requests.",
    };
  }

  const security = session.keychainServiceUsedForUnlock
    ? { ...defaultSecurity, keychainService: session.keychainServiceUsedForUnlock }
    : defaultSecurity;

  return {
    sessionPath,
    exists: true,
    valid: true,
    host: session.host,
    source: session.source,
    keychainServiceUsedForUnlock: session.keychainServiceUsedForUnlock,
    cookieNames: session.cookieNames,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    security,
    note: "Unlocked session cache is present. Cookie values are not printed.",
  };
}

export async function unlockFrontSession(
  cookiesPath: string,
  options: {
    sessionPath?: string;
    ttlHours?: number;
    force?: boolean;
    keychainService?: string;
    source?: string;
    note?: string;
  } = {},
): Promise<FrontSessionUnlockResult> {
  const sessionPath = options.sessionPath ?? defaultSessionPath();
  if (!options.force) {
    const existing = await checkFrontSession(sessionPath);
    if (existing.valid) {
      return {
        ...existing,
        unlocked: true,
        keychainAccessed: false,
        reusedExisting: true,
        note: "Unlocked session cache is already valid. Keychain was not accessed.",
      };
    }
  }

  const rows = await readEncryptedFrontCookies(cookiesPath);
  const keychainService = options.keychainService ?? FRONT_KEYCHAIN_SERVICE;
  const password = readKeychainPassword(keychainService);
  const cookieParts: string[] = [];
  const cookieNames: string[] = [];
  const expirations: number[] = [];
  let csrfToken: string | undefined;

  for (const row of rows) {
    const value = decryptChromiumCookieValue(
      Buffer.from(row.encrypted_value, "hex"),
      password,
      row.host_key,
    );
    cookieParts.push(`${row.name}=${value}`);
    cookieNames.push(row.name);
    if (row.name === "front.csrf") {
      csrfToken = value;
    }
    const expiresAt = chromeTimeToUnixMs(row.expires_utc);
    if (expiresAt && expiresAt > Date.now()) {
      expirations.push(expiresAt);
    }
  }

  const createdAtMs = Date.now();
  const ttlMs = Math.max(1, options.ttlHours ?? 12) * 60 * 60 * 1000;
  const expiresAtMs = Math.min(createdAtMs + ttlMs, ...expirations);
  const session: FrontSession = {
    host: FRONT_COOKIE_HOST,
    source: options.source ?? "front-app",
    keychainServiceUsedForUnlock: keychainService,
    cookieHeader: cookieParts.join("; "),
    cookieNames,
    csrfToken,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };

  await writeFrontSession(sessionPath, session);
  return {
    ...(await checkFrontSession(sessionPath)),
    unlocked: true,
    keychainAccessed: true,
    reusedExisting: false,
    note: options.note ?? `Unlocked Front session from ${options.source ?? "front-app"}. Cookie values are not printed.`,
  };
}

export async function unlockFrontSessionFromPlainCookies(
  rows: PlainFrontCookieRow[],
  options: { sessionPath?: string; ttlHours?: number; force?: boolean; source?: string } = {},
): Promise<FrontSessionUnlockResult> {
  const sessionPath = options.sessionPath ?? defaultSessionPath();
  if (!options.force) {
    const existing = await checkFrontSession(sessionPath);
    if (existing.valid) {
      return {
        ...existing,
        unlocked: true,
        keychainAccessed: false,
        reusedExisting: true,
        note: "Unlocked session cache is already valid. Keychain was not accessed.",
      };
    }
  }

  const selected = selectFrontCookieRows(rows.map((row) => plainFrontCookieRowSchema.parse(row)));
  const csrfToken = selected.find((row) => row.name === "front.csrf")?.value;
  const createdAtMs = Date.now();
  const ttlMs = Math.max(1, options.ttlHours ?? 12) * 60 * 60 * 1000;
  const expirations = selected
    .map((row) => chromeTimeToUnixMs(row.expires_utc))
    .filter((expiresAt): expiresAt is number => Boolean(expiresAt && expiresAt > Date.now()));
  const expiresAtMs = Math.min(createdAtMs + ttlMs, ...expirations);
  const session: FrontSession = {
    host: FRONT_COOKIE_HOST,
    source: options.source ?? "plain-cookie-source",
    cookieHeader: selected.map((row) => `${row.name}=${row.value}`).join("; "),
    cookieNames: selected.map((row) => row.name),
    csrfToken,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };

  await writeFrontSession(sessionPath, session);
  return {
    ...(await checkFrontSession(sessionPath)),
    unlocked: true,
    keychainAccessed: false,
    reusedExisting: false,
    note: `Unlocked Front session from ${options.source ?? "plain-cookie-source"}. Cookie values are not printed.`,
  };
}

export async function clearFrontSession(sessionPath = defaultSessionPath()) {
  await unlink(sessionPath).catch(() => {});
  return {
    sessionPath,
    cleared: true,
  };
}

export async function readFrontSession(sessionPath = defaultSessionPath()): Promise<FrontSession | undefined> {
  let raw: SessionFile;
  try {
    raw = frontSessionFileSchema.parse(JSON.parse(await readFile(sessionPath, "utf8"))) as SessionFile;
  } catch {
    return undefined;
  }

  if (raw.version !== SESSION_CRYPTO_VERSION || !raw.expiresAt || Date.parse(raw.expiresAt) <= Date.now()) {
    return undefined;
  }

  try {
    const key = sessionEncryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(raw.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload = frontSessionPayloadSchema.parse(JSON.parse(plaintext));
    return {
      host: raw.host,
      source: raw.source,
      keychainServiceUsedForUnlock: raw.keychainServiceUsedForUnlock,
      cookieHeader: payload.cookieHeader,
      cookieNames: raw.cookieNames,
      csrfToken: payload.csrfToken,
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
    };
  } catch {
    return undefined;
  }
}

export function decryptChromiumCookieValue(encryptedValue: Buffer, password: string, host: string) {
  const prefix = encryptedValue.subarray(0, 3).toString("utf8");
  const payload = prefix === "v10" || prefix === "v11" ? encryptedValue.subarray(3) : encryptedValue;
  const key = pbkdf2Sync(password, CHROME_MAC_SALT, CHROME_MAC_ITERATIONS, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, CHROME_MAC_IV);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  const digest = createHash("sha256").update(host).digest();
  const value = plaintext.subarray(0, digest.length).equals(digest)
    ? plaintext.subarray(digest.length)
    : plaintext;
  return value.toString("utf8");
}

export function encryptChromiumCookieValueForTest(value: string, password: string, host: string) {
  const key = pbkdf2Sync(password, CHROME_MAC_SALT, CHROME_MAC_ITERATIONS, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, CHROME_MAC_IV);
  const digest = createHash("sha256").update(host).digest();
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(Buffer.concat([digest, Buffer.from(value, "utf8")])),
    cipher.final(),
  ]);
}

async function readEncryptedFrontCookies(cookiesPath: string): Promise<CookieSecretRow[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "frontctl-auth-"));
  const copiedPath = join(tempDir, "Cookies.sqlite");

  try {
    await copyFile(cookiesPath, copiedPath);
    const sql = [
      "select host_key, name, hex(encrypted_value) as encrypted_value, expires_utc",
      "from cookies",
      `where host_key in (${FRONT_COOKIE_HOSTS.map((host) => `'${host}'`).join(", ")}) and name in (${FRONT_SESSION_COOKIE_NAMES.map((name) => `'${name}'`).join(", ")})`,
      "order by name, expires_utc desc;",
    ].join(" ");
    const { stdout } = await run("sqlite3", ["-json", copiedPath, sql], 1024 * 1024);
    const rows = stdout.trim()
      ? (JSON.parse(stdout) as unknown[]).map((row) => cookieSecretRowSchema.parse(row)) as CookieSecretRow[]
      : [];
    const selected = selectFrontCookieRows(rows);
    if (!hasRequiredFrontCookies(selected)) {
      throw new Error("Front session cookies were not found. Open Front and sign in, then rerun `frontctl auth unlock`.");
    }
    return selected;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function selectFrontCookieRows<T extends { host_key: string; name: string; expires_utc: number }>(rows: T[]): T[] {
  const byName = new Map<string, T>();
  for (const row of rows) {
    if (!FRONT_SESSION_COOKIE_NAMES.includes(row.name as (typeof FRONT_SESSION_COOKIE_NAMES)[number])) {
      continue;
    }
    const existing = byName.get(row.name);
    if (!existing || row.expires_utc > existing.expires_utc || row.host_key === FRONT_COOKIE_HOST) {
      byName.set(row.name, row);
    }
  }
  return [...FRONT_SESSION_COOKIE_NAMES]
    .map((name) => byName.get(name))
    .filter((row): row is T => Boolean(row));
}

function hasRequiredFrontCookies(rows: Array<{ name: string }>) {
  const names = new Set(rows.map((row) => row.name));
  return REQUIRED_FRONT_COOKIE_NAMES.every((name) => names.has(name));
}

function readKeychainPassword(service: string) {
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not read ${service} from Keychain. Authorize Keychain access and rerun auth unlock.`);
  }
  return result.stdout.trimEnd();
}

async function writeFrontSession(sessionPath: string, session: FrontSession) {
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
  const key = sessionEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({
      cookieHeader: session.cookieHeader,
      csrfToken: session.csrfToken,
    }), "utf8"),
    cipher.final(),
  ]);
  const file: SessionFile = frontSessionFileSchema.parse({
    version: SESSION_CRYPTO_VERSION,
    encryption: {
      mode: SESSION_ENCRYPTION_MODE,
      keychainBackedSessionKey: false,
    },
    host: session.host,
    source: session.source,
    keychainServiceUsedForUnlock: session.keychainServiceUsedForUnlock,
    cookieNames: session.cookieNames,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }) as SessionFile;
  await writeFile(sessionPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(sessionPath, 0o600);
}

function sessionEncryptionKey() {
  return createHash("sha256").update(`${homedir()}:frontctl-local-session:v1`).digest();
}

function chromeTimeToUnixMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value / 1000 - 11_644_473_600_000);
}
