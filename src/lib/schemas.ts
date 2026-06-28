import { z } from "zod";

const nonEmptyString = z.string().min(1);
const optionalString = z.string().optional();
const frontId = z.union([z.string().min(1), z.number().finite()]);
const jsonRecord = z.record(z.string(), z.unknown());

const isoDateString = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "Expected ISO-compatible date string",
});

export const frontRouteContextSchema = z.object({
  origin: z.string().url(),
  cell: z.string().regex(/^cell-[^/]+$/),
  companyId: z.string().min(1),
  teamId: z.string().min(1),
}).strict();

export const frontSessionFileSchema = z.object({
  version: z.literal(1),
  encryption: z.object({
    mode: z.literal("local-derived-v1"),
    keychainBackedSessionKey: z.literal(false),
  }).optional(),
  host: nonEmptyString,
  source: optionalString,
  keychainServiceUsedForUnlock: optionalString,
  cookieNames: z.array(nonEmptyString),
  createdAt: isoDateString,
  expiresAt: isoDateString,
  nonce: nonEmptyString,
  tag: nonEmptyString,
  ciphertext: nonEmptyString,
}).strict();

export const frontSessionPayloadSchema = z.object({
  cookieHeader: nonEmptyString,
  csrfToken: optionalString,
}).strict();

export const cookieSecretRowSchema = z.object({
  host_key: nonEmptyString,
  name: nonEmptyString,
  encrypted_value: z.string().regex(/^[a-f0-9]*$/i),
  expires_utc: z.number().finite(),
}).strict();

export const plainFrontCookieRowSchema = z.object({
  host_key: nonEmptyString,
  name: nonEmptyString,
  value: z.string(),
  expires_utc: z.number().finite(),
}).strict();

export const mutationActorSchema = z.object({
  name: nonEmptyString,
  client: optionalString,
  runId: optionalString,
}).strict();

export const mutationAuditEntrySchema = z.object({
  ts: isoDateString.optional(),
  action: optionalString,
  mode: z.enum(["dry-run", "execute"]).optional(),
  phase: z.enum(["attempt", "identity-commented", "completed", "failed"]).optional(),
  conversationId: optionalString,
  actor: mutationActorSchema.optional(),
  reason: optionalString,
  method: optionalString,
  path: optionalString,
  bodyKeys: z.array(z.string()).optional(),
  bodySha256: optionalString,
  identityCommentUid: optionalString,
  identityActivityId: optionalString,
  resultKeys: z.array(z.string()).optional(),
  resultSha256: optionalString,
  errorClass: optionalString,
  errorMessageSha256: optionalString,
}).passthrough();

export const mutationIdentitySchema = z.object({
  frontVisibleComment: z.boolean(),
  timing: z.enum(["before-action", "command-comment", "none"]),
  enforcedByCli: z.boolean(),
  requiredBeforeAction: z.boolean().optional(),
  note: optionalString,
  comment: z.object({
    commentUid: nonEmptyString,
    activityId: z.unknown().optional(),
  }).strict().optional(),
}).strict();

export const mutationPreviewSchema = z.object({
  source: z.literal("live-private"),
  publicApiUsed: z.literal(false),
  sendsEmail: z.literal(false),
  mode: z.enum(["dry-run", "execute"]),
  action: nonEmptyString,
  actor: mutationActorSchema.optional(),
  reason: optionalString,
  identity: mutationIdentitySchema,
  canExecute: z.boolean(),
  verification: z.unknown().optional(),
  conversationId: optionalString,
  request: z.object({
    method: optionalString,
    path: optionalString,
    body: z.unknown().optional(),
  }).strict(),
  details: z.unknown().optional(),
  note: optionalString,
}).strict();

export const mutationExecutionResultSchema = mutationPreviewSchema.extend({
  result: z.unknown().optional(),
}).strict();

export type MutationPreviewResult = z.infer<typeof mutationPreviewSchema>;
export type MutationExecutionResult = z.infer<typeof mutationExecutionResultSchema>;

const conversationPatchItemSchema = z.object({
  id: frontId,
  status: z.enum(["open", "archived", "deleted", "spam"]).optional(),
  assignee_id: z.union([frontId, z.null()]).optional(),
  inbox_id: frontId.optional(),
  reminder: z.union([z.number().finite(), z.null()]).optional(),
  tags: z.object({
    add: z.array(z.number().finite()).optional(),
    remove: z.array(z.number().finite()).optional(),
  }).strict().optional(),
}).strict();

export const conversationPatchBodySchema = z.object({
  conversations: z.array(conversationPatchItemSchema).min(1),
}).strict();

export const commentSaveBodySchema = z.object({
  text: z.string().min(1),
  attachments: z.array(z.unknown()),
  referenced_activity_id: z.null(),
  annotation: z.null(),
}).strict();

export const internalTaskCommentSaveBodySchema = z.object({
  linked_conversation_type: z.literal("internal_task"),
  text: z.string().min(1),
  attachments: z.array(z.unknown()),
  original_linked_conversation_id: frontId.optional(),
}).strict();

export const commentPublishBodySchema = z.object({
  type: z.literal("comment"),
  comment: z.object({
    uid: nonEmptyString,
  }).strict(),
  meta: z.object({
    trackers: z.array(z.unknown()),
  }).strict(),
}).strict();

export const draftReplyBodySchema = z.object({
  in_reply_to_id: frontId,
  referenced_message_id: frontId,
  author_id: z.number().finite(),
  from: z.object({
    channel_id: z.number().finite(),
  }).strict(),
  subject: z.string(),
  recipients: z.array(z.object({
    role: nonEmptyString,
    handle: nonEmptyString,
    name: z.string(),
    source: z.literal("email"),
  }).passthrough()).min(1),
  attachments: z.array(z.unknown()),
  html: z.string(),
  text: z.string(),
  shared_draft: z.boolean(),
  virtru_encrypt: z.boolean(),
  has_quote: z.boolean(),
  quote_include: z.boolean(),
  quote_modified: z.boolean(),
  forward_include: z.boolean(),
  forward_modified: z.boolean(),
  signature_include: z.boolean(),
  signature_modified: z.boolean(),
  main_style: z.string(),
  default_font_style: z.string(),
  format: z.literal("html"),
  handle_time_increment: z.number().finite(),
}).strict();

export const draftComposeBodySchema = z.object({
  author_id: z.number().finite(),
  from: z.object({
    channel_id: z.number().finite(),
  }).strict(),
  subject: z.string(),
  recipients: z.array(z.object({
    role: nonEmptyString,
    handle: nonEmptyString,
    name: z.string(),
    source: z.literal("email"),
  }).passthrough()).min(1),
  attachments: z.array(z.unknown()),
  html: z.string(),
  text: z.string(),
  shared_draft: z.boolean(),
  virtru_encrypt: z.boolean(),
  has_quote: z.boolean(),
  quote_include: z.boolean(),
  quote_modified: z.boolean(),
  forward_include: z.boolean(),
  forward_modified: z.boolean(),
  signature_include: z.boolean(),
  signature_modified: z.boolean(),
  main_style: z.string(),
  default_font_style: z.string(),
  format: z.literal("html"),
  handle_time_increment: z.number().finite(),
}).strict();

export const composeDraftPreviewBodySchema = z.object({
  body: z.string().min(1),
  draft: z.literal(true),
  kind: z.literal("compose"),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
}).strict();

export const frontBootSchema = z.object({
  user: jsonRecord.optional(),
}).passthrough();

export const frontConversationSchema = z.object({
  id: frontId.optional(),
  subject: z.string().optional(),
  status: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
  channels: z.array(z.unknown()).optional(),
  channels_full: z.array(z.unknown()).optional(),
  senders: jsonRecord.optional(),
  contact: jsonRecord.optional(),
  last_message: jsonRecord.optional(),
  last_manual_message: jsonRecord.optional(),
}).passthrough();

export const frontTimelineResponseSchema = z.union([
  z.array(jsonRecord),
  z.object({
    timeline: z.array(jsonRecord).optional(),
  }).passthrough(),
]);

export const sanitizedDiscoveryEntrySchema = z.object({
  method: z.string().optional(),
  path: z.string().optional(),
  routeKind: z.string().optional(),
  requestBodyShape: z.unknown().optional(),
}).passthrough();

export const sanitizedDiscoveryFixtureSchema = z.object({
  redacted: z.literal(true),
  entries: z.array(sanitizedDiscoveryEntrySchema),
}).passthrough();

export const browserProbeRuntimeSchema = z.object({
  ok: z.boolean().optional(),
  httpStatus: z.number().finite().optional(),
  status: z.string().optional(),
  contentType: z.string().nullable().optional(),
  hasSubject: z.boolean().optional(),
  hasMessages: z.boolean().optional(),
  bodyShape: z.unknown().optional(),
}).passthrough();

export type SanitizedDiscoveryEntry = z.infer<typeof sanitizedDiscoveryEntrySchema>;

export function validateMutationPayload(action: string, body: unknown) {
  switch (action) {
    case "archive":
    case "unarchive":
    case "restore":
    case "unsnooze":
    case "snooze":
    case "tag.add":
    case "tag.remove":
    case "assign":
    case "unassign":
    case "move":
      return conversationPatchBodySchema.parse(body).conversations.every((conversation) => allowedConversationStatus(action, conversation.status))
        ? conversationPatchBodySchema.parse(body)
        : (() => { throw new Error(`Invalid conversation status for ${action}`); })();
    case "delete":
      return conversationPatchBodySchema.parse(body).conversations.every((conversation) => conversation.status === "deleted")
        ? conversationPatchBodySchema.parse(body)
        : (() => { throw new Error("Delete payload must set status deleted"); })();
    case "comment.add":
      return commentPublishBodySchema.parse(body);
    case "conversation.create-test":
      return internalTaskCommentSaveBodySchema.parse(body);
    case "draft.reply":
      return draftReplyBodySchema.parse(body);
    case "draft.compose":
      return draftComposeBodySchema.parse(body);
    default:
      return body;
  }
}

function allowedConversationStatus(action: string, status: unknown) {
  if (status === undefined) {
    return true;
  }
  if (action === "archive" || action === "snooze" || action === "unsnooze") {
    return status === "archived";
  }
  if (action === "unarchive" || action === "restore") {
    return status === "open";
  }
  return status === "open" || status === "archived";
}
