import { readFile } from "node:fs/promises";
import { auditMutation } from "../lib/audit.js";
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
  method?: string;
  url?: string;
  body?: unknown;
  details?: unknown;
  canExecute: boolean;
  verification?: WriteVerification;
  note?: string;
}

export async function archiveConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const ids = positional(args);
  if (!ids.length) {
    throw new CliError("Missing conversation id", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation(args, await verifiedSpec({
    action: "archive",
    conversationId: ids.length === 1 ? ids[0] : undefined,
    method: "POST",
    url: routes.conversationBatchArchive,
    body: { conversation_ids: ids },
    details: {
      count: ids.length,
      conversationIds: ids,
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
  const resolvedAlias = tagResolution.resolvedAlias;
  return runMutation(args, await verifiedSpec({
    action: `tag.${operation}`,
    conversationId: id,
    method: "POST",
    url: operation === "add" ? routes.tagConversation(id, resolvedAlias) : routes.untagConversation(id, resolvedAlias),
    details: {
      tag: tagResolution,
    },
    note: tagResolution.warning,
    canExecute: false,
  }), paths);
}

export async function commentConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id] = positional(args);
  if (operation !== "add") {
    throw new CliError("Usage: frontctl comment add CONVERSATION_ID --body \"...\"|--body-file note.md", 64);
  }
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const body = await readBodyArg(args);
  if (!body) {
    throw new CliError("Missing comment body. Use --body \"...\" or --body-file path", 64);
  }
  const routes = await getRoutes(paths);
  return runMutation(args, await verifiedSpec({
    action: "comment.add",
    conversationId: id,
    method: "POST",
    url: routes.comments(id),
    body: { body },
    canExecute: false,
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
    method: "POST",
    url: routes.conversationStatus(id, "snoozed"),
    body: { until: snoozeUntil.iso },
    details: {
      input: until,
      normalizedUntil: snoozeUntil.iso,
      parser: snoozeUntil.parser,
    },
    canExecute: false,
  }), paths);
}

export async function draftCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, id] = positional(args);
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
      throw new CliError("Usage: frontctl draft discard DRAFT_ID", 64);
    }
    const [routes, cachedDraft] = await Promise.all([
      getRoutes(paths),
      readCachedDraft(paths.indexedDbLevelDbPath, id),
    ]);
    const messageUid = cachedDraft.draft?.messageUid;
    const spec: MutationSpec = {
      action: "draft.discard",
      conversationId: cachedDraft.draft?.conversationId,
      method: "DELETE",
      url: messageUid ? routes.message(messageUid) : undefined,
      canExecute: false,
      note: messageUid
        ? undefined
        : "Could not resolve this cached draft to a Front message id. Run `frontctl draft list --json` and discard a listed draft with messageUid.",
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
  const routes = await getRoutes(paths);
  const draftBody = operation === "reply"
    ? { body, draft: true }
    : composeDraftBody(args, body);
  return runMutation(args, await verifiedSpec({
    action: `draft.${operation}`,
    conversationId: id,
    method: "POST",
    url: operation === "reply" && id ? routes.messages(id) : routes.conversations,
    body: draftBody,
    canExecute: false,
    note: "Send remains blocked.",
  }), paths);
}

async function runMutation(args: string[], spec: MutationSpec, _paths: FrontPaths) {
  const mode: MutationMode = args.includes("--yes") && !args.includes("--dry-run") ? "execute" : "dry-run";
  const path = spec.url ? new URL(spec.url).pathname : undefined;
  await auditMutation({
    action: spec.action,
    mode,
    conversationId: spec.conversationId,
    method: spec.method,
    path,
    body: spec.body,
  });

  if (mode === "dry-run") {
    return preview(spec, mode);
  }

  if (!spec.canExecute) {
    throw new CliError(spec.note ?? `${spec.action} execution is not enabled yet.`, 69);
  }

  if (!spec.url || !spec.method) {
    throw new CliError(`Missing route for ${spec.action}`, 69);
  }

  const client = await createFrontPrivateClient(_paths);
  const result = await client.requestJson(spec.url, { method: spec.method, body: spec.body });
  return {
    ...preview(spec, mode),
    result,
  };
}

function preview(spec: MutationSpec, mode: MutationMode) {
  return {
    source: "live-private",
    publicApiUsed: false,
    sendsEmail: false,
    mode,
    action: spec.action,
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

function noteFor(spec: MutationSpec, mode: MutationMode) {
  const notes = [spec.note, spec.verification?.reason].filter(Boolean);
  if (notes.length) {
    return notes.join(" ");
  }
  return mode === "dry-run" ? "Dry run only. Re-run with --yes to execute." : undefined;
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
    if (arg === "--body") {
      index += 1;
      continue;
    }
    if (arg === "--body-file") {
      index += 1;
      continue;
    }
    if (arg === "--limit") {
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
