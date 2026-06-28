import { writeFile } from "node:fs/promises";
import { CliError } from "../lib/cli.js";
import { attachmentsFromTimeline, normalizeTimeline, readCachedConversation } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function attachmentsCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand] = args;
  if (subcommand && !["list", "read"].includes(subcommand)) {
    throw new CliError("Usage: frontctl attachments list CONVERSATION_ID | attachments read CONVERSATION_ID ATTACHMENT_ID --output FILE", 64);
  }
  const id = args.find((arg) => !arg.startsWith("--") && !["list", "read"].includes(arg));
  if (!id) {
    throw new CliError("Usage: frontctl attachments list CONVERSATION_ID [--offline-cache]", 64);
  }

  if (subcommand === "read") {
    return readAttachment(args, id, paths);
  }

  if (args.includes("--offline-cache")) {
    const read = await readCachedConversation(paths.cacheDataPath, id);
    const attachments = attachmentsFromTimeline(read.timeline);
    return {
      source: "cache",
      stale: true,
      id,
      count: attachments.length,
      attachments,
    };
  }

  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const timeline = await client.getJson<Record<string, unknown>>(routes.timeline(id));
  const timelineValue = Array.isArray(timeline.timeline) ? timeline.timeline : timeline;
  const attachments = attachmentsFromTimeline(normalizeTimeline(timelineValue));
  return {
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    id,
    count: attachments.length,
    attachments,
  };
}

async function readAttachment(args: string[], conversationId: string, paths: FrontPaths) {
  const attachmentId = positional(args)[1];
  const output = readStringFlag(args, "--output");
  if (!attachmentId || !output) {
    throw new CliError("Usage: frontctl attachments read CONVERSATION_ID ATTACHMENT_ID --output FILE", 64);
  }
  const client = await createFrontPrivateClient(paths);
  if (!client.requestBytes) {
    throw new CliError("Attachment download requires the local session-cookie transport. Run `frontctl auth check --json`.", 69);
  }
  const routes = buildFrontRoutes(client.context);
  const timeline = await client.getJson<Record<string, unknown>>(routes.timeline(conversationId));
  const timelineValue = Array.isArray(timeline.timeline) ? timeline.timeline : timeline;
  const match = findRawAttachment(timelineValue, attachmentId);
  if (!match?.url) {
    throw new CliError(`Could not find a downloadable attachment matching ${attachmentId}`, 69);
  }
  const downloaded = await client.requestBytes(absoluteUrl(match.url, routes.attachment(attachmentId)));
  await writeFile(output, downloaded.bytes);
  return {
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    conversationId,
    attachment: {
      id: match.id,
      filename: match.filename ?? downloaded.filename,
      contentType: downloaded.contentType ?? match.contentType,
      size: downloaded.bytes.byteLength,
    },
    output,
  };
}

function findRawAttachment(timeline: unknown, attachmentId: string) {
  const items = Array.isArray(timeline) ? timeline : [];
  for (const item of items) {
    const raw = isObject(item) ? item : undefined;
    const message = isObject(raw?.message) ? raw?.message as Record<string, unknown> : raw;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      if (!isObject(attachment)) {
        continue;
      }
      const id = stringField(attachment.id ?? attachment.uid);
      const filename = stringField(attachment.filename ?? attachment.name ?? attachment.display_name);
      if (id !== attachmentId && filename !== attachmentId) {
        continue;
      }
      return {
        id,
        filename,
        contentType: stringField(attachment.content_type ?? attachment.mime_type ?? attachment.type),
        url: stringField(attachment.url ?? attachment.download_url ?? attachment.content_url),
      };
    }
  }
  return undefined;
}

function positional(args: string[]) {
  return args.filter((arg) => !arg.startsWith("--") && arg !== "list" && arg !== "read");
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function absoluteUrl(url: string, fallback: string) {
  try {
    return new URL(url, fallback).toString();
  } catch {
    return fallback;
  }
}

function stringField(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
