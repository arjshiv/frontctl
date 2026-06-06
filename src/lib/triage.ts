import type { CachedConversation, CachedTimelineItem } from "./frontCache.js";
import { summarizeConversation } from "./summary.js";

export interface TriageItem {
  id: string;
  subject?: string;
  status?: string;
  contact?: string;
  updatedAt?: string;
  hasAttachments?: boolean;
  gist?: string;
  suggestedNextStep?: string;
  reason: string;
  commands: {
    read: string;
    summarize: string;
    draftReply: string;
    archivePreview: string;
    snoozePreview: string;
  };
}

export interface TriageResult {
  source?: string;
  stale?: boolean;
  publicApiUsed: false;
  scope: "inbox";
  count: number;
  buckets: {
    needsReply: TriageItem[];
    waiting: TriageItem[];
    reminders: TriageItem[];
    withAttachments: TriageItem[];
    archived: TriageItem[];
    manualReview: TriageItem[];
  };
}

export function triageConversationReads(reads: Array<{
  id: string;
  conversation?: CachedConversation;
  timeline: CachedTimelineItem[];
}>, metadata: {
  source?: string;
  stale?: boolean;
} = {}): TriageResult {
  const buckets: TriageResult["buckets"] = {
    needsReply: [],
    waiting: [],
    reminders: [],
    withAttachments: [],
    archived: [],
    manualReview: [],
  };

  for (const read of reads) {
    const summary = summarizeConversation({
      id: read.id,
      conversation: read.conversation,
      timeline: read.timeline,
    });
    const item = triageItem(read.id, read.conversation, summary);
    const step = summary.suggestedNextStep ?? "";
    if (read.conversation?.status === "archived") {
      buckets.archived.push(item);
    } else if (/reminder/i.test(step)) {
      buckets.reminders.push(item);
    } else if (/needs a reply|triage decision|reply/i.test(step)) {
      buckets.needsReply.push(item);
    } else if (/waiting/i.test(step)) {
      buckets.waiting.push(item);
    } else {
      buckets.manualReview.push(item);
    }
    if (read.conversation?.hasAttachments) {
      buckets.withAttachments.push({ ...item, reason: "Has attachments." });
    }
  }

  return {
    source: metadata.source,
    stale: metadata.stale,
    publicApiUsed: false,
    scope: "inbox",
    count: reads.length,
    buckets,
  };
}

function triageItem(id: string, conversation: CachedConversation | undefined, summary: ReturnType<typeof summarizeConversation>): TriageItem {
  const subject = conversation?.subject ?? summary.subject;
  return {
    id,
    subject,
    status: conversation?.status ?? summary.status,
    contact: conversation?.contact ?? summary.contact,
    updatedAt: conversation?.updatedAt ?? summary.updatedAt,
    hasAttachments: conversation?.hasAttachments ?? summary.hasAttachments,
    gist: summary.gist,
    suggestedNextStep: summary.suggestedNextStep,
    reason: summary.suggestedNextStep ?? "Review manually.",
    commands: {
      read: `frontctl read ${shellToken(id)} --json`,
      summarize: `frontctl summarize ${shellToken(id)} --json`,
      draftReply: `frontctl draft reply ${shellToken(id)} --body-file reply.md --json`,
      archivePreview: `frontctl archive ${shellToken(id)} --json`,
      snoozePreview: `frontctl snooze ${shellToken(id)} tomorrow-9am --json`,
    },
  };
}

function shellToken(value: string) {
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : JSON.stringify(value);
}
