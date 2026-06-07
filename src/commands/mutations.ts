import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { auditMutation, type MutationActor } from "../lib/audit.js";
import { CliError } from "../lib/cli.js";
import { listCachedDrafts, readCachedDraft } from "../lib/draftCache.js";
import { createFrontPrivateClient, getBoot } from "../lib/frontPrivate.js";
import { buildFrontRoutes, discoverFrontRouteContext, type FrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { extractTags, listCachedTags, resolveTagIdentifier, type FrontTag } from "../lib/tags.js";
import { verifyWriteFixture, type WriteVerification } from "../lib/writeVerification.js";

type MutationMode = "dry-run" | "execute";

interface MutationSpec {
  action: string;
  conversationId?: string;
  actor?: MutationActor;
  reason?: string;
  method?: string;
  url?: string;
  body?: unknown;
  details?: unknown;
  canExecute: boolean;
  verification?: WriteVerification;
  note?: string;
  execute?: (client: Awaited<ReturnType<typeof createFrontPrivateClient>>) => Promise<unknown>;
}

export async function archiveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const ids = positional(args);
  if (!ids.length) {
    throw new CliError("Missing conversation id", 64);
  }
  if (ids.length > 1) {
    throw new CliError("Batch archive is not enabled for this private route. Archive one conversation at a time.", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation(args, await verifiedSpec({
    action: "archive",
    conversationId: ids[0],
    method: "PATCH",
    url: routes.conversations,
    body: conversationPatchBody(ids[0], { status: "archived" }),
    details: {
      status: "archived",
    },
    canExecute: false,
  }), paths);
}

export async function unarchiveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation(args, await verifiedSpec({
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
  }), paths);
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
  if (!operation || !["add", "remove"].includes(operation)) {
    throw new CliError("Usage: frontctl tag list [--live] [--limit 100] | tag add|remove CONVERSATION_ID TAG", 64);
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
  return runMutation(args, { ...spec, canExecute: spec.canExecute && resolvedTagId !== undefined }, paths);
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
    return runMutation(args, spec, paths);
  }

  const body = await readBodyArg(args);
  if (!body) {
    throw new CliError("Missing comment body. Use --body \"...\" or --body-file path", 64);
  }
  const routes = await getRoutes(paths);
  const commentUid = randomBytes(16).toString("hex");
  const saveBody = commentSaveBody(body);
  const publishBody = commentPublishBody(commentUid);
  return runMutation(args, await verifiedSpec({
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
  }), paths);
}

export async function snoozeConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id, until] = positional(args);
  if (!id || !until) {
    throw new CliError("Usage: frontctl snooze CONVERSATION_ID UNTIL", 64);
  }
  const routes = await getRoutes(paths);
  const snoozeUntil = parseSnoozeUntil(until);
  return runMutation(args, await verifiedSpec({
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
  }), paths);
}

export async function unsnoozeConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [id] = positional(args);
  if (!id) {
    throw new CliError("Usage: frontctl unsnooze CONVERSATION_ID", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation(args, await verifiedSpec({
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
  }), paths);
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
    return runMutation(args, messageUid ? await verifiedSpec(spec) : spec, paths);
  }
  if (!["reply", "compose"].includes(operation ?? "")) {
    throw new CliError("Usage: frontctl draft list|read|discard|reply|compose ...", 64);
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
    return runMutation(args, await verifiedSpec({
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
    }), paths);
  }
  const draftBody = composeDraftBody(args, body);
  return runMutation(args, {
    action: "draft.compose",
    body: draftBody,
    details: {
      note: "Standalone compose route is not live-verified in this Front build. Use draft reply for conversation replies; do not execute compose until browser discovery captures the real route.",
    },
    canExecute: false,
    note: "Standalone draft compose is preview-only until its private Front route is observed and implemented. Send remains blocked.",
  }, paths);
}

async function runMutation(args: string[], spec: MutationSpec, _paths: FrontPaths) {
  const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
  const path = spec.url ? new URL(spec.url).pathname : undefined;
  const actor = actorFromArgs(args);
  const reason = readStringFlag(args, "--reason");
  const identifiedSpec = {
    ...spec,
    actor,
    reason,
  };
  await auditMutation({
    action: identifiedSpec.action,
    mode,
    conversationId: identifiedSpec.conversationId,
    actor,
    reason,
    method: identifiedSpec.method,
    path,
    body: identifiedSpec.body,
  });

  if (mode === "dry-run") {
    return preview(identifiedSpec, mode);
  }

  if (!identifiedSpec.canExecute) {
    throw new CliError(identifiedSpec.note ?? `${identifiedSpec.action} execution is not enabled yet.`, 69);
  }

  if (!identifiedSpec.url || !identifiedSpec.method) {
    throw new CliError(`Missing route for ${identifiedSpec.action}`, 69);
  }

  const client = await createFrontPrivateClient(_paths);
  const result = identifiedSpec.execute
    ? await identifiedSpec.execute(client)
    : await client.requestJson(identifiedSpec.url, { method: identifiedSpec.method, body: identifiedSpec.body });
  return {
    ...preview(identifiedSpec, mode),
    result: summarizeMutationResult(result),
  };
}

function preview(spec: MutationSpec, mode: MutationMode) {
  return {
    source: "live-private",
    publicApiUsed: false,
    sendsEmail: false,
    mode,
    action: spec.action,
    actor: spec.actor,
    reason: spec.reason,
    identity: {
      frontVisibleComment: false,
      note: "Action identity is recorded in frontctl preview/audit metadata. No Front comment is added automatically, so archive/snooze state is not disturbed.",
    },
    canExecute: spec.canExecute,
    verification: spec.verification,
    conversationId: spec.conversationId,
    request: {
      method: spec.method,
      path: spec.url ? new URL(spec.url).pathname : undefined,
      body: spec.body,
    },
    details: spec.details,
    note: noteFor(spec, mode),
  };
}

function actorFromArgs(args: string[]): MutationActor {
  return {
    name: readStringFlag(args, "--actor") ?? readStringFlag(args, "--agent-name") ?? process.env.FRONTCTL_ACTOR_NAME ?? "frontctl agent",
    client: readStringFlag(args, "--client") ?? process.env.FRONTCTL_ACTOR_CLIENT,
    runId: readStringFlag(args, "--run-id") ?? process.env.FRONTCTL_RUN_ID,
  };
}

function noteFor(spec: MutationSpec, mode: MutationMode) {
  const notes = [spec.note, spec.verification?.reason].filter(Boolean);
  if (notes.length) {
    return notes.join(" ");
  }
  return mode === "dry-run" ? "Dry run only. Re-run with --yes to execute." : undefined;
}

function summarizeMutationResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const raw = result as Record<string, unknown>;
  const summary: Record<string, unknown> = { ok: true };
  copyIfPresent(summary, raw, "id");
  copyIfPresent(summary, raw, "status");
  copyIfPresent(summary, raw, "subject");
  copyIfPresent(summary, raw, "uid");
  copyIfPresent(summary, raw, "messageUid");
  copyIfPresent(summary, raw, "commentUid");
  copyIfPresent(summary, raw, "activityId");
  copyIfPresent(summary, raw, "discardCommand");
  if (typeof raw.updated_at === "number") {
    summary.updatedAt = new Date(raw.updated_at).toISOString();
  } else {
    copyIfPresent(summary, raw, "updatedAt");
  }
  return summary;
}

function copyIfPresent(target: Record<string, unknown>, source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (["string", "number", "boolean"].includes(typeof value)) {
    target[key] = value;
  }
}

async function verifiedSpec(spec: MutationSpec): Promise<MutationSpec> {
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
    if (["--body", "--body-file", "--limit", "--actor", "--agent-name", "--client", "--run-id", "--reason"].includes(arg)) {
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

function composeDraftBody(args: string[], body: string) {
  const draft: Record<string, unknown> = { body, draft: true, kind: "compose" };
  const to = readStringListFlag(args, "--to");
  const cc = readStringListFlag(args, "--cc");
  const bcc = readStringListFlag(args, "--bcc");
  const subject = readStringFlag(args, "--subject");
  if (to.length) {
    draft.to = to;
  }
  if (cc.length) {
    draft.cc = cc;
  }
  if (bcc.length) {
    draft.bcc = bcc;
  }
  if (subject !== undefined) {
    draft.subject = subject;
  }
  return draft;
}

async function buildReplyDraftBody(conversationId: string, body: string, paths: FrontPaths) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const [boot, conversation, timelineResponse] = await Promise.all([
    client.getJson<Record<string, unknown>>(routes.boot),
    client.getJson<Record<string, unknown>>(routes.conversation(conversationId)),
    client.getJson<Record<string, unknown>>(routes.timeline(conversationId)),
  ]);
  const timeline = Array.isArray(timelineResponse.timeline) ? timelineResponse.timeline : timelineResponse;
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

function commentSaveBody(text: string) {
  return {
    text,
    attachments: [],
    referenced_activity_id: null,
    annotation: null,
  };
}

function commentPublishBody(commentUid: string) {
  return {
    type: "comment",
    comment: { uid: commentUid },
    meta: { trackers: [] },
  };
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

function findCommentActivityId(result: unknown, commentUid: string) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const activities = (result as Record<string, unknown>).activities;
  if (!Array.isArray(activities)) {
    return undefined;
  }
  const activity = (activities as Array<Record<string, unknown>>).find((item) => {
    const comment = item.comment as Record<string, unknown> | undefined;
    return String(comment?.uid ?? item.comment_uid ?? "") === commentUid;
  });
  return activity?.id;
}

function frontNumericId(id: string) {
  return /^\d+$/.test(id) ? Number(id) : id;
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
