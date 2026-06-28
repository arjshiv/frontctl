import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createFrontPrivateClient } from "../src/lib/frontPrivate.js";
import { buildFrontRoutes } from "../src/lib/frontRoutes.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("session-cookie private requests time out instead of hanging forever", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-timeout"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const previousFetch = globalThis.fetch;
  const previousTimeout = process.env.FRONTCTL_HTTP_TIMEOUT_MS;
  process.env.FRONTCTL_HTTP_TIMEOUT_MS = "25";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted") as Error & { name: string };
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    await assert.rejects(
      () => client.getJson(routes.conversation("1")),
      /Front private request timed out after 25ms: GET .*\/conversations\/1/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) {
      delete process.env.FRONTCTL_HTTP_TIMEOUT_MS;
    } else {
      process.env.FRONTCTL_HTTP_TIMEOUT_MS = previousTimeout;
    }
  }
});
