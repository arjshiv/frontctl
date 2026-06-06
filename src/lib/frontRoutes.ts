import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
  searchRaw: (query: string) => string;
  searchHints: (query: string) => string;
  conversations: string;
  conversationStatus: (id: string, status: string) => string;
  conversationBatchArchive: string;
  tagConversation: (id: string, tagAlias: string) => string;
  untagConversation: (id: string, tagAlias: string) => string;
  comments: (id: string) => string;
  message: (id: string) => string;
  messages: (id: string) => string;
}

const ROUTE_PATTERN =
  /(https:\/\/(?:app|[a-z0-9-]+)\.frontapp\.com)\/(cell-[^/\s\x00"'<>\\]+)\/api\/1\/companies\/([a-f0-9]+)\/team\/(\d+)\/conversations\/(?:inbox|done)/i;

export async function discoverFrontRouteContext(cacheDataPath: string): Promise<FrontRouteContext | undefined> {
  let files: string[];
  try {
    files = await readdir(cacheDataPath);
  } catch {
    return undefined;
  }

  for (const file of files) {
    if (file === "index" || file.startsWith(".")) {
      continue;
    }
    let text: string;
    try {
      text = (await readFile(join(cacheDataPath, file))).toString("latin1");
    } catch {
      continue;
    }

    const match = text.match(ROUTE_PATTERN);
    if (match) {
      return {
        origin: match[1],
        cell: match[2],
        companyId: match[3],
        teamId: match[4],
      };
    }
  }

  return undefined;
}

export function buildFrontRoutes(context: FrontRouteContext): FrontRoutes {
  const root = `${context.origin}/${context.cell}/api/1/companies/${context.companyId}`;
  const teamRoot = `${root}/team/${context.teamId}`;

  return {
    boot: `${root}/boot/app/8`,
    inbox: `${teamRoot}/conversations/inbox`,
    done: `${teamRoot}/conversations/done`,
    conversation: (id) => `${root}/conversations/${encodeURIComponent(id)}`,
    timeline: (id) => `${root}/conversations/${encodeURIComponent(id)}/timeline`,
    content: (id) => `${root}/conversations/${encodeURIComponent(id)}/content`,
    searchRaw: (query) => `${root}/search_raw/${encodeURIComponent(query)}`,
    searchHints: (query) => `${root}/search_hints/${encodeURIComponent(query)}`,
    conversations: `${root}/conversations`,
    conversationStatus: (id, status) =>
      `${root}/conversations/${encodeURIComponent(id)}/status/${encodeURIComponent(status)}`,
    conversationBatchArchive: `${root}/conversation_batch/archive`,
    tagConversation: (id, tagAlias) =>
      `${root}/conversations/${encodeURIComponent(id)}/tag/${encodeURIComponent(tagAlias)}`,
    untagConversation: (id, tagAlias) =>
      `${root}/conversations/${encodeURIComponent(id)}/untag/${encodeURIComponent(tagAlias)}`,
    comments: (id) => `${root}/conversations/${encodeURIComponent(id)}/comments`,
    message: (id) => `${root}/messages/${encodeURIComponent(id)}`,
    messages: (id) => `${root}/conversations/${encodeURIComponent(id)}/messages`,
  };
}
