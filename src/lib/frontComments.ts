import {
  commentPublishBodySchema,
  commentSaveBodySchema,
  internalTaskCommentSaveBodySchema,
} from "./schemas.js";

export function commentSaveBody(text: string) {
  return commentSaveBodySchema.parse({
    text,
    attachments: [],
    referenced_activity_id: null,
    annotation: null,
  });
}

export function commentPublishBody(commentUid: string) {
  return commentPublishBodySchema.parse({
    type: "comment",
    comment: { uid: commentUid },
    meta: { trackers: [] },
  });
}

export function internalTaskCommentSaveBody(text: string, originalConversationId?: string) {
  return internalTaskCommentSaveBodySchema.parse({
    linked_conversation_type: "internal_task",
    text,
    attachments: [],
    ...(originalConversationId ? { original_linked_conversation_id: originalConversationId } : {}),
  });
}

export function internalTaskCommentPublishBody(commentUid: string, options: {
  subject: string;
  inboxId?: string | number;
  assigneeId?: string | number;
}) {
  return {
    type: "comment",
    comment: { uid: commentUid },
    meta: {
      ...(options.inboxId !== undefined ? { inbox_id: options.inboxId } : {}),
      ...(options.assigneeId !== undefined ? { assignee_id: options.assigneeId } : {}),
      subject: options.subject,
      trackers: [],
    },
  };
}

export function findCommentActivityId(result: unknown, commentUid: string) {
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

export function findSavedComment(result: unknown, commentUid: string): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const raw = result as Record<string, unknown>;
  if (String(raw.uid ?? "") === commentUid) {
    return raw;
  }
  const comments = (result as Record<string, unknown>).comments;
  if (!Array.isArray(comments)) {
    return undefined;
  }
  return (comments as Array<Record<string, unknown>>).find((comment) => String(comment.uid ?? "") === commentUid);
}
