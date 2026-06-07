import { randomBytes } from "node:crypto";
import { CliError } from "./cli.js";
import { commentPublishBody, commentSaveBody, findCommentActivityId } from "./frontComments.js";
import { buildFrontRoutes } from "./frontRoutes.js";
import type { AgentIdentityComment, FrontPrivateClient, IdentifiedMutationSpec, MutationMode } from "./mutationTypes.js";

export async function addAgentIdentityComment(
  client: FrontPrivateClient,
  spec: IdentifiedMutationSpec,
): Promise<AgentIdentityComment> {
  if (!spec.conversationId) {
    throw new CliError(`Cannot write agent identity comment without a conversation id for ${spec.action}`, 69);
  }
  const routes = buildFrontRoutes(client.context);
  const commentUid = randomBytes(16).toString("hex");
  const body = agentIdentityCommentBody(spec);
  await client.requestJson(`${routes.comment(spec.conversationId, commentUid)}?include_conversation=true`, {
    method: "PUT",
    body: commentSaveBody(body),
  });
  const result = await client.requestJson<Record<string, unknown>>(routes.timeline(spec.conversationId), {
    method: "POST",
    body: commentPublishBody(commentUid),
  });
  return {
    commentUid,
    activityId: findCommentActivityId(result, commentUid) ?? result.id,
    body,
  };
}

export function shouldWriteAgentIdentityComment(spec: IdentifiedMutationSpec) {
  return Boolean(
    spec.conversationId
      && spec.canExecute
      && spec.method
      && spec.url
      && spec.action !== "comment.add",
  );
}

export function identitySummary(
  spec: IdentifiedMutationSpec,
  mode: MutationMode,
  agentComment?: AgentIdentityComment,
) {
  if (spec.action === "comment.add") {
    return {
      frontVisibleComment: true,
      timing: "command-comment",
      enforcedByCli: true,
      note: "This command itself creates the visible Front comment. No extra identity comment is added.",
    };
  }
  if (shouldWriteAgentIdentityComment(spec)) {
    return {
      frontVisibleComment: true,
      timing: "before-action",
      enforcedByCli: true,
      requiredBeforeAction: mode === "execute",
      note: mode === "execute"
        ? "frontctl wrote the visible agent identity comment before applying the requested action."
        : "frontctl will write a visible agent identity comment before applying this action.",
      comment: agentComment
        ? {
          commentUid: agentComment.commentUid,
          activityId: agentComment.activityId,
        }
        : undefined,
    };
  }
  return {
    frontVisibleComment: false,
    timing: "none",
    enforcedByCli: false,
    note: spec.canExecute
      ? "No visible Front identity comment is required for this command."
      : "Execution is blocked, so no Front identity comment will be written.",
  };
}

function agentIdentityCommentBody(spec: IdentifiedMutationSpec) {
  const lines = [
    "frontctl agent action",
    `Actor: ${spec.actor.name}`,
    spec.actor.client ? `Client: ${spec.actor.client}` : undefined,
    spec.actor.runId ? `Run ID: ${spec.actor.runId}` : undefined,
    `Action: ${spec.action}`,
    spec.reason ? `Reason: ${spec.reason}` : "Reason: not provided",
    "Note: this comment was written before the requested action so the action can set the final thread state.",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
