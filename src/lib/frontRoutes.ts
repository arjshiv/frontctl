import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { frontRouteContextSchema } from "./schemas.js";

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
