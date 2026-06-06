import { strict as assert } from "node:assert";
import test from "node:test";
import { triageConversationReads } from "../src/lib/triage.js";

test("triageConversationReads groups inbox conversations by next action", () => {
  const result = triageConversationReads([
    {
      id: "needs-reply-1",
      conversation: { id: "needs-reply-1", subject: "Need update", status: "unassigned", hasAttachments: true },
      timeline: [
        { id: "in-1", type: "inbound", date: "2026-06-05T10:00:00.000Z", text: "Can you send an update?" },
        { id: "out-1", type: "out_reply", date: "2026-06-04T10:00:00.000Z", text: "Checking." },
      ],
    },
    {
      id: "waiting-1",
      conversation: { id: "waiting-1", subject: "Waiting", status: "assigned" },
      timeline: [
        { id: "out-2", type: "out_reply", date: "2026-06-05T09:00:00.000Z", text: "Sent details." },
      ],
    },
    {
      id: "archived-1",
      conversation: { id: "archived-1", subject: "Done", status: "archived" },
      timeline: [],
    },
    {
      id: "newsletter-1",
      conversation: {
        id: "newsletter-1",
        subject: "Weekly AI digest",
        status: "unassigned",
        summary: "Read online. Sponsored newsletter roundup. Unsubscribe.",
      },
      timeline: [
        { id: "in-2", type: "inbound", date: "2026-06-05T08:00:00.000Z", text: "View in browser. Unsubscribe." },
      ],
    },
  ], { source: "cache", stale: true });

  assert.equal(result.publicApiUsed, false);
  assert.equal(result.count, 4);
  assert.deepEqual(result.buckets.needsReply.map((item) => item.id), ["needs-reply-1"]);
  assert.deepEqual(result.buckets.waiting.map((item) => item.id), ["waiting-1"]);
  assert.deepEqual(result.buckets.archived.map((item) => item.id), ["archived-1"]);
  assert.deepEqual(result.buckets.manualReview.map((item) => item.id), ["newsletter-1"]);
  assert.deepEqual(result.buckets.withAttachments.map((item) => item.id), ["needs-reply-1"]);
  assert.match(result.buckets.needsReply[0].commands.draftReply, /frontctl draft reply needs-reply-1/);
});
