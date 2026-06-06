import { readCacheDocuments } from "./frontCache.js";

export interface FrontTag {
  id?: string;
  alias?: string;
  name?: string;
  color?: string;
}

export interface TagResolution {
  input: string;
  resolvedAlias: string;
  matchedBy: "alias" | "id" | "name" | "literal";
  tag?: FrontTag;
  warning?: string;
}

export async function listCachedTags(cacheDataPath: string, limit = 100) {
  const documents = await readCacheDocuments(cacheDataPath);
  const tags = uniqueTags(documents.flatMap((document) => extractTags(document.value))).slice(0, limit);
  return {
    source: "cache" as const,
    stale: true as const,
    count: tags.length,
    tags,
    warning: tags.length ? undefined : "No cached Front tags found. Open a tagged conversation or run `frontctl tag list --live --json` after auth unlock.",
  };
}

export function extractTags(value: unknown): FrontTag[] {
  const tags: FrontTag[] = [];
  visit(value, undefined, tags);
  return uniqueTags(tags);
}

export function resolveTagIdentifier(input: string, tags: FrontTag[]): TagResolution {
  const trimmed = input.trim();
  const normalized = normalizeLookup(trimmed);
  const matches = tags
    .map((tag) => ({ tag, matchedBy: tagMatchKind(tag, normalized) }))
    .filter((match): match is { tag: FrontTag; matchedBy: "alias" | "id" | "name" } => Boolean(match.matchedBy));

  if (!matches.length) {
    return {
      input,
      resolvedAlias: trimmed,
      matchedBy: "literal",
      warning: "No cached tag matched this input. Treating it as a literal Front tag alias.",
    };
  }

  const aliasMatches = matches.filter((match) => match.matchedBy === "alias");
  const idMatches = matches.filter((match) => match.matchedBy === "id");
  const nameMatches = matches.filter((match): match is { tag: FrontTag; matchedBy: "name" } => match.matchedBy === "name");
  const best = aliasMatches[0] ?? idMatches[0] ?? uniqueNameMatch(nameMatches, input);
  if (!best) {
    throw new Error(`Tag name is ambiguous: ${input}. Use an exact alias or id from frontctl tag list.`);
  }
  const resolvedAlias = best.tag.alias ?? best.tag.id ?? best.tag.name;
  if (!resolvedAlias) {
    throw new Error(`Matched tag has no usable alias/id/name: ${input}`);
  }
  return {
    input,
    resolvedAlias,
    matchedBy: best.matchedBy,
    tag: best.tag,
  };
}

function visit(value: unknown, parentKey: string | undefined, tags: FrontTag[]) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, parentKey, tags);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const raw = value as Record<string, unknown>;
  if (looksLikeTag(raw, parentKey)) {
    const tag = normalizeTag(raw);
    if (tag) {
      tags.push(tag);
    }
  }

  for (const [key, child] of Object.entries(raw)) {
    if (keySensitive(key)) {
      continue;
    }
    visit(child, key, tags);
  }
}

function looksLikeTag(raw: Record<string, unknown>, parentKey: string | undefined) {
  const keySuggestsTag = Boolean(parentKey && /tags?|taggings?/i.test(parentKey));
  const typeSuggestsTag = stringField(raw.type)?.toLowerCase() === "tag";
  const hasTagIdentity = Boolean(raw.id ?? raw.uid ?? raw.alias ?? raw.slug ?? raw.name ?? raw.display_name);
  return hasTagIdentity && (keySuggestsTag || typeSuggestsTag);
}

function normalizeTag(raw: Record<string, unknown>): FrontTag | undefined {
  const id = stringField(raw.id ?? raw.uid);
  const alias = stringField(raw.alias ?? raw.slug ?? raw.handle);
  const name = stringField(raw.name ?? raw.display_name ?? raw.label);
  const color = stringField(raw.color ?? raw.background_color ?? raw.hex_color);
  const tag: FrontTag = {};
  assignIfPresent(tag, "id", id);
  assignIfPresent(tag, "alias", alias);
  assignIfPresent(tag, "name", name);
  assignIfPresent(tag, "color", color);
  return Object.keys(tag).length ? tag : undefined;
}

function uniqueTags(tags: FrontTag[]) {
  const seen = new Set<string>();
  const unique: FrontTag[] = [];
  for (const tag of tags) {
    const key = tag.alias ?? tag.id ?? tag.name;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(tag);
  }
  return unique.sort((a, b) => (a.name ?? a.alias ?? a.id ?? "").localeCompare(b.name ?? b.alias ?? b.id ?? ""));
}

function keySensitive(key: string) {
  return /cookie|token|auth|secret|body|text|html|email/i.test(key);
}

function tagMatchKind(tag: FrontTag, normalized: string): "alias" | "id" | "name" | undefined {
  if (normalizeLookup(tag.alias) === normalized) {
    return "alias";
  }
  if (normalizeLookup(tag.id) === normalized) {
    return "id";
  }
  if (normalizeLookup(tag.name) === normalized) {
    return "name";
  }
  return undefined;
}

function uniqueNameMatch(matches: Array<{ tag: FrontTag; matchedBy: "name" }>, input: string) {
  if (matches.length <= 1) {
    return matches[0];
  }
  const aliases = new Set(matches.map((match) => match.tag.alias ?? match.tag.id ?? match.tag.name).filter(Boolean));
  if (aliases.size === 1) {
    return matches[0];
  }
  throw new Error(`Tag name is ambiguous: ${input}. Use an exact alias or id from frontctl tag list.`);
}

function normalizeLookup(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().toLowerCase()
    : "";
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function assignIfPresent<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}
