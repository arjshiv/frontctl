import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mutationAuditEntrySchema } from "./schemas.js";

export interface MutationAuditEvent {
  action: string;
  mode: "dry-run" | "execute";
  conversationId?: string;
  actor?: MutationActor;
  reason?: string;
  method?: string;
  path?: string;
  body?: unknown;
}

export interface MutationActor {
  name: string;
  client?: string;
  runId?: string;
}

export interface MutationAuditEntry {
  ts?: string;
  action?: string;
  mode?: "dry-run" | "execute";
  conversationId?: string;
  actor?: MutationActor;
  reason?: string;
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
    actor: event.actor,
    reason: event.reason,
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
    const parsed = mutationAuditEntrySchema.safeParse(raw);
    if (!parsed.success) {
      return undefined;
    }
    const entry = parsed.data;
    return {
      ts: entry.ts,
      action: entry.action,
      mode: entry.mode,
      conversationId: entry.conversationId,
      actor: entry.actor,
      reason: entry.reason,
      method: entry.method,
      path: entry.path,
      bodyKeys: entry.bodyKeys?.map(String).sort(),
      bodySha256: entry.bodySha256,
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
