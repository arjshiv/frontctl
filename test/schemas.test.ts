import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFrontSession } from "../src/lib/auth.js";
import { installSanitizedDiscoveryFixture, verifyWriteFixture } from "../src/lib/writeVerification.js";
import {
  browserProbeRuntimeSchema,
  commentPublishBodySchema,
  conversationBatchLinkBodySchema,
  conversationPatchBodySchema,
  draftForwardBodySchema,
  draftReplyBodySchema,
  frontConversationSchema,
  internalTaskCommentSaveBodySchema,
  tagCreateBodySchema,
  validateMutationPayload,
} from "../src/lib/schemas.js";

test("mutation schemas accept known safe Front write bodies", () => {
  assert.equal(conversationPatchBodySchema.parse({
    conversations: [{ id: 123, status: "archived", reminder: null }],
  }).conversations[0]?.status, "archived");

  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("assign", {
    conversations: [{ id: 123, assignee_id: 456 }],
  })).conversations[0]?.assignee_id, 456);
  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("unassign", {
    conversations: [{ id: 123, assignee_id: null }],
  })).conversations[0]?.assignee_id, null);
  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("move", {
    conversations: [{ id: 123, inbox_id: 456 }],
  })).conversations[0]?.inbox_id, 456);
  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("follower.add", {
    conversations: [{ id: 123, trackers: { add: [{ teammate_id: 456, status: "inbox", stage: "follower" }] } }],
  })).conversations[0]?.trackers?.add?.[0]?.stage, "follower");
  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("follower.remove", {
    conversations: [{ id: 123, trackers: { remove: [{ teammate_id: 456 }] } }],
  })).conversations[0]?.trackers?.remove?.[0]?.teammate_id, 456);
  assert.equal(conversationPatchBodySchema.parse(validateMutationPayload("custom-field.set", {
    conversations: [{ id: 123, custom_attributes: { add: [{ custom_field_id: 456, value: "true" }] } }],
  })).conversations[0]?.custom_attributes?.add?.[0]?.custom_field_id, 456);
  assert.equal(conversationBatchLinkBodySchema.parse(validateMutationPayload("link.add", {
    conversation_ids: [456],
    options: { original_conversation_id: 123 },
  })).options.original_conversation_id, 123);
  assert.deepEqual(validateMutationPayload("link.remove", {}), {});

  assert.equal(commentPublishBodySchema.parse({
    type: "comment",
    comment: { uid: "comment-uid" },
    meta: { trackers: [] },
  }).comment.uid, "comment-uid");

  assert.equal(draftReplyBodySchema.parse({
    in_reply_to_id: 123,
    referenced_message_id: 123,
    author_id: 456,
    from: { channel_id: 789 },
    subject: "Subject",
    recipients: [{ role: "to", handle: "person@example.com", name: "Person", source: "email" }],
    attachments: [],
    html: "<div>Draft</div>",
    text: "Draft",
    shared_draft: false,
    virtru_encrypt: false,
    has_quote: false,
    quote_include: false,
    quote_modified: false,
    forward_include: false,
    forward_modified: false,
    signature_include: false,
    signature_modified: false,
    main_style: "",
    default_font_style: "",
    format: "html",
    handle_time_increment: 0,
  }).format, "html");

  assert.equal((validateMutationPayload("draft.update", {
    author_id: 456,
    from: { channel_id: 789 },
    subject: "Subject",
    recipients: [{ role: "to", handle: "person@example.com", name: "Person", source: "email" }],
    attachments: [],
    html: "<div>Draft</div>",
    text: "Draft",
    shared_draft: false,
    virtru_encrypt: false,
    has_quote: false,
    quote_include: false,
    quote_modified: false,
    forward_include: false,
    forward_modified: false,
    signature_include: false,
    signature_modified: false,
    main_style: "",
    default_font_style: "",
    format: "html",
    handle_time_increment: 0,
  }) as { format: string }).format, "html");

  assert.equal(draftForwardBodySchema.parse(validateMutationPayload("draft.forward", {
    author_id: 456,
    from: { channel_id: 789 },
    subject: "Fw: Subject",
    recipients: [{ role: "to", handle: "person@example.com", name: "Person", source: "email" }],
    attachments: [],
    html: "<div>Draft</div>",
    text: "Draft",
    shared_draft: false,
    virtru_encrypt: false,
    has_quote: false,
    quote_include: false,
    quote_modified: false,
    forward_html: "<div>Forwarded message</div>",
    forward_include: true,
    forward_modified: false,
    signature_include: false,
    signature_modified: false,
    main_style: "",
    default_font_style: "",
    format: "html",
    handle_time_increment: 0,
  })).forward_include, true);

  assert.equal(tagCreateBodySchema.parse(validateMutationPayload("tag.create", {
    name: "frontctl-test-delete-me",
    description: "",
    highlight: null,
    is_visible_in_p2: false,
  })).name, "frontctl-test-delete-me");

  assert.equal(internalTaskCommentSaveBodySchema.parse({
    linked_conversation_type: "internal_task",
    text: "Safe integration test",
    attachments: [],
  }).linked_conversation_type, "internal_task");
});

test("mutation schemas reject unsafe or drifted write bodies", () => {
  assert.throws(() => validateMutationPayload("archive", {
    conversations: [{ id: 123, status: "deleted" }],
  }));
  assert.throws(() => validateMutationPayload("comment.add", {
    type: "message",
    comment: { uid: "comment-uid" },
    meta: { trackers: [] },
  }));
  assert.throws(() => validateMutationPayload("draft.reply", {
    text: "missing required Front draft fields",
  }));
  assert.throws(() => validateMutationPayload("conversation.create-test", {
    linked_conversation_type: "email",
    text: "would send",
    attachments: [],
  }));
});

test("browser probe schema is tolerant but rejects invalid scalar types", () => {
  assert.equal(browserProbeRuntimeSchema.parse({
    ok: false,
    httpStatus: 401,
    status: "authentication_required",
    bodyShape: { token: "<redacted>" },
    extraFrontField: true,
  }).status, "authentication_required");

  assert.throws(() => browserProbeRuntimeSchema.parse({
    ok: "yes",
    httpStatus: "200",
  }));
});

test("conversation schema accepts nullable Front contact on internal tasks", () => {
  const parsed = frontConversationSchema.parse({
    id: 96868834641,
    subject: "frontctl live verification",
    status: "archived",
    contact: null,
  });

  assert.equal(parsed.contact, null);
});

test("sanitized discovery fixture install rejects unredacted shapes", async () => {
  const root = await makeTempDir("frontctl-schema-fixture");
  await assert.rejects(
    installSanitizedDiscoveryFixture({
      redacted: false,
      entries: [{ routeKind: "conversation.update" }],
    }, { env: { FRONTCTL_DISCOVERY_FIXTURES_PATH: root } as NodeJS.ProcessEnv }),
  );

  const installed = await installSanitizedDiscoveryFixture({
    redacted: true,
    entries: [{
      method: "PATCH",
      path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
      routeKind: "conversation.update",
      requestBodyShape: { conversations: [{ id: "number", status: "string" }] },
    }],
  }, { env: { FRONTCTL_DISCOVERY_FIXTURES_PATH: root } as NodeJS.ProcessEnv });

  assert.equal(installed.count, 1);
});

test("write verification validates command body before matching known routes", async () => {
  await assert.rejects(verifyWriteFixture({
    action: "archive",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "deleted" }] },
    env: { FRONTCTL_DISCOVERY_FIXTURES_PATH: join(await makeTempDir("frontctl-schema-empty"), "fixtures") } as NodeJS.ProcessEnv,
  }));
});

test("write verification matches numeric workspace tag delete routes", async () => {
  const result = await verifyWriteFixture({
    action: "tag.delete",
    method: "DELETE",
    path: "/cell-00017/api/1/companies/32390a17805cd26f734/tags/224924625",
    env: { FRONTCTL_DISCOVERY_FIXTURES_PATH: join(await makeTempDir("frontctl-schema-tag-delete"), "fixtures") } as NodeJS.ProcessEnv,
  });

  assert.equal(result.verified, true);
  assert.equal(result.source, "known-route");
});

test("session file schema rejects malformed unlocked-session cache", async () => {
  const dir = await makeTempDir("frontctl-schema-session");
  const sessionPath = join(dir, "session.json");
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath, JSON.stringify({
    version: 1,
    host: "app.frontapp.com",
    cookieNames: ["front.id"],
    createdAt: "not-a-date",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "nonce",
    tag: "tag",
    ciphertext: "ciphertext",
  }));

  assert.equal(await readFrontSession(sessionPath), undefined);
});

async function makeTempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}
