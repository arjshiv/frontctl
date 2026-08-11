import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  frontRouteBaseContextSchema,
  frontRouteContextFileSchema,
  frontRouteContextSchema,
} from "./schemas.js";

export interface FrontRouteBaseContext {
  origin: string;
  cell: string;
  companyId: string;
}

export interface FrontRouteContext {
  origin: string;
  cell: string;
  companyId: string;
  teamId: string;
}

export interface FrontRoutes {
  boot: string;
  inbox: string;
  done: string;
  conversation: (id: string) => string;
  timeline: (id: string) => string;
  content: (id: string) => string;
  appLink: (link: string) => string;
  searchRaw: (query: string) => string;
  searchHints: (query: string) => string;
  searchCards: (query: string, limit?: number) => string;
  conversations: string;
  conversationEvents: (id: string) => string;
  conversationInboxes: (id: string) => string;
  conversationFollowers: (id: string) => string;
  comments: (id: string) => string;
  comment: (conversationId: string, commentUid: string) => string;
  newConversationComment: (commentUid: string) => string;
  commentTimeline: (conversationId: string, commentUid: string) => string;
  timelineActivity: (conversationId: string, activityId: string) => string;
  message: (id: string) => string;
  messages: (id: string) => string;
  conversationMessage: (conversationId: string, messageUid: string) => string;
  newConversationMessage: (messageUid: string) => string;
  attachment: (id: string) => string;
  card: (id: string) => string;
  contacts: string;
  accounts: string;
  links: string;
  conversationBatchLink: string;
  customFields: string;
  tags: string;
}

const ROUTE_PATTERN =
  /(https:\/\/(?:app|[a-z0-9-]+)\.frontapp\.com)\/(cell-[^/\s\x00"'<>\\]+)\/api\/1\/companies\/([a-f0-9]+)\/team\/(\d+)(?:\/|[?\s\x00"'<>\\]|$)/i;
const BASE_ROUTE_PATTERN =
  /(https:\/\/(?:app|[a-z0-9-]+)\.frontapp\.com)\/(cell-[^/\s\x00"'<>\\]+)\/api\/1\/companies\/([a-f0-9]+)(?:\/|[?\s\x00"'<>\\]|$)/i;
const TEAM_STORAGE_PATTERN = /(?:^|[^A-Za-z0-9_])tea:(\d{4,})(?=$|[^0-9])/g;

interface RouteContextFile {
  version: 1;
  validatedAt: string;
  context: FrontRouteContext;
}

export async function discoverFrontRouteContext(cacheDataPath: string): Promise<FrontRouteContext | undefined> {
  for (const text of await readDirectoryFiles(cacheDataPath)) {
    const match = text.match(ROUTE_PATTERN);
    if (match) {
      return frontRouteContextSchema.parse({
        origin: match[1],
        cell: match[2],
        companyId: match[3],
        teamId: match[4],
      });
    }
  }

  return undefined;
}

export async function discoverFrontRouteBaseContext(
  cacheDataPath: string,
): Promise<FrontRouteBaseContext | undefined> {
  for (const text of await readDirectoryFiles(cacheDataPath)) {
    const match = text.match(BASE_ROUTE_PATTERN);
    if (match) {
      return frontRouteBaseContextSchema.parse({
        origin: match[1],
        cell: match[2],
        companyId: match[3],
      });
    }
  }
  return undefined;
}

export async function discoverFrontTeamId(localStorageLevelDbPath: string): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const text of await readDirectoryFiles(localStorageLevelDbPath)) {
    for (const match of text.matchAll(TEAM_STORAGE_PATTERN)) {
      candidates.add(match[1]);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

export function defaultRouteContextPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.FRONTCTL_ROUTE_CONTEXT_PATH) {
    return env.FRONTCTL_ROUTE_CONTEXT_PATH;
  }
  const sessionPath = env.FRONTCTL_SESSION_PATH ?? join(homedir(), ".frontctl", "session.json");
  return join(dirname(sessionPath), "route-context.json");
}

export async function readPersistedFrontRouteContext(
  contextPath = defaultRouteContextPath(),
): Promise<FrontRouteContext | undefined> {
  try {
    const file = frontRouteContextFileSchema.parse(
      JSON.parse(await readFile(contextPath, "utf8")),
    ) as RouteContextFile;
    return file.context;
  } catch {
    return undefined;
  }
}

export async function writePersistedFrontRouteContext(
  context: FrontRouteContext,
  contextPath = defaultRouteContextPath(),
) {
  const file = frontRouteContextFileSchema.parse({
    version: 1,
    validatedAt: new Date().toISOString(),
    context: frontRouteContextSchema.parse(context),
  }) as RouteContextFile;
  await mkdir(dirname(contextPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${contextPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(temporaryPath, contextPath);
  await chmod(contextPath, 0o600);
}

export async function discoverLocalFrontRouteContext(paths: {
  cacheDataPath: string;
  localStorageLevelDbPath: string;
}): Promise<FrontRouteContext | undefined> {
  const [cached, base, teamId, persisted] = await Promise.all([
    discoverFrontRouteContext(paths.cacheDataPath),
    discoverFrontRouteBaseContext(paths.cacheDataPath),
    discoverFrontTeamId(paths.localStorageLevelDbPath),
    readPersistedFrontRouteContext(),
  ]);
  if (cached) {
    return cached;
  }
  if (base) {
    if (persisted && sameBaseContext(base, persisted)) {
      return persisted;
    }
    if (teamId) {
      return frontRouteContextSchema.parse({ ...base, teamId });
    }
    return undefined;
  }
  return persisted;
}

export function buildFrontBootRoute(context: FrontRouteBaseContext) {
  const base = frontRouteBaseContextSchema.parse(context);
  return `${base.origin}/${base.cell}/api/1/companies/${base.companyId}/boot/app/8`;
}

export function buildFrontRoutes(context: FrontRouteContext): FrontRoutes {
  context = frontRouteContextSchema.parse(context);
  const root = `${context.origin}/${context.cell}/api/1/companies/${context.companyId}`;
  const teamRoot = `${root}/team/${context.teamId}`;

  return {
    boot: `${root}/boot/app/8`,
    inbox: `${teamRoot}/conversations/inbox`,
    done: `${teamRoot}/conversations/done`,
    conversation: (id) => `${root}/conversations/${encodeURIComponent(id)}`,
    timeline: (id) => `${root}/conversations/${encodeURIComponent(id)}/timeline`,
    content: (id) => `${root}/conversations/${encodeURIComponent(id)}/content`,
    appLink: (link) => `${root}/app_link?link=${encodeURIComponent(link)}`,
    searchRaw: (query) => `${root}/search_raw/${encodeURIComponent(query)}`,
    searchHints: (query) => `${root}/search_hints/${encodeURIComponent(query)}`,
    searchCards: (query, limit) =>
      `${root}/search_card/${encodeURIComponent(query.toLowerCase())}${limit ? `?limit=${encodeURIComponent(String(limit))}` : ""}`,
    conversations: `${root}/conversations`,
    conversationEvents: (id) => `${root}/conversations/${encodeURIComponent(id)}/events`,
    conversationInboxes: (id) => `${root}/conversations/${encodeURIComponent(id)}/inboxes`,
    conversationFollowers: (id) => `${root}/conversations/${encodeURIComponent(id)}/followers`,
    comments: (id) => `${root}/conversations/${encodeURIComponent(id)}/comments`,
    comment: (conversationId, commentUid) =>
      `${root}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentUid)}`,
    newConversationComment: (commentUid) =>
      `${root}/conversations/new/comments/${encodeURIComponent(commentUid)}`,
    commentTimeline: (conversationId, commentUid) =>
      `${root}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentUid)}/timeline`,
    timelineActivity: (conversationId, activityId) =>
      `${root}/conversations/${encodeURIComponent(conversationId)}/timeline/${encodeURIComponent(activityId)}`,
    message: (id) => `${root}/messages/${encodeURIComponent(id)}`,
    messages: (id) => `${root}/conversations/${encodeURIComponent(id)}/messages`,
    conversationMessage: (conversationId, messageUid) =>
      `${root}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageUid)}`,
    newConversationMessage: (messageUid) =>
      `${root}/conversations/new/messages/${encodeURIComponent(messageUid)}`,
    attachment: (id) => `${root}/download/${encodeURIComponent(id)}`,
    card: (id) => `${root}/cards/${encodeURIComponent(id)}`,
    contacts: `${root}/contacts`,
    accounts: `${root}/accounts`,
    links: `${root}/links`,
    conversationBatchLink: `${root}/conversation_batch/link`,
    customFields: `${root}/custom_fields`,
    tags: `${root}/tags`,
  };
}

async function readDirectoryFiles(directory: string) {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }

  const texts: string[] = [];
  const newestFirst = await Promise.all(files.map(async (file) => {
    try {
      return { file, mtimeMs: (await stat(join(directory, file))).mtimeMs };
    } catch {
      return { file, mtimeMs: 0 };
    }
  }));
  newestFirst.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const { file } of newestFirst) {
    if (file === "index" || file.startsWith(".")) {
      continue;
    }
    try {
      texts.push((await readFile(join(directory, file))).toString("latin1"));
    } catch {
      // Chromium rotates these files while Front is running; skip a file that moved.
    }
  }
  return texts;
}

function sameBaseContext(base: FrontRouteBaseContext, context: FrontRouteContext) {
  return base.origin === context.origin
    && base.cell === context.cell
    && base.companyId === context.companyId;
}
