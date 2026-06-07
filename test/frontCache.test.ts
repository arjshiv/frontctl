import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  listCachedInbox,
  normalizeTimeline,
  normalizeConversation,
  readCachedConversations,
  readCachedConversation,
  searchCachedConversations,
} from "../src/lib/frontCache.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontCacheFixture } from "./helpers.js";

test("listCachedInbox reads the latest cached inbox without archived conversations by default", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-list"));
  await writeFakeFrontCacheFixture(paths);

  const result = await listCachedInbox(paths.cacheDataPath);

  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.fetchAt, "2026-06-05T18:26:22.041Z");
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.id),
    ["93727705553", "95907812305"],
  );
  assert.equal(result.conversations[0].contact, "Ricky Espana (Support)");
  assert.equal(result.conversations[0].hasAttachments, true);
});

test("listCachedInbox can include archived conversations and apply limits", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-archived"));
  await writeFakeFrontCacheFixture(paths);

  const result = await listCachedInbox(paths.cacheDataPath, { includeArchived: true, limit: 2 });

  assert.equal(result.count, 2);
  assert.equal(result.totalCached, 3);
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.status),
    ["unassigned", "assigned"],
  );
});

test("searchCachedConversations searches cached subjects, contacts, summaries, and archived items", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-search"));
  await writeFakeFrontCacheFixture(paths);

  const bySubject = await searchCachedConversations(paths.cacheDataPath, "residesk", 10);
  const byContact = await searchCachedConversations(paths.cacheDataPath, "erica", 10);
  const bySummary = await searchCachedConversations(paths.cacheDataPath, "document next", 10);

  assert.deepEqual(
    bySubject.conversations.map((conversation) => conversation.id),
    ["95843954129"],
  );
  assert.deepEqual(
    byContact.conversations.map((conversation) => conversation.id),
    ["95907812305"],
  );
  assert.deepEqual(
    bySummary.conversations.map((conversation) => conversation.id),
    ["93727705553"],
  );
});

test("normalizeConversation accepts live search conversation_id fields", () => {
  const conversation = normalizeConversation({
    conversation_id: "search-result-1",
    subject: "Live search result",
    contact: { name: "Front Contact" },
  });

  assert.equal(conversation?.id, "search-result-1");
  assert.equal(conversation?.subject, "Live search result");
});

test("normalizeTimeline preserves rich message text with bounded truncation metadata", () => {
  const longText = `Intro ${"long body ".repeat(80)}closing marker`;
  const timeline = normalizeTimeline([
    {
      id: "timeline-1",
      type: "message",
      message: {
        id: "message-1",
        html: `<p>${longText}</p><script>SECRET_SCRIPT()</script>`,
      },
    },
    {
      id: "timeline-2",
      message: {
        id: "message-2",
        text: "x".repeat(21_000),
      },
    },
  ]);

  assert.match(timeline[0].text ?? "", /closing marker/);
  assert.doesNotMatch(timeline[0].text ?? "", /SECRET_SCRIPT|<p>|<\/p>/);
  assert.equal(timeline[0].textTruncated, false);
  assert.ok((timeline[0].textLength ?? 0) > 500);
  assert.equal(timeline[1].text?.length, 20_000);
  assert.equal(timeline[1].textLength, 21_000);
  assert.equal(timeline[1].textTruncated, true);
});

test("normalizeTimeline preserves Front comment text", () => {
  const timeline = normalizeTimeline([
    {
      id: "activity-1",
      type: "comment",
      comment: {
        uid: "comment-1",
        text: "frontctl agent action\nActor: Codex\nAction: archive",
      },
    },
  ]);

  assert.equal(timeline[0].type, "comment");
  assert.match(timeline[0].text ?? "", /frontctl agent action/);
  assert.match(timeline[0].text ?? "", /Action: archive/);
});

test("readCachedConversation returns cached timeline snippets without raw cache request text", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-read"));
  await writeFakeFrontCacheFixture(paths);

  const result = await readCachedConversation(paths.cacheDataPath, "93727705553");
  const serialized = JSON.stringify(result);

  assert.equal(result.id, "93727705553");
  assert.equal(result.conversation?.subject, "Re: Your O-1A onboarding with Deel | Arjun Kannan");
  assert.equal(result.timeline.length, 2);
  assert.equal(result.timeline[0].from, "Ricky Espana (Support)");
  assert.match(result.timeline[0].text ?? "", /upload the remaining materials/);
  assert.equal(result.timeline[0].attachments?.[0].filename, "checklist.pdf");
  assert.equal(result.timeline[0].attachments?.[0].urlPresent, true);
  assert.doesNotMatch(serialized, /SECRET_CACHE_TOKEN|access_token|api2\.frontapp\.com/);
  assert.doesNotMatch(serialized, /SECRET_ATTACHMENT_TOKEN|signed\.example/);
});

test("readCachedConversations bulk reads selected cached conversations from one cache scan", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-bulk-read"));
  await writeFakeFrontCacheFixture(paths);

  const reads = await readCachedConversations(paths.cacheDataPath, { includeArchived: true, limit: 3 });

  assert.deepEqual(
    reads.map((read) => read.id),
    ["93727705553", "95907812305", "95843954129"],
  );
  assert.equal(reads[0].conversation?.subject, "Re: Your O-1A onboarding with Deel | Arjun Kannan");
  assert.equal(reads[0].timeline[0].attachments?.[0].filename, "checklist.pdf");
});

test("listCachedInbox reports an actionable warning when no inbox cache exists", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-empty"));

  const result = await listCachedInbox(paths.cacheDataPath);

  assert.equal(result.count, 0);
  assert.match(result.warning ?? "", /Open Front inbox/i);
});

test("listCachedInbox ignores nested cache directories", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cache-directory"));
  await mkdir(join(paths.cacheDataPath, "nested-cache-dir"));
  await writeFakeFrontCacheFixture(paths);

  const result = await listCachedInbox(paths.cacheDataPath);

  assert.equal(result.count, 2);
});
