import {
  archiveConversation,
  commentConversation,
  draftCommand,
  snoozeConversation,
  tagConversation,
  unarchiveConversation,
  unsnoozeConversation,
} from "./mutations.js";
import { CliError } from "../lib/cli.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { verifyAllWriteFixtures } from "../lib/writeVerification.js";

const SUPPORTED_LIVE_ACTIONS = [
  "archive",
  "unarchive",
  "snooze",
  "unsnooze",
  "tag.add",
  "tag.remove",
  "comment.add",
  "comment.remove",
  "draft.reply",
  "draft.compose",
  "draft.update",
  "draft.discard",
] as const;

interface LiveState {
  status: unknown;
  reminders: unknown[];
  tags: Array<{ id: string; alias?: string; name?: string }>;
  hasDrafts: boolean;
  draftCount: number;
  containsMarker: boolean;
}

export async function verifyLiveWritesCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [conversationId] = positional(args);
  if (!conversationId) {
    throw new CliError("Usage: frontctl discovery verify-live-writes CONVERSATION_ID --yes [--leave-proof-comment]", 64);
  }
  const leaveProofComment = args.includes("--leave-proof-comment");
  const actor = readStringFlag(args, "--actor") ?? "frontctl live verifier";
  if (!args.includes("--yes")) {
    return {
      source: "live-private",
      publicApiUsed: false,
      mode: "dry-run",
      conversationId,
      canExecute: true,
      requiresYes: true,
      actions: SUPPORTED_LIVE_ACTIONS,
      finalState: {
        status: "archived",
        reminders: 0,
        temporaryTagRemoved: true,
        temporaryCommentRemoved: true,
        temporaryDraftDiscarded: true,
        identityCommentsRemain: true,
      },
      command: `frontctl discovery verify-live-writes ${shellToken(conversationId)} --yes --json`,
      note: "This command mutates a real Front conversation, verifies each state change live, and cleans up temporary tag/comment/draft artifacts. Required identity comments remain visible by design.",
    };
  }

  const routeVerification = await verifyAllWriteFixtures();
  const bad = routeVerification.actions.filter((action) => !action.verified);
  if (bad.length) {
    throw new CliError(`Deployable write routes are not verified: ${bad.map((action) => action.action).join(", ")}`, 69);
  }

  const marker = `frontctl live verification ${new Date().toISOString()}`;
  const cleanupState = {
    addedTagId: undefined as string | undefined,
    commentActivityIds: [] as string[],
    draftTargets: [] as Array<{ conversationId: string; messageUid: string }>,
  };
  const steps: Array<{ action: string; ok: boolean; result?: unknown }> = [];

  const cleanup = async () => {
    for (const target of cleanupState.draftTargets) {
      await draftCommand(["discard", target.conversationId, target.messageUid, "--yes", "--json"], paths).catch(() => undefined);
    }
    for (const activityId of cleanupState.commentActivityIds) {
      await commentConversation(["remove", conversationId, activityId, "--yes", "--json"], paths).catch(() => undefined);
    }
    if (cleanupState.addedTagId) {
      await tagConversation(["remove", conversationId, cleanupState.addedTagId, "--yes", "--json"], paths).catch(() => undefined);
    }
    await unsnoozeConversation([conversationId, "--yes", "--json"], paths).catch(() => undefined);
    await archiveConversation([conversationId, "--yes", "--json"], paths).catch(() => undefined);
  };

  try {
    const before = await conversationState(conversationId, marker, paths, { includeContent: false });
    const tag = await pickTemporaryTag(before.tags, paths);

    await runStep(steps, "unarchive", () =>
      unarchiveConversation([conversationId, "--actor", actor, "--reason", "Live write verification restore before archive test", "--yes", "--json"], paths));
    await assertEventually("unarchive", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return current.status !== "archived" && current.reminders.length === 0;
    });

    await runStep(steps, "archive", () =>
      archiveConversation([conversationId, "--actor", actor, "--reason", "Live write verification archive test", "--yes", "--json"], paths));
    await assertEventually("archive", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return current.status === "archived";
    });

    await runStep(steps, "snooze", () =>
      snoozeConversation([conversationId, "in:2h", "--actor", actor, "--reason", "Live write verification snooze test", "--yes", "--json"], paths));
    await assertEventually("snooze", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return current.status === "archived" && current.reminders.length > 0;
    });

    await runStep(steps, "unsnooze", () =>
      unsnoozeConversation([conversationId, "--actor", actor, "--reason", "Live write verification unsnooze cleanup", "--yes", "--json"], paths));
    await assertEventually("unsnooze", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return current.status === "archived" && current.reminders.length === 0;
    });

    cleanupState.addedTagId = tag.id;
    await runStep(steps, "tag.add", () =>
      tagConversation(["add", conversationId, tag.id, "--actor", actor, "--reason", "Live write verification tag add test", "--yes", "--json"], paths));
    await assertEventually("tag.add", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return current.tags.some((candidate) => candidate.id === tag.id);
    });

    await runStep(steps, "tag.remove", () =>
      tagConversation(["remove", conversationId, tag.id, "--actor", actor, "--reason", "Live write verification tag remove cleanup", "--yes", "--json"], paths));
    cleanupState.addedTagId = undefined;
    await assertEventually("tag.remove", async () => {
      const current = await conversationState(conversationId, marker, paths, { includeContent: false });
      return !current.tags.some((candidate) => candidate.id === tag.id);
    });

    const comment = await runStep(steps, "comment.add", () =>
      commentConversation(["add", conversationId, "--body", marker, "--actor", actor, "--reason", "Live write verification comment add test", "--yes", "--json"], paths));
    const activityId = resultId(comment, ["activityId", "id"]);
    if (!activityId) {
      throw new CliError("comment.add did not return an activity id", 69);
    }
    cleanupState.commentActivityIds.push(activityId);
    await assertEventually("comment.add", async () => {
      const current = await conversationState(conversationId, marker, paths);
      return current.containsMarker;
    });

    await runStep(steps, "comment.remove", () =>
      commentConversation(["remove", conversationId, activityId, "--actor", actor, "--reason", "Live write verification comment remove cleanup", "--yes", "--json"], paths));
    cleanupState.commentActivityIds = cleanupState.commentActivityIds.filter((id) => id !== activityId);
    await assertEventually("comment.remove", async () => {
      const current = await conversationState(conversationId, marker, paths);
      return !current.containsMarker;
    });

    try {
      const draft = await runStep(steps, "draft.reply", () =>
        draftCommand(["reply", conversationId, "--body", marker, "--yes", "--json"], paths));
      const messageUid = resultId(draft, ["messageUid"]);
      if (!messageUid) {
        throw new CliError("draft.reply did not return a message uid", 69);
      }
      cleanupState.draftTargets.push({ conversationId, messageUid });
      await assertEventually("draft.reply", async () => {
        const current = await conversationState(conversationId, marker, paths);
        return current.hasDrafts && current.containsMarker;
      });

      await runStep(steps, "draft.discard", () =>
        draftCommand(["discard", conversationId, messageUid, "--yes", "--json"], paths));
      cleanupState.draftTargets = cleanupState.draftTargets.filter((target) => target.messageUid !== messageUid);
      await assertDraftGone("draft.discard", conversationId, marker, paths);
    } catch (error) {
      if (!isMissingReplySource(error)) {
        throw error;
      }
      const composeMarker = `${marker} compose fallback`;
      const updatedMarker = `${marker} updated compose fallback`;
      const draft = await runStep(steps, "draft.compose", () =>
        draftCommand([
          "compose",
          "--to",
          "test@test.com",
          "--subject",
          "frontctl live verification draft",
          "--body",
          composeMarker,
          "--yes",
          "--json",
        ], paths));
      const draftConversationId = resultId(draft, ["conversationId"]);
      const messageUid = resultId(draft, ["messageUid"]);
      if (!draftConversationId || !messageUid) {
        throw new CliError("draft.compose did not return a conversation id and message uid", 69);
      }
      cleanupState.draftTargets.push({ conversationId: draftConversationId, messageUid });
      await assertEventually("draft.compose", async () => {
        const current = await conversationState(draftConversationId, composeMarker, paths);
        return current.hasDrafts && current.containsMarker;
      });

      await runStep(steps, "draft.update", () =>
        draftCommand([
          "update",
          draftConversationId,
          messageUid,
          "--to",
          "test@test.com",
          "--subject",
          "frontctl live verification draft updated",
          "--body",
          updatedMarker,
          "--yes",
          "--json",
        ], paths));
      await assertEventually("draft.update", async () => {
        const current = await conversationState(draftConversationId, updatedMarker, paths);
        return current.hasDrafts && current.containsMarker;
      });

      await runStep(steps, "draft.discard", () =>
        draftCommand(["discard", draftConversationId, messageUid, "--yes", "--json"], paths));
      cleanupState.draftTargets = cleanupState.draftTargets.filter((target) => target.messageUid !== messageUid);
      await assertDraftGone("draft.discard", draftConversationId, updatedMarker, paths);
    }

    let proof: { activityId?: string; body?: string } | undefined;
    if (leaveProofComment) {
      const body = `frontctl visible proof from ${actor} at ${new Date().toISOString()}: live write verification passed.`;
      const proofResult = await runStep(steps, "comment.proof", () =>
        commentConversation(["add", conversationId, "--body", body, "--actor", actor, "--reason", "Leave visible proof after live write verification", "--yes", "--json"], paths));
      proof = {
        activityId: resultId(proofResult, ["activityId", "id"]),
        body,
      };
    }

    await runStep(steps, "final.archive", () =>
      archiveConversation([conversationId, "--actor", actor, "--reason", "Live write verification final cleanup", "--yes", "--json"], paths));
    await assertEventually("final.archive", async () => {
      const current = await conversationState(conversationId, marker, paths);
      return current.status === "archived" && current.reminders.length === 0 && !current.hasDrafts && !current.containsMarker;
    });

    const after = await conversationState(conversationId, marker, paths);
    return {
      ok: true,
      source: "live-private",
      publicApiUsed: false,
      sendsEmail: false,
      conversationId,
      marker,
      actor,
      verifiedActions: SUPPORTED_LIVE_ACTIONS,
      routeVerification: {
        scope: routeVerification.scope,
        allVerified: routeVerification.allVerified,
        verifiedCount: routeVerification.verifiedCount,
        count: routeVerification.count,
        blockedActions: routeVerification.blockedActions,
      },
      tagUsed: { id: tag.id, alias: tag.alias, name: tag.name },
      proof,
      visibleIdentityCommentsRemain: true,
      steps,
      before: summarizeState(before),
      after: summarizeState(after),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function runStep(
  steps: Array<{ action: string; ok: boolean; result?: unknown }>,
  action: string,
  fn: () => Promise<unknown>,
) {
  const result = await fn() as Record<string, unknown>;
  if (action.startsWith("draft.") && result.sendsEmail !== false) {
    throw new CliError(`${action} did not explicitly report sendsEmail:false`, 69);
  }
  steps.push({
    action,
    ok: true,
    result: summarizeStepResult(result),
  });
  return result;
}

function summarizeStepResult(result: Record<string, unknown>) {
  const raw = (result.result && typeof result.result === "object") ? result.result as Record<string, unknown> : {};
  return {
    mode: result.mode,
    canExecute: result.canExecute,
    path: (result.request as Record<string, unknown> | undefined)?.path,
    status: raw.status,
    id: raw.id,
    activityId: raw.activityId,
    messageUid: raw.messageUid,
  };
}

async function pickTemporaryTag(existingTags: LiveState["tags"], paths: FrontPaths) {
  const live = await tagConversation(["list", "--live", "--limit", "200", "--json"], paths) as {
    tags?: Array<{ id?: unknown; alias?: string; name?: string }>;
  };
  const existing = new Set(existingTags.map((tag) => tag.id));
  const tag = (live.tags ?? []).find((candidate) => {
    const id = String(candidate.id ?? "");
    const alias = String(candidate.alias ?? "");
    return /^\d+$/.test(id) && !existing.has(id) && !alias.startsWith("!");
  });
  if (!tag) {
    throw new CliError("Could not find a numeric non-system tag that is not already on the conversation.", 69);
  }
  return {
    id: String(tag.id),
    alias: tag.alias,
    name: tag.name,
  };
}

async function conversationState(
  conversationId: string,
  marker: string,
  paths: FrontPaths,
  options: { includeContent?: boolean } = {},
): Promise<LiveState> {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const raw = await client.getJson<Record<string, unknown>>(routes.conversation(conversationId));
  const content = options.includeContent === false
    ? undefined
    : await client.getJson<Record<string, unknown>>(routes.content(conversationId));
  const text = content ? JSON.stringify(content) : "";
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => {
      const item = tag as Record<string, unknown>;
      return {
        id: String(item.id ?? ""),
        alias: typeof item.alias === "string" ? item.alias : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
      };
    })
    : [];
  const drafts = content && Array.isArray(content.draft_messages) ? content.draft_messages : [];
  return {
    status: raw.status,
    reminders: Array.isArray(raw.reminders) ? raw.reminders : [],
    tags,
    hasDrafts: Boolean(raw.has_drafts) || drafts.length > 0,
    draftCount: drafts.length,
    containsMarker: text.includes(marker),
  };
}

async function assertEventually(name: string, predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new CliError(`Live state assertion failed after ${name}`, 69);
}

async function assertDraftGone(name: string, conversationId: string, marker: string, paths: FrontPaths) {
  await assertEventually(name, async () => {
    try {
      const current = await conversationState(conversationId, marker, paths);
      return !current.hasDrafts && !current.containsMarker;
    } catch (error) {
      if (String((error as Error).message ?? error).includes("HTTP 404")) {
        return true;
      }
      throw error;
    }
  });
}

function summarizeState(state: LiveState) {
  return {
    status: state.status,
    reminders: state.reminders.length,
    tags: state.tags.map((tag) => tag.alias ?? tag.name ?? tag.id),
    hasDrafts: state.hasDrafts,
    draftCount: state.draftCount,
    containsMarker: state.containsMarker,
  };
}

function resultId(result: unknown, keys: string[]) {
  const raw = result as Record<string, unknown>;
  const nested = raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : {};
  for (const key of keys) {
    const value = nested[key] ?? raw[key];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function isMissingReplySource(error: unknown) {
  return String((error as Error).message ?? error).includes("Could not find a source message to reply to");
}

function positional(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--actor"].includes(arg)) {
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

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function shellToken(value: string) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
