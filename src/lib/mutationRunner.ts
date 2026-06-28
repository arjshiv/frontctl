import { auditMutation, type MutationActor } from "./audit.js";
import { addAgentIdentityComment, identitySummary, shouldWriteAgentIdentityComment } from "./agentIdentityComment.js";
import { CliError } from "./cli.js";
import { createFrontPrivateClient } from "./frontPrivate.js";
import {
  mutationExecutionResultSchema,
  mutationPreviewSchema,
} from "./schemas.js";
import type {
  AgentIdentityComment,
  IdentifiedMutationSpec,
  MutationMode,
  MutationSpec,
  RunMutationOptions,
} from "./mutationTypes.js";

export async function runMutation({ args, spec, paths }: RunMutationOptions): Promise<any> {
  const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
  const path = spec.url ? new URL(spec.url).pathname : undefined;
  const actor = actorFromArgs(args);
  const reason = readStringFlag(args, "--reason");
  const identifiedSpec: IdentifiedMutationSpec = {
    ...spec,
    actor,
    reason,
  };
  await auditMutation({
    action: identifiedSpec.action,
    mode,
    phase: "attempt",
    conversationId: identifiedSpec.conversationId,
    actor,
    reason,
    method: identifiedSpec.method,
    path,
    body: identifiedSpec.body,
  });

  if (mode === "dry-run") {
    return mutationPreviewSchema.parse(preview(identifiedSpec, mode));
  }

  if (!identifiedSpec.canExecute) {
    throw new CliError(identifiedSpec.note ?? `${identifiedSpec.action} execution is not enabled yet.`, 69);
  }

  if (!identifiedSpec.url || !identifiedSpec.method) {
    throw new CliError(`Missing route for ${identifiedSpec.action}`, 69);
  }

  const client = await createFrontPrivateClient(paths);
  const agentComment = shouldWriteAgentIdentityComment(identifiedSpec)
    ? await addAgentIdentityComment(client, identifiedSpec)
    : undefined;
  if (agentComment) {
    await auditMutation({
      action: identifiedSpec.action,
      mode,
      phase: "identity-commented",
      conversationId: identifiedSpec.conversationId,
      actor,
      reason,
      method: identifiedSpec.method,
      path,
      identityCommentUid: agentComment.commentUid,
      identityActivityId: agentComment.activityId,
    });
  }

  let result: unknown;
  try {
    result = identifiedSpec.execute
      ? await identifiedSpec.execute(client)
      : await client.requestJson(identifiedSpec.url, { method: identifiedSpec.method, body: identifiedSpec.body });
  } catch (error) {
    await auditMutation({
      action: identifiedSpec.action,
      mode,
      phase: "failed",
      conversationId: identifiedSpec.conversationId,
      actor,
      reason,
      method: identifiedSpec.method,
      path,
      identityCommentUid: agentComment?.commentUid,
      identityActivityId: agentComment?.activityId,
      error,
    });
    throw mutationFailedAfterIdentityComment(error, identifiedSpec, agentComment);
  }

  const summarizedResult = summarizeMutationResult(result);
  await auditMutation({
    action: identifiedSpec.action,
    mode,
    phase: "completed",
    conversationId: identifiedSpec.conversationId,
    actor,
    reason,
    method: identifiedSpec.method,
    path,
    identityCommentUid: agentComment?.commentUid,
    identityActivityId: agentComment?.activityId,
    result: summarizedResult,
  });
  return mutationExecutionResultSchema.parse({
    ...preview(identifiedSpec, mode, agentComment),
    result: summarizedResult,
  });
}

function preview(spec: IdentifiedMutationSpec, mode: MutationMode, agentComment?: AgentIdentityComment) {
  return {
    source: "live-private",
    publicApiUsed: false,
    sendsEmail: false,
    mode,
    action: spec.action,
    actor: spec.actor,
    reason: spec.reason,
    identity: identitySummary(spec, mode, agentComment),
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

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function noteFor(spec: MutationSpec, mode: MutationMode) {
  const notes = [spec.note, spec.verification?.reason].filter(Boolean);
  if (notes.length) {
    return notes.join(" ");
  }
  return mode === "dry-run" ? "Dry run only. Re-run with --yes to execute." : undefined;
}

export function summarizeMutationResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const raw = result as Record<string, unknown>;
  const summary: Record<string, unknown> = { ok: true };
  copyIfPresent(summary, raw, "id");
  copyIfPresent(summary, raw, "status");
  copyIfPresent(summary, raw, "subject");
  copyIfPresent(summary, raw, "uid");
  copyIfPresent(summary, raw, "conversationId");
  copyIfPresent(summary, raw, "sourceConversationId");
  copyIfPresent(summary, raw, "messageUid");
  copyIfPresent(summary, raw, "commentUid");
  copyIfPresent(summary, raw, "activityId");
  copyIfPresent(summary, raw, "discardCommand");
  copyIfPresent(summary, raw, "linkedConversationId");
  copyIfPresent(summary, raw, "removeCommand");
  copyIfPresent(summary, raw, "tagId");
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

function mutationFailedAfterIdentityComment(error: unknown, spec: MutationSpec, agentComment?: AgentIdentityComment) {
  if (!agentComment) {
    return error;
  }
  const cause = error instanceof Error ? error.message : String(error);
  const refs = [
    `commentUid=${agentComment.commentUid}`,
    agentComment.activityId === undefined ? undefined : `activityId=${agentComment.activityId}`,
  ].filter(Boolean).join(" ");
  const message = `Wrote the visible agent identity comment, but ${spec.action} failed before the requested action completed. ${refs}. Cause: ${cause}`;
  return new CliError(message, error instanceof CliError ? error.exitCode : 69);
}
