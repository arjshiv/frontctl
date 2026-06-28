import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sanitizeDiscoveryInput } from "./discovery.js";
import {
  sanitizedDiscoveryEntrySchema,
  sanitizedDiscoveryFixtureSchema,
  validateMutationPayload,
  type SanitizedDiscoveryEntry,
} from "./schemas.js";

export interface WriteVerification {
  verified: boolean;
  action: string;
  expectedRouteKind: string;
  source?: "discovery-fixture" | "known-route";
  fixturePath?: string;
  requestBodyShapeMatched?: boolean;
  reason?: string;
}

export interface WriteCaptureGuide {
  action: string;
  verified: boolean;
  expectedRouteKind: string;
  fixturePath?: string;
  safeFrontAction: string;
  previewCommand: string;
  captureName: string;
  captureCommand: string;
  verifyCommand: string;
  notes: string[];
}

const ACTION_ROUTE_KIND: Record<string, string> = {
  archive: "conversation.update",
  unarchive: "conversation.update",
  delete: "conversation.update",
  restore: "conversation.update",
  "conversation.create-test": "comment.save",
  assign: "conversation.update",
  unassign: "conversation.update",
  move: "conversation.update",
  "follower.add": "conversation.update",
  "follower.remove": "conversation.update",
  "link.add": "conversation.links",
  "link.remove": "conversation.links",
  "custom-field.set": "conversation.custom-fields",
  unsnooze: "conversation.update",
  "tag.add": "conversation.update",
  "tag.remove": "conversation.update",
  "comment.add": "comment.add",
  "comment.remove": "comment.remove",
  snooze: "conversation.update",
  "draft.reply": "message-or-draft",
  "draft.compose": "message-or-draft",
  "draft.discard": "draft.discard",
};

const BUILT_IN_VERIFIED_ACTIONS = new Set([
  "archive",
  "unarchive",
  "delete",
  "restore",
  "unsnooze",
  "snooze",
  "tag.add",
  "tag.remove",
  "comment.add",
  "comment.remove",
  "draft.reply",
  "draft.compose",
  "draft.discard",
  "conversation.create-test",
  "assign",
  "unassign",
  "move",
  "follower.add",
]);

const BLOCKED_PREVIEW_ONLY_ACTIONS = new Set<string>();

const ACTION_CAPTURE_GUIDES: Record<string, Omit<WriteCaptureGuide, "verified" | "expectedRouteKind" | "fixturePath" | "captureCommand" | "verifyCommand">> = {
  archive: {
    action: "archive",
    safeFrontAction: "Archive exactly one low-risk conversation in Front, then optionally unarchive it manually after capture.",
    previewCommand: "frontctl archive CONVERSATION_ID --json",
    captureName: "archive",
    notes: [
      "Use a test or low-risk conversation because archive changes mailbox state.",
      "Capture only one archive action during the capture window.",
    ],
  },
  delete: {
    action: "delete",
    safeFrontAction: "Move exactly one harmless test conversation to Front trash.",
    previewCommand: "frontctl delete CONVERSATION_ID --json",
    captureName: "delete",
    notes: [
      "Use only a dedicated test conversation.",
      "Do not permanently delete anything.",
    ],
  },
  restore: {
    action: "restore",
    safeFrontAction: "Restore one harmless test conversation from Front trash.",
    previewCommand: "frontctl restore CONVERSATION_ID --json",
    captureName: "restore",
    notes: [
      "Use the same test conversation that was intentionally moved to trash.",
      "Capture restore separately from delete.",
    ],
  },
  "conversation.create-test": {
    action: "conversation.create-test",
    safeFrontAction: "Create one harmless internal discussion/test conversation in Front without sending email.",
    previewCommand: "frontctl create-test-conversation --subject \"frontctl test conversation\" --body \"Safe local integration test\" --json",
    captureName: "conversation.create-test",
    notes: [
      "Use an internal discussion or task-style conversation, not an outbound email compose.",
      "Do not click send or capture message finalize/deliver routes.",
      "The private app saves the internal task comment first, then publishes that saved comment to the new conversation timeline.",
      "After capture, use this test conversation for archive, restore, snooze, tag, comment, and draft tests.",
    ],
  },
  assign: {
    action: "assign",
    safeFrontAction: "Assign one harmless test conversation to yourself or another explicitly chosen teammate.",
    previewCommand: "frontctl assign CONVERSATION_ID TEAMMATE_ID --json",
    captureName: "assign",
    notes: [
      "Use only a dedicated test conversation.",
      "Capture assign separately from unassign.",
      "Prefer your own teammate id for live verification.",
    ],
  },
  unassign: {
    action: "unassign",
    safeFrontAction: "Clear the assignee from one harmless test conversation.",
    previewCommand: "frontctl unassign CONVERSATION_ID --json",
    captureName: "unassign",
    notes: [
      "Use the same dedicated test conversation after an assign test.",
      "Capture unassign separately from assign.",
    ],
  },
  move: {
    action: "move",
    safeFrontAction: "Move one harmless test conversation into an explicitly chosen inbox.",
    previewCommand: "frontctl move CONVERSATION_ID INBOX_ID --json",
    captureName: "move",
    notes: [
      "Use only a dedicated test conversation.",
      "Prefer moving to your own personal inbox for live verification.",
    ],
  },
  "follower.add": {
    action: "follower.add",
    safeFrontAction: "Add yourself as a tracker/follower on one harmless test conversation.",
    previewCommand: "frontctl follower add CONVERSATION_ID TEAMMATE_ID --json",
    captureName: "follower.add",
    notes: [
      "Use only a dedicated test conversation.",
      "Prefer your own teammate id to avoid notifying another person.",
      "Follower removal is not deployable until it is separately verified on a safe non-owner tracker.",
    ],
  },
  "custom-field.set": {
    action: "custom-field.set",
    safeFrontAction: "Set one harmless custom field on a dedicated test conversation, then set it back if needed.",
    previewCommand: "frontctl custom-field set CONVERSATION_ID FIELD_ID true --json",
    captureName: "custom-field.set",
    notes: [
      "Use only a dedicated test conversation.",
      "Prefer a low-risk boolean test value such as true/false on an existing custom field.",
      "Do not create or delete workspace-level custom fields during this capture.",
    ],
  },
  unsnooze: {
    action: "unsnooze",
    safeFrontAction: "Clear the reminder from one snoozed low-risk conversation in Front.",
    previewCommand: "frontctl unsnooze CONVERSATION_ID --json",
    captureName: "unsnooze",
    notes: [
      "Use a low-risk conversation that was intentionally snoozed.",
      "Capture only one unsnooze action during the capture window.",
    ],
  },
  unarchive: {
    action: "unarchive",
    safeFrontAction: "Unarchive exactly one low-risk conversation in Front, usually to restore after an archive test.",
    previewCommand: "frontctl unarchive CONVERSATION_ID --json",
    captureName: "unarchive",
    notes: [
      "Use only when restoring a conversation that was intentionally archived.",
      "Capture only one unarchive action during the capture window.",
    ],
  },
  "tag.add": {
    action: "tag.add",
    safeFrontAction: "Apply one harmless test tag to one conversation in Front.",
    previewCommand: "frontctl tag add CONVERSATION_ID TAG_ALIAS --json",
    captureName: "tag.add",
    notes: [
      "Use a dedicated temporary tag when possible.",
      "Capture tag add separately from tag remove.",
    ],
  },
  "tag.remove": {
    action: "tag.remove",
    safeFrontAction: "Remove one harmless test tag from one conversation in Front.",
    previewCommand: "frontctl tag remove CONVERSATION_ID TAG_ALIAS --json",
    captureName: "tag.remove",
    notes: [
      "Apply the tag before capture if the conversation does not already have it.",
      "Capture tag remove separately from tag add.",
    ],
  },
  "comment.add": {
    action: "comment.add",
    safeFrontAction: "Add one private internal comment such as 'frontctl discovery test' to a low-risk conversation.",
    previewCommand: "frontctl comment add CONVERSATION_ID --body \"frontctl discovery test\" --json",
    captureName: "comment.add",
    notes: [
      "Use a private internal comment, not an email reply.",
      "Do not capture message send/finalize/deliver actions.",
    ],
  },
  "comment.remove": {
    action: "comment.remove",
    safeFrontAction: "Delete one private internal test comment activity that was created for verification.",
    previewCommand: "frontctl comment remove CONVERSATION_ID ACTIVITY_OR_COMMENT_UID --json",
    captureName: "comment.remove",
    notes: [
      "Use only a harmless test comment created for verification.",
      "Capture comment removal separately from comment creation.",
    ],
  },
  snooze: {
    action: "snooze",
    safeFrontAction: "Snooze one low-risk conversation to a short future time in Front.",
    previewCommand: "frontctl snooze CONVERSATION_ID tomorrow-9am --json",
    captureName: "snooze",
    notes: [
      "Use a low-risk conversation because snooze changes mailbox state.",
      "Pick a short future snooze time so manual cleanup is easy.",
    ],
  },
  "draft.reply": {
    action: "draft.reply",
    safeFrontAction: "Create or update one draft reply in Front without sending it.",
    previewCommand: "frontctl draft reply CONVERSATION_ID --body \"Draft only\" --json",
    captureName: "draft.reply",
    notes: [
      "Do not click send.",
      "Capture draft save/update separately from discard.",
    ],
  },
  "draft.compose": {
    action: "draft.compose",
    safeFrontAction: "Create one new draft compose in Front without sending it.",
    previewCommand: "frontctl draft compose --to test@example.com --subject \"frontctl draft test\" --body \"Draft only\" --json",
    captureName: "draft.compose",
    notes: [
      "Do not click send.",
      "Use a harmless recipient and subject so compose recipient and subject payload shape can be verified.",
    ],
  },
  "draft.discard": {
    action: "draft.discard",
    safeFrontAction: "Discard one existing test draft in Front.",
    previewCommand: "frontctl draft discard DRAFT_ID --json",
    captureName: "draft.discard",
    notes: [
      "Create a harmless draft first, then capture only the discard action.",
      "Do not capture send/finalize/deliver routes.",
    ],
  },
};

export const WRITE_ACTION_SPECS = [
  {
    action: "archive",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "archived" }] },
  },
  {
    action: "unarchive",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "open" }] },
  },
  {
    action: "delete",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "deleted" }] },
  },
  {
    action: "restore",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "open" }] },
  },
  {
    action: "unsnooze",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "archived", reminder: null }] },
  },
  {
    action: "tag.add",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, tags: { add: [456] } }] },
  },
  {
    action: "tag.remove",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, tags: { remove: [456] } }] },
  },
  {
    action: "conversation.create-test",
    method: "PUT",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/new/comments/comment-placeholder",
    body: {
      linked_conversation_type: "internal_task",
      text: "frontctl local integration test",
      attachments: [],
    },
  },
  {
    action: "assign",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, assignee_id: 456 }] },
  },
  {
    action: "unassign",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, assignee_id: null }] },
  },
  {
    action: "move",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, inbox_id: 456 }] },
  },
  {
    action: "follower.add",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, trackers: { add: [{ teammate_id: 456, status: "inbox", stage: "follower" }] } }] },
  },
  {
    action: "comment.add",
    method: "POST",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/conversation-placeholder/timeline",
    body: { type: "comment", comment: { uid: "comment-placeholder" }, meta: { trackers: [] } },
  },
  {
    action: "comment.remove",
    method: "DELETE",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/conversation-placeholder/timeline/456",
  },
  {
    action: "snooze",
    method: "PATCH",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations",
    body: { conversations: [{ id: 123, status: "archived", reminder: 1780805080056 }] },
  },
  {
    action: "draft.reply",
    method: "PUT",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/conversation-placeholder/messages/message-placeholder",
    body: {
      in_reply_to_id: 123,
      referenced_message_id: 123,
      author_id: 456,
      from: { channel_id: 789 },
      subject: "frontctl draft test",
      recipients: [{ role: "to", handle: "test@example.com", name: "Test", source: "email" }],
      attachments: [],
      html: "<div>draft-placeholder</div>",
      text: "draft-placeholder",
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
  },
  {
    action: "draft.compose",
    method: "PUT",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/new/messages/message-placeholder",
    body: {
      author_id: 456,
      from: { channel_id: 789 },
      subject: "frontctl draft test",
      recipients: [{ role: "to", handle: "test@example.com", name: "Test", source: "email" }],
      attachments: [],
      html: "<div>draft-placeholder</div>",
      text: "draft-placeholder",
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
  },
  {
    action: "draft.discard",
    method: "DELETE",
    path: "/cell-placeholder/api/1/companies/company-placeholder/conversations/conversation-placeholder/messages/message-placeholder",
  },
] as const;

export async function verifyAllWriteFixtures(env: NodeJS.ProcessEnv = process.env) {
  const fixturePath = discoveryFixtureRoot(env);
  const actions = await Promise.all(
    WRITE_ACTION_SPECS.map((spec) => verifyWriteFixture({ ...spec, env })),
  );
  const blockedActions = [...BLOCKED_PREVIEW_ONLY_ACTIONS].map((action) => ({
    verified: false,
    action,
    expectedRouteKind: ACTION_ROUTE_KIND[action] ?? action,
    requestBodyShapeMatched: false,
    status: "preview-only",
    reason: "This action is preview-only until its private non-send Front route is observed and implemented.",
  }));
  return {
    fixturePath,
    scope: "deployable-v1-thread-actions",
    count: actions.length,
    verifiedCount: actions.filter((action) => action.verified).length,
    allVerified: actions.every((action) => action.verified),
    actions,
    blockedActions,
  };
}

export async function writeCaptureGuide(options: {
  action?: string;
  remoteDebuggingPort?: number;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const actions = options.action ? [options.action] : WRITE_ACTION_SPECS.map((spec) => spec.action);
  const unknown = actions.filter((action) => !ACTION_CAPTURE_GUIDES[action]);
  if (unknown.length) {
    throw new Error(`Unknown write action: ${unknown.join(", ")}`);
  }
  const port = options.remoteDebuggingPort ?? 9222;
  const guides = await Promise.all(actions.map(async (action) => {
    const spec = WRITE_ACTION_SPECS.find((candidate) => candidate.action === action);
    const verification = spec
      ? await verifyWriteFixture({ ...spec, action, env: options.env })
      : {
        verified: false,
        action,
        expectedRouteKind: ACTION_ROUTE_KIND[action] ?? action,
        reason: BLOCKED_PREVIEW_ONLY_ACTIONS.has(action)
          ? "Preview-only action. Capture guide is informational until frontctl implements a non-send route for it."
          : "No command route spec exists for this action.",
      } satisfies WriteVerification;
    const guide = ACTION_CAPTURE_GUIDES[action];
    return {
      ...guide,
      verified: verification.verified,
      expectedRouteKind: verification.expectedRouteKind,
      fixturePath: verification.fixturePath,
      captureCommand: `frontctl discovery capture --remote-debugging-port ${port} --duration-ms 15000 --install --name ${guide.captureName} --json`,
      verifyCommand: "frontctl discovery verify-writes --json",
    } satisfies WriteCaptureGuide;
  }));
  return {
    fixtureRoot: discoveryFixtureRoot(options.env ?? process.env),
    scope: options.action ? "requested-action" : "deployable-v1-thread-actions",
    remoteDebuggingPort: port,
    launchCommand: `frontctl discovery launch --remote-debugging-port ${port} --json`,
    count: guides.length,
    verifiedCount: guides.filter((guide) => guide.verified).length,
    nextUnverified: guides.find((guide) => !guide.verified)?.action,
    guides,
  };
}

export async function verifyWriteFixture(options: {
  action: string;
  method?: string;
  path?: string;
  body?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<WriteVerification> {
  const body = options.body === undefined ? undefined : validateMutationPayload(options.action, options.body);
  const expectedRouteKind = ACTION_ROUTE_KIND[options.action] ?? options.action;
  const fixtureRoot = discoveryFixtureRoot(options.env ?? process.env);
  const strictFixtures = (options.env ?? process.env).FRONTCTL_REQUIRE_DISCOVERY_FIXTURES === "1";

  const fixtures = await readFixtureFiles(fixtureRoot);
  if (!fixtures.length && strictFixtures) {
    return {
      verified: false,
      action: options.action,
      expectedRouteKind,
      reason: `No sanitized write fixtures found in ${fixtureRoot}. Run frontctl discovery launch, perform one safe action in Front, then run frontctl discovery capture --install --name ${safeFixtureName(options.action)} --json.`,
    };
  }
  for (const fixturePath of fixtures) {
    const entries = await readSanitizedEntries(fixturePath);
    const match = entries.find((entry) => {
      const routeMatched = entry.routeKind === expectedRouteKind &&
      (!options.method || entry.method?.toUpperCase() === options.method.toUpperCase()) &&
      (!options.path || pathShape(entry.path) === pathShape(options.path));
      if (!routeMatched) {
        return false;
      }
      return bodyShapeMatches(entry.requestBodyShape, shapeOfCommandBody(body));
    });
    if (match) {
      return {
        verified: true,
        action: options.action,
        expectedRouteKind,
        source: "discovery-fixture",
        fixturePath,
        requestBodyShapeMatched: true,
      };
    }
  }

  if (!strictFixtures && knownWriteRouteMatches(options)) {
    return {
      verified: true,
      action: options.action,
      expectedRouteKind,
      source: "known-route",
      requestBodyShapeMatched: true,
      reason: fixtures.length
        ? "No installed discovery fixture matched, but the request matches frontctl's built-in non-send route contract."
        : "No installed discovery fixture found; using frontctl's built-in non-send route contract.",
    };
  }

  return {
    verified: false,
    action: options.action,
    expectedRouteKind,
    requestBodyShapeMatched: false,
    reason: `No sanitized fixture matched ${options.method ?? "*"} ${pathShape(options.path)} as ${expectedRouteKind} with the expected request body shape.`,
  };
}

function knownWriteRouteMatches(options: {
  action: string;
  method?: string;
  path?: string;
  body?: unknown;
}) {
  if (!BUILT_IN_VERIFIED_ACTIONS.has(options.action)) {
    return false;
  }
  const spec = WRITE_ACTION_SPECS.find((candidate) => candidate.action === options.action);
  if (!spec) {
    return false;
  }
  if (options.method && spec.method.toUpperCase() !== options.method.toUpperCase()) {
    return false;
  }
  if (options.path && pathShape(spec.path) !== pathShape(options.path)) {
    return false;
  }
  const specBody = "body" in spec ? validateMutationPayload(spec.action, spec.body) : undefined;
  const body = options.body === undefined ? undefined : validateMutationPayload(options.action, options.body);
  return bodyShapeMatches(shapeOfCommandBody(specBody), shapeOfCommandBody(body));
}

export function discoveryFixtureRoot(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_DISCOVERY_FIXTURES_PATH ?? join(homedir(), ".frontctl", "discovery-fixtures");
}

export async function installDiscoveryFixture(inputPath: string, options: { name?: string; env?: NodeJS.ProcessEnv } = {}) {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const sanitized = isSanitizedFixture(raw) ? raw : sanitizeDiscoveryInput(raw);
  return installSanitizedDiscoveryFixture(sanitized, {
    ...options,
    name: options.name ?? basename(inputPath).replace(/\.[^.]+$/, ""),
  });
}

export async function installSanitizedDiscoveryFixture(
  sanitized: unknown,
  options: { name?: string; env?: NodeJS.ProcessEnv } = {},
) {
  if (!isSanitizedFixture(sanitized)) {
    throw new Error("Discovery fixture install expected sanitized discovery output with redacted entries.");
  }
  const env = options.env ?? process.env;
  const root = discoveryFixtureRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(sanitized, null, 2);
  const safeName = safeFixtureName(options.name ?? "front-write-fixture");
  const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 10);
  const outputPath = join(root, `${safeName}-${digest}.json`);
  await writeFile(outputPath, serialized, { mode: 0o600 });
  const entries = await readSanitizedEntries(outputPath);
  return {
    fixturePath: outputPath,
    fixtureRoot: root,
    installed: true,
    count: entries.length,
    routeKinds: [...new Set(entries.map((entry) => entry.routeKind).filter(Boolean))].sort(),
  };
}

export async function listDiscoveryFixtures(env: NodeJS.ProcessEnv = process.env) {
  const fixtureRoot = discoveryFixtureRoot(env);
  const files = await readFixtureFiles(fixtureRoot);
  const fixtures = await Promise.all(files.map(async (fixturePath) => {
    const entries = await readSanitizedEntries(fixturePath);
    return {
      fixturePath,
      count: entries.length,
      routeKinds: [...new Set(entries.map((entry) => entry.routeKind).filter(Boolean))].sort(),
    };
  }));
  return {
    fixtureRoot,
    count: fixtures.length,
    fixtures,
  };
}

async function readFixtureFiles(path: string) {
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    return [];
  }
  if (info.isFile()) {
    return [path];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const names = await readdir(path);
  return names
    .filter((name) => /\.json$/i.test(name))
    .map((name) => join(path, name));
}

async function readSanitizedEntries(path: string): Promise<SanitizedDiscoveryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const fixture = sanitizedDiscoveryFixtureSchema.safeParse(parsed);
    if (fixture.success) {
      return fixture.data.entries;
    }
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => sanitizedDiscoveryEntrySchema.safeParse(entry))
        .filter((entry) => entry.success)
        .map((entry) => entry.data);
    }
  } catch {
    return [];
  }
  return [];
}

function pathShape(path: string | undefined) {
  if (!path) {
    return undefined;
  }
  return path
    .replace(/^\/cell-[^/]+/, "/cell/:cell")
    .replace(/\/companies\/[^/]+/, "/companies/:company")
    .replace(/\/team\/[^/]+/, "/team/:team")
    .replace(/\/conversations\/[^/]+/, "/conversations/:conversation")
    .replace(/\/timeline\/[^/]+/, "/timeline/:activity")
    .replace(/\/comments\/[^/]+/, "/comments/:comment")
    .replace(/\/messages\/[^/]+/, "/messages/:message")
    .replace(/\/tag\/[^/]+/, "/tag/:tag")
    .replace(/\/untag\/[^/]+/, "/untag/:tag");
}

function bodyShapeMatches(fixtureShape: unknown, commandShape: unknown): boolean {
  if (commandShape === undefined) {
    return true;
  }
  if (fixtureShape === undefined) {
    return false;
  }
  if (typeof commandShape === "string") {
    return typeof fixtureShape === "string";
  }
  if (Array.isArray(commandShape)) {
    return Array.isArray(fixtureShape);
  }
  if (!isObject(commandShape) || !isObject(fixtureShape)) {
    return typeof commandShape === typeof fixtureShape;
  }
  return Object.entries(commandShape).every(([key, value]) => key in fixtureShape && bodyShapeMatches(fixtureShape[key], value));
}

function shapeOfCommandBody(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length ? [shapeOfCommandBody(value[0])] : [];
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOfCommandBody(child)]));
  }
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSanitizedFixture(value: unknown): value is Record<string, unknown> {
  return sanitizedDiscoveryFixtureSchema.safeParse(value).success;
}

function safeFixtureName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "front-write-fixture";
}
