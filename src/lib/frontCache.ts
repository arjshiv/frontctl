import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export interface CachedConversation {
  id: string;
  subject: string;
  status?: string;
  messageType?: string;
  contact?: string;
  summary?: string;
  updatedAt?: string;
  bumpedAt?: string;
  numMessages?: number;
  hasAttachments?: boolean;
}

export interface CachedInboxSnapshot {
  source: "cache";
  stale: true;
  cacheFile: string;
  fetchAt?: string;
  totalCached: number;
  count: number;
  conversations: CachedConversation[];
}

export interface CachedConversationRead {
  source: "cache";
  stale: true;
  id: string;
  cacheFile?: string;
  conversation?: CachedConversation;
  timeline: CachedTimelineItem[];
}

export interface CachedTimelineItem {
  id: string;
  type?: string;
  date?: string;
  from?: string;
  subject?: string;
  text?: string;
  textLength?: number;
  textTruncated?: boolean;
  hasAttachments?: boolean;
  attachments?: CachedAttachment[];
}

export interface CachedAttachment {
  id?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  urlPresent?: boolean;
}

interface CacheDocument {
  file: string;
  fetchAt?: number;
  value: Record<string, unknown>;
}

export interface InboxListOptions {
  limit?: number;
  includeArchived?: boolean;
}

export async function listCachedInbox(cacheDataPath: string, options: InboxListOptions = {}) {
  return listCachedInboxFromDocuments(await readCacheDocuments(cacheDataPath), options);
}

function listCachedInboxFromDocuments(documents: CacheDocument[], options: InboxListOptions = {}) {
  const snapshots = readInboxSnapshotsFromDocuments(documents);
  const latest = snapshots[0];

  if (!latest) {
    return {
      source: "cache" as const,
      stale: true as const,
      cacheFile: undefined,
      fetchAt: undefined,
      totalCached: 0,
      count: 0,
      conversations: [],
      warning: "No cached Front inbox response found. Open Front inbox, then rerun this command.",
    };
  }

  const raw = Array.isArray(latest.value.conversations) ? latest.value.conversations : [];
  const conversations = raw
    .map(normalizeConversation)
    .filter((conversation): conversation is CachedConversation => Boolean(conversation))
    .filter((conversation) => options.includeArchived || conversation.status !== "archived");
  const limited = conversations.slice(0, options.limit ?? 20);

  return {
    source: "cache" as const,
    stale: true as const,
    cacheFile: latest.file,
    fetchAt: latest.fetchAt ? new Date(latest.fetchAt).toISOString() : undefined,
    totalCached: conversations.length,
    count: limited.length,
    conversations: limited,
  } satisfies CachedInboxSnapshot;
}

export async function searchCachedConversations(cacheDataPath: string, query: string, limit = 20) {
  const normalizedQuery = query.trim().toLowerCase();
  const snapshot = await listCachedInbox(cacheDataPath, { includeArchived: true, limit: 500 });

  if (!normalizedQuery) {
    return {
      ...snapshot,
      query,
      count: 0,
      conversations: [],
    };
  }

  const matches = snapshot.conversations
    .filter((conversation) =>
      [
        conversation.id,
        conversation.subject,
        conversation.contact,
        conversation.summary,
        conversation.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
    )
    .slice(0, limit);

  return {
    ...snapshot,
    query,
    count: matches.length,
    conversations: matches,
  };
}

export async function readCachedConversation(
  cacheDataPath: string,
  conversationId: string,
): Promise<CachedConversationRead> {
  const documents = await readCacheDocuments(cacheDataPath);
  return readCachedConversationFromDocuments(documents, conversationId);
}

export async function readCachedConversations(
  cacheDataPath: string,
  options: InboxListOptions = {},
): Promise<CachedConversationRead[]> {
  const documents = await readCacheDocuments(cacheDataPath);
  const snapshot = listCachedInboxFromDocuments(documents, { ...options, includeArchived: options.includeArchived });
  return snapshot.conversations.map((conversation) => readCachedConversationFromDocuments(documents, conversation.id, conversation));
}

function readCachedConversationFromDocuments(
  documents: CacheDocument[],
  conversationId: string,
  knownConversation?: CachedConversation,
): CachedConversationRead {
  const conversation = knownConversation ??
    listCachedInboxFromDocuments(documents, { includeArchived: true, limit: 500 }).conversations
      .find((candidate) => candidate.id === conversationId);
  const content = documents
    .filter((document) => isConversationDocument(document.value, conversationId))
    .sort((a, b) => (Number(b.value.updated_at) || b.fetchAt || 0) - (Number(a.value.updated_at) || a.fetchAt || 0))[0];

  return {
    source: "cache",
    stale: true,
    id: conversationId,
    cacheFile: content?.file,
    conversation,
    timeline: content ? normalizeTimeline(content.value.timeline) : [],
  };
}

async function readInboxSnapshots(cacheDataPath: string): Promise<CacheDocument[]> {
  return readInboxSnapshotsFromDocuments(await readCacheDocuments(cacheDataPath));
}

function readInboxSnapshotsFromDocuments(documents: CacheDocument[]): CacheDocument[] {
  return documents
    .filter((document) => Array.isArray(document.value.conversations))
    .sort((a, b) => (Number(b.value.fetch_at) || b.fetchAt || 0) - (Number(a.value.fetch_at) || a.fetchAt || 0));
}

export async function readCacheDocuments(cacheDataPath: string): Promise<CacheDocument[]> {
  let files: string[];
  try {
    files = await readdir(cacheDataPath);
  } catch {
    return [];
  }

  const documents: CacheDocument[] = [];
  for (const file of files) {
    if (file === "index" || file.startsWith(".")) {
      continue;
    }

    const body = await extractCacheFile(join(cacheDataPath, file));
    if (!body || !body.includes("{")) {
      continue;
    }

    const parsed = parseFirstJsonObject(body);
    if (!parsed) {
      continue;
    }

    if (!isRelevantFrontDocument(parsed)) {
      continue;
    }

    documents.push({
      file,
      fetchAt: typeof parsed.fetch_at === "number" ? parsed.fetch_at : undefined,
      value: parsed,
    });
  }

  return documents;
}

async function extractCacheFile(filePath: string): Promise<string | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return undefined;
  }
  const text = buffer.toString("utf8");
  if (text.includes('{"fetch_at"') || text.includes('"timeline"') || text.includes('{"tags"') || text.includes('"tags"')) {
    return text;
  }

  const gzipOffset = buffer.indexOf(GZIP_MAGIC);
  if (gzipOffset < 0) {
    return undefined;
  }

  const tempPath = join(tmpdir(), `frontctl-${process.pid}-${basename(filePath)}.gz`);
  try {
    await writeFile(tempPath, buffer.subarray(gzipOffset));
    const result = spawnSync("gzip", ["-dc", tempPath], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout || undefined;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function parseFirstJsonObject(input: string): Record<string, unknown> | undefined {
  const starts = ['{"fetch_at"', '{"id"', '{"limit"', '{"updated_at"', '{"tags"', '{"user"', '{"company"']
    .map((needle) => input.indexOf(needle))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const start = starts[0];
  if (start === undefined) {
    return undefined;
  }

  for (let end = input.lastIndexOf("}"); end > start; end = input.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(input.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      // Chromium cache files can append metadata after the response body.
    }
  }

  return undefined;
}

function isRelevantFrontDocument(value: Record<string, unknown>) {
  return (
    Array.isArray(value.conversations) ||
    Array.isArray(value.timeline) ||
    Array.isArray(value.tags) ||
    typeof value.subject === "string" ||
    typeof value.user === "object" ||
    typeof value.company === "object"
  );
}

function isConversationDocument(value: Record<string, unknown>, conversationId: string) {
  if (String(value.id ?? "") === conversationId && Array.isArray(value.timeline)) {
    return true;
  }

  const timeline = value.timeline;
  return (
    Array.isArray(timeline) &&
    timeline.some((item) => item && typeof item === "object" && String((item as Record<string, unknown>).conversation_id ?? "") === conversationId)
  );
}

export function normalizeConversation(value: unknown): CachedConversation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id ?? raw.conversation_id;
  if (id === undefined || id === null) {
    return undefined;
  }

  return {
    id: String(id),
    subject: stringField(raw.subject) || "(no subject)",
    status: stringField(raw.status),
    messageType: stringField(raw.message_type),
    contact: contactName(raw.contact),
    summary: stringField(raw.summary),
    updatedAt: timestampField(raw.updated_at),
    bumpedAt: timestampField(raw.bumped_at),
    numMessages: numberField(raw.num_messages),
    hasAttachments: booleanField(raw.has_attachments),
  };
}

export function normalizeTimeline(value: unknown): CachedTimelineItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): CachedTimelineItem | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const raw = item as Record<string, unknown>;
      const message = raw.message && typeof raw.message === "object" ? (raw.message as Record<string, unknown>) : undefined;
      const id = raw.id ?? message?.id;
      if (id === undefined || id === null) {
        return undefined;
      }

      const timelineItem: CachedTimelineItem = {
        id: String(id),
      };
      assignIfPresent(timelineItem, "type", stringField(raw.type ?? message?.type));
      assignIfPresent(timelineItem, "date", timestampField(raw.date ?? message?.date));
      assignIfPresent(timelineItem, "from", contactName(raw.from ?? message?.from));
      assignIfPresent(timelineItem, "subject", stringField(message?.subject));
      assignText(timelineItem, stringField(message?.text ?? message?.body ?? message?.html ?? message?.blurb));
      const attachments = normalizeAttachments(message?.attachments ?? raw.attachments);
      assignIfPresent(timelineItem, "attachments", attachments.length ? attachments : undefined);
      assignIfPresent(timelineItem, "hasAttachments", attachments.length > 0 ? true : booleanField(message?.has_attachments));
      return timelineItem;
    })
    .filter((item): item is CachedTimelineItem => Boolean(item));
}

export function attachmentsFromTimeline(timeline: CachedTimelineItem[]) {
  return timeline.flatMap((item) =>
    (item.attachments ?? []).map((attachment) => ({
      ...attachment,
      timelineItemId: item.id,
      date: item.date,
      from: item.from,
      subject: item.subject,
    })),
  );
}

function assignIfPresent<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function contactName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return (
    stringField(raw.name) ??
    stringField(raw.display_name) ??
    stringField(raw.card_name) ??
    stringField(raw.handle) ??
    stringField(raw.email) ??
    stringField(raw.alias)
  );
}

function normalizeAttachments(value: unknown): CachedAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): CachedAttachment | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const raw = item as Record<string, unknown>;
      const attachment: CachedAttachment = {};
      assignIfPresent(attachment, "id", stringField(raw.id ?? raw.uid));
      assignIfPresent(attachment, "filename", stringField(raw.filename ?? raw.name ?? raw.display_name));
      assignIfPresent(attachment, "contentType", stringField(raw.content_type ?? raw.mime_type ?? raw.type));
      assignIfPresent(attachment, "size", numberField(raw.size ?? raw.byte_size));
      assignIfPresent(attachment, "urlPresent", raw.url || raw.download_url || raw.content_url ? true : undefined);
      return Object.keys(attachment).length ? attachment : undefined;
    })
    .filter((attachment): attachment is CachedAttachment => Boolean(attachment));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestampField(value: unknown): string | undefined {
  return typeof value === "number" && value > 0 ? new Date(value).toISOString() : undefined;
}

const MAX_TIMELINE_TEXT_CHARS = 20_000;

function assignText(target: CachedTimelineItem, value: string | undefined) {
  const cleaned = cleanMessageText(value);
  if (!cleaned) {
    return;
  }
  target.textLength = cleaned.length;
  target.textTruncated = cleaned.length > MAX_TIMELINE_TEXT_CHARS;
  target.text = target.textTruncated ? cleaned.slice(0, MAX_TIMELINE_TEXT_CHARS) : cleaned;
}

function cleanMessageText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
