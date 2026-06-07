import { readMemoryProfile, type MemoryProfile } from "./memory.js";
import { run } from "./process.js";
import { defaultStorePath, ensureStore } from "./store.js";

export interface WorkflowReport {
  source: "local-workflows";
  publicApiUsed: false;
  generatedAt: string;
  dbPath: string;
  observedWindow: {
    requestedMonths: number;
    cutoff: string;
    oldest?: string;
    newest?: string;
    conversations: number;
  };
  liveVerification?: {
    source: "live-private";
    verifiedAt: string;
    activeConversations: number;
    note: string;
  };
  productLens: {
    principle: string;
    observations: string[];
  };
  workflows: Workflow[];
}

export interface Workflow {
  id: "daily-triage" | "noise-review" | "follow-up" | "tag-hygiene" | "ops-risk";
  label: string;
  goal: string;
  whenToUse: string;
  items: WorkflowItem[];
  nextCommands: string[];
}

export interface WorkflowItem {
  id: string;
  subject?: string;
  status?: string;
  contact?: string;
  bumpedAt?: string;
  updatedAt?: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  commands: {
    read: string;
    summarize: string;
    archivePreview?: string;
    snoozePreview?: string;
    tagList?: string;
    tagPreview?: string;
  };
}

export interface WorkflowRow {
  id: string;
  subject?: string;
  status?: string;
  messageType?: string;
  contact?: string;
  summary?: string;
  bumpedAt?: string;
  updatedAt?: string;
  numMessages?: number;
  hasAttachments?: boolean;
}

export async function buildWorkflowReport(options: {
  dbPath?: string;
  memoryPath?: string;
  months?: number;
  limit?: number;
  actor?: string;
  currentOpenRows?: WorkflowRow[];
} = {}): Promise<WorkflowReport> {
  const dbPath = options.dbPath ?? defaultStorePath();
  await ensureStore(dbPath);
  const months = options.months ?? 6;
  const limit = options.limit ?? 8;
  const actor = options.actor ?? "frontctl agent";
  const cutoff = cutoffDate(months);
  const [memory, rows] = await Promise.all([
    readMemoryProfile(options.memoryPath),
    readWorkflowRows(dbPath, cutoff.toISOString()),
  ]);
  const recent = rows.sort(byRecent);
  const currentOpenRows = options.currentOpenRows?.sort(byRecent);
  const activeRows = currentOpenRows ?? recent.filter((row) => row.status !== "archived");
  const archiveContacts = archiveHeavyContacts(recent);
  const dailyItems = todayMatters(activeRows).slice(0, limit);
  const noiseItems = noiseCandidates(activeRows, archiveContacts).slice(0, limit);
  const followUpItems = followUps(activeRows).slice(0, limit);
  const tagItems = tagOpportunities(activeRows).slice(0, limit);
  const opsItems = opsRisk(recent).slice(0, limit);

  return {
    source: "local-workflows",
    publicApiUsed: false,
    generatedAt: new Date().toISOString(),
    dbPath,
    observedWindow: {
      requestedMonths: months,
      cutoff: cutoff.toISOString(),
      oldest: recent.map(rowDate).filter(Boolean).at(-1),
      newest: recent.map(rowDate).find(Boolean),
      conversations: recent.length,
    },
    liveVerification: currentOpenRows
      ? {
        source: "live-private",
        verifiedAt: new Date().toISOString(),
        activeConversations: currentOpenRows.length,
        note: "Open-action queues were filtered through the current live inbox so stale local rows are not proposed as active work.",
      }
      : undefined,
    productLens: {
      principle: "Make the agent useful in the workflows the user already repeats; default to previews and local evidence.",
      observations: observations(recent, memory),
    },
    workflows: [
      workflow("daily-triage", "Daily triage", "Show what deserves attention before touching state.", "Start here each day or before an inbox-zero pass.", dailyItems, actor),
      workflow("noise-review", "Noise review", "Preview obvious archive candidates without hiding anything automatically.", "Use when the inbox has low-value notifications, newsletters, and receipts.", noiseItems, actor),
      workflow("follow-up", "Follow-up review", "Keep multi-message, attachment, and scheduling threads moving.", "Use before drafting replies or snoozing work.", followUpItems, actor),
      workflow("tag-hygiene", "Tag hygiene", "Suggest where durable tags would reduce future search and triage work.", "Use after memory init or when repeated themes show up.", tagItems, actor),
      workflow("ops-risk", "Ops and risk alerts", "Separate alerts that should be reviewed from routine archive noise.", "Use when job failures, billing, security, or operational alerts appear.", opsItems, actor),
    ],
  };
}

async function readWorkflowRows(dbPath: string, cutoffIso: string): Promise<WorkflowRow[]> {
  const sql = `
    select id, subject, status, message_type as messageType, contact, summary,
           bumped_at as bumpedAt, updated_at as updatedAt, num_messages as numMessages,
           has_attachments as hasAttachments
    from conversations
    where coalesce(bumped_at, updated_at, synced_at, '') >= ${sqlString(cutoffIso)}
    order by coalesce(bumped_at, updated_at, synced_at, '') desc;
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
    bumpedAt: stringValue(row.bumpedAt),
    updatedAt: stringValue(row.updatedAt),
    numMessages: numberValue(row.numMessages),
    hasAttachments: booleanValue(row.hasAttachments),
  }));
}

function workflow(
  id: Workflow["id"],
  label: string,
  goal: string,
  whenToUse: string,
  rows: WorkflowRow[],
  actor: string,
): Workflow {
  return {
    id,
    label,
    goal,
    whenToUse,
    items: rows.map((row) => itemFor(id, row, actor)),
    nextCommands: nextCommands(id, actor),
  };
}

function itemFor(workflowId: Workflow["id"], row: WorkflowRow, actor: string): WorkflowItem {
  const reason = reasonFor(workflowId, row);
  const tag = tagFor(row);
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    contact: row.contact,
    bumpedAt: row.bumpedAt,
    updatedAt: row.updatedAt,
    reason,
    confidence: confidenceFor(workflowId, row),
    commands: {
      read: `frontctl read ${shellToken(row.id)} --live --json`,
      summarize: `frontctl summarize ${shellToken(row.id)} --live --json`,
      archivePreview: workflowId === "noise-review" ? archiveCommand(row.id, actor, reason) : undefined,
      snoozePreview: workflowId === "follow-up" || workflowId === "daily-triage"
        ? snoozeCommand(row.id, actor, reason)
        : undefined,
      tagList: workflowId === "tag-hygiene" ? "frontctl tag list --live --json" : undefined,
      tagPreview: workflowId === "tag-hygiene" && tag
        ? `frontctl tag add ${shellToken(row.id)} ${shellToken(tag)} --actor ${shellToken(actor)} --reason ${shellToken(reason)} --json`
        : undefined,
    },
  };
}

function observations(rows: WorkflowRow[], memory: MemoryProfile | undefined) {
  const archived = rows.filter((row) => row.status === "archived");
  const open = rows.filter((row) => row.status !== "archived");
  const singleArchived = archived.filter((row) => (row.numMessages ?? 0) <= 1 && !row.hasAttachments);
  const archiveContacts = archiveHeavyContacts(rows);
  const notes = [
    `${singleArchived.length} of ${archived.length} archived conversations are single-message/no-attachment, so archive previews should be fast but still visible.`,
    `${open.filter((row) => (row.numMessages ?? 0) > 1).length} open conversations are multi-message; these are better treated as follow-up work than archive candidates.`,
    `${archiveContacts.size} senders appear archive-heavy in the observed window; use them as suggestions, not silent rules.`,
  ];
  if (memory) {
    notes.push(`Local memory exists with ${memory.corpus.conversations} conversations and ${memory.preferences.tagOpportunities.length} tag opportunity groups.`);
  } else {
    notes.push("No local memory profile found yet; run `frontctl memory init --live --all --limit 200 --json` after unlock.");
  }
  return notes;
}

function todayMatters(rows: WorkflowRow[]) {
  return rows
    .filter((row) => row.status !== "archived")
    .filter((row) => (row.numMessages ?? 0) > 1 || Boolean(row.hasAttachments) || isScheduling(row) || isSupport(row) || isRisk(row))
    .sort(prioritySort);
}

function noiseCandidates(rows: WorkflowRow[], archiveContacts: Set<string>) {
  return rows
    .filter((row) => row.status !== "archived")
    .filter((row) => !row.hasAttachments && (row.numMessages ?? 0) <= 1)
    .filter((row) => archiveContacts.has(row.contact ?? "") || isNewsletter(row) || isReceipt(row) || isRoutineNotification(row))
    .filter((row) => !isRisk(row))
    .sort(prioritySort);
}

function followUps(rows: WorkflowRow[]) {
  return rows
    .filter((row) => row.status !== "archived")
    .filter((row) => (row.numMessages ?? 0) > 1 || Boolean(row.hasAttachments) || isScheduling(row))
    .sort(prioritySort);
}

function tagOpportunities(rows: WorkflowRow[]) {
  return rows
    .filter((row) => row.status !== "archived")
    .filter((row) => Boolean(tagFor(row)))
    .sort(prioritySort);
}

function opsRisk(rows: WorkflowRow[]) {
  return rows
    .filter((row) => isOps(row) || isRisk(row) || isReceipt(row))
    .sort(prioritySort);
}

function archiveHeavyContacts(rows: WorkflowRow[]) {
  const counts = new Map<string, { archived: number; open: number }>();
  for (const row of rows) {
    const contact = row.contact;
    if (!contact) continue;
    const current = counts.get(contact) ?? { archived: 0, open: 0 };
    if (row.status === "archived") current.archived += 1;
    else current.open += 1;
    counts.set(contact, current);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count.archived >= 2 && count.open === 0)
      .map(([contact]) => contact),
  );
}

function reasonFor(workflowId: Workflow["id"], row: WorkflowRow) {
  if (workflowId === "noise-review") return "Looks like recurring low-value mail based on prior archive behavior.";
  if (workflowId === "follow-up") return row.hasAttachments ? "Open thread has attachments that may need review." : "Open multi-message or scheduling thread may need follow-up.";
  if (workflowId === "tag-hygiene") return `Theme matches suggested tag: ${tagFor(row) ?? "review"}.`;
  if (workflowId === "ops-risk") return isRisk(row) ? "Operational or risk alert should be reviewed before archiving." : "Operational or finance notification should be separated from human follow-up.";
  return "Likely attention-worthy open conversation.";
}

function confidenceFor(workflowId: Workflow["id"], row: WorkflowRow): WorkflowItem["confidence"] {
  if (workflowId === "noise-review") return (row.numMessages ?? 0) <= 1 && !row.hasAttachments ? "high" : "medium";
  if (workflowId === "ops-risk") return isRisk(row) ? "high" : "medium";
  if (workflowId === "tag-hygiene") return tagFor(row) ? "medium" : "low";
  return (row.numMessages ?? 0) > 1 || row.hasAttachments ? "high" : "medium";
}

function tagFor(row: WorkflowRow) {
  if (isReceipt(row)) return "Finance";
  if (isScheduling(row)) return "Scheduling";
  if (isRisk(row)) return "Risk";
  if (isSupport(row)) return "Needs Reply";
  if (isOps(row)) return "Ops";
  return undefined;
}

function nextCommands(id: Workflow["id"], actor: string) {
  const base = ["frontctl memory report --json"];
  if (id === "daily-triage") return [...base, "frontctl triage inbox --live --limit 20 --json"];
  if (id === "noise-review") return [...base, `frontctl archive CONVERSATION_ID --actor ${shellToken(actor)} --reason "User approved archive from daily noise review" --json`];
  if (id === "follow-up") return [...base, `frontctl snooze CONVERSATION_ID tomorrow-9am --actor ${shellToken(actor)} --reason "User approved follow-up reminder" --json`];
  if (id === "tag-hygiene") return [...base, "frontctl tag list --live --json"];
  return [...base, "frontctl read CONVERSATION_ID --live --json"];
}

function isNewsletter(row: WorkflowRow) {
  return /\b(newsletter|digest|subscribe|read online|weekly|report)\b/i.test(text(row));
}

function isReceipt(row: WorkflowRow) {
  return /\b(invoice|billing|payment|receipt|budget|contractor payment|renewal|pricing)\b/i.test(text(row));
}

function isScheduling(row: WorkflowRow) {
  return /\b(schedule|booking|meeting|calendar|availability|prep email|reschedule)\b/i.test(text(row));
}

function isSupport(row: WorkflowRow) {
  return /\b(support|customer|resident|issue|escalation|follow.?up|reply|needs reply)\b/i.test(text(row));
}

function isRisk(row: WorkflowRow) {
  return /\b(security|critical|violation|incident|risk|failed|failure|bug|outage|vulnerability)\b/i.test(text(row));
}

function isOps(row: WorkflowRow) {
  return /\b(job|cron|backfill|duplicate|alert|fixed|failed|mailroom|document scan)\b/i.test(text(row));
}

function isRoutineNotification(row: WorkflowRow) {
  return /\b(notification|summary|reminder|upgrade|limit|new duplicates|document scans?)\b/i.test(text(row));
}

function prioritySort(a: WorkflowRow, b: WorkflowRow) {
  const score = (row: WorkflowRow) =>
    (row.hasAttachments ? 4 : 0)
    + ((row.numMessages ?? 0) > 1 ? 3 : 0)
    + (isRisk(row) ? 3 : 0)
    + (isScheduling(row) ? 2 : 0)
    + (isSupport(row) ? 2 : 0);
  return score(b) - score(a) || byRecent(a, b);
}

function byRecent(a: WorkflowRow, b: WorkflowRow) {
  return Date.parse(rowDate(b) ?? "") - Date.parse(rowDate(a) ?? "");
}

function rowDate(row: WorkflowRow) {
  return row.bumpedAt ?? row.updatedAt;
}

function cutoffDate(months: number) {
  const now = process.env.FRONTCTL_NOW ? new Date(process.env.FRONTCTL_NOW) : new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - Math.max(1, Math.floor(months)));
  return cutoff;
}

function archiveCommand(id: string, actor: string, reason: string) {
  return `frontctl archive ${shellToken(id)} --actor ${shellToken(actor)} --reason ${shellToken(reason)} --json`;
}

function snoozeCommand(id: string, actor: string, reason: string) {
  return `frontctl snooze ${shellToken(id)} tomorrow-9am --actor ${shellToken(actor)} --reason ${shellToken(reason)} --json`;
}

function text(row: WorkflowRow) {
  return [row.subject, row.contact, row.summary, row.messageType].filter(Boolean).join(" ");
}

function shellToken(value: string) {
  return /^[A-Za-z0-9._:@/-]+$/.test(value) ? value : JSON.stringify(value);
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
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
