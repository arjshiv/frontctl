import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { buildMemoryProfile, readMemoryProfile, writeMemoryProfile } from "../src/lib/memory.js";
import { syncStore } from "../src/lib/store.js";
import { makeTempDir } from "./helpers.js";

test("buildMemoryProfile infers local aggregate preferences without raw timeline bodies", async () => {
  const root = await makeTempDir("frontctl-memory");
  const dbPath = join(root, "frontctl.sqlite");
  const memoryPath = join(root, "memory.json");
  await syncStore([
    {
      source: "live-private",
      conversation: {
        id: "archive-1",
        subject: "Weekly digest",
        status: "archived",
        summary: "Newsletter update",
        numMessages: 1,
        hasAttachments: false,
      },
      timeline: [{ id: "message-1", text: "RAW TIMELINE BODY SHOULD NOT BE IN MEMORY" }],
    },
    {
      source: "live-private",
      conversation: {
        id: "open-1",
        subject: "Contract renewal meeting",
        status: "unassigned",
        summary: "Pricing and contract follow-up",
        numMessages: 4,
        hasAttachments: true,
      },
    },
  ], dbPath);

  const profile = await buildMemoryProfile({ dbPath, memoryPath });
  await writeMemoryProfile(profile, memoryPath);
  const saved = await readMemoryProfile(memoryPath);
  const serialized = JSON.stringify(saved);

  assert.equal(profile.privacy.localOnly, true);
  assert.equal(profile.privacy.storesRawTimelineBodies, false);
  assert.equal(profile.corpus.conversations, 2);
  assert.equal(profile.corpus.singleMessageArchived, 1);
  assert.ok(profile.preferences.likelyArchiveFast.some((signal) => /single-message/.test(signal.label)));
  assert.ok(profile.preferences.likelyKeepOpen.some((signal) => /attachment/.test(signal.label)));
  assert.ok(profile.preferences.tagOpportunities.some((signal) => /billing|finance/.test(signal.label)));
  assert.doesNotMatch(serialized, /RAW TIMELINE BODY/);
});
