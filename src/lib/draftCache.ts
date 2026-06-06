import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CachedDraft {
  id: string;
  kind: string;
  confidence: number;
  conversationId?: string;
  messageUid?: string;
  subject?: string;
  bodySnippet?: string;
  sourceFile: string;
  offset: number;
}

export interface CachedDraftReadResult {
  source: "local-indexeddb";
  stale: true;
  id: string;
  draft?: CachedDraft;
  text?: string;
}

export async function listCachedDrafts(indexedDbLevelDbPath: string): Promise<CachedDraft[]> {
  const files = await listLevelDbFiles(indexedDbLevelDbPath);
  const drafts: CachedDraft[] = [];

  for (const file of files) {
    const text = (await readFile(file)).toString("latin1");
    for (const match of text.matchAll(/draft-(compose|reply|forward|ing)|"type"\s*"draft"|DRAFT/gim)) {
      const offset = match.index ?? 0;
      const window = cleanupText(text.slice(Math.max(0, offset - 1200), offset + 2200));
      const draft = draftFromWindow(file, offset, window, match[1]);
      if (draft && draft.confidence >= 7) {
        drafts.push(draft);
      }
    }
  }

  const byId = new Map<string, CachedDraft>();
  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = [
      draft.conversationId ?? "",
      draft.messageUid ?? "",
      draft.kind,
      draft.bodySnippet ?? "",
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    byId.set(draft.id, draft);
  }
  return [...byId.values()].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.offset - b.offset);
}

export async function readCachedDraft(
  indexedDbLevelDbPath: string,
  id: string,
): Promise<CachedDraftReadResult> {
  const drafts = await listCachedDrafts(indexedDbLevelDbPath);
  const draft = drafts.find((candidate) => candidate.id === id);
  if (!draft) {
    return { source: "local-indexeddb", stale: true, id };
  }
  const text = (await readFile(draft.sourceFile)).toString("latin1");
  return {
    source: "local-indexeddb",
    stale: true,
    id,
    draft,
    text: cleanupText(text.slice(Math.max(0, draft.offset - 2000), draft.offset + 5000)),
  };
}

async function listLevelDbFiles(root: string) {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && /\.(ldb|log)$/i.test(name)) {
      files.push(path);
    }
  }
  return files;
}

function draftFromWindow(file: string, offset: number, window: string, kindMatch?: string): CachedDraft | undefined {
  if (!/draft|DRAFT/.test(window)) {
    return undefined;
  }
  const conversationId = firstMatch(window, /conversations\/(\d+)/);
  const messageUid = firstMatch(window, /messages\/([a-f0-9]{8,})/i);
  const subject = firstMatch(window, /(?:subject|Re:)\s*[:"]?\s*([^"]{3,120})/i);
  const bodySnippet = extractBodySnippet(window);
  const confidence = draftConfidence(window, kindMatch, bodySnippet, conversationId);
  return {
    id: createHash("sha256").update(`${file}:${offset}`).digest("hex").slice(0, 16),
    kind: kindMatch ? `draft-${kindMatch}` : "draft",
    confidence,
    conversationId,
    messageUid,
    subject,
    bodySnippet,
    sourceFile: file,
    offset,
  };
}

function extractBodySnippet(text: string) {
  const afterBlurb = text.match(/blurb["\s:]+(.{20,700})/i)?.[1] ?? text;
  return cleanupText(afterBlurb)
    .replace(/"[^"]*"\s*[:_]\s*/g, " ")
    .slice(0, 500)
    .trim() || undefined;
}

function draftConfidence(window: string, kindMatch: string | undefined, bodySnippet: string | undefined, conversationId: string | undefined) {
  let score = 0;
  if (kindMatch) score += 5;
  if (/"type"\s*"draft"|DRAFT/.test(window)) score += 2;
  if (/\b(?:blurb|body|html)\b/i.test(window)) score += 2;
  if (/\b(?:isSaving|wasSaved|recipients|isReply)\b/.test(window)) score += 2;
  if (conversationId) score += 1;
  if (bodySnippet && englishWordCount(bodySnippet) >= 6) score += 2;
  if (bodySnippet && symbolRatio(bodySnippet) < 0.35) score += 1;
  return score;
}

function englishWordCount(text: string) {
  const common = text.match(/\b(?:the|and|you|your|we|our|this|that|for|with|from|please|thanks|thank|hello|hi|let|know|will|can|have|hope|follow|reply|send|need)\b/gi);
  return common?.length ?? 0;
}

function symbolRatio(text: string) {
  if (!text) {
    return 1;
  }
  const symbols = text.replace(/[a-z0-9\s.,!?'"@:/()-]/gi, "").length;
  return symbols / text.length;
}

function cleanupText(text: string) {
  return text
    .replace(/\0/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.trim();
}
