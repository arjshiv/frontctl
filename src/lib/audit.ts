import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MutationAuditEvent {
  action: string;
  mode: "dry-run" | "execute";
  conversationId?: string;
  method?: string;
  path?: string;
  body?: unknown;
}

export interface MutationAuditEntry {
  ts?: string;
  action?: string;
  mode?: "dry-run" | "execute";
  conversationId?: string;
  method?: string;
  path?: string;
  bodyKeys?: string[];
  bodySha256?: string;
}

export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_AUDIT_PATH ?? join(homedir(), ".frontctl", "audit.jsonl");
}

export async function auditMutation(event: MutationAuditEvent, auditPath = defaultAuditPath()) {
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  const entry = {
    ts: new Date().toISOString(),
    action: event.action,
    mode: event.mode,
    conversationId: event.conversationId,
    method: event.method,
    path: event.path,
    bodyKeys: bodyKeys(event.body),
    bodySha256: event.body === undefined ? undefined : sha256(JSON.stringify(event.body)),
  };
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function listAuditEntries(options: {
  auditPath?: string;
  limit?: number;
  action?: string;
  conversationId?: string;
  mode?: "dry-run" | "execute";
} = {}) {
  const auditPath = options.auditPath ?? defaultAuditPath();
  const entries = await readAuditFile(auditPath);
  const filtered = entries
    .filter((entry) => !options.action || entry.action === options.action)
    .filter((entry) => !options.conversationId || entry.conversationId === options.conversationId)
    .filter((entry) => !options.mode || entry.mode === options.mode)
    .sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")))
    .slice(0, options.limit ?? 50);
  return {
    auditPath,
    count: filtered.length,
    entries: filtered,
  };
}

async function readAuditFile(auditPath: string): Promise<MutationAuditEntry[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseAuditLine)
    .filter((entry): entry is MutationAuditEntry => Boolean(entry));
}

function parseAuditLine(line: string): MutationAuditEntry | undefined {
  try {
    const raw = JSON.parse(line) as unknown;
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const entry = raw as Record<string, unknown>;
    return {
      ts: stringField(entry.ts),
      action: stringField(entry.action),
      mode: entry.mode === "dry-run" || entry.mode === "execute" ? entry.mode : undefined,
      conversationId: stringField(entry.conversationId),
      method: stringField(entry.method),
      path: stringField(entry.path),
      bodyKeys: Array.isArray(entry.bodyKeys) ? entry.bodyKeys.map(String).sort() : undefined,
      bodySha256: stringField(entry.bodySha256),
    };
  } catch {
    return undefined;
  }
}

function bodyKeys(body: unknown) {
  return body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
