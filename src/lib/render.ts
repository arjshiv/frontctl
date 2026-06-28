import type { CachedConversation, CachedTimelineItem } from "./frontCache.js";

export type OutputFormat = "json" | "plain" | "markdown";

export interface ConversationListLike {
  source?: string;
  transport?: string;
  stale?: boolean;
  publicApiUsed?: boolean;
  routes?: string[];
  query?: string;
  totalReturned?: number;
  count?: number;
  freshness?: { fresh?: boolean; warning?: string; lastSyncedAt?: string };
  conversations?: CachedConversation[];
}

export interface ConversationReadLike {
  source?: string;
  transport?: string;
  stale?: boolean;
  publicApiUsed?: boolean;
  id: string;
  freshness?: { fresh?: boolean; warning?: string; lastSyncedAt?: string };
  conversation?: CachedConversation;
  timeline?: CachedTimelineItem[];
  full?: unknown;
}

export interface SummaryLike {
  source?: string;
  stale?: boolean;
  summary?: {
    id: string;
    subject?: string;
    status?: string;
    contact?: string;
    messageCount?: number;
    hasAttachments?: boolean;
    updatedAt?: string;
    gist?: string;
    suggestedNextStep?: string;
    timelineHighlights?: Array<{
      id?: string;
      type?: string;
      date?: string;
      from?: string;
      text?: string;
    } | undefined>;
  };
}

export function formatFromArgs(args: string[]): OutputFormat {
  const index = args.indexOf("--format");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === "plain" || value === "markdown") {
    return value;
  }
  return "json";
}

export function maybeRenderConversationList(result: ConversationListLike, args: string[]) {
  const format = formatFromArgs(args);
  return format === "json" ? result : renderConversationList(result, format);
}

export function maybeRenderConversationRead(result: ConversationReadLike, args: string[]) {
  const format = formatFromArgs(args);
  return format === "json" ? result : renderConversationRead(result, format);
}

export function maybeRenderSummary(result: SummaryLike, args: string[]) {
  const format = formatFromArgs(args);
  return format === "json" ? result : renderSummary(result, format);
}

export function skipValueFlag(args: string[], flag: string, index: number) {
  return args[index] === flag;
}

export function argsWithoutValueFlag(args: string[], flag: string) {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

export function firstPositionalArg(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" || arg === "--format" || arg === "--body" || arg === "--body-file") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      return arg;
    }
  }
  return undefined;
}

function renderConversationList(result: ConversationListLike, format: Exclude<OutputFormat, "json">) {
  const heading = result.query ? `Search: ${result.query}` : "Front Conversations";
  const lines = format === "markdown"
    ? [`# ${heading}`, "", metaLine(result), ""]
    : [heading, metaLine(result), ""];
  pushFreshness(lines, result.freshness);

  const conversations = result.conversations ?? [];
  if (!conversations.length) {
    lines.push(format === "markdown" ? "_No conversations found._" : "No conversations found.");
    return lines.filter(Boolean).join("\n");
  }

  conversations.forEach((conversation, index) => {
    const title = `${index + 1}. ${conversation.subject || "(no subject)"}`;
    if (format === "markdown") {
      lines.push(`## ${title}`);
      lines.push(`- ID: \`${conversation.id}\``);
      pushOptional(lines, "Status", conversation.status);
      pushOptional(lines, "Contact", conversation.contact);
      pushOptional(lines, "Updated", conversation.updatedAt);
      pushOptional(lines, "Messages", conversation.numMessages);
      if (conversation.hasAttachments) lines.push("- Attachments: yes");
      pushOptional(lines, "Summary", conversation.summary);
      lines.push("");
    } else {
      lines.push(`${title} [${conversation.id}]`);
      lines.push(`  ${compact([conversation.status, conversation.contact, conversation.updatedAt])}`);
      if (conversation.summary) lines.push(`  ${conversation.summary}`);
      lines.push("");
    }
  });

  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trimEnd();
}

function renderConversationRead(result: ConversationReadLike, format: Exclude<OutputFormat, "json">) {
  const conversation = result.conversation;
  const title = conversation?.subject ?? `Conversation ${result.id}`;
  const lines = format === "markdown"
    ? [`# ${title}`, "", `ID: \`${result.id}\`  `, `${metaLine(result)}  `]
    : [title, `ID: ${result.id}`, metaLine(result)];
  pushFreshness(lines, result.freshness);

  if (conversation) {
    if (format === "markdown") {
      pushOptional(lines, "Status", conversation.status);
      pushOptional(lines, "Contact", conversation.contact);
      pushOptional(lines, "Updated", conversation.updatedAt);
      pushOptional(lines, "Messages", conversation.numMessages);
      if (conversation.hasAttachments) lines.push("- Attachments: yes");
    } else {
      lines.push(compact([conversation.status, conversation.contact, conversation.updatedAt]));
    }
  }

  lines.push("", format === "markdown" ? "## Timeline" : "Timeline", "");
  const timeline = result.timeline ?? [];
  if (!timeline.length) {
    lines.push(format === "markdown" ? "_No timeline items found._" : "No timeline items found.");
    return lines.join("\n").trimEnd();
  }

  for (const item of timeline) {
    const label = compact([item.date, item.type, item.from]);
    if (format === "markdown") {
      lines.push(`### ${label || item.id}`);
      if (item.id) lines.push(`- Item: \`${item.id}\``);
      if (item.subject) lines.push(`- Subject: ${item.subject}`);
      if (item.textTruncated) lines.push(`- Text: truncated at ${item.text?.length ?? 0} of ${item.textLength} characters`);
      if (item.attachments?.length) {
        lines.push(`- Attachments: ${item.attachments.map(renderAttachment).join(", ")}`);
      }
      lines.push("");
      lines.push(item.text || "_No text snippet._");
      lines.push("");
    } else {
      lines.push(label || item.id);
      if (item.subject) lines.push(`Subject: ${item.subject}`);
      if (item.textTruncated) lines.push(`Text: truncated at ${item.text?.length ?? 0} of ${item.textLength} characters`);
      if (item.attachments?.length) lines.push(`Attachments: ${item.attachments.map(renderAttachment).join(", ")}`);
      lines.push(item.text || "No text snippet.");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function renderSummary(result: SummaryLike, format: Exclude<OutputFormat, "json">) {
  const summary = result.summary;
  if (!summary) {
    return format === "markdown" ? "# Summary\n\n_No summary available._" : "Summary\nNo summary available.";
  }

  const lines = format === "markdown"
    ? [`# ${summary.subject || "Conversation Summary"}`, "", metaLine(result), ""]
    : [summary.subject || "Conversation Summary", metaLine(result), ""];

  if (format === "markdown") {
    lines.push(`- ID: \`${summary.id}\``);
    pushOptional(lines, "Status", summary.status);
    pushOptional(lines, "Contact", summary.contact);
    pushOptional(lines, "Updated", summary.updatedAt);
    pushOptional(lines, "Messages", summary.messageCount);
    if (summary.hasAttachments) lines.push("- Attachments: yes");
    pushOptional(lines, "Next step", summary.suggestedNextStep);
    pushOptional(lines, "Gist", summary.gist);
    lines.push("", "## Highlights", "");
    for (const item of summary.timelineHighlights ?? []) {
      if (item) lines.push(`- ${compact([item.date, item.type, item.from])}: ${item.text ?? ""}`.trim());
    }
  } else {
    lines.push(`ID: ${summary.id}`);
    lines.push(compact([summary.status, summary.contact, summary.updatedAt]));
    if (summary.suggestedNextStep) lines.push(`Next step: ${summary.suggestedNextStep}`);
    if (summary.gist) lines.push(`Gist: ${summary.gist}`);
    lines.push("", "Highlights:");
    for (const item of summary.timelineHighlights ?? []) {
      if (item) lines.push(`- ${compact([item.date, item.type, item.from])}: ${item.text ?? ""}`.trim());
    }
  }

  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trimEnd();
}

function metaLine(result: { source?: string; transport?: string; stale?: boolean }) {
  return compact([result.source, result.transport, result.stale ? "stale" : undefined]);
}

function pushFreshness(lines: string[], freshness: { warning?: string; lastSyncedAt?: string } | undefined) {
  if (freshness?.warning) {
    lines.push(`Freshness: ${freshness.warning}`);
    return;
  }
  if (freshness?.lastSyncedAt) {
    lines.push(`Freshness: synced at ${freshness.lastSyncedAt}`);
  }
}

function pushOptional(lines: string[], label: string, value: unknown) {
  if (value !== undefined && value !== null && value !== "") {
    lines.push(`- ${label}: ${String(value)}`);
  }
}

function compact(values: Array<unknown>) {
  return values.filter((value) => value !== undefined && value !== null && value !== "").join(" | ");
}

function renderAttachment(attachment: { filename?: string; contentType?: string; size?: number; urlPresent?: boolean }) {
  return compact([
    attachment.filename ?? "attachment",
    attachment.contentType,
    attachment.size ? `${attachment.size} bytes` : undefined,
    attachment.urlPresent ? "url present" : undefined,
  ]);
}
