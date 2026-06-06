import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  archiveConversation,
  commentConversation,
  draftCommand,
  snoozeConversation,
  tagConversation,
} from "../src/commands/mutations.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("archiveConversation dry-run builds discovered private route without unlocked auth", async () => {
  const { paths, auditPath } = await fakeMutationContext("frontctl-mutation-archive");

  const result = await archiveConversation([
    "conversation-1",
    "--actor",
    "Codex",
    "--client",
    "codex",
    "--run-id",
    "run-123",
    "--reason",
    "Low-value automated notification",
  ], paths);

  assert.equal(result.mode, "dry-run");
  assert.equal(result.action, "archive");
  assert.deepEqual(result.actor, { name: "Codex", client: "codex", runId: "run-123" });
  assert.equal(result.reason, "Low-value automated notification");
  assert.equal(result.identity.frontVisibleComment, false);
  assert.equal(result.canExecute, true);
  assert.equal(result.request.method, "POST");
  assert.match(result.request.path ?? "", /\/conversation_batch\/archive$/);
  assert.deepEqual(result.request.body, { conversation_ids: ["conversation-1"] });
  assert.ok(result.verification);
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.source, "known-route");
  const audit = await readFile(auditPath, "utf8");
  assert.match(audit, /"action":"archive"/);
  assert.match(audit, /"actor":\{"name":"Codex","client":"codex","runId":"run-123"\}/);
  assert.match(audit, /Low-value automated notification/);
});

test("archiveConversation can execute only after a matching sanitized fixture exists", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-fixture");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "archive",
    "POST",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversation_batch/archive",
    { conversation_ids: ["string"] },
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;

  const result = await archiveConversation(["conversation-1"], paths);

  assert.equal(result.canExecute, true);
  assert.ok(result.verification);
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.fixturePath, fixturePath);
  assert.equal(result.verification.requestBodyShapeMatched, true);
});

test("archiveConversation can execute with built-in known route coverage", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-known-route");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const request = await withMockedFrontRequest(async () => {
    const result = await archiveConversation(["conversation-1", "--yes"], paths) as any;
    assert.equal(result.mode, "execute");
    assert.equal(result.canExecute, true);
    assert.equal(result.verification.source, "known-route");
    assert.deepEqual(result.result, { ok: true });
  });

  assert.equal(request.method, "POST");
  assert.match(request.url, /\/conversation_batch\/archive$/);
  assert.deepEqual(request.body, { conversation_ids: ["conversation-1"] });
});

test("archiveConversation supports batch archive previews and execution", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-batch");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const preview = await archiveConversation(["conversation-1", "conversation-2"], paths) as any;
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.canExecute, true);
  assert.equal(preview.conversationId, undefined);
  assert.deepEqual(preview.details, {
    count: 2,
    conversationIds: ["conversation-1", "conversation-2"],
  });
  assert.deepEqual(preview.request.body, { conversation_ids: ["conversation-1", "conversation-2"] });

  const request = await withMockedFrontRequest(async () => {
    const result = await archiveConversation(["conversation-1", "conversation-2", "--yes"], paths) as any;
    assert.equal(result.mode, "execute");
    assert.equal(result.canExecute, true);
    assert.equal(result.details.count, 2);
  });

  assert.equal(request.method, "POST");
  assert.match(request.url, /\/conversation_batch\/archive$/);
  assert.deepEqual(request.body, { conversation_ids: ["conversation-1", "conversation-2"] });
});

test("archiveConversation rejects route-only fixtures without matching body shape", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-route-only");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "archive",
    "POST",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversation_batch/archive",
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;
  process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES = "1";

  try {
    const result = await archiveConversation(["conversation-1"], paths);

    assert.equal(result.canExecute, false);
    assert.ok(result.verification);
    assert.equal(result.verification.verified, false);
    assert.equal(result.verification.requestBodyShapeMatched, false);
  } finally {
    delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;
  }
});

test("tagConversation dry-run supports add and remove", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-tag");
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
      ],
    }),
  );

  const add = await tagConversation(["add", "conversation-1", "Needs Reply"], paths) as any;
  const remove = await tagConversation(["remove", "conversation-1", "tag-1"], paths) as any;

  assert.match(add.request.path ?? "", /\/conversations\/conversation-1\/tag\/needs-reply$/);
  assert.match(remove.request.path ?? "", /\/conversations\/conversation-1\/untag\/needs-reply$/);
  assert.deepEqual(add.details.tag, {
    input: "Needs Reply",
    resolvedAlias: "needs-reply",
    matchedBy: "name",
    tag: { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
  });
  assert.equal(remove.details.tag.matchedBy, "id");
  assert.equal(add.canExecute, true);
  assert.equal(remove.canExecute, true);
});

test("tagConversation rejects ambiguous tag names instead of guessing", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-tag-ambiguous");
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "support-one", name: "Support" },
        { id: "tag-2", alias: "support-two", name: "Support" },
      ],
    }),
  );

  await assert.rejects(
    tagConversation(["add", "conversation-1", "Support"], paths),
    /ambiguous/,
  );
});

test("tagConversation lists cached tag aliases without live auth", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-tag-list-cache");
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
        { id: "tag-2", alias: "vip", name: "VIP" },
      ],
    }),
  );

  const result = await tagConversation(["list"], paths) as any;

  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.tags.map((tag: { alias?: string }) => tag.alias), ["needs-reply", "vip"]);
});

test("tagConversation lists live tag aliases from private boot data", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-tag-list-live");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const request = await withMockedFrontRequest(async () => {
    const result = await tagConversation(["list", "--live"], paths) as any;
    assert.equal(result.source, "live-private");
    assert.equal(result.publicApiUsed, false);
    assert.equal(result.count, 2);
    assert.deepEqual(result.tags.map((tag: { alias?: string }) => tag.alias), ["billing", "needs-reply"]);
  }, {
    tags: [
      { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
      { id: "tag-2", alias: "billing", name: "Billing" },
    ],
  });

  assert.equal(request.method, "GET");
  assert.match(request.url, /\/boot\/app\/8$/);
});

test("commentConversation audit log hashes body instead of storing raw text", async () => {
  const { paths, auditPath } = await fakeMutationContext("frontctl-mutation-comment");

  const bodyPath = join(paths.supportPath, "comment.md");
  await writeFile(bodyPath, "SECRET COMMENT BODY");
  const result = await commentConversation(["add", "conversation-1", "--body-file", bodyPath], paths) as any;
  const audit = await readFile(auditPath, "utf8");

  assert.equal(result.mode, "dry-run");
  assert.equal(result.actor.name, "frontctl agent");
  assert.equal(result.identity.frontVisibleComment, false);
  assert.equal(result.canExecute, true);
  assert.deepEqual(result.request.body, { body: "SECRET COMMENT BODY" });
  assert.doesNotMatch(audit, /SECRET COMMENT BODY/);
  assert.match(audit, /bodySha256/);
});

test("snooze and draft dry-runs remain non-sending and ready for explicit execution", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-gated");
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  const snooze = await snoozeConversation(["conversation-1", "tomorrow-9am"], paths);
  const draft = await draftCommand(["reply", "conversation-1", "--body", "Draft only"], paths) as any;

  assert.equal(snooze.canExecute, true);
  assert.equal(draft.sendsEmail, false);
  assert.equal(draft.canExecute, true);
  assert.match(draft.note ?? "", /Send remains blocked/);
});

test("snooze normalizes human time shortcuts before preview or execution", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-snooze-shortcuts");
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  const relative = await snoozeConversation(["conversation-1", "in:2h"], paths) as any;
  const later = await snoozeConversation(["conversation-1", "later"], paths) as any;

  assert.equal(relative.request.body.until, "2026-06-05T18:00:00.000Z");
  assert.equal(relative.details.input, "in:2h");
  assert.equal(relative.details.normalizedUntil, "2026-06-05T18:00:00.000Z");
  assert.equal(relative.details.parser, "relative");
  assert.equal(later.request.body.until, "2026-06-05T18:00:00.000Z");
  assert.equal(later.details.parser, "shortcut");
});

test("snooze rejects past or unsupported times before any write", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-snooze-invalid");
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  await assert.rejects(
    snoozeConversation(["conversation-1", "2026-06-05T15:00:00.000Z", "--yes"], paths),
    /future/,
  );
  await assert.rejects(
    snoozeConversation(["conversation-1", "someday-maybe", "--yes"], paths),
    /Unsupported snooze time/,
  );
});

test("draft compose preserves recipients and subject in preview without sending", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-compose-fields");

  const draft = await draftCommand([
    "compose",
    "--to",
    "alice@example.com,bob@example.com",
    "--cc",
    "team@example.com",
    "--bcc",
    "audit@example.com",
    "--subject",
    "Draft subject",
    "--body",
    "Draft only",
  ], paths) as any;

  assert.equal(draft.action, "draft.compose");
  assert.equal(draft.mode, "dry-run");
  assert.equal(draft.sendsEmail, false);
  assert.deepEqual(draft.request.body, {
    body: "Draft only",
    draft: true,
    kind: "compose",
    to: ["alice@example.com", "bob@example.com"],
    cc: ["team@example.com"],
    bcc: ["audit@example.com"],
    subject: "Draft subject",
  });
});

test("draft compose requires matching recipient and subject fixture shape when provided", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-compose-shape");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "message-or-draft",
    "POST",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations",
    { body: "string", draft: "boolean", kind: "string" },
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;
  process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES = "1";

  try {
    const draft = await draftCommand([
      "compose",
      "--to",
      "alice@example.com",
      "--subject",
      "Draft subject",
      "--body",
      "Draft only",
    ], paths) as any;

    assert.equal(draft.canExecute, false);
    assert.equal(draft.verification.verified, false);
    assert.equal(draft.verification.requestBodyShapeMatched, false);
  } finally {
    delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;
  }
});

test("snooze executes only after matching fixture and unlocked session", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-snooze-execute");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "snooze",
    "POST",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/conversation-1/status/snoozed",
    { until: "string" },
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const snoozeUntil = "2030-06-06T09:00:00.000Z";
  const request = await withMockedFrontRequest(async () => {
    const result = await snoozeConversation(["conversation-1", snoozeUntil, "--yes"], paths) as any;
    assert.equal(result.mode, "execute");
    assert.equal(result.canExecute, true);
    assert.deepEqual(result.result, { ok: true });
  });

  assert.equal(request.method, "POST");
  assert.match(request.url, /\/conversations\/conversation-1\/status\/snoozed$/);
  assert.deepEqual(request.body, { until: snoozeUntil });
});

test("draft reply and compose become executable with matching non-send fixtures", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-draft-execute");
  await writeFile(
    join(paths.supportPath, "draft-fixtures.json"),
    JSON.stringify({
      publicApiUsed: false,
      redacted: true,
      entries: [
        {
          method: "POST",
          path: "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/conversation-1/messages",
          routeKind: "message-or-draft",
          requestBodyShape: { body: "string", draft: "boolean" },
          redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
        },
        {
          method: "POST",
          path: "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations",
          routeKind: "message-or-draft",
          requestBodyShape: {
            body: "string",
            draft: "boolean",
            kind: "string",
            to: ["string"],
            subject: "string",
          },
          redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
        },
      ],
    }),
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(paths.supportPath, "draft-fixtures.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const replyRequest = await withMockedFrontRequest(async () => {
    const reply = await draftCommand(["reply", "conversation-1", "--body", "Draft only", "--yes"], paths) as any;
    assert.equal(reply.mode, "execute");
    assert.equal(reply.canExecute, true);
    assert.equal(reply.sendsEmail, false);
  });
  const composeRequest = await withMockedFrontRequest(async () => {
    const compose = await draftCommand([
      "compose",
      "--to",
      "alice@example.com",
      "--subject",
      "Draft subject",
      "--body",
      "New draft only",
      "--yes",
    ], paths) as any;
    assert.equal(compose.mode, "execute");
    assert.equal(compose.canExecute, true);
    assert.equal(compose.sendsEmail, false);
  });

  assert.match(replyRequest.url, /\/conversations\/conversation-1\/messages$/);
  assert.deepEqual(replyRequest.body, { body: "Draft only", draft: true });
  assert.match(composeRequest.url, /\/conversations$/);
  assert.deepEqual(composeRequest.body, {
    body: "New draft only",
    draft: true,
    kind: "compose",
    to: ["alice@example.com"],
    subject: "Draft subject",
  });
});

test("draft reply accepts --body-file without enabling send", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-body-file");
  const bodyPath = join(paths.supportPath, "reply.md");
  await writeFile(bodyPath, "Draft from file");

  const draft = await draftCommand(["reply", "conversation-1", "--body-file", bodyPath], paths) as any;

  assert.equal(draft.sendsEmail, false);
  assert.equal(draft.canExecute, true);
  assert.deepEqual(draft.request.body, { body: "Draft from file", draft: true });
});

test("draft list/read scan local IndexedDB without Front writes", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-draft-cache");
  await mkdir(paths.indexedDbLevelDbPath, { recursive: true });
  await writeFile(
    join(paths.indexedDbLevelDbPath, "000001.ldb"),
    `prefix draft-compose /cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/messages/abc123def456 blurb"Hello from a cached draft body" DRAFT suffix`,
  );

  const list = await draftCommand(["list"], paths) as any;
  assert.equal(list.source, "local-indexeddb");
  assert.ok(list.count >= 1);
  assert.equal(list.drafts[0].conversationId, "123");
  assert.match(list.drafts[0].bodySnippet ?? "", /cached draft body/);

  const read = await draftCommand(["read", list.drafts[0].id], paths) as any;
  assert.equal(read.source, "local-indexeddb");
  assert.match(read.text ?? "", /cached draft body/);
});

test("draft discard explains when a cached draft cannot be resolved to a message route", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-draft-discard");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "draft.discard",
    "DELETE",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/messages/abc123def456",
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;

  const discard = await draftCommand(["discard", "draft-1"], paths) as any;

  assert.equal(discard.mode, "dry-run");
  assert.equal(discard.action, "draft.discard");
  assert.equal(discard.canExecute, false);
  assert.equal(discard.sendsEmail, false);
  assert.equal(discard.request.path, undefined);
  assert.match(discard.note ?? "", /Could not resolve/);
});

test("draft discard can be fixture-verified after resolving cached message uid", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-draft-discard-route");
  await mkdir(paths.indexedDbLevelDbPath, { recursive: true });
  await writeFile(
    join(paths.indexedDbLevelDbPath, "000001.ldb"),
    `prefix draft-compose /cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/messages/abc123def456 blurb"Hello from a cached draft body" DRAFT suffix`,
  );
  const list = await draftCommand(["list"], paths) as any;
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "draft.discard",
    "DELETE",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/messages/abc123def456",
  );
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;

  const discard = await draftCommand(["discard", list.drafts[0].id], paths) as any;

  assert.equal(discard.mode, "dry-run");
  assert.equal(discard.action, "draft.discard");
  assert.equal(discard.canExecute, true);
  assert.equal(discard.sendsEmail, false);
  assert.equal(discard.conversationId, "123");
  assert.match(discard.request.path ?? "", /\/messages\/abc123def456$/);
  assert.equal(discard.verification.verified, true);
});

async function fakeMutationContext(name: string) {
  const paths = await makeFakeFrontInstall(await makeTempDir(name));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const auditPath = join(paths.supportPath, "audit.jsonl");
  process.env.FRONTCTL_AUDIT_PATH = auditPath;
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  delete process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH;
  delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;
  delete process.env.FRONTCTL_NOW;
  return { paths, auditPath };
}

async function writeSanitizedFixture(root: string, routeKind: string, method: string, path: string, requestBodyShape?: unknown) {
  const fixturePath = join(root, `${routeKind}.sanitized.json`);
  await writeFile(fixturePath, JSON.stringify({
    publicApiUsed: false,
    redacted: true,
    entries: [
      {
        method,
        path,
        routeKind,
        requestBodyShape,
        redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
      },
    ],
  }));
  return fixturePath;
}

async function withMockedFrontRequest(fn: () => Promise<void>, responseBody: unknown = { ok: true }) {
  const previousFetch = globalThis.fetch;
  let request: { url: string; method: string; body?: unknown } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.ok(request);
  return request;
}
