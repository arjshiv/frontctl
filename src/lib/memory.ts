import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./process.js";
import { defaultStorePath, ensureStore, storeStats } from "./store.js";

export interface MemoryProfile {
  schemaVersion: 1;
  generatedAt: string;
  memoryPath: string;
  dbPath: string;
  privacy: {
    localOnly: true;
    storesCookies: false;
    storesAuthHeaders: false;
    storesRawTimelineBodies: false;
    note: string;
  };
  corpus: {
    conversations: number;
    archived: number;
    open: number;
    snoozed: number;
    withAttachments: number;
    singleMessageArchived: number;
    multiMessageOpen: number;
  };
  workSurfaces: {
    sources: Array<{ source: string; count: number; lastSyncedAt?: string }>;
    note: string;
  };
  preferences: {
    likelyArchiveFast: PreferenceSignal[];
    likelyKeepOpen: PreferenceSignal[];
    tagOpportunities: PreferenceSignal[];
  };
  suggestedNextCommands: string[];
}

export interface PreferenceSignal {
  label: string;
  confidence: "low" | "medium" | "high";
  count: number;
  rationale: string;
  exampleConversationIds: string[];
}

interface MemoryConversationRow {
  id: string;
  subject?: string;
  status?: string;
  messageType?: string;
  contact?: string;
  summary?: string;
  numMessages?: number;
  hasAttachments?: boolean;
  source?: string;
}

export function defaultMemoryPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_MEMORY_PATH ?? join(homedir(), ".frontctl", "memory.json");
}

export async function buildMemoryProfile(options: {
  dbPath?: string;
  memoryPath?: string;
  limit?: number;
} = {}): Promise<MemoryProfile> {
  const dbPath = options.dbPath ?? defaultStorePath();
  const memoryPath = options.memoryPath ?? defaultMemoryPath();
  await ensureStore(dbPath);
  const [stats, rows] = await Promise.all([
    storeStats(dbPath),
    readMemoryRows(dbPath, options.limit ?? 500),
  ]);
  const corpus = {
    conversations: rows.length,
    archived: rows.filter((row) => row.status === "archived").length,
    open: rows.filter((row) => !row.status || row.status === "open" || row.status === "unassigned").length,
    snoozed: rows.filter((row) => row.status === "snoozed").length,
    withAttachments: rows.filter((row) => row.hasAttachments).length,
    singleMessageArchived: rows.filter((row) => row.status === "archived" && (row.numMessages ?? 0) <= 1).length,
    multiMessageOpen: rows.filter((row) => row.status !== "archived" && (row.numMessages ?? 0) > 1).length,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    memoryPath,
    dbPath,
    privacy: {
      localOnly: true,
      storesCookies: false,
      storesAuthHeaders: false,
      storesRawTimelineBodies: false,
      note: "Memory is a local aggregate preference profile. It stores counts, signals, and conversation ids, not cookies, auth headers, or raw timeline bodies.",
    },
    corpus,
    workSurfaces: {
      sources: stats.sources,
      note: "Sources identify whether the local profile came from cache or live private reads. Front inbox names are not persisted yet.",
    },
    preferences: {
      likelyArchiveFast: archiveSignals(rows),
      likelyKeepOpen: keepOpenSignals(rows),
      tagOpportunities: tagSignals(rows),
    },
    suggestedNextCommands: [
      "frontctl sync --live --all --limit 200 --json",
      "frontctl memory init --limit 500 --json",
      "frontctl tag list --live --json",
      "frontctl triage inbox --live --limit 20 --json",
    ],
  };
}

export async function writeMemoryProfile(profile: MemoryProfile, memoryPath = profile.memoryPath) {
  await mkdir(dirname(memoryPath), { recursive: true, mode: 0o700 });
  await writeFile(memoryPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  return {
    memoryPath,
    written: true,
    profile,
  };
}

export async function readMemoryProfile(memoryPath = defaultMemoryPath()): Promise<MemoryProfile | undefined> {
  try {
    return JSON.parse(await readFile(memoryPath, "utf8")) as MemoryProfile;
  } catch {
    return undefined;
  }
}

async function readMemoryRows(dbPath: string, limit: number): Promise<MemoryConversationRow[]> {
  const sql = `
    select id, subject, status, message_type as messageType, contact, summary,
           num_messages as numMessages, has_attachments as hasAttachments, source
    from conversations
    order by coalesce(bumped_at, updated_at, synced_at, '') desc
    limit ${Math.max(1, Math.floor(limit))};
  `;
  const { stdout } = await run("sqlite3", ["-json", dbPath, sql], 10 * 1024 * 1024);
  const rows = stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [];
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    subject: stringValue(row.subject),
    status: stringValue(row.status),
    messageType: stringValue(row.messageType),
    contact: stringValue(row.contact),
    summary: stringValue(row.summary),
    numMessages: numberValue(row.numMessages),
    hasAttachments: booleanValue(row.hasAttachments),
    source: stringValue(row.source),
  }));
}

function archiveSignals(rows: MemoryConversationRow[]): PreferenceSignal[] {
  const archived = rows.filter((row) => row.status === "archived");
  return [
    signal(
      "Archive single-message, no-attachment conversations quickly",
      archived.filter((row) => (row.numMessages ?? 0) <= 1 && !row.hasAttachments),
      rows.length,
      "These look like low-friction closes because they are already archived, short, and have no attachments.",
    ),
    signal(
      "Archive newsletter or notification-like conversations",
      archived.filter((row) => text(row).match(/\b(newsletter|digest|notification|webinar|receipt|alert)\b/i)),
      rows.length,
      "Archived conversations with newsletter/notification wording are likely safe future archive candidates after preview.",
    ),
  ].filter((item): item is PreferenceSignal => Boolean(item));
}

function keepOpenSignals(rows: MemoryConversationRow[]): PreferenceSignal[] {
  const open = rows.filter((row) => row.status !== "archived");
  return [
    signal(
      "Keep multi-message active conversations open",
      open.filter((row) => (row.numMessages ?? 0) > 1),
      rows.length,
      "Open conversations with multiple messages are more likely to need continuity or follow-up.",
    ),
    signal(
      "Keep attachment-bearing conversations open",
      open.filter((row) => row.hasAttachments),
      rows.length,
      "Attachments often imply documents, invoices, contracts, screenshots, or files that may need review.",
    ),
  ].filter((item): item is PreferenceSignal => Boolean(item));
}

function tagSignals(rows: MemoryConversationRow[]): PreferenceSignal[] {
  const categories: Array<{ label: string; pattern: RegExp; rationale: string }> = [
    {
      label: "Consider a billing or finance tag",
      pattern: /\b(invoice|billing|payment|receipt|renewal|pricing|contract)\b/i,
      rationale: "Repeated finance-like language benefits from a stable tag instead of ad hoc search.",
    },
    {
      label: "Consider a scheduling tag",
      pattern: /\b(schedule|calendar|meeting|booking|reschedule|availability)\b/i,
      rationale: "Scheduling conversations are easy to lose in a general inbox and often need time-based follow-up.",
    },
    {
      label: "Consider a security or product-risk tag",
      pattern: /\b(security|injection|risk|incident|bug|outage|vulnerability)\b/i,
      rationale: "Risk and technical issue threads usually deserve durable grouping and review.",
    },
    {
      label: "Consider a customer or support follow-up tag",
      pattern: /\b(customer|resident|support|issue|escalation|follow.?up|reply)\b/i,
      rationale: "Support-like threads benefit from a tag that separates response work from reading.",
    },
  ];
  return categories
    .map((category) => signal(category.label, rows.filter((row) => text(row).match(category.pattern)), rows.length, category.rationale))
    .filter((item): item is PreferenceSignal => Boolean(item));
}

function signal(label: string, rows: MemoryConversationRow[], total: number, rationale: string): PreferenceSignal | undefined {
  if (!rows.length) {
    return undefined;
  }
  const ratio = total ? rows.length / total : 0;
  return {
    label,
    confidence: ratio >= 0.3 ? "high" : ratio >= 0.12 || rows.length >= 3 ? "medium" : "low",
    count: rows.length,
    rationale,
    exampleConversationIds: rows.slice(0, 5).map((row) => row.id),
  };
}

function text(row: MemoryConversationRow) {
  return [row.subject, row.contact, row.summary, row.messageType].filter(Boolean).join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return undefined;
}
