import {
  commentPublishBodySchema,
  commentSaveBodySchema,
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
