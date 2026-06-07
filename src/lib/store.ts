import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./process.js";
import type { CachedConversation, CachedTimelineItem } from "./frontCache.js";

export interface StoreConversationInput {
  conversation: CachedConversation;
  timeline?: CachedTimelineItem[];
  source: "cache" | "live-private";
  syncedAt?: string;
}

export interface StoreSyncResult {
  dbPath: string;
  syncedAt: string;
  conversations: number;
  timelineItems: number;
}

export interface StoreSearchResult {
  dbPath: string;
  query: string;
  count: number;
  conversations: CachedConversation[];
  freshness: StoreFreshness;
}

export interface StoreStats {
  dbPath: string;
  conversations: number;
  timelineItems: number;
  attachments: number;
  ftsRows: number;
  lastSyncedAt?: string;
  sources: Array<{ source: string; count: number; lastSyncedAt?: string }>;
  freshness: StoreFreshness;
}

export interface StoreFreshness {
  lastSyncedAt?: string;
  ageSeconds?: number;
  maxAgeHours: number;
  fresh: boolean;
  warning?: string;
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_STORE_PATH ?? join(homedir(), ".frontctl", "frontctl.sqlite");
}

export async function ensureStore(dbPath = defaultStorePath()) {
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  await execSql(dbPath, schemaSql());
  await ensureTimelineColumns(dbPath);
}

export async function syncStore(
  inputs: StoreConversationInput[],
  dbPath = defaultStorePath(),
): Promise<StoreSyncResult> {
  await ensureStore(dbPath);
  const syncedAt = new Date().toISOString();
  const rows = inputs.map((input) => ({ ...input, syncedAt: input.syncedAt ?? syncedAt }));
  await execSql(dbPath, transactionSql(rows));
  return {
    dbPath,
    syncedAt,
    conversations: rows.length,
    timelineItems: rows.reduce((sum, row) => sum + (row.timeline?.length ?? 0), 0),
  };
}

export async function searchStore(
  query: string,
  limit = 20,
  dbPath = defaultStorePath(),
  maxAgeHours = defaultMaxAgeHours(),
): Promise<StoreSearchResult> {
  await ensureStore(dbPath);
  const expression = ftsExpression(query);
  const sql = `
    select c.id, c.subject, c.status, c.message_type as messageType, c.contact, c.summary,
           c.updated_at as updatedAt, c.bumped_at as bumpedAt, c.num_messages as numMessages,
           c.has_attachments as hasAttachments
    from conversations_fts f
    join conversations c on c.id = f.conversation_id
    where conversations_fts match ${sqlString(expression)}
    order by rank
    limit ${Math.max(1, Math.floor(limit))};
  `;
  const { stdout } = await runSqliteJson(dbPath, sql, 10 * 1024 * 1024);
  const rows = stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [];
  const conversations = rows.map(rowToConversation);
  return {
    dbPath,
    query,
    count: conversations.length,
    conversations,
    freshness: await storeFreshness(dbPath, maxAgeHours),
  };
}

export async function readStoreConversation(
  id: string,
  dbPath = defaultStorePath(),
  maxAgeHours = defaultMaxAgeHours(),
) {
  await ensureStore(dbPath);
  const conversationSql = `
    select id, subject, status, message_type as messageType, contact, summary, updated_at as updatedAt,
           bumped_at as bumpedAt, num_messages as numMessages, has_attachments as hasAttachments
    from conversations
    where id = ${sqlString(id)}
    limit 1;
  `;
  const timelineSql = `
    select id, type, date, sender as "from", subject, text,
           text_length as textLength, text_truncated as textTruncated,
           has_attachments as hasAttachments
    from timeline_items
    where conversation_id = ${sqlString(id)}
    order by coalesce(date, '') desc, id desc;
  `;
  const attachmentSql = `
    select timeline_item_id as timelineItemId, id, filename, content_type as contentType,
           size, url_present as urlPresent
    from attachments
    where conversation_id = ${sqlString(id)}
    order by timeline_item_id, filename;
  `;
  const [{ stdout: conversationStdout }, { stdout: timelineStdout }, { stdout: attachmentStdout }] = await Promise.all([
    runSqliteJson(dbPath, conversationSql, 10 * 1024 * 1024),
    runSqliteJson(dbPath, timelineSql, 10 * 1024 * 1024),
    runSqliteJson(dbPath, attachmentSql, 10 * 1024 * 1024),
  ]);
  const conversations = conversationStdout.trim()
    ? (JSON.parse(conversationStdout) as Array<Record<string, unknown>>)
    : [];
  const timelineRows = timelineStdout.trim()
    ? (JSON.parse(timelineStdout) as Array<Record<string, unknown>>)
    : [];
  const attachmentRows = attachmentStdout.trim()
    ? (JSON.parse(attachmentStdout) as Array<Record<string, unknown>>)
    : [];
  const attachmentsByTimelineId = new Map<string, Array<Record<string, unknown>>>();
  for (const attachment of attachmentRows) {
    const timelineItemId = String(attachment.timelineItemId ?? "");
    attachmentsByTimelineId.set(timelineItemId, [...(attachmentsByTimelineId.get(timelineItemId) ?? []), attachment]);
  }
  return {
    source: "store" as const,
    stale: true as const,
    dbPath,
    id,
    conversation: conversations[0] ? rowToConversation(conversations[0]) : undefined,
    timeline: timelineRows.map((row) => {
      const item = rowToTimelineItem(row);
      const attachments = (attachmentsByTimelineId.get(item.id) ?? []).map(rowToAttachment);
      return attachments.length ? { ...item, attachments, hasAttachments: true } : item;
    }),
    freshness: await storeFreshness(dbPath, maxAgeHours),
  };
}

export async function storeStats(dbPath = defaultStorePath(), maxAgeHours = defaultMaxAgeHours()): Promise<StoreStats> {
  await ensureStore(dbPath);
  const summarySql = `
    select
      (select count(*) from conversations) as conversations,
      (select count(*) from timeline_items) as timelineItems,
      (select count(*) from attachments) as attachments,
      (select count(*) from conversations_fts) as ftsRows,
      (select max(synced_at) from conversations) as lastSyncedAt;
  `;
  const sourcesSql = `
    select source, count(*) as count, max(synced_at) as lastSyncedAt
    from conversations
    group by source
    order by source;
  `;
  const [{ stdout: summaryStdout }, { stdout: sourcesStdout }] = await Promise.all([
    runSqliteJson(dbPath, summarySql, 1024 * 1024),
    runSqliteJson(dbPath, sourcesSql, 1024 * 1024),
  ]);
  const [row = {}] = summaryStdout.trim() ? (JSON.parse(summaryStdout) as Array<Record<string, unknown>>) : [];
  const sources = sourcesStdout.trim() ? (JSON.parse(sourcesStdout) as Array<Record<string, unknown>>) : [];
  return {
    dbPath,
    conversations: Number(row.conversations ?? 0),
    timelineItems: Number(row.timelineItems ?? 0),
    attachments: Number(row.attachments ?? 0),
    ftsRows: Number(row.ftsRows ?? 0),
    lastSyncedAt: stringValue(row.lastSyncedAt),
    sources: sources.map((source) => ({
      source: String(source.source ?? "unknown"),
      count: Number(source.count ?? 0),
      lastSyncedAt: stringValue(source.lastSyncedAt),
    })),
    freshness: freshnessFromLastSynced(stringValue(row.lastSyncedAt), maxAgeHours),
  };
}

export async function storeFreshness(dbPath = defaultStorePath(), maxAgeHours = defaultMaxAgeHours()): Promise<StoreFreshness> {
  await ensureStore(dbPath);
  const sql = "select max(synced_at) as lastSyncedAt from conversations;";
  const { stdout } = await runSqliteJson(dbPath, sql, 1024 * 1024);
  const [row = {}] = stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [];
  return freshnessFromLastSynced(stringValue(row.lastSyncedAt), maxAgeHours);
}

export function defaultMaxAgeHours(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.FRONTCTL_STORE_MAX_AGE_HOURS);
  return Number.isFinite(value) && value > 0 ? value : 12;
}

async function execSql(dbPath: string, sql: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "frontctl-sql-"));
  const sqlPath = join(tempDir, "script.sql");
  try {
    await writeFile(sqlPath, `pragma busy_timeout = 5000;\n${sql}`);
    await runSqliteWithRetry([dbPath, `.read ${sqlPath}`], 50 * 1024 * 1024);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runSqliteJson(dbPath: string, sql: string, maxBuffer: number) {
  return runSqliteWithRetry(["-json", dbPath, sql], maxBuffer);
}

async function runSqliteWithRetry(args: string[], maxBuffer: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await run("sqlite3", args, maxBuffer);
    } catch (error) {
      lastError = error;
      if (!String(error).includes("database is locked")) {
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

function schemaSql() {
  return `
    create table if not exists conversations (
      id text primary key,
      subject text not null,
      status text,
      message_type text,
      contact text,
      summary text,
      updated_at text,
      bumped_at text,
      num_messages integer,
      has_attachments integer,
      source text not null,
      synced_at text not null
    );

    create table if not exists attachments (
      id text primary key,
      conversation_id text not null,
      timeline_item_id text not null,
      filename text,
      content_type text,
      size integer,
      url_present integer,
      source text not null,
      synced_at text not null
    );

    create table if not exists timeline_items (
      id text primary key,
      conversation_id text not null,
      type text,
      date text,
      sender text,
      subject text,
      text text,
      text_length integer,
      text_truncated integer,
      has_attachments integer,
      source text not null,
      synced_at text not null
    );

    create virtual table if not exists conversations_fts using fts5(
      conversation_id unindexed,
      subject,
      contact,
      summary,
      timeline
    );
  `;
}

async function ensureTimelineColumns(dbPath: string) {
  const { stdout } = await runSqliteJson(dbPath, "pragma table_info(timeline_items);", 1024 * 1024);
  const columns = new Set(
    (stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [])
      .map((row) => String(row.name ?? "")),
  );
  const statements: string[] = [];
  if (!columns.has("text_length")) {
    statements.push("alter table timeline_items add column text_length integer;");
  }
  if (!columns.has("text_truncated")) {
    statements.push("alter table timeline_items add column text_truncated integer;");
  }
  if (statements.length) {
    await execSql(dbPath, statements.join("\n"));
  }
}

function transactionSql(inputs: StoreConversationInput[]) {
  const statements = inputs.flatMap((input) => {
    const conversation = input.conversation;
    const timeline = input.timeline ?? [];
    const timelineText = timeline
      .map((item) => [item.from, item.subject, item.text].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("\n");

    return [
      `
      insert into conversations (
        id, subject, status, message_type, contact, summary, updated_at, bumped_at,
        num_messages, has_attachments, source, synced_at
      ) values (
        ${sqlString(conversation.id)},
        ${sqlString(conversation.subject)},
        ${sqlNullable(conversation.status)},
        ${sqlNullable(conversation.messageType)},
        ${sqlNullable(conversation.contact)},
        ${sqlNullable(conversation.summary)},
        ${sqlNullable(conversation.updatedAt)},
        ${sqlNullable(conversation.bumpedAt)},
        ${sqlNumber(conversation.numMessages)},
        ${sqlBoolean(conversation.hasAttachments)},
        ${sqlString(input.source)},
        ${sqlString(input.syncedAt ?? new Date().toISOString())}
      )
      on conflict(id) do update set
        subject = excluded.subject,
        status = excluded.status,
        message_type = excluded.message_type,
        contact = excluded.contact,
        summary = excluded.summary,
        updated_at = excluded.updated_at,
        bumped_at = excluded.bumped_at,
        num_messages = excluded.num_messages,
        has_attachments = excluded.has_attachments,
        source = excluded.source,
        synced_at = excluded.synced_at;
      `,
      `delete from timeline_items where conversation_id = ${sqlString(conversation.id)};`,
      `delete from attachments where conversation_id = ${sqlString(conversation.id)};`,
      ...timeline.map((item) => `
        insert into timeline_items (
          id, conversation_id, type, date, sender, subject, text, text_length, text_truncated,
          has_attachments, source, synced_at
        ) values (
          ${sqlString(item.id)},
          ${sqlString(conversation.id)},
          ${sqlNullable(item.type)},
          ${sqlNullable(item.date)},
          ${sqlNullable(item.from)},
          ${sqlNullable(item.subject)},
          ${sqlNullable(item.text)},
          ${sqlNumber(item.textLength)},
          ${sqlBoolean(item.textTruncated)},
          ${sqlBoolean(item.hasAttachments)},
          ${sqlString(input.source)},
          ${sqlString(input.syncedAt ?? new Date().toISOString())}
        )
        on conflict(id) do update set
          type = excluded.type,
          date = excluded.date,
          sender = excluded.sender,
          subject = excluded.subject,
          text = excluded.text,
          text_length = excluded.text_length,
          text_truncated = excluded.text_truncated,
          has_attachments = excluded.has_attachments,
          source = excluded.source,
          synced_at = excluded.synced_at;
      `),
      ...timeline.flatMap((item) => (item.attachments ?? []).map((attachment, index) => `
        insert into attachments (
          id, conversation_id, timeline_item_id, filename, content_type, size, url_present, source, synced_at
        ) values (
          ${sqlString(attachment.id ?? `${item.id}:attachment:${index}`)},
          ${sqlString(conversation.id)},
          ${sqlString(item.id)},
          ${sqlNullable(attachment.filename)},
          ${sqlNullable(attachment.contentType)},
          ${sqlNumber(attachment.size)},
          ${sqlBoolean(attachment.urlPresent)},
          ${sqlString(input.source)},
          ${sqlString(input.syncedAt ?? new Date().toISOString())}
        )
        on conflict(id) do update set
          conversation_id = excluded.conversation_id,
          timeline_item_id = excluded.timeline_item_id,
          filename = excluded.filename,
          content_type = excluded.content_type,
          size = excluded.size,
          url_present = excluded.url_present,
          source = excluded.source,
          synced_at = excluded.synced_at;
      `)),
      `delete from conversations_fts where conversation_id = ${sqlString(conversation.id)};`,
      `
        insert into conversations_fts (conversation_id, subject, contact, summary, timeline)
        values (
          ${sqlString(conversation.id)},
          ${sqlString(conversation.subject)},
          ${sqlNullable(conversation.contact)},
          ${sqlNullable(conversation.summary)},
          ${sqlString(timelineText)}
        );
      `,
    ];
  });
  return ["begin immediate;", ...statements, "commit;"].join("\n");
}

function rowToConversation(row: Record<string, unknown>): CachedConversation {
  return {
    id: String(row.id ?? ""),
    subject: String(row.subject ?? "(no subject)"),
    status: stringValue(row.status),
    messageType: stringValue(row.messageType),
    contact: stringValue(row.contact),
    summary: stringValue(row.summary),
    updatedAt: stringValue(row.updatedAt),
    bumpedAt: stringValue(row.bumpedAt),
    numMessages: numberValue(row.numMessages),
    hasAttachments: booleanValue(row.hasAttachments),
  };
}

function rowToTimelineItem(row: Record<string, unknown>): CachedTimelineItem {
  return {
    id: String(row.id ?? ""),
    type: stringValue(row.type),
    date: stringValue(row.date),
    from: stringValue(row.from),
    subject: stringValue(row.subject),
    text: stringValue(row.text),
    textLength: numberValue(row.textLength),
    textTruncated: booleanValue(row.textTruncated),
    hasAttachments: booleanValue(row.hasAttachments),
  };
}

function rowToAttachment(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    filename: stringValue(row.filename),
    contentType: stringValue(row.contentType),
    size: numberValue(row.size),
    urlPresent: booleanValue(row.urlPresent),
  };
}

function ftsExpression(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ") || '""';
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullable(value: string | undefined) {
  return value === undefined ? "null" : sqlString(value);
}

function sqlNumber(value: number | undefined) {
  return value === undefined ? "null" : String(Math.floor(value));
}

function sqlBoolean(value: boolean | undefined) {
  return value === undefined ? "null" : value ? "1" : "0";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return undefined;
}

function freshnessFromLastSynced(lastSyncedAt: string | undefined, maxAgeHours: number): StoreFreshness {
  if (!lastSyncedAt) {
    return {
      lastSyncedAt,
      maxAgeHours,
      fresh: false,
      warning: "Local index has not been synced yet. Run `frontctl sync --json`.",
    };
  }
  const syncedMs = Date.parse(lastSyncedAt);
  if (!Number.isFinite(syncedMs)) {
    return {
      lastSyncedAt,
      maxAgeHours,
      fresh: false,
      warning: "Local index sync timestamp is invalid. Run `frontctl sync --json`.",
    };
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - syncedMs) / 1000));
  const fresh = ageSeconds <= maxAgeHours * 60 * 60;
  return {
    lastSyncedAt,
    ageSeconds,
    maxAgeHours,
    fresh,
    warning: fresh
      ? undefined
      : `Local index is older than ${maxAgeHours} hours. Run \`frontctl sync --json\` for fresh results.`,
  };
}
