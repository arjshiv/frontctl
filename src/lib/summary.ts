import type { CachedConversation, CachedTimelineItem } from "./frontCache.js";

export interface ConversationSummaryInput {
  id: string;
  conversation?: CachedConversation;
  timeline: CachedTimelineItem[];
}

export function summarizeConversation(input: ConversationSummaryInput) {
  const messages = input.timeline.filter((item) => item.text);
  const latest = messages[0];
  const inbound = messages.find((item) => item.type === "inbound");
  const outbound = messages.find((item) => item.type === "out_reply" || item.type === "outbound");
  const latestReminder = input.timeline.find((item) => item.type === "reminder");

  return {
    id: input.id,
    subject: input.conversation?.subject ?? latest?.subject ?? "(no subject)",
    status: input.conversation?.status,
    contact: input.conversation?.contact,
    messageCount: input.conversation?.numMessages ?? messages.length,
    hasAttachments: input.conversation?.hasAttachments,
    updatedAt: input.conversation?.updatedAt,
    gist: firstPresent(input.conversation?.summary, latest?.text, inbound?.text),
    latestMessage: summarizeItem(latest),
    latestInbound: summarizeItem(inbound),
    latestOutbound: summarizeItem(outbound),
    latestReminder: summarizeItem(latestReminder),
    suggestedNextStep: suggestedNextStep(input.conversation, inbound, outbound, latestReminder),
    timelineHighlights: messages.slice(0, 5).map(summarizeItem).filter(Boolean),
  };
}

function summarizeItem(item: CachedTimelineItem | undefined) {
  if (!item) {
    return undefined;
  }
  return {
    id: item.id,
    type: item.type,
    date: item.date,
    from: item.from,
    text: item.text,
  };
}

function firstPresent(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())?.trim();
}

function suggestedNextStep(
  conversation: CachedConversation | undefined,
  inbound: CachedTimelineItem | undefined,
  outbound: CachedTimelineItem | undefined,
  reminder: CachedTimelineItem | undefined,
) {
  if (conversation?.status === "archived") {
    return "No immediate action: conversation is archived.";
  }
  if (reminder && (!outbound || Date.parse(reminder.date ?? "") > Date.parse(outbound.date ?? ""))) {
    return "Review the reminder before replying or archiving.";
  }
  if (inbound && (!outbound || Date.parse(inbound.date ?? "") > Date.parse(outbound.date ?? ""))) {
    if (!outbound && !looksActionableInbound(conversation, inbound)) {
      return "Review manually; no clear response needed.";
    }
    return "Likely needs a reply or triage decision.";
  }
  if (outbound) {
    return "Waiting on the other party unless new context arrived.";
  }
  return "Review manually.";
}

function looksActionableInbound(conversation: CachedConversation | undefined, inbound: CachedTimelineItem) {
  const text = [conversation?.subject, conversation?.summary, inbound.text].filter(Boolean).join("\n").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (looksLikeBroadcast(text)) {
    return false;
  }
  return /\?/.test(text) ||
    /\b(can|could|would|will|please|need|needs|needed|help|urgent|asap|confirm|review|approve|send|share|update|follow up|following up|let me know|respond|reply)\b/i.test(text);
}

function looksLikeBroadcast(text: string) {
  return /\b(unsubscribe|read online|view in browser|newsletter|digest|roundup|webinar|sponsored|subscribe|advertisement)\b/i.test(text) ||
    /\b(openai|anthropic|spacex|google ai|viral|launches|announces)\b.*\b(deal|blog|newsletter|digest|roundup|viral|upgrades)\b/i.test(text);
}
