import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assignConversation,
  archiveConversation,
  commentConversation,
  createTestConversation,
  draftCommand,
  snoozeConversation,
  tagConversation,
  unarchiveConversation,
  unsnoozeConversation,
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
  assert.equal(result.identity.frontVisibleComment, true);
  assert.equal(result.identity.timing, "before-action");
  assert.equal(result.identity.enforcedByCli, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.request.method, "PATCH");
  assert.match(result.request.path ?? "", /\/conversations$/);
  assert.deepEqual(result.request.body, { conversations: [{ id: "conversation-1", status: "archived" }] });
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
    "conversation.update",
    "PATCH",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations",
    { conversations: [{ id: "string", status: "string" }] },
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

  assert.equal(request.method, "PATCH");
  assert.match(request.url, /\/conversations$/);
  assert.deepEqual(request.body, { conversations: [{ id: "conversation-1", status: "archived" }] });
});

test("archiveConversation writes visible agent identity comment before archive execution", async () => {
  const { paths, auditPath } = await fakeMutationContext("frontctl-mutation-archive-identity-comment");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const requests = await withMockedFrontRequests(async () => {
    const result = await archiveConversation([
      "conversation-1",
      "--actor",
      "Codex",
      "--client",
      "codex",
      "--run-id",
      "run-123",
      "--reason",
      "User approved archive",
      "--yes",
    ], paths) as any;
    assert.equal(result.mode, "execute");
    assert.equal(result.identity.frontVisibleComment, true);
    assert.equal(result.identity.timing, "before-action");
    assert.equal(result.identity.requiredBeforeAction, true);
    assert.equal(result.identity.comment.activityId, "activity-1");
    assert.deepEqual(result.result, { ok: true, id: "activity-1" });
  }, { ok: true, id: "activity-1" });

  const writes = requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].method, "PUT");
  assert.match(writes[0].url, /\/conversations\/conversation-1\/comments\/[a-f0-9]{32}\?include_conversation=true$/);
  assert.match(String((writes[0].body as any).text), /frontctl agent action/);
  assert.match(String((writes[0].body as any).text), /Actor: Codex/);
  assert.match(String((writes[0].body as any).text), /Client: codex/);
  assert.match(String((writes[0].body as any).text), /Run ID: run-123/);
  assert.match(String((writes[0].body as any).text), /Action: archive/);
  assert.match(String((writes[0].body as any).text), /Reason: User approved archive/);
  assert.equal(writes[1].method, "POST");
  assert.match(writes[1].url, /\/conversations\/conversation-1\/timeline$/);
  assert.equal((writes[1].body as any).type, "comment");
  assert.equal(writes[2].method, "PATCH");
  assert.match(writes[2].url, /\/conversations$/);
  assert.deepEqual(writes[2].body, { conversations: [{ id: "conversation-1", status: "archived" }] });

  const auditEntries = await readAuditJsonl(auditPath);
  assert.deepEqual(auditEntries.map((entry) => entry.phase), ["attempt", "identity-commented", "completed"]);
  assert.equal(auditEntries[1].identityActivityId, "activity-1");
  assert.match(String(auditEntries[1].identityCommentUid), /^[a-f0-9]{32}$/);
  assert.equal(auditEntries[2].identityActivityId, "activity-1");
  assert.deepEqual(auditEntries[2].resultKeys, ["id", "ok"]);
});

test("archiveConversation reports identity comment refs if requested action fails after commenting", async () => {
  const { paths, auditPath } = await fakeMutationContext("frontctl-mutation-archive-comment-then-fail");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const requests = await withMockedFrontRequests(async () => {
    await assert.rejects(
      archiveConversation(["conversation-1", "--actor", "Codex", "--reason", "Archive failure test", "--yes"], paths),
      /Wrote the visible agent identity comment, but archive failed.*commentUid=[a-f0-9]{32}.*activityId=activity-1.*HTTP 500/,
    );
  }, (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(input).endsWith("/conversations")) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return { ok: true, id: "activity-1" };
  });

  const writes = requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].method, "PUT");
  assert.equal(writes[1].method, "POST");
  assert.equal(writes[2].method, "PATCH");

  const auditEntries = await readAuditJsonl(auditPath);
  assert.deepEqual(auditEntries.map((entry) => entry.phase), ["attempt", "identity-commented", "failed"]);
  assert.equal(auditEntries[1].identityActivityId, "activity-1");
  assert.equal(auditEntries[2].identityActivityId, "activity-1");
  assert.match(String(auditEntries[2].identityCommentUid), /^[a-f0-9]{32}$/);
  assert.equal(auditEntries[2].errorClass, "CliError");
  assert.match(String(auditEntries[2].errorMessageSha256), /^[a-f0-9]{64}$/);
});

test("archiveConversation rejects batch archive until a batch route is verified", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-batch");

  await assert.rejects(
    archiveConversation(["conversation-1", "conversation-2"], paths),
    /Batch archive is not enabled/,
  );
});

test("archiveConversation rejects route-only fixtures without matching body shape", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-archive-route-only");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "conversation.update",
    "PATCH",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations",
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

test("unarchiveConversation restores a conversation through the observed status patch route", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-unarchive");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const request = await withMockedFrontRequest(async () => {
    const result = await unarchiveConversation(["conversation-1", "--yes"], paths) as any;
    assert.equal(result.action, "unarchive");
    assert.equal(result.mode, "execute");
    assert.equal(result.canExecute, true);
    assert.deepEqual(result.request.body, { conversations: [{ id: "conversation-1", status: "open" }] });
  });

  assert.equal(request.method, "PATCH");
  assert.match(request.url, /\/conversations$/);
  assert.deepEqual(request.body, { conversations: [{ id: "conversation-1", status: "open" }] });
});

test("assignConversation executes assign and unassign through the verified conversation patch route", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-assign");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const assignRequests = await withMockedFrontRequests(async () => {
    const result = await assignConversation([
      "conversation-1",
      "6088721",
      "--actor",
      "Codex",
      "--reason",
      "Assign test conversation",
      "--yes",
    ], paths) as any;

    assert.equal(result.action, "assign");
    assert.equal(result.canExecute, true);
    assert.equal(result.identity.timing, "before-action");
    assert.deepEqual(result.request.body, { conversations: [{ id: "conversation-1", assignee_id: 6088721 }] });
  }, { ok: true, id: "activity-1" });

  assertIdentityCommentBeforeFinalWrite(
    assignRequests.filter((request) => request.method !== "GET"),
    "assign",
    "PATCH",
    /\/conversations$/,
  );
  assert.deepEqual(assignRequests.filter((request) => request.method !== "GET")[2].body, {
    conversations: [{ id: "conversation-1", assignee_id: 6088721 }],
  });

  const unassignRequests = await withMockedFrontRequests(async () => {
    const result = await assignConversation([
      "unassign",
      "conversation-1",
      "--actor",
      "Codex",
      "--reason",
      "Unassign test conversation",
      "--yes",
    ], paths) as any;

    assert.equal(result.action, "unassign");
    assert.equal(result.canExecute, true);
    assert.equal(result.identity.timing, "before-action");
    assert.deepEqual(result.request.body, { conversations: [{ id: "conversation-1", assignee_id: null }] });
  }, { ok: true, id: "activity-2" });

  assertIdentityCommentBeforeFinalWrite(
    unassignRequests.filter((request) => request.method !== "GET"),
    "unassign",
    "PATCH",
    /\/conversations$/,
  );
  assert.deepEqual(unassignRequests.filter((request) => request.method !== "GET")[2].body, {
    conversations: [{ id: "conversation-1", assignee_id: null }],
  });
});

test("createTestConversation previews the non-send internal task save route", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-create-test-conversation");

  const result = await createTestConversation([
    "--subject",
    "frontctl test conversation",
    "--body",
    "Safe integration test",
  ], paths) as any;

  assert.equal(result.action, "conversation.create-test");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.sendsEmail, false);
  assert.equal(result.canExecute, true);
  assert.match(result.request.path, /\/conversations\/new\/comments\/[a-f0-9]{32}$/);
  assert.deepEqual(result.request.body, {
    linked_conversation_type: "internal_task",
    text: "Safe integration test",
    attachments: [],
  });
  assert.equal(result.details.subject, "frontctl test conversation");
  assert.equal(result.details.publishRequest.method, "POST");
  assert.deepEqual(result.details.publishRequest.body.meta, {
    subject: "frontctl test conversation",
    trackers: [],
  });
  assert.match(result.note, /Send remains blocked/);
  assert.equal(result.verification.verified, true);
});

test("createTestConversation executes by saving and publishing an internal task comment", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-create-test-conversation-execute");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const requests = await withMockedFrontRequests(async () => {
    const result = await createTestConversation([
      "--subject",
      "frontctl installed integration test",
      "--body",
      "Safe integration test",
      "--inbox-id",
      "7946577",
      "--actor",
      "Codex",
      "--reason",
      "Create dedicated Front test conversation",
      "--yes",
    ], paths) as any;

    assert.equal(result.mode, "execute");
    assert.equal(result.action, "conversation.create-test");
    assert.equal(result.sendsEmail, false);
    assert.equal(result.identity.frontVisibleComment, false);
    assert.equal(result.result.conversationId, "96868000001");
    assert.equal(result.result.activityId, "45958000001");
    assert.match(result.result.commentUid, /^[a-f0-9]{32}$/);
  }, (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (/\/conversations\/new\/comments\/[a-f0-9]{32}\?include_conversation=true&include_linked_activities=true$/.test(url)) {
      const uid = url.match(/comments\/([a-f0-9]{32})/)?.[1];
      return {
        uid,
        conversation_id: 96868000001,
        text: body.text,
        conversation: { id: 96868000001 },
      };
    }
    if (url.endsWith("/conversations/96868000001/timeline")) {
      return {
        ok: true,
        id: "45958000001",
        activities: [
          {
            id: "45958000001",
            comment: { uid: (body.comment as Record<string, unknown>).uid },
          },
        ],
      };
    }
    return { ok: true };
  });

  const writes = requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, "PUT");
  assert.match(writes[0].url, /\/conversations\/new\/comments\/[a-f0-9]{32}\?include_conversation=true&include_linked_activities=true$/);
  assert.deepEqual(writes[0].body, {
    linked_conversation_type: "internal_task",
    text: "Safe integration test",
    attachments: [],
  });
  assert.equal(writes[1].method, "POST");
  assert.match(writes[1].url, /\/conversations\/96868000001\/timeline$/);
  assert.equal((writes[1].body as any).type, "comment");
  assert.deepEqual((writes[1].body as any).meta, {
    inbox_id: 7946577,
    subject: "frontctl installed integration test",
    trackers: [],
  });
});

test("state-changing mutations write visible identity comments before the requested write", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-identity-all");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "123", alias: "needs-reply", name: "Needs Reply" },
      ],
    }),
  );
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  const cases: Array<{
    name: string;
    action: string;
    run: () => Promise<unknown>;
    expectedFinalMethod: string;
    expectedFinalUrl: RegExp;
  }> = [
    {
      name: "unarchive",
      action: "unarchive",
      run: () => unarchiveConversation(["conversation-1", "--actor", "Codex", "--reason", "Restore for test", "--yes"], paths),
      expectedFinalMethod: "PATCH",
      expectedFinalUrl: /\/conversations$/,
    },
    {
      name: "snooze",
      action: "snooze",
      run: () => snoozeConversation(["conversation-1", "in:2h", "--actor", "Codex", "--reason", "Snooze for test", "--yes"], paths),
      expectedFinalMethod: "PATCH",
      expectedFinalUrl: /\/conversations$/,
    },
    {
      name: "unsnooze",
      action: "unsnooze",
      run: () => unsnoozeConversation(["conversation-1", "--actor", "Codex", "--reason", "Unsnooze for test", "--yes"], paths),
      expectedFinalMethod: "PATCH",
      expectedFinalUrl: /\/conversations$/,
    },
    {
      name: "tag.add",
      action: "tag.add",
      run: () => tagConversation(["add", "conversation-1", "Needs Reply", "--actor", "Codex", "--reason", "Tag for test", "--yes"], paths),
      expectedFinalMethod: "PATCH",
      expectedFinalUrl: /\/conversations$/,
    },
    {
      name: "comment.remove",
      action: "comment.remove",
      run: () => commentConversation(["remove", "conversation-1", "456", "--actor", "Codex", "--reason", "Remove test comment", "--yes"], paths),
      expectedFinalMethod: "DELETE",
      expectedFinalUrl: /\/conversations\/conversation-1\/timeline\/456$/,
    },
    {
      name: "draft.reply",
      action: "draft.reply",
      run: () => draftCommand(["reply", "conversation-1", "--body", "Draft only", "--actor", "Codex", "--reason", "Draft for test", "--yes"], paths),
      expectedFinalMethod: "PUT",
      expectedFinalUrl: /\/conversations\/conversation-1\/messages\/[a-f0-9]{32}\?include_conversation=true$/,
    },
    {
      name: "draft.discard",
      action: "draft.discard",
      run: () => draftCommand(["discard", "conversation-1", "draftuid123", "--actor", "Codex", "--reason", "Discard draft for test", "--yes"], paths),
      expectedFinalMethod: "DELETE",
      expectedFinalUrl: /\/conversations\/conversation-1\/messages\/draftuid123$/,
    },
  ];

  for (const item of cases) {
    const requests = await withMockedFrontRequests(async () => {
      const result = await item.run() as any;
      assert.equal(result.identity.frontVisibleComment, true, item.name);
      assert.equal(result.identity.timing, "before-action", item.name);
    }, draftReplyMockResponse);
    const writes = requests.filter((request) => request.method !== "GET");
    assertIdentityCommentBeforeFinalWrite(writes, item.action, item.expectedFinalMethod, item.expectedFinalUrl);
  }
});

test("tagConversation dry-run supports add and remove", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-tag");
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "123", alias: "needs-reply", name: "Needs Reply" },
      ],
    }),
  );

  const add = await tagConversation(["add", "conversation-1", "Needs Reply"], paths) as any;
  const remove = await tagConversation(["remove", "conversation-1", "123"], paths) as any;

  assert.match(add.request.path ?? "", /\/conversations$/);
  assert.match(remove.request.path ?? "", /\/conversations$/);
  assert.deepEqual(add.request.body, { conversations: [{ id: "conversation-1", tags: { add: [123] } }] });
  assert.deepEqual(remove.request.body, { conversations: [{ id: "conversation-1", tags: { remove: [123] } }] });
  assert.deepEqual(add.details.tag, {
    input: "Needs Reply",
    resolvedAlias: "needs-reply",
    matchedBy: "name",
    tag: { id: "123", alias: "needs-reply", name: "Needs Reply" },
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
  assert.equal(result.identity.frontVisibleComment, true);
  assert.equal(result.identity.timing, "command-comment");
  assert.equal(result.canExecute, true);
  assert.match(result.request.path ?? "", /\/conversations\/conversation-1\/timeline$/);
  assert.equal(result.request.body.type, "comment");
  assert.equal(result.request.body.comment.uid.length, 32);
  assert.deepEqual(result.request.body.meta, { trackers: [] });
  assert.deepEqual(result.details.saveRequest.body, {
    text: "SECRET COMMENT BODY",
    attachments: [],
    referenced_activity_id: null,
    annotation: null,
  });
  assert.doesNotMatch(audit, /SECRET COMMENT BODY/);
  assert.match(audit, /bodySha256/);
});

test("commentConversation add executes without a separate identity comment", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-comment-add-no-double-comment");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

  const requests = await withMockedFrontRequests(async () => {
    const result = await commentConversation([
      "add",
      "conversation-1",
      "--body",
      "User requested visible note",
      "--actor",
      "Codex",
      "--reason",
      "Add requested note",
      "--yes",
    ], paths) as any;
    assert.equal(result.identity.frontVisibleComment, true);
    assert.equal(result.identity.timing, "command-comment");
    assert.equal(result.result.activityId, "activity-1");
  }, { ok: true, id: "activity-1" });

  const writes = requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, "PUT");
  assert.match(writes[0].url, /\/conversations\/conversation-1\/comments\/[a-f0-9]{32}\?include_conversation=true$/);
  assert.equal((writes[0].body as any).text, "User requested visible note");
  assert.equal(writes[1].method, "POST");
  assert.match(writes[1].url, /\/conversations\/conversation-1\/timeline$/);
  assert.equal((writes[1].body as any).type, "comment");
});

test("commentConversation remove targets the verified timeline activity delete route", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-comment-remove");

  const result = await commentConversation(["remove", "conversation-1", "123"], paths) as any;

  assert.equal(result.mode, "dry-run");
  assert.equal(result.action, "comment.remove");
  assert.equal(result.canExecute, true);
  assert.equal(result.request.method, "DELETE");
  assert.match(result.request.path ?? "", /\/conversations\/conversation-1\/timeline\/123$/);
});

test("snooze and draft dry-runs remain non-sending but require discovery before execution", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-gated");
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  const snooze = await snoozeConversation(["conversation-1", "tomorrow-9am"], paths);
  const draft = await draftCommand(["reply", "conversation-1", "--body", "Draft only"], paths) as any;

  assert.equal(snooze.canExecute, true);
  assert.equal(draft.sendsEmail, false);
  assert.equal(draft.canExecute, true);
  assert.equal(draft.request.method, "PUT");
  assert.match(draft.request.path ?? "", /\/conversations\/conversation-1\/messages\/[a-f0-9]{32}$/);
  assert.equal(draft.request.body.text, "Draft only");
  assert.equal("version" in draft.request.body, false);
  assert.match(draft.note ?? "", /Draft save only/);
});

test("snooze normalizes human time shortcuts before preview or execution", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-snooze-shortcuts");
  process.env.FRONTCTL_NOW = "2026-06-05T16:00:00.000Z";

  const relative = await snoozeConversation(["conversation-1", "in:2h"], paths) as any;
  const later = await snoozeConversation(["conversation-1", "later"], paths) as any;

  assert.equal(relative.request.body.conversations[0].reminder, Date.parse("2026-06-05T18:00:00.000Z"));
  assert.equal(relative.details.input, "in:2h");
  assert.equal(relative.details.normalizedUntil, "2026-06-05T18:00:00.000Z");
  assert.equal(relative.details.parser, "relative");
  assert.equal(later.request.body.conversations[0].reminder, Date.parse("2026-06-05T18:00:00.000Z"));
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
  assert.equal(draft.canExecute, true);
  assert.equal(draft.request.method, "PUT");
  assert.match(draft.request.path, /\/conversations\/new\/messages\/[a-f0-9]{32}$/);
  assert.match(draft.note ?? "", /Draft save only/);
  assert.equal(draft.request.body.text, "Draft only");
  assert.equal(draft.request.body.subject, "Draft subject");
  assert.deepEqual(
    draft.request.body.recipients.map((recipient: { role: string; handle: string }) => [recipient.role, recipient.handle]),
    [["to", "alice@example.com"], ["to", "bob@example.com"], ["cc", "team@example.com"], ["bcc", "audit@example.com"]],
  );
  assert.equal(draft.request.body.shared_draft, false);
});

test("draft compose rejects old guessed fixture shapes in strict discovery mode", async () => {
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
    assert.equal(draft.request.method, "PUT");
    assert.match(draft.request.path, /\/conversations\/new\/messages\/[a-f0-9]{32}$/);
    assert.match(draft.verification.reason, /No sanitized fixture matched/);
  } finally {
    delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;
  }
});

test("snooze executes only after matching fixture and unlocked session", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-snooze-execute");
  const fixturePath = await writeSanitizedFixture(
    paths.supportPath,
    "conversation.update",
    "PATCH",
    "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations",
    { conversations: [{ id: "string", status: "string", reminder: "number" }] },
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

  assert.equal(request.method, "PATCH");
  assert.match(request.url, /\/conversations$/);
  assert.deepEqual(request.body, {
    conversations: [{ id: "conversation-1", status: "archived", reminder: Date.parse(snoozeUntil) }],
  });
});

test("draft reply and standalone compose execute with live-proven non-send shapes", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-draft-execute");
  await writeFile(
    join(paths.supportPath, "draft-fixtures.json"),
    JSON.stringify({
      publicApiUsed: false,
      redacted: true,
      entries: [
        {
          method: "PUT",
          path: "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/conversation-1/messages/message-placeholder",
          routeKind: "message-or-draft",
          requestBodyShape: {
            in_reply_to_id: "number",
            referenced_message_id: "number",
            author_id: "number",
            from: { channel_id: "number" },
            subject: "string",
            recipients: [{ role: "string", handle: "string", name: "string", source: "string" }],
            attachments: [],
            html: "string",
            text: "string",
            shared_draft: "boolean",
            virtru_encrypt: "boolean",
            has_quote: "boolean",
            quote_include: "boolean",
            quote_modified: "boolean",
            forward_include: "boolean",
            forward_modified: "boolean",
            signature_include: "boolean",
            signature_modified: "boolean",
            main_style: "string",
            default_font_style: "string",
            format: "string",
            handle_time_increment: "number",
          },
          redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
        },
        {
          method: "PUT",
          path: "/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/new/messages/message-placeholder",
          routeKind: "message-or-draft",
          requestBodyShape: {
            author_id: "number",
            from: { channel_id: "number" },
            subject: "string",
            recipients: [{ role: "string", handle: "string", name: "string", source: "string" }],
            attachments: [],
            html: "string",
            text: "string",
            shared_draft: "boolean",
            virtru_encrypt: "boolean",
            has_quote: "boolean",
            quote_include: "boolean",
            quote_modified: "boolean",
            forward_include: "boolean",
            forward_modified: "boolean",
            signature_include: "boolean",
            signature_modified: "boolean",
            main_style: "string",
            default_font_style: "string",
            format: "string",
            handle_time_increment: "number",
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
    assert.equal(reply.result.messageUid, "draftuid123");
  }, draftReplyMockResponse);

  assert.match(replyRequest.url, /\/conversations\/conversation-1\/messages\/[a-f0-9]{32}\?include_conversation=true$/);
  assert.equal(replyRequest.method, "PUT");
  const replyBody = replyRequest.body as any;
  assert.equal(replyBody.text, "Draft only");
  assert.equal(replyBody.in_reply_to_id, 226523505105);
  assert.equal(replyBody.from.channel_id, 7599313);
  assert.equal(replyBody.recipients[0].handle, "support@example.com");
  assert.equal("version" in replyBody, false);

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
    assert.equal(compose.result.conversationId, "96867835601");
    assert.equal(compose.result.messageUid, "newdraftuid123");
    assert.match(compose.result.discardCommand, /frontctl draft discard 96867835601 newdraftuid123 --json/);
  }, draftReplyMockResponse);

  assert.match(composeRequest.url, /\/conversations\/new\/messages\/[a-f0-9]{32}\?include_conversation=true$/);
  assert.equal(composeRequest.method, "PUT");
  const composeBody = composeRequest.body as any;
  assert.equal(composeBody.text, "New draft only");
  assert.equal(composeBody.subject, "Draft subject");
  assert.equal(composeBody.from.channel_id, 7599313);
  assert.equal(composeBody.recipients[0].handle, "alice@example.com");
  assert.equal("in_reply_to_id" in composeBody, false);
});

test("draft reply accepts --body-file without enabling send", async () => {
  const { paths } = await fakeMutationContext("frontctl-mutation-body-file");
  const bodyPath = join(paths.supportPath, "reply.md");
  await writeFile(bodyPath, "Draft from file");

  const draft = await draftCommand(["reply", "conversation-1", "--body-file", bodyPath], paths) as any;

  assert.equal(draft.sendsEmail, false);
  assert.equal(draft.canExecute, true);
  assert.equal(draft.request.method, "PUT");
  assert.equal(draft.request.body.text, "Draft from file");
  assert.equal("version" in draft.request.body, false);
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

async function readAuditJsonl(path: string) {
  return (await readFile(path, "utf8"))
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function draftReplyMockResponse(input: string | URL | Request) {
  const url = String(input);
  if (url.includes("/boot/app/8")) {
    return {
      user: {
        id: 6088721,
        email: "arjun@example.com",
        preferences: { defaultFontStyle: "" },
      },
      channels: [
        {
          id: 7599313,
          namespace: "tea:6088721",
          is_private: true,
          message_type: "email",
          type_name: "email",
          send_as: "arjun@example.com",
          settings: { canSend: true },
        },
      ],
    };
  }
  if (/\/conversations\/new\/messages\/[a-f0-9]{32}/.test(url)) {
    return {
      id: 227921854801,
      uid: "newdraftuid123",
      conversation_id: 96867835601,
      subject: "Draft subject",
    };
  }
  if (url.includes("/conversations/conversation-1/timeline")) {
    return {
      timeline: [
        {
          type: "email",
          id: 226523505105,
          subject: "Draft test",
          from: {
            role: "from",
            handle: "sender@example.com",
            display_name: "Sender",
          },
          recipients: [
            {
              role: "from",
              handle: "sender@example.com",
              display_name: "Sender",
            },
            {
              role: "to",
              handle: "me@example.com",
              display_name: "Me",
              channel_id: 7599313,
            },
            {
              role: "reply-to",
              handle: "support@example.com",
              display_name: "Support",
            },
          ],
        },
      ],
    };
  }
  if (/\/conversations\/conversation-1\/messages\/[a-f0-9]{32}/.test(url)) {
    return {
      id: 226605248081,
      uid: "draftuid123",
      subject: "Draft test",
    };
  }
  return { ok: true };
}

async function withMockedFrontRequest(
  fn: () => Promise<void>,
  responseBody: unknown | ((input: string | URL | Request, init?: RequestInit) => unknown | Response) = { ok: true },
) {
  const requests = await withMockedFrontRequests(fn, responseBody);
  return requests.at(-1)!;
}

async function withMockedFrontRequests(
  fn: () => Promise<void>,
  responseBody: unknown | ((input: string | URL | Request, init?: RequestInit) => unknown | Response) = { ok: true },
) {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    });
    const body = typeof responseBody === "function" ? responseBody(input, init) : responseBody;
    if (body instanceof Response) {
      return body;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.ok(requests.length);
  return requests;
}

function assertIdentityCommentBeforeFinalWrite(
  writes: Array<{ url: string; method: string; body?: unknown }>,
  action: string,
  finalMethod: string,
  finalUrl: RegExp,
) {
  assert.equal(writes.length, 3, action);
  assert.equal(writes[0].method, "PUT", action);
  assert.match(writes[0].url, /\/conversations\/conversation-1\/comments\/[a-f0-9]{32}\?include_conversation=true$/, action);
  assert.match(String((writes[0].body as any).text), /frontctl agent action/, action);
  assert.match(String((writes[0].body as any).text), new RegExp(`Action: ${action.replace(".", "\\.")}`), action);
  assert.equal(writes[1].method, "POST", action);
  assert.match(writes[1].url, /\/conversations\/conversation-1\/timeline$/, action);
  assert.equal((writes[1].body as any).type, "comment", action);
  assert.equal(writes[2].method, finalMethod, action);
  assert.match(writes[2].url, finalUrl, action);
}
