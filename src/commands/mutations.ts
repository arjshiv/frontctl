import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CliError } from "../lib/cli.js";
import { listCachedDrafts, readCachedDraft } from "../lib/draftCache.js";
import {
  commentPublishBody,
  commentSaveBody,
  findCommentActivityId,
  findSavedComment,
  internalTaskCommentPublishBody,
  internalTaskCommentSaveBody,
} from "../lib/frontComments.js";
import { createFrontPrivateClient, getBoot } from "../lib/frontPrivate.js";
import { buildFrontRoutes, discoverFrontRouteContext, type FrontRoutes } from "../lib/frontRoutes.js";
import { runMutation, summarizeMutationResult } from "../lib/mutationRunner.js";
import type { MutationMode, MutationSpec } from "../lib/mutationTypes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import {
  frontBootSchema,
  frontConversationSchema,
  frontTimelineResponseSchema,
  validateMutationPayload,
} from "../lib/schemas.js";
import { extractTags, listCachedTags, resolveTagIdentifier, type FrontTag } from "../lib/tags.js";
import { verifyWriteFixture, type WriteVerification } from "../lib/writeVerification.js";

type CustomFieldResolution = {
  id: number;
  input: string;
  name?: string;
  type?: string;
  resourceType?: string;
};

export async function archiveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const ids = positional(args);
  if (!ids.length) {
    throw new CliError("Missing conversation id", 64);
  }
  if (ids.length > 1) {
    throw new CliError("Batch archive is not enabled for this private route. Archive one conversation at a time.", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "archive",
    conversationId: ids[0],
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(ids[0], { status: "archived" }),
    details: {
      status: "archived",
    },
    canExecute: false,
  }), paths });
}

export async function unarchiveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "unarchive",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, { status: "open" }),
    details: {
      status: "open",
      note: "Front returns restored personal inbox conversations as unassigned.",
    },
    canExecute: false,
  }), paths });
}

export async function deleteConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const routes = await getRoutes(paths);
  const teammateId = await teammateIdForTrackerMutation(args, paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "delete",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationTrackerStatusBody(id, teammateId, "trashed"),
    details: {
      status: "trashed",
      note: "Moves the conversation to Front trash; this is not permanent delete.",
    },
    canExecute: false,
  }), paths });
}

export async function restoreConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const routes = await getRoutes(paths);
  const teammateId = await teammateIdForTrackerMutation(args, paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "restore",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationTrackerStatusBody(id, teammateId, "inbox"),
    details: {
      status: "inbox",
      note: "Restores a trashed/deleted conversation to open state.",
    },
    canExecute: false,
  }), paths });
}

export async function createTestConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const subject = readStringFlag(args, "--subject") ?? "frontctl test conversation";
  const body = readStringFlag(args, "--body") ?? "frontctl local integration test. Safe to archive, comment, tag, snooze, link, move, assign, and draft.";
  const routes = await getRoutes(paths);
  const commentUid = randomBytes(16).toString("hex");
  const saveBody = internalTaskCommentSaveBody(body, readStringFlag(args, "--original-conversation-id"));
  const inboxId = numericOrString(readStringFlag(args, "--inbox-id")) ?? undefined;
  const assigneeId = numericOrString(readStringFlag(args, "--assignee-id")) ?? undefined;
  const publishBody = internalTaskCommentPublishBody(commentUid, { subject, inboxId, assigneeId });
  const saveUrl = `${routes.newConversationComment(commentUid)}?include_conversation=true&include_linked_activities=true`;
  return runMutation({ args, spec: await verifiedSpec({
    action: "conversation.create-test",
    method: "PUT",
    url: saveUrl,
    body: saveBody,
    details: {
      commentUid,
      subject,
      publishRequest: {
        method: "POST",
        path: "/conversations/CREATED_CONVERSATION_ID/timeline",
        body: publishBody,
      },
      note: "Creates a non-send Front internal task/test conversation. This must never send email.",
    },
    canExecute: false,
    note: "Creates a Front internal task/test conversation only. Send remains blocked.",
    execute: async (client) => {
      const saveResult = await client.requestJson<Record<string, unknown>>(saveUrl, {
        method: "PUT",
        body: saveBody,
      });
      const savedComment = findSavedComment(saveResult, commentUid);
      if (!savedComment) {
        throw new CliError("Front did not return the saved internal task comment.", 69);
      }
      const conversationId = stringOrNumberField(savedComment.conversationId)
        ?? stringOrNumberField(savedComment.conversation_id)
        ?? findConversationIdInDataGroup(saveResult);
      if (!conversationId) {
        throw new CliError("Front did not return a conversation id for the internal task comment.", 69);
      }
      const result = await client.requestJson<Record<string, unknown>>(routes.timeline(conversationId), {
        method: "POST",
        body: publishBody,
      });
      const summary = summarizeMutationResult(result) as Record<string, unknown>;
      return {
        ...summary,
        conversationId,
        commentUid,
        activityId: findCommentActivityId(result, commentUid) ?? result.id,
      };
    },
  }), paths });
}

export async function assignConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operationOrId, maybeId, maybeAssignee] = positional(args);
  const operation = operationOrId === "add" || operationOrId === "set" || operationOrId === "remove" || operationOrId === "clear" || operationOrId === "unassign"
    ? operationOrId
    : "set";
  const id = operation === "set" ? operationOrId : maybeId;
  const assignee = operation === "set" ? maybeId : maybeAssignee;
  if (!id) {
    throw new CliError("Usage: frontctl assign CONVERSATION_ID TEAMMATE_ID_OR_EMAIL | assign unassign CONVERSATION_ID", 64);
  }
  const assigneeId = operation === "remove" || operation === "clear" || operation === "unassign" ? null : assignee;
  if (assigneeId === undefined) {
    throw new CliError("Missing assignee id/email", 64);
  }
  const routes = await getRoutes(paths);
  const action = assigneeId === null ? "unassign" : "assign";
  return runMutation({ args, spec: await verifiedSpec({
    action,
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, { assignee_id: numericOrString(assigneeId) }),
    details: {
      assigneeId,
      note: action === "assign"
        ? "Assigns the conversation through Front's verified private conversation update route."
        : "Clears the assignee through Front's verified private conversation update route.",
    },
    canExecute: false,
  }), paths });
}

export async function moveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id, inboxId] = positional(args);
  if (!id || !inboxId) {
    throw new CliError("Usage: frontctl move CONVERSATION_ID INBOX_ID", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "move",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, { inbox_id: numericOrString(inboxId) }),
    details: {
      inboxId,
      note: "Private Front move route is previewed until captured on this account.",
    },
    canExecute: false,
  }), paths });
}

export async function followerConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id, teammateId] = positional(args);
  if (!operation || !["add", "remove"].includes(operation) || !id || !teammateId) {
    throw new CliError("Usage: frontctl follower add|remove CONVERSATION_ID TEAMMATE_ID_OR_EMAIL", 64);
  }
  if (operation === "remove" && isExecute(args) && !args.includes("--allow-self-remove")) {
    await assertNotRemovingActiveUserFollower(teammateId, paths);
  }
  const routes = await getRoutes(paths);
  const teammate = numericOrString(teammateId);
  const trackerPatch = operation === "add"
    ? { trackers: { add: [{ teammate_id: teammate, status: "inbox", stage: "follower" }] } }
    : { trackers: { remove: [{ teammate_id: teammate }] } };
  return runMutation({ args, spec: await verifiedSpec({
    action: `follower.${operation}`,
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, trackerPatch),
    details: {
      teammateId,
      note: operation === "add"
        ? "Adds a Front tracker/subscriber through the verified private conversation update route."
        : "Removes a Front tracker/subscriber through the verified private conversation update route. Removing the active user can immediately revoke read access on unassigned/internal task conversations.",
    },
    canExecute: false,
  }), paths });
}

export async function linkConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id] = positional(args);
  if (!operation || !["add", "remove"].includes(operation) || !id) {
    throw new CliError("Usage: frontctl link add CONVERSATION_ID LINKED_CONVERSATION_ID | link remove CONVERSATION_ID LINK_ACTIVITY_ID", 64);
  }
  const routes = await getRoutes(paths);
  const target = positional(args)[2];
  if (!target) {
    throw new CliError(operation === "add" ? "Missing linked conversation id" : "Missing link activity id", 64);
  }
  const body = operation === "add"
    ? {
        conversation_ids: [frontNumericId(target)],
        options: { original_conversation_id: frontNumericId(id) },
      }
    : {};
  return runMutation({ args, spec: await verifiedSpec({
    action: `link.${operation}`,
    conversationId: id,
    method: operation === "add" ? "POST" : "PUT",
    url: operation === "add" ? routes.conversationBatchLink : `${routes.timelineActivity(id, target)}/unlink`,
    body,
    details: {
      target,
      note: operation === "add"
        ? "Links two Front conversations through the verified private conversation_batch/link route."
        : "Unlinks a Front linked-conversation timeline activity through the observed private /unlink route.",
    },
    canExecute: false,
    execute: operation === "add"
      ? async (client) => {
          const result = await client.requestJson<Record<string, unknown>>(routes.conversationBatchLink, {
            method: "POST",
            body,
          });
          const activityId = firstActivityId(result);
          return {
            ...summarizeMutationResult(result) as Record<string, unknown>,
            linkedConversationId: target,
            activityId,
            removeCommand: activityId ? `frontctl link remove ${id} ${activityId} --json` : undefined,
          };
        }
      : undefined,
  }), paths });
}

export async function customFieldConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id, fieldName, ...valueParts] = positional(args);
  if (operation !== "set" || !id || !fieldName || !valueParts.length) {
    throw new CliError("Usage: frontctl custom-field set CONVERSATION_ID FIELD_NAME VALUE", 64);
  }
  const field = await resolveCustomFieldArgument(fieldName, paths);
  if (field.resourceType && field.resourceType !== "conversation") {
    throw new CliError(
      `Custom field "${field.name ?? field.input}" is scoped to Front ${field.resourceType} records, not conversations. ` +
      "This account's observed card custom-field route is PUT /cards/:id with custom_field_attributes, but live card updates returned HTTP 403, so frontctl keeps this write blocked.",
      69,
    );
  }
  const value = normalizeCustomFieldValue(field, valueParts.join(" "));
  const routes = await getRoutes(paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "custom-field.set",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, {
      custom_attributes: {
        add: [{ custom_field_id: field.id, value }],
      },
    }),
    details: {
      field,
      value,
      note: "Builds Front's observed custom_attributes patch shape. Execution remains fixture-gated until a live Front UI capture proves persistence on this account.",
    },
    canExecute: false,
  }), paths });
}

export async function tagConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id, tagAlias] = positional(args);
  if (operation === "list") {
    const limit = readNumberFlag(args, "--limit") ?? 100;
    if (args.includes("--live")) {
      const tags = extractTags(await getBoot(paths)).slice(0, limit);
      return {
        source: "live-private",
        publicApiUsed: false,
        count: tags.length,
        tags,
      };
    }
    return listCachedTags(paths.cacheDataPath, limit);
  }
  if (operation === "counts") {
    const limit = readNumberFlag(args, "--limit") ?? 100;
    const tags = extractTags(await getBoot(paths)).slice(0, limit);
    return {
      source: "live-private",
      stale: false,
      publicApiUsed: false,
      count: tags.length,
      tags: tags.map((tag) => ({ ...tag, conversationCount: undefined })),
      note: "Front boot exposes tag metadata but not reliable per-tag counts. Use search filters for exact counts when that route is captured.",
    };
  }
  if (operation === "delete") {
    const tagId = id;
    if (!tagId || !/^\d+$/.test(tagId)) {
      throw new CliError("Usage: frontctl tag delete TAG_ID", 64);
    }
    const routes = await getRoutes(paths);
    const deleteUrl = `${routes.tags}/${encodeURIComponent(tagId)}`;
    return runMutation({ args, spec: await verifiedSpec({
      action: "tag.delete",
      method: "DELETE",
      url: deleteUrl,
      details: {
        tagId,
        note: "Deletes a workspace-level Front tag through the verified private tag route. Numeric tag id is required so frontctl never guesses which tag to delete.",
      },
      canExecute: false,
      execute: async (client) => {
        await client.requestJson(deleteUrl, { method: "DELETE" });
        return { ok: true, tagId };
      },
    }), paths });
  }
  if (operation === "create") {
    const name = id;
    if (!name) {
      throw new CliError("Usage: frontctl tag create NAME", 64);
    }
    const routes = await getRoutes(paths);
    return runMutation({ args, spec: await verifiedSpec({
      action: "tag.create",
      method: "POST",
      url: routes.tags,
      body: { name },
      details: {
        name,
        note: "Creates a workspace-level Front tag through the verified private tag route. Use disposable names for tests and clean them up with `frontctl tag delete TAG_ID --yes`.",
      },
      canExecute: false,
    }), paths });
  }
  if (!operation || !["add", "remove"].includes(operation)) {
    throw new CliError("Usage: frontctl tag list|counts|create|delete ... | tag add|remove CONVERSATION_ID TAG", 64);
  }
  if (!id || !tagAlias) {
    throw new CliError("Missing conversation id or tag", 64);
  }
  const [routes, tagResolution] = await Promise.all([
    getRoutes(paths),
    resolveTagArgument(tagAlias, args, paths),
  ]);
  const resolvedTagId = numericTagId(tagResolution);
  const tagPatch = operation === "add"
    ? { tags: { add: [resolvedTagId] } }
    : { tags: { remove: [resolvedTagId] } };
  const spec = await verifiedSpec({
    action: `tag.${operation}`,
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, tagPatch),
    details: {
      tag: tagResolution,
      numericTagId: resolvedTagId,
    },
    note: resolvedTagId === undefined
      ? [tagResolution.warning, "Front's app update route requires a numeric tag id. Run `frontctl tag list --live --json` and use the numeric id for this tag."]
        .filter(Boolean)
        .join(" ")
      : tagResolution.warning,
    canExecute: false,
  });
  return runMutation({ args, spec: { ...spec, canExecute: spec.canExecute && resolvedTagId !== undefined }, paths });
}

export async function commentConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id, commentRef] = positional(args);
  if (!operation || !["add", "remove"].includes(operation)) {
    throw new CliError("Usage: frontctl comment add CONVERSATION_ID --body \"...\"|--body-file note.md | comment remove CONVERSATION_ID ACTIVITY_OR_COMMENT_UID", 64);
  }
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  if (operation === "remove") {
    if (!commentRef) {
      throw new CliError("Missing comment activity id or comment uid", 64);
    }
    const routes = await getRoutes(paths);
    const spec = await verifiedSpec({
      action: "comment.remove",
      conversationId: id,
      method: "DELETE",
      url: routes.timelineActivity(id, commentRef),
      details: {
        input: commentRef,
        note: "If a comment uid is provided, frontctl resolves it to the timeline activity id at execution time.",
      },
      canExecute: false,
      execute: async (client) => {
        const activityId = /^\d+$/.test(commentRef)
          ? commentRef
          : await resolveCommentActivityId(client, routes, id, commentRef);
        return client.requestJson(routes.timelineActivity(id, activityId), { method: "DELETE", body: {} });
      },
    });
    return runMutation({ args, spec, paths });
  }

  const body = await readBodyArg(args);
  if (!body) {
    throw new CliError("Missing comment body. Use --body \"...\" or --body-file path", 64);
  }
  const routes = await getRoutes(paths);
  const commentUid = randomBytes(16).toString("hex");
  const saveBody = commentSaveBody(body);
  const publishBody = commentPublishBody(commentUid);
  return runMutation({ args, spec: await verifiedSpec({
    action: "comment.add",
    conversationId: id,
    method: "POST",
    url: routes.timeline(id),
    body: publishBody,
    details: {
      commentUid,
      saveRequest: {
        method: "PUT",
        path: new URL(`${routes.comment(id, commentUid)}?include_conversation=true`).pathname,
        body: saveBody,
      },
    },
    canExecute: false,
    execute: async (client) => {
      await client.requestJson(`${routes.comment(id, commentUid)}?include_conversation=true`, {
        method: "PUT",
        body: saveBody,
      });
      const result = await client.requestJson<Record<string, unknown>>(routes.timeline(id), {
        method: "POST",
        body: publishBody,
      });
      const summary = summarizeMutationResult(result) as Record<string, unknown>;
      return {
        ...summary,
        commentUid,
        activityId: findCommentActivityId(result, commentUid) ?? result.id,
      };
    },
  }), paths });
}

export async function snoozeConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id, until] = positional(args);
  if (!id || !until) {
    throw new CliError("Usage: frontctl snooze CONVERSATION_ID UNTIL", 64);
  }
  const routes = await getRoutes(paths);
  const snoozeUntil = parseSnoozeUntil(until);
  return runMutation({ args, spec: await verifiedSpec({
    action: "snooze",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, { status: "archived", reminder: snoozeUntil.epochMs }),
    details: {
      input: until,
      normalizedUntil: snoozeUntil.iso,
      normalizedUntilEpochMs: snoozeUntil.epochMs,
      parser: snoozeUntil.parser,
      status: "archived",
    },
    canExecute: false,
  }), paths });
}

export async function unsnoozeConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Usage: frontctl unsnooze CONVERSATION_ID", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation({ args, spec: await verifiedSpec({
    action: "unsnooze",
    conversationId: id,
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(id, { status: "archived", reminder: null }),
    details: {
      reminder: null,
      status: "archived",
      note: "Clears the reminder while keeping the conversation archived.",
    },
    canExecute: false,
  }), paths });
}

export async function draftCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id, messageUidArg] = positional(args);
  if (operation === "list") {
    const limit = readNumberFlag(args, "--limit") ?? 20;
    const drafts = (await listCachedDrafts(paths.indexedDbLevelDbPath)).slice(0, limit);
    return {
      source: "local-indexeddb",
      stale: true,
      count: drafts.length,
      drafts,
    };
  }
  if (operation === "read") {
    if (!id) {
      throw new CliError("Usage: frontctl draft read DRAFT_ID", 64);
    }
    return readCachedDraft(paths.indexedDbLevelDbPath, id);
  }
  if (operation === "discard") {
    if (!id) {
      throw new CliError("Usage: frontctl draft discard DRAFT_ID | draft discard CONVERSATION_ID MESSAGE_UID", 64);
    }
    const routes = await getRoutes(paths);
    const cachedDraft = messageUidArg ? undefined : await readCachedDraft(paths.indexedDbLevelDbPath, id);
    const conversationId = messageUidArg ? id : cachedDraft?.draft?.conversationId;
    const messageUid = messageUidArg ?? cachedDraft?.draft?.messageUid;
    const spec: MutationSpec = {
      action: "draft.discard",
      conversationId,
      method: "DELETE",
      url: messageUid ? discardDraftUrl(routes, conversationId, messageUid) : undefined,
      canExecute: false,
      note: messageUid
        ? undefined
        : "Could not resolve this cached draft to a Front message id. Run `frontctl draft list --json` and discard a listed draft with messageUid, or pass CONVERSATION_ID MESSAGE_UID.",
    };
    return runMutation({ args, spec: messageUid ? await verifiedSpec(spec) : spec, paths });
  }
  if (operation === "update") {
    if (!id || !messageUidArg) {
      throw new CliError("Usage: frontctl draft update CONVERSATION_ID MESSAGE_UID --to EMAIL [--subject TEXT] --body \"...\"|--body-file draft.md", 64);
    }
    const body = await readBodyArg(args);
    if (!body) {
      throw new CliError("Missing draft body. Use --body \"...\" or --body-file path", 64);
    }
    const routes = await getRoutes(paths);
    const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
    const { draftBody, details } = mode === "execute"
      ? await buildComposeDraftBody(args, body, paths)
      : previewComposeDraftBody(args, body);
    const updateUrl = `${routes.conversationMessage(id, messageUidArg)}?include_conversation=true`;
    return runMutation({ args, spec: await verifiedSpec({
      action: "draft.update",
      conversationId: id,
      method: "PUT",
      url: updateUrl,
      body: draftBody,
      details: {
        ...details,
        conversationId: id,
        messageUid: messageUidArg,
        discardCommand: `frontctl draft discard ${id} ${messageUidArg} --json`,
        note: "Updates an existing saved compose draft through Front's non-send draft save route. Recipients and subject are explicit so frontctl does not guess from stale draft cache.",
      },
      canExecute: false,
      note: "Draft save only. Send remains blocked.",
      execute: async (client) => {
        const result = await client.requestJson<Record<string, unknown>>(updateUrl, {
          method: "PUT",
          body: draftBody,
        });
        const summary = summarizeMutationResult(result) as Record<string, unknown>;
        return {
          ...summary,
          conversationId: id,
          messageUid: String(result.uid ?? messageUidArg),
          discardCommand: `frontctl draft discard ${id} ${String(result.uid ?? messageUidArg)} --json`,
        };
      },
    }), paths });
  }
  if (operation === "forward") {
    if (!id) {
      throw new CliError("Usage: frontctl draft forward CONVERSATION_ID --to EMAIL --body \"...\"|--body-file note.md", 64);
    }
    const body = await readBodyArg(args);
    const to = readStringListFlag(args, "--to");
    if (!body || !to.length) {
      throw new CliError("Draft forward needs --to and --body or --body-file", 64);
    }
    const routes = await getRoutes(paths);
    const draftUid = randomBytes(16).toString("hex");
    const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
    const { draftBody, details } = mode === "execute"
      ? await buildForwardDraftBody(id, args, body, paths)
      : previewForwardDraftBody(id, args, body);
    const draftUrl = `${routes.newConversationMessage(draftUid)}?include_conversation=true`;
    return runMutation({ args, spec: await verifiedSpec({
      action: "draft.forward",
      conversationId: id,
      method: "PUT",
      url: draftUrl,
      body: draftBody,
      details: {
        ...details,
        sourceConversationId: id,
        draftUid,
        discardCommand: `frontctl draft discard CONVERSATION_ID ${draftUid} --json`,
      },
      canExecute: false,
      note: "Forward-as-draft save only. Send remains blocked.",
      execute: async (client) => {
        const result = await client.requestJson<Record<string, unknown>>(draftUrl, {
          method: "PUT",
          body: draftBody,
        });
        const conversationId = stringOrNumberField(result.conversation_id)
          ?? stringOrNumberField((result.conversation as Record<string, unknown> | undefined)?.id);
        const messageUid = String(result.uid ?? draftUid);
        const summary = summarizeMutationResult(result) as Record<string, unknown>;
        return {
          ...summary,
          sourceConversationId: id,
          conversationId,
          messageUid,
          discardCommand: conversationId
            ? `frontctl draft discard ${conversationId} ${messageUid} --json`
            : `frontctl draft discard DRAFT_ID_OR_CONVERSATION_ID ${messageUid} --json`,
        };
      },
    }), paths });
  }
  if (!["reply", "compose", "create"].includes(operation ?? "")) {
    throw new CliError("Usage: frontctl draft list|read|discard|reply|compose|create|update|forward ...", 64);
  }
  if (operation === "reply" && !id) {
    throw new CliError("Missing conversation id", 64);
  }
  const body = await readBodyArg(args);
  if (!body) {
    throw new CliError("Missing draft body. Use --body \"...\" or --body-file path", 64);
  }
  if (operation === "reply") {
    const routes = await getRoutes(paths);
    const draftUid = randomBytes(16).toString("hex");
    const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
    const { draftBody, details } = mode === "execute"
      ? await buildReplyDraftBody(id, body, paths)
      : previewReplyDraftBody(body);
    const draftUrl = `${routes.conversationMessage(id, draftUid)}?include_conversation=true`;
    return runMutation({ args, spec: await verifiedSpec({
      action: "draft.reply",
      conversationId: id,
      method: "PUT",
      url: draftUrl,
      body: draftBody,
      details: {
        ...details,
        draftUid,
        discardCommand: `frontctl draft discard ${id} ${draftUid} --json`,
      },
      canExecute: false,
      note: "Draft save only. Send remains blocked.",
      execute: async (client) => {
        const result = await client.requestJson<Record<string, unknown>>(draftUrl, {
          method: "PUT",
          body: draftBody,
        });
        const summary = summarizeMutationResult(result) as Record<string, unknown>;
        return {
          ...summary,
          conversationId: id,
          messageUid: String(result.uid ?? draftUid),
          discardCommand: `frontctl draft discard ${id} ${String(result.uid ?? draftUid)} --json`,
        };
      },
    }), paths });
  }
  const to = readStringListFlag(args, "--to");
  if (!to.length) {
    throw new CliError("Draft compose needs at least one --to recipient.", 64);
  }
  const routes = await getRoutes(paths);
  const draftUid = randomBytes(16).toString("hex");
  const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
  const { draftBody, details } = mode === "execute"
    ? await buildComposeDraftBody(args, body, paths)
    : previewComposeDraftBody(args, body);
  const draftUrl = `${routes.newConversationMessage(draftUid)}?include_conversation=true`;
  return runMutation({ args, spec: await verifiedSpec({
    action: "draft.compose",
    method: "PUT",
    url: draftUrl,
    body: draftBody,
    details: {
      ...details,
      draftUid,
      operation,
      discardCommand: `frontctl draft discard CONVERSATION_ID ${draftUid} --json`,
    },
    canExecute: false,
    note: "Draft save only. Send remains blocked.",
    execute: async (client) => {
      const result = await client.requestJson<Record<string, unknown>>(draftUrl, {
        method: "PUT",
        body: draftBody,
      });
      const conversationId = stringOrNumberField(result.conversation_id)
        ?? stringOrNumberField((result.conversation as Record<string, unknown> | undefined)?.id);
      const messageUid = String(result.uid ?? draftUid);
      const summary = summarizeMutationResult(result) as Record<string, unknown>;
      return {
        ...summary,
        conversationId,
        messageUid,
        discardCommand: conversationId
          ? `frontctl draft discard ${conversationId} ${messageUid} --json`
          : `frontctl draft discard DRAFT_ID_OR_CONVERSATION_ID ${messageUid} --json`,
      };
    },
  }), paths });
}

async function verifiedSpec(spec: MutationSpec): Promise<MutationSpec> {
  if (spec.body !== undefined) {
    spec = {
      ...spec,
      body: validateMutationPayload(spec.action, spec.body),
    };
  }
  const path = spec.url ? new URL(spec.url).pathname : undefined;
  const verification = await verifyWriteFixture({
    action: spec.action,
    method: spec.method,
    path,
    body: spec.body,
  });
  return {
    ...spec,
    canExecute: verification.verified,
    verification,
  };
}

function positional(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--body", "--body-file", "--limit", "--actor", "--agent-name", "--client", "--run-id", "--reason", "--url", "--name", "--from-channel-id", "--inbox-id", "--assignee-id", "--original-conversation-id", "--teammate-id"].includes(arg)) {
      index += 1;
      continue;
    }
    if (["--to", "--cc", "--bcc", "--subject"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    values.push(arg);
  }
  return values;
}

function firstValue(args: string[]) {
  return positional(args)[0];
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readBodyArg(args: string[]) {
  const body = readStringFlag(args, "--body");
  if (body !== undefined) {
    return body;
  }
  const bodyFile = readStringFlag(args, "--body-file");
  return bodyFile ? readFile(bodyFile, "utf8") : undefined;
}

async function buildReplyDraftBody(conversationId: string, body: string, paths: FrontPaths) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const [boot, conversation, timelineResponse] = await Promise.all([
    client.getJson(routes.boot).then((value) => frontBootSchema.parse(value)),
    client.getJson(routes.conversation(conversationId)).then((value) => frontConversationSchema.parse(value)),
    client.getJson(routes.timeline(conversationId)).then((value) => frontTimelineResponseSchema.parse(value)),
  ]);
  const timeline = Array.isArray(timelineResponse)
    ? timelineResponse
    : Array.isArray(timelineResponse.timeline)
      ? timelineResponse.timeline
      : [];
  const content = { timeline };
  const sourceMessage = latestConversationMessage(content, conversation);
  const authorId = numberField((boot.user as Record<string, unknown> | undefined)?.id);
  const channelId = replyChannelId(sourceMessage);
  const recipient = replyRecipient(sourceMessage);
  if (!sourceMessage.id) {
    throw new CliError("Could not find a source message to reply to in this conversation.", 69);
  }
  if (!authorId) {
    throw new CliError("Could not resolve the current Front user for draft reply.", 69);
  }
  if (!channelId) {
    throw new CliError("Could not resolve a sending channel for draft reply.", 69);
  }
  if (!recipient?.handle) {
    throw new CliError("Could not resolve reply recipient for draft reply.", 69);
  }
  const subject = stringField(sourceMessage.subject) ?? "";
  const defaultFontStyle = stringField(
    ((boot.user as Record<string, unknown> | undefined)?.preferences as Record<string, unknown> | undefined)
      ?.defaultFontStyle,
  ) ?? "";
  const html = bodyToHtml(body);
  return {
    draftBody: {
      in_reply_to_id: sourceMessage.id,
      referenced_message_id: sourceMessage.id,
      author_id: authorId,
      from: { channel_id: channelId },
      subject,
      recipients: [recipient],
      attachments: [],
      html,
      text: body,
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
      default_font_style: defaultFontStyle,
      format: "html",
      handle_time_increment: 0,
    },
    details: {
      sourceMessageId: sourceMessage.id,
      fromChannelId: channelId,
      recipient: {
        role: recipient.role,
        handle: recipient.handle,
      },
      bodyFormat: "html",
      version: "omitted-for-new-draft",
    },
  };
}

async function buildComposeDraftBody(args: string[], body: string, paths: FrontPaths) {
  const boot = await getBoot(paths);
  const authorId = numberField((boot.user as Record<string, unknown> | undefined)?.id);
  if (!authorId) {
    throw new CliError("Could not resolve the current Front user for draft compose.", 69);
  }
  const channelId = resolveComposeChannelId(args, boot, authorId);
  if (!channelId) {
    throw new CliError("Could not resolve a sending channel for draft compose. Pass --from-channel-id CHANNEL_ID.", 69);
  }
  return composeDraftBodyFromFields(args, body, {
    authorId,
    channelId,
    defaultFontStyle: defaultFontStyle(boot),
    preview: false,
  });
}

async function buildForwardDraftBody(sourceConversationId: string, args: string[], body: string, paths: FrontPaths) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const [boot, conversation, timelineResponse] = await Promise.all([
    client.getJson(routes.boot).then((value) => frontBootSchema.parse(value)),
    client.getJson(routes.conversation(sourceConversationId)).then((value) => frontConversationSchema.parse(value)),
    client.getJson(routes.timeline(sourceConversationId)).then((value) => frontTimelineResponseSchema.parse(value)),
  ]);
  const timeline = Array.isArray(timelineResponse)
    ? timelineResponse
    : Array.isArray(timelineResponse.timeline)
      ? timelineResponse.timeline
      : [];
  const sourceMessage = latestConversationMessage({ timeline }, conversation);
  if (!sourceMessage.id) {
    throw new CliError("Could not find a source message to forward in this conversation.", 69);
  }
  const authorId = numberField((boot.user as Record<string, unknown> | undefined)?.id);
  if (!authorId) {
    throw new CliError("Could not resolve the current Front user for draft forward.", 69);
  }
  const channelId = resolveComposeChannelId(args, boot, authorId);
  if (!channelId) {
    throw new CliError("Could not resolve a sending channel for draft forward. Pass --from-channel-id CHANNEL_ID.", 69);
  }
  return forwardDraftBodyFromFields(args, body, sourceMessage, {
    authorId,
    channelId,
    defaultFontStyle: defaultFontStyle(boot),
    preview: false,
    sourceConversationId,
  });
}

function previewForwardDraftBody(sourceConversationId: string, args: string[], body: string) {
  return forwardDraftBodyFromFields(args, body, {
    id: 123,
    subject: "frontctl draft preview",
    sentAt: Date.now(),
    recipients: [
      { role: "from", handle: "sender@example.com", name: "Sender" },
      { role: "to", handle: "recipient@example.com", name: "Recipient" },
    ],
    body: "<div>Forwarded preview body</div>",
  }, {
    authorId: 456,
    channelId: 789,
    defaultFontStyle: "",
    preview: true,
    sourceConversationId,
  });
}

function forwardDraftBodyFromFields(
  args: string[],
  body: string,
  sourceMessage: Record<string, unknown>,
  options: { authorId: number; channelId: number; defaultFontStyle: string; preview: boolean; sourceConversationId: string },
) {
  const html = bodyToHtml(body);
  const recipients = [
    ...composeRecipients(readStringListFlag(args, "--to"), "to"),
    ...composeRecipients(readStringListFlag(args, "--cc"), "cc"),
    ...composeRecipients(readStringListFlag(args, "--bcc"), "bcc"),
  ];
  const subject = readStringFlag(args, "--subject") ?? `Fw: ${cleanSubject(stringField(sourceMessage.subject) ?? "")}`;
  const forwardHtml = buildForwardHtml(sourceMessage);
  return {
    draftBody: {
      author_id: options.authorId,
      from: { channel_id: options.channelId },
      subject,
      recipients,
      attachments: [],
      html,
      text: body,
      shared_draft: false,
      virtru_encrypt: false,
      has_quote: false,
      quote_include: false,
      quote_modified: false,
      forward_html: forwardHtml,
      forward_include: true,
      forward_modified: false,
      signature_include: false,
      signature_modified: false,
      main_style: "",
      default_font_style: options.defaultFontStyle,
      format: "html",
      handle_time_increment: 0,
    },
    details: {
      sourceConversationId: options.sourceConversationId,
      sourceMessageId: stringOrNumberField(sourceMessage.id) ?? "preview-placeholder",
      fromChannelId: options.preview ? "preview-placeholder" : options.channelId,
      recipients: recipients.map((recipient) => ({ role: recipient.role, handle: recipient.handle })),
      subject,
      forwardIncluded: true,
      bodyFormat: "html",
      note: options.preview
        ? "Preview uses placeholder user/channel/source ids. Execution resolves the source message and private sending channel from live Front data."
        : "Forward-as-draft uses Front's non-send /conversations/new/messages route with forwarded-message HTML included.",
    },
  };
}

function previewComposeDraftBody(args: string[], body: string) {
  return composeDraftBodyFromFields(args, body, {
    authorId: 456,
    channelId: 789,
    defaultFontStyle: "",
    preview: true,
  });
}

function composeDraftBodyFromFields(
  args: string[],
  body: string,
  options: { authorId: number; channelId: number; defaultFontStyle: string; preview: boolean },
) {
  const html = bodyToHtml(body);
  const recipients = [
    ...composeRecipients(readStringListFlag(args, "--to"), "to"),
    ...composeRecipients(readStringListFlag(args, "--cc"), "cc"),
    ...composeRecipients(readStringListFlag(args, "--bcc"), "bcc"),
  ];
  return {
    draftBody: {
      author_id: options.authorId,
      from: { channel_id: options.channelId },
      subject: readStringFlag(args, "--subject") ?? "",
      recipients,
      attachments: [],
      html,
      text: body,
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
      default_font_style: options.defaultFontStyle,
      format: "html",
      handle_time_increment: 0,
    },
    details: {
      fromChannelId: options.preview ? "preview-placeholder" : options.channelId,
      recipients: recipients.map((recipient) => ({ role: recipient.role, handle: recipient.handle })),
      bodyFormat: "html",
      note: options.preview
        ? "Preview uses placeholder user/channel ids. Execution resolves the current user and default private sending channel from live Front boot data."
        : "Standalone draft save uses Front's non-send /conversations/new/messages route.",
    },
  };
}

function composeRecipients(handles: string[], role: "to" | "cc" | "bcc") {
  return handles.map((handle) => ({
    role,
    handle,
    name: handle,
    source: "email",
  }));
}

function previewReplyDraftBody(body: string) {
  return {
    draftBody: {
      in_reply_to_id: 123,
      referenced_message_id: 123,
      author_id: 456,
      from: { channel_id: 789 },
      subject: "frontctl draft preview",
      recipients: [{ role: "to", handle: "recipient@example.com", name: "Recipient", source: "email" }],
      attachments: [],
      html: bodyToHtml(body),
      text: body,
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
    },
    details: {
      sourceMessageId: "preview-placeholder",
      fromChannelId: "preview-placeholder",
      recipient: {
        role: "to",
        handle: "preview-placeholder",
      },
      bodyFormat: "html",
      version: "omitted-for-new-draft",
      note: "Preview uses placeholder ids. Execution resolves the source message, channel, and recipient from the live conversation.",
    },
  };
}

function resolveComposeChannelId(args: string[], boot: Record<string, unknown>, authorId: number) {
  const explicit = readNumberFlag(args, "--from-channel-id");
  if (explicit) {
    return explicit;
  }
  const channels = Array.isArray(boot.channels) ? boot.channels as Array<Record<string, unknown>> : [];
  const user = boot.user as Record<string, unknown> | undefined;
  const userEmail = stringField(user?.email);
  const privateNamespace = `tea:${authorId}`;
  return channels
    .filter((channel) => isSendableEmailChannel(channel))
    .map((channel) => stringField(channel.namespace) === privateNamespace && booleanField(channel.is_private) === true ? numberField(channel.id) : undefined)
    .find((id): id is number => id !== undefined)
    ?? channels
      .filter((channel) => isSendableEmailChannel(channel))
      .map((channel) => userEmail && (stringField(channel.send_as) === userEmail || stringField(channel.address) === userEmail) ? numberField(channel.id) : undefined)
      .find((id): id is number => id !== undefined)
    ?? numberField(channels.find(isSendableEmailChannel)?.id);
}

function isSendableEmailChannel(channel: Record<string, unknown>) {
  const settings = isObject(channel.settings) ? channel.settings : {};
  return numberField(channel.id) !== undefined
    && (channel.message_type === "email" || channel.type_name === "email")
    && settings.canSend !== false;
}

function defaultFontStyle(boot: Record<string, unknown>) {
  return stringField(
    ((boot.user as Record<string, unknown> | undefined)?.preferences as Record<string, unknown> | undefined)
      ?.defaultFontStyle,
  ) ?? "";
}

function latestConversationMessage(content: Record<string, unknown>, conversation?: Record<string, unknown>) {
  const timeline = Array.isArray(content.timeline) ? content.timeline as Array<Record<string, unknown>> : [];
  const messages = timeline
    .map((item) => (isObject(item.message) ? item.message : item))
    .filter((item): item is Record<string, unknown> => isObject(item) && (item.type === "email" || "recipients" in item));
  const message = messages.at(-1);
  if (message) {
    return message;
  }
  const fallback = conversation ? conversationReplyMessage(conversation) : undefined;
  if (fallback) {
    return fallback;
  }
  throw new CliError("Could not find a source message to reply to in this conversation.", 69);
}

function conversationReplyMessage(conversation: Record<string, unknown>) {
  const lastMessage = isObject(conversation.last_manual_message)
    ? conversation.last_manual_message
    : isObject(conversation.last_message)
      ? conversation.last_message
      : undefined;
  const id = lastMessage?.id;
  if (!id) {
    return undefined;
  }
  const channelId = firstNumber(conversation.channels)
    ?? firstNumber((conversation.channels_full as unknown[] | undefined)?.map((channel) =>
      isObject(channel) ? channel.id : undefined));
  const senders = isObject(conversation.senders) ? conversation.senders : undefined;
  const sender = isObject((senders?.last_sender as Record<string, unknown> | undefined)?.recipient)
    ? (senders?.last_sender as Record<string, unknown>).recipient as Record<string, unknown>
    : isObject((senders?.first_sender as Record<string, unknown> | undefined)?.recipient)
      ? (senders?.first_sender as Record<string, unknown>).recipient as Record<string, unknown>
      : isObject(conversation.contact)
        ? conversation.contact
        : undefined;
  const handle = stringField(sender?.handle) ?? stringField(sender?.email) ?? stringField(sender?.display_name);
  return {
    type: "email",
    id,
    subject: stringField(conversation.subject) ?? stringField(lastMessage?.subject) ?? "",
    recipients: [
      ...(channelId ? [{ role: "to", channel_id: channelId }] : []),
      ...(handle ? [{
        role: "reply-to",
        handle,
        display_name: stringField(sender?.display_name) ?? stringField(sender?.name) ?? handle,
      }] : []),
    ],
  };
}

function firstNumber(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items.find((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function replyChannelId(message: Record<string, unknown>) {
  const recipients = Array.isArray(message.recipients) ? message.recipients as Array<Record<string, unknown>> : [];
  for (const recipient of recipients) {
    const direct = numberField(recipient.channel_id);
    const nested = numberField((recipient.channel_full as Record<string, unknown> | undefined)?.id);
    if (direct ?? nested) {
      return direct ?? nested;
    }
  }
  return undefined;
}

function replyRecipient(message: Record<string, unknown>) {
  const recipients = Array.isArray(message.recipients) ? message.recipients as Array<Record<string, unknown>> : [];
  const from = recipients.find((candidate) => candidate.role === "reply-to")
    ?? (isObject(message.from) ? message.from : undefined)
    ?? recipients.find((candidate) => candidate.role === "from");
  if (!from) {
    return undefined;
  }
  const handle = stringField(from.handle) ?? stringField(from.email) ?? stringField(from.display_name);
  if (!handle) {
    return undefined;
  }
  return {
    role: "to",
    handle,
    name: stringField(from.display_name) ?? stringField(from.name) ?? handle,
    source: "email",
  };
}

function buildForwardHtml(message: Record<string, unknown>) {
  const recipients = Array.isArray(message.recipients) ? message.recipients as Array<Record<string, unknown>> : [];
  const lines = [
    "----------- Forwarded message -----------",
    formatForwardRecipients("From", recipients.filter((recipient) => recipient.role === "from" || recipient.role === "reply-to")),
    `Date: ${formatForwardDate(message)}`,
    `Subject: ${cleanSubject(stringField(message.subject) ?? "")}`,
    formatForwardRecipients("To", recipients.filter((recipient) => recipient.role === "to")),
    formatForwardRecipients("Cc", recipients.filter((recipient) => recipient.role === "cc")),
  ].filter((line): line is string => Boolean(line));
  const rawBody = stringField(message.body)
    ?? stringField(message.lightBody)
    ?? stringField(message.light_body)
    ?? stringField(message.html)
    ?? (stringField(message.text) ? bodyToHtml(stringField(message.text) ?? "") : "");
  const header = lines.map(escapeHtml).join("<br>");
  return `${header}<br><br>${rawBody}`;
}

function formatForwardRecipients(label: string, recipients: Array<Record<string, unknown>>) {
  if (!recipients.length) {
    return undefined;
  }
  const handles = recipients
    .map((recipient) => stringField(recipient.display_name)
      ?? stringField(recipient.name)
      ?? stringField(recipient.handle)
      ?? stringField(recipient.email))
    .filter((value): value is string => Boolean(value));
  return handles.length ? `${label}: ${handles.join(", ")}` : undefined;
}

function formatForwardDate(message: Record<string, unknown>) {
  const value = numberField(message.sentAt)
    ?? numberField(message.sent_at)
    ?? numberField(message.date)
    ?? numberField(message.createdAt)
    ?? numberField(message.created_at)
    ?? numberField(message.updatedAt)
    ?? numberField(message.updated_at);
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
}

function cleanSubject(subject: string) {
  return subject.replace(/^(?:re:\s*|fwd:\s*|fw:\s*)+/i, "");
}

function discardDraftUrl(routes: FrontRoutes, conversationId: string | undefined, messageUid: string) {
  return conversationId ? routes.conversationMessage(conversationId, messageUid) : routes.message(messageUid);
}

function bodyToHtml(body: string) {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<div>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</div>`)
    .join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrNumberField(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function booleanField(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringListFlag(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const raw = args[index + 1];
    if (!raw) {
      continue;
    }
    values.push(...raw.split(",").map((value) => value.trim()).filter(Boolean));
  }
  return values;
}

function conversationPatchBody(id: string, patch: Record<string, unknown>) {
  return {
    conversations: [
      {
        id: frontNumericId(id),
        ...patch,
      },
    ],
  };
}

function conversationTrackerStatusBody(id: string, teammateId: string | number | null | undefined, status: "trashed" | "inbox") {
  if (teammateId === null || teammateId === undefined) {
    throw new CliError("Missing active Front teammate id for tracker status mutation.", 69);
  }
  return conversationPatchBody(id, {
    trackers: {
      add: [{
        status,
        bump: true,
        teammate_id: teammateId,
      }],
    },
    tags: {},
    pinnedActivities: {},
    topics: {},
    custom_attributes: {},
    timeline: {},
    macros: {},
    bulk_reply: {},
  });
}

async function resolveCommentActivityId(
  client: Awaited<ReturnType<typeof createFrontPrivateClient>>,
  routes: FrontRoutes,
  conversationId: string,
  commentUid: string,
) {
  const content = await client.getJson<Record<string, unknown>>(routes.content(conversationId));
  const timeline = Array.isArray(content.timeline) ? content.timeline as Array<Record<string, unknown>> : [];
  const activity = timeline.find((item) => {
    const comment = item.comment as Record<string, unknown> | undefined;
    return String(comment?.uid ?? item.comment_uid ?? "") === commentUid;
  });
  const activityId = activity?.id;
  if (!activityId) {
    throw new CliError(`Could not find comment activity for uid ${commentUid}`, 69);
  }
  return String(activityId);
}

function frontNumericId(id: string) {
  return /^\d+$/.test(id) ? Number(id) : id;
}

function findConversationIdInDataGroup(result: unknown) {
  if (!isObject(result)) {
    return undefined;
  }
  const conversations = result.conversations;
  if (Array.isArray(conversations)) {
    return stringOrNumberField((conversations[0] as Record<string, unknown> | undefined)?.id);
  }
  if (isObject(conversations) && isObject(conversations.byId)) {
    return stringOrNumberField((Object.values(conversations.byId)[0] as Record<string, unknown> | undefined)?.id);
  }
  return stringOrNumberField(result.conversation_id)
    ?? stringOrNumberField((result.conversation as Record<string, unknown> | undefined)?.id);
}

function firstActivityId(result: unknown) {
  if (!isObject(result) || !Array.isArray(result.activities)) {
    return undefined;
  }
  return stringOrNumberField((result.activities[0] as Record<string, unknown> | undefined)?.id);
}

function numericOrString(value: string | null | undefined) {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  return /^\d+$/.test(value) ? Number(value) : value;
}

function isExecute(args: string[]) {
  return args.includes("--yes") && !args.includes("--dry-run");
}

async function teammateIdForTrackerMutation(args: string[], paths: FrontPaths) {
  const explicit = readStringFlag(args, "--teammate-id");
  if (explicit) {
    return numericOrString(explicit);
  }
  if (!isExecute(args)) {
    return 0;
  }
  const boot = await getBoot(paths);
  const user = isObject(boot.user) ? boot.user as Record<string, unknown> : undefined;
  const teammateId = stringOrNumberField(user?.id);
  if (!teammateId) {
    throw new CliError("Could not resolve the active Front teammate id for this tracker mutation.", 69);
  }
  return numericOrString(teammateId);
}

async function assertNotRemovingActiveUserFollower(teammateId: string, paths: FrontPaths) {
  const boot = await getBoot(paths).catch(() => undefined);
  const user = isObject(boot?.user) ? boot.user as Record<string, unknown> : undefined;
  const currentUserId = stringOrNumberField(user?.id);
  const currentUserEmail = stringOrNumberField(user?.email);
  if (teammateId === currentUserId || teammateId.toLowerCase() === currentUserEmail?.toLowerCase()) {
    throw new CliError(
      "Refusing to remove the active Front user as a follower before writing an identity comment. Front can reject or revoke access for self-removal on personal/internal-task conversations. Use --allow-self-remove only on a disposable conversation when you are prepared to lose access.",
      69,
    );
  }
}

function numericTagId(resolution: { tag?: FrontTag; input: string; resolvedAlias: string }) {
  const candidates = [resolution.tag?.id, resolution.resolvedAlias, resolution.input];
  for (const candidate of candidates) {
    if (candidate !== undefined && /^\d+$/.test(String(candidate))) {
      return Number(candidate);
    }
  }
  return undefined;
}

async function resolveCustomFieldArgument(input: string, paths: FrontPaths): Promise<CustomFieldResolution> {
  const boot = await getBoot(paths).catch(() => undefined);
  const customFields = boot ? customFieldCatalog(boot, input) : [];
  if (/^\d+$/.test(input)) {
    const id = Number(input);
    return customFields.find((field) => field.id === id) ?? { id, input };
  }
  if (!boot) {
    throw new CliError(`Could not resolve custom field "${input}" without live Front metadata. Run frontctl resources list custom-fields --json and use a numeric id.`, 69);
  }
  const normalizedInput = normalizeLookup(input);
  const matches = customFields.filter((field) => normalizeLookup(field.name) === normalizedInput);
  if (matches.length === 1) {
    return { ...matches[0], input };
  }
  if (matches.length > 1) {
    throw new CliError(`Custom field name is ambiguous: ${input}. Use the numeric field id.`, 64);
  }
  throw new CliError(`Could not resolve custom field "${input}". Run frontctl resources list custom-fields --json and use a listed id or exact name.`, 69);
}

function customFieldCatalog(boot: Record<string, unknown>, input: string): CustomFieldResolution[] {
  const customFields: CustomFieldResolution[] = [];
  for (const rawField of Array.isArray(boot.custom_fields) ? boot.custom_fields : []) {
    if (!isObject(rawField)) {
      continue;
    }
    const id = numberField(rawField.id);
    if (id === undefined) {
      continue;
    }
    customFields.push({
      id,
      input,
      name: stringField(rawField.name),
      type: stringField(rawField.type),
      resourceType: stringField(rawField.resource_type),
    });
  }
  return customFields;
}

function normalizeCustomFieldValue(field: CustomFieldResolution, rawValue: string) {
  if (field.type !== "boolean") {
    return rawValue;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) {
    return "true";
  }
  if (["false", "no", "0", "off"].includes(normalized)) {
    return "false";
  }
  throw new CliError("Boolean custom fields require true/false, yes/no, 1/0, or on/off.", 64);
}

function normalizeLookup(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function parseSnoozeUntil(input: string) {
  const value = input.trim();
  if (!value) {
    throw new CliError("Missing snooze time", 64);
  }
  const now = currentDate();
  const direct = new Date(value);
  if (Number.isFinite(direct.getTime())) {
    return futureSnooze(input, direct, "date");
  }

  const relative = value.match(/^(?:in:|\+)(\d+)(m|h|d)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
    return futureSnooze(input, new Date(now.getTime() + amount * multiplier), "relative");
  }

  if (/^later$/i.test(value)) {
    return futureSnooze(input, new Date(now.getTime() + 2 * 60 * 60_000), "shortcut");
  }
  if (/^tomorrow$/i.test(value)) {
    return futureSnooze(input, atLocalTime(addLocalDays(now, 1), 9, 0), "shortcut");
  }

  const dayTime = value.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:[-@_ ](.+))?$/i);
  if (dayTime) {
    const day = dayTime[1].toLowerCase();
    const time = parseClock(dayTime[2] ?? "9am");
    const base = day === "today"
      ? new Date(now)
      : day === "tomorrow"
        ? addLocalDays(now, 1)
        : addLocalDays(now, daysUntilWeekday(now, day));
    return futureSnooze(input, atLocalTime(base, time.hours, time.minutes), "day-time");
  }

  throw new CliError(
    "Unsupported snooze time. Use ISO, in:2h, in:30m, later, tomorrow, tomorrow-9am, or monday-9am.",
    64,
  );
}

function futureSnooze(input: string, date: Date, parser: string) {
  if (!Number.isFinite(date.getTime())) {
    throw new CliError(`Invalid snooze time: ${input}`, 64);
  }
  if (date.getTime() <= currentDate().getTime()) {
    throw new CliError(`Snooze time must be in the future: ${input}`, 64);
  }
  return {
    iso: date.toISOString(),
    epochMs: date.getTime(),
    parser,
  };
}

function currentDate() {
  const override = process.env.FRONTCTL_NOW;
  if (override) {
    const date = new Date(override);
    if (!Number.isFinite(date.getTime())) {
      throw new CliError("FRONTCTL_NOW must be a valid date when set.", 64);
    }
    return date;
  }
  return new Date();
}

function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function atLocalTime(date: Date, hours: number, minutes: number) {
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function daysUntilWeekday(date: Date, weekday: string) {
  const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday);
  if (target < 0) {
    throw new CliError(`Unsupported weekday: ${weekday}`, 64);
  }
  const delta = (target - date.getDay() + 7) % 7;
  return delta === 0 ? 7 : delta;
}

function parseClock(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    throw new CliError(`Invalid snooze time of day: ${value}`, 64);
  }
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (minutes < 0 || minutes > 59) {
    throw new CliError(`Invalid snooze minutes: ${value}`, 64);
  }
  if (meridiem) {
    if (hours < 1 || hours > 12) {
      throw new CliError(`Invalid snooze hour: ${value}`, 64);
    }
    if (meridiem === "am") {
      hours = hours === 12 ? 0 : hours;
    } else {
      hours = hours === 12 ? 12 : hours + 12;
    }
  } else if (hours < 0 || hours > 23) {
    throw new CliError(`Invalid snooze hour: ${value}`, 64);
  }
  return { hours, minutes };
}

async function getRoutes(paths: FrontPaths): Promise<FrontRoutes> {
  const context = await discoverFrontRouteContext(paths.cacheDataPath);
  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun.", 69);
  }
  return buildFrontRoutes(context);
}

async function resolveTagArgument(input: string, args: string[], paths: FrontPaths) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return {
      input,
      resolvedAlias: trimmed,
      matchedBy: "id" as const,
      tag: { id: trimmed },
    };
  }
  const tags = await tagCatalog(args, paths);
  try {
    return resolveTagIdentifier(input, tags);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 64);
  }
}

async function tagCatalog(args: string[], paths: FrontPaths): Promise<FrontTag[]> {
  if (args.includes("--live")) {
    return extractTags(await getBoot(paths));
  }
  return (await listCachedTags(paths.cacheDataPath, 500)).tags;
}
