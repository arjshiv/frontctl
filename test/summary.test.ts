import { strict as assert } from "node:assert";
import test from "node:test";
import { summarizeConversation } from "../src/lib/summary.js";

test("summarizeConversation identifies likely reply-needed conversations", () => {
  const summary = summarizeConversation({
    id: "conversation-1",
    conversation: {
      id: "conversation-1",
      subject: "Need help",
      status: "unassigned",
      contact: "Customer",
      numMessages: 2,
      summary: "Customer is asking for a status update.",
    },
    timeline: [
      {
        id: "message-2",
        type: "inbound",
        date: "2026-06-05T10:00:00.000Z",
        from: "Customer",
        text: "Can you send an update?",
      },
      {
        id: "message-1",
        type: "out_reply",
        date: "2026-06-04T10:00:00.000Z",
        from: "User",
        text: "Looking into this.",
      },
    ],
  });

  assert.equal(summary.subject, "Need help");
  assert.equal(summary.gist, "Customer is asking for a status update.");
  assert.match(summary.suggestedNextStep, /reply/i);
  assert.equal(summary.timelineHighlights.length, 2);
});

test("summarizeConversation treats archived conversations as no immediate action", () => {
  const summary = summarizeConversation({
    id: "conversation-1",
    conversation: {
      id: "conversation-1",
      subject: "Done",
      status: "archived",
    },
    timeline: [],
  });

  assert.match(summary.suggestedNextStep, /No immediate action/);
});

test("summarizeConversation does not classify newsletters as reply-needed", () => {
  const summary = summarizeConversation({
    id: "newsletter-1",
    conversation: {
      id: "newsletter-1",
      subject: "ChatGPT Remembers You Better Now - Anthropic's Blog Goes Viral",
      status: "unassigned",
      contact: "Newsletter",
      numMessages: 1,
      summary: "Read online. OpenAI upgrades ChatGPT memory. Unsubscribe from this newsletter.",
    },
    timeline: [
      {
        id: "message-1",
        type: "inbound",
        date: "2026-06-05T10:00:00.000Z",
        from: "Newsletter",
        text: "OpenAI upgrades ChatGPT memory. View in browser. Unsubscribe.",
      },
    ],
  });

  assert.match(summary.suggestedNextStep, /Review manually/);
  assert.doesNotMatch(summary.suggestedNextStep ?? "", /reply/i);
});

test("summarizeConversation keeps direct first-contact requests reply-needed", () => {
  const summary = summarizeConversation({
    id: "request-1",
    conversation: {
      id: "request-1",
      subject: "Question about onboarding",
      status: "unassigned",
      contact: "Customer",
      numMessages: 1,
    },
    timeline: [
      {
        id: "message-1",
        type: "inbound",
        date: "2026-06-05T10:00:00.000Z",
        from: "Customer",
        text: "Can you please send an update?",
      },
    ],
  });

  assert.match(summary.suggestedNextStep, /reply/i);
});
