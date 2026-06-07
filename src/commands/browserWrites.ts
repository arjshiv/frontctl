import { readFrontSession } from "../lib/auth.js";
import { CliError } from "../lib/cli.js";
import { selectFrontDevToolsTarget, sanitizeDevToolsTarget } from "../lib/discovery.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes, discoverFrontRouteContext } from "../lib/frontRoutes.js";
import type { FrontPaths } from "../lib/paths.js";
import { verifyAllWriteFixtures } from "../lib/writeVerification.js";

const BROWSER_WRITE_ACTIONS = [
  "unarchive",
  "archive",
  "snooze",
  "unsnooze",
  "tag.add",
  "tag.remove",
  "comment.add",
  "comment.remove",
  "draft.reply",
  "draft.discard",
] as const;

export async function browserSeedCommand(args: string[], paths: FrontPaths) {
  const remoteDebuggingPort = readNumberFlag(args, "--remote-debugging-port") ?? 9222;
  const targetUrlContains = readStringFlag(args, "--target-url-contains") ?? "app.frontapp.com";
  if (!args.includes("--yes")) {
    return {
      source: "frontctl-session-to-browser-cdp",
      mode: "dry-run",
      publicApiUsed: false,
      requiresYes: true,
      remoteDebuggingPort,
      targetUrlContains,
      cookieNames: ["front.id", "front.id.sig", "front.csrf"],
      valuePrinted: false,
      command: `frontctl discovery browser-seed --remote-debugging-port ${remoteDebuggingPort} --target-url-contains ${shellToken(targetUrlContains)} --yes --json`,
      note: "Seeds the existing short-lived frontctl session into the selected browser tab via CDP. Cookie values are not printed.",
    };
  }

  const session = await readFrontSession();
  if (!session?.cookieHeader) {
    throw new CliError("No valid frontctl session cache. Run `frontctl auth check --json` and unlock once if needed.", 69);
  }
  const context = await discoverFrontRouteContext(paths.cacheDataPath);
  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun.", 69);
  }
  const routes = buildFrontRoutes(context);
  const target = await findBrowserTarget(remoteDebuggingPort, targetUrlContains);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    throw new CliError("No usable Front browser tab with a DevTools websocket URL was found.", 69);
  }

  const csrf = await fetchCsrf(routes.boot, session.cookieHeader);
  const cookies = parseCookieHeader(session.cookieHeader)
    .filter((cookie) => cookie.name === "front.id" || cookie.name === "front.id.sig");
  if (csrf) {
    cookies.push({ name: "front.csrf", value: csrf, httpOnly: false });
  }
  const connection = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    await connection.send("Network.enable", {});
    const seeded = [];
    for (const cookie of cookies) {
      const result = await connection.send("Network.setCookie", {
        name: cookie.name,
        value: cookie.value,
        domain: "app.frontapp.com",
        path: "/",
        secure: true,
        httpOnly: cookie.httpOnly ?? true,
        sameSite: "Lax",
        url: "https://app.frontapp.com/",
      });
      seeded.push({ name: cookie.name, success: result.success === true });
    }
    return {
      source: "frontctl-session-to-browser-cdp",
      mode: "execute",
      publicApiUsed: false,
      remoteDebuggingPort,
      target: sanitizeDevToolsTarget(target),
      targetUrlContains,
      cookieNamesSeeded: seeded,
      valuePrinted: false,
      nextCommand: `frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port ${remoteDebuggingPort} --target-url-contains ${shellToken(targetUrlContains)} --json`,
    };
  } finally {
    connection.close();
  }
}

export async function verifyBrowserWritesCommand(args: string[], paths: FrontPaths) {
  const [conversationId] = positional(args);
  const remoteDebuggingPort = readNumberFlag(args, "--remote-debugging-port") ?? 9222;
  const tagId = readNumberFlag(args, "--tag-id");
  const targetUrlContains = readStringFlag(args, "--target-url-contains") ?? (conversationId ? `conversations/${conversationId}` : undefined);
  if (!conversationId) {
    throw new CliError("Usage: frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --tag-id TAG_ID --yes", 64);
  }
  if (!tagId) {
    throw new CliError("Missing --tag-id. Run `frontctl tag list --live --json` and choose a low-risk numeric tag id for the browser add/remove test.", 64);
  }
  if (!args.includes("--yes")) {
    return {
      source: "browser-cdp-runtime",
      mode: "dry-run",
      publicApiUsed: false,
      sendsEmail: false,
      requiresYes: true,
      conversationId,
      remoteDebuggingPort,
      targetUrlContains,
      tagId,
      actions: BROWSER_WRITE_ACTIONS,
      command: `frontctl discovery verify-browser-writes ${shellToken(conversationId)} --remote-debugging-port ${remoteDebuggingPort} --target-url-contains ${shellToken(targetUrlContains ?? "")} --tag-id ${tagId} --yes --json`,
      note: "Mutates one real Front conversation from inside the selected browser tab, verifies private route writes, cleans up temporary tag/comment/draft artifacts, and archives the conversation last.",
    };
  }

  const routeVerification = await verifyAllWriteFixtures();
  const bad = routeVerification.actions.filter((action) => !action.verified);
  if (bad.length) {
    throw new CliError(`Deployable write routes are not verified: ${bad.map((action) => action.action).join(", ")}`, 69);
  }
  const context = await discoverFrontRouteContext(paths.cacheDataPath);
  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun.", 69);
  }
  const draftSeed = await resolveDraftSeed(conversationId, paths);
  const target = await findBrowserTarget(remoteDebuggingPort, targetUrlContains);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    throw new CliError("No usable Front browser tab with a DevTools websocket URL was found.", 69);
  }
  const connection = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    const expression = browserWriteVerifierExpression({
      conversationId,
      rootPath: `/${context.cell}/api/1/companies/${context.companyId}`,
      tagId,
      draftSeed,
    });
    const result = await connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120_000,
    });
    if (result.exceptionDetails) {
      throw new CliError(`Browser write verification failed: ${String((result.exceptionDetails as Record<string, unknown>).text ?? "runtime exception")}`, 69);
    }
    const runtimeResult = result.result as Record<string, unknown> | undefined;
    return {
      target: sanitizeDevToolsTarget(target),
      remoteDebuggingPort,
      targetUrlContains,
      routeVerification: {
        scope: routeVerification.scope,
        allVerified: routeVerification.allVerified,
        verifiedCount: routeVerification.verifiedCount,
        count: routeVerification.count,
        blockedActions: routeVerification.blockedActions,
      },
      ...(runtimeResult?.value as Record<string, unknown>),
    };
  } finally {
    connection.close();
  }
}

async function findBrowserTarget(remoteDebuggingPort: number, targetUrlContains: string | undefined) {
  const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
  if (!response.ok) {
    throw new CliError(`Chrome DevTools target list failed with HTTP ${response.status}`, 69);
  }
  const targets = await response.json() as Array<Record<string, unknown>>;
  return selectFrontDevToolsTarget(targets, targetUrlContains);
}

async function fetchCsrf(bootUrl: string, cookieHeader: string) {
  const response = await fetch(bootUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: cookieHeader,
      origin: new URL(bootUrl).origin,
      referer: `${new URL(bootUrl).origin}/`,
    },
  });
  const setCookie = response.headers.get("set-cookie");
  await response.arrayBuffer();
  const match = setCookie?.match(/(?:^|,\s*)front\.csrf=([^;,]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function parseCookieHeader(cookieHeader: string) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return { name: part.slice(0, index), value: part.slice(index + 1), httpOnly: true };
    });
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

async function connectDevTools(webSocketDebuggerUrl: string) {
  const WebSocketCtor = (globalThis as typeof globalThis & {
    WebSocket?: new (url: string) => {
      addEventListener: (event: string, listener: (message?: { data?: unknown }) => void, options?: { once?: boolean }) => void;
      send: (message: string) => void;
      close: () => void;
    };
  }).WebSocket;
  if (!WebSocketCtor) {
    throw new CliError("This Node runtime does not expose WebSocket.", 69);
  }
  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  socket.addEventListener("message", (message) => {
    const data = typeof message?.data === "string" ? JSON.parse(message.data) as Record<string, unknown> : undefined;
    const id = typeof data?.id === "number" ? data.id : undefined;
    if (!data || id === undefined || !pending.has(id)) {
      return;
    }
    const callbacks = pending.get(id)!;
    pending.delete(id);
    if (data.error) {
      callbacks.reject(new Error(JSON.stringify(data.error)));
      return;
    }
    callbacks.resolve(data.result as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Browser DevTools websocket connection failed.")), { once: true });
  });
  return {
    send(method: string, params: Record<string, unknown>) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function resolveDraftSeed(conversationId: string, paths: FrontPaths) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const [boot, conversation, timelineResponse] = await Promise.all([
    client.getJson<Record<string, unknown>>(routes.boot),
    client.getJson<Record<string, unknown>>(routes.conversation(conversationId)),
    client.getJson<Record<string, unknown>>(routes.timeline(conversationId)),
  ]);
  const timeline = Array.isArray(timelineResponse.timeline) ? timelineResponse.timeline : timelineResponse;
  const sourceMessage = latestConversationMessage({ timeline }, conversation);
  const authorId = numberField((boot.user as Record<string, unknown> | undefined)?.id);
  const channelId = replyChannelId(sourceMessage);
  const recipient = replyRecipient(sourceMessage);
  if (!sourceMessage.id) {
    throw new CliError("Could not find a source message to reply to in this conversation.", 69);
  }
  if (!authorId) {
    throw new CliError("Could not resolve the current Front user for browser draft reply.", 69);
  }
  if (!channelId) {
    throw new CliError("Could not resolve a sending channel for browser draft reply.", 69);
  }
  if (!recipient?.handle) {
    throw new CliError("Could not resolve reply recipient for browser draft reply.", 69);
  }
  return {
    sourceMessageId: sourceMessage.id,
    authorId,
    channelId,
    subject: stringField(sourceMessage.subject) ?? "",
    recipient,
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
  const handle = stringField(from?.handle) ?? stringField(from?.email) ?? stringField(from?.display_name);
  if (!handle) {
    return undefined;
  }
  return {
    role: "to",
    handle,
    name: stringField(from?.display_name) ?? stringField(from?.name) ?? handle,
    source: "email",
  };
}

function browserWriteVerifierExpression(input: {
  conversationId: string;
  rootPath: string;
  tagId: number;
  draftSeed: {
    sourceMessageId: unknown;
    authorId: number;
    channelId: number;
    subject: string;
    recipient: Record<string, unknown>;
  };
}) {
  return `
(${browserWriteVerifierRuntime.toString()})(${JSON.stringify(input)})
`;
}

function browserWriteVerifierRuntime(input: {
  conversationId: string;
  rootPath: string;
  tagId: number;
  draftSeed: {
    sourceMessageId: unknown;
    authorId: number;
    channelId: number;
    subject: string;
    recipient: Record<string, unknown>;
  };
}) {
  const id = input.conversationId;
  const numericId = Number(id);
  const root = input.rootPath;
  const marker = `frontctl browser verification ${new Date().toISOString()}`;
  const tagId = input.tagId;
  const steps: Array<Record<string, unknown>> = [];
  const cleanup: { tag: boolean; commentActivityId: string | null; draftUid: string | null } = {
    tag: false,
    commentActivityId: null,
    draftUid: null,
  };
  const cookieValue = (name: string) => document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  const jsonFetch = async (path: string, method = "GET", body?: unknown) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-front-precogs": "direct",
      "X-Front-Session-Id": "frontctl-browser-verify",
    };
    const csrf = cookieValue("front.csrf");
    if (csrf) headers["X-Front-Xsrf"] = decodeURIComponent(csrf);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { ok: response.ok, status: response.status, path, method, parsed };
  };
  const summarize = (name: string, result: Awaited<ReturnType<typeof jsonFetch>>, extra: Record<string, unknown> = {}) => {
    const url = new URL(result.path, location.origin);
    steps.push({ action: name, ok: result.ok, httpStatus: result.status, method: result.method, path: url.pathname, ...extra });
    if (!result.ok) throw new Error(`${name} failed with HTTP ${result.status}`);
    return result.parsed as Record<string, unknown>;
  };
  const patch = async (name: string, patchBody: Record<string, unknown>) =>
    summarize(name, await jsonFetch(`${root}/conversations`, "PATCH", { conversations: [{ id: numericId, ...patchBody }] }));
  const readState = async () => {
    const raw = await jsonFetch(`${root}/conversations/${id}`);
    const contentResult = await jsonFetch(`${root}/conversations/${id}/content`);
    const content = contentResult.parsed as Record<string, unknown>;
    const serialized = JSON.stringify(content);
    const tags = Array.isArray((raw.parsed as Record<string, unknown>).tags)
      ? ((raw.parsed as Record<string, unknown>).tags as Array<Record<string, unknown>>).map((tag) => String(tag.id))
      : [];
    return {
      status: (raw.parsed as Record<string, unknown>).status,
      reminders: Array.isArray((raw.parsed as Record<string, unknown>).reminders) ? ((raw.parsed as Record<string, unknown>).reminders as unknown[]).length : 0,
      tags,
      hasDrafts: Boolean((raw.parsed as Record<string, unknown>).has_drafts) || (cleanup.draftUid ? serialized.includes(cleanup.draftUid) : false),
      containsMarker: serialized.includes(marker),
      content,
    };
  };
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const findCommentActivityId = (content: Record<string, unknown>, commentUid: string) => {
    const timeline = Array.isArray(content.timeline) ? content.timeline as Array<Record<string, unknown>> : [];
    const item = timeline.find((entry) => String((entry.comment as Record<string, unknown> | undefined)?.uid ?? entry.comment_uid ?? "") === commentUid);
    return item?.id ? String(item.id) : null;
  };

  return (async () => {
    try {
      await patch("unarchive", { status: "open" });
      await patch("archive", { status: "archived" });
      await patch("snooze", { status: "archived", reminder: Date.now() + 2 * 60 * 60 * 1000 });
      await patch("unsnooze", { status: "archived", reminder: null });
      await patch("tag.add", { tags: { add: [tagId] } });
      cleanup.tag = true;
      await patch("tag.remove", { tags: { remove: [tagId] } });
      cleanup.tag = false;
      const commentUid = uid();
      summarize("comment.save", await jsonFetch(`${root}/conversations/${id}/comments/${commentUid}?include_conversation=true`, "PUT", { text: marker, attachments: [], referenced_activity_id: null, annotation: null }), { commentUid });
      const commentResult = summarize("comment.add", await jsonFetch(`${root}/conversations/${id}/timeline`, "POST", { type: "comment", comment: { uid: commentUid }, meta: { trackers: [] } }), { commentUid });
      const activityId = commentResult.id ? String(commentResult.id) : findCommentActivityId((await readState()).content, commentUid);
      cleanup.commentActivityId = activityId;
      if (!activityId) throw new Error("comment activity id not found");
      summarize("comment.remove", await jsonFetch(`${root}/conversations/${id}/timeline/${activityId}`, "DELETE", {}), { activityId });
      cleanup.commentActivityId = null;
      const draftUid = uid();
      cleanup.draftUid = draftUid;
      summarize("draft.reply", await jsonFetch(`${root}/conversations/${id}/messages/${draftUid}?include_conversation=true`, "PUT", {
        in_reply_to_id: input.draftSeed.sourceMessageId,
        referenced_message_id: input.draftSeed.sourceMessageId,
        author_id: input.draftSeed.authorId,
        from: { channel_id: input.draftSeed.channelId },
        subject: input.draftSeed.subject,
        recipients: [input.draftSeed.recipient],
        attachments: [],
        html: `<div>${marker}</div>`,
        text: marker,
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
      }), { messageUid: draftUid });
      summarize("draft.discard", await jsonFetch(`${root}/conversations/${id}/messages/${draftUid}`, "DELETE", {}), { messageUid: draftUid });
      cleanup.draftUid = null;
    } finally {
      if (cleanup.draftUid) await jsonFetch(`${root}/conversations/${id}/messages/${cleanup.draftUid}`, "DELETE", {}).catch(() => null);
      if (cleanup.commentActivityId) await jsonFetch(`${root}/conversations/${id}/timeline/${cleanup.commentActivityId}`, "DELETE", {}).catch(() => null);
      if (cleanup.tag) await jsonFetch(`${root}/conversations`, "PATCH", { conversations: [{ id: numericId, tags: { remove: [tagId] } }] }).catch(() => null);
      await jsonFetch(`${root}/conversations`, "PATCH", { conversations: [{ id: numericId, status: "archived", reminder: null }] }).catch(() => null);
    }
    const finalState = await readState();
    return {
      source: "browser-cdp-runtime",
      publicApiUsed: false,
      sendsEmail: false,
      conversationId: id,
      marker,
      verifiedActions: steps.filter((step) => step.action !== "comment.save").map((step) => step.action),
      steps,
      finalState: {
        status: finalState.status,
        reminders: finalState.reminders,
        hasDrafts: finalState.hasDrafts,
        containsMarker: finalState.containsMarker,
        tagPresent: finalState.tags.includes(String(tagId)),
      },
    };
  })();
}

function positional(args: string[]) {
  const skip = new Set(["--remote-debugging-port", "--target-url-contains", "--tag-id"]);
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skip.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function shellToken(value: string) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}
