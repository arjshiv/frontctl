import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { readStoreConversation, searchStore, syncStore } from "../src/lib/store.js";
import { makeTempDir } from "./helpers.js";

test("syncStore indexes conversations and timeline text with FTS", async () => {
  const dbPath = join(await makeTempDir("frontctl-store"), "frontctl.sqlite");

  const sync = await syncStore([
    {
      source: "cache",
      conversation: {
        id: "conversation-1",
        subject: "Lease renewal",
        contact: "Customer",
        summary: "Resident asks about renewal pricing.",
      },
      timeline: [
        {
          id: "message-1",
          type: "inbound",
          from: "Customer",
          text: "Can you explain the renewal offer?",
          textLength: 34,
          textTruncated: false,
          attachments: [
            {
              id: "attachment-1",
              filename: "renewal.pdf",
              contentType: "application/pdf",
              size: 123,
              urlPresent: true,
            },
          ],
        },
      ],
    },
  ], dbPath);
  const search = await searchStore("renewal offer", 10, dbPath);
  const read = await readStoreConversation("conversation-1", dbPath);

  assert.equal(sync.conversations, 1);
  assert.equal(sync.timelineItems, 1);
  assert.equal(search.count, 1);
  assert.equal(search.conversations[0].id, "conversation-1");
  assert.equal(search.freshness.fresh, true);
  assert.equal(read.timeline[0].text, "Can you explain the renewal offer?");
  assert.equal(read.timeline[0].textLength, 34);
  assert.equal(read.timeline[0].textTruncated, false);
  assert.equal(read.timeline[0].attachments?.[0].filename, "renewal.pdf");
  assert.equal(read.freshness.fresh, true);
});

test("store freshness marks old syncs as stale with resync guidance", async () => {
  const dbPath = join(await makeTempDir("frontctl-store-freshness"), "frontctl.sqlite");
  await syncStore([
    {
      source: "cache",
      syncedAt: "2020-01-01T00:00:00.000Z",
      conversation: {
        id: "conversation-1",
        subject: "Old sync",
      },
    },
  ], dbPath);

  const search = await searchStore("Old", 10, dbPath, 1);

  assert.equal(search.freshness.fresh, false);
  assert.equal(search.freshness.maxAgeHours, 1);
  assert.match(search.freshness.warning ?? "", /frontctl sync --live/);
});
