import { CliError } from "../lib/cli.js";
import { buildFrontRoutes, discoverFrontRouteContext, type FrontRouteContext } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { run } from "../lib/process.js";
import { firstPositionalArg } from "../lib/render.js";

export type OpenLauncher = (target: string) => Promise<void>;

export async function openConversation(
  args: string[],
  paths: FrontPaths = defaultFrontPaths(),
  launcher: OpenLauncher = macOpen,
) {
  const id = firstPositionalArg(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }

  const context = await discoverFrontRouteContext(paths.cacheDataPath);
  if (!context) {
    throw new CliError("Could not discover Front route context. Open Front inbox once, then rerun.", 69);
  }

  const targets = buildOpenTargets(context, id);

  if (!args.includes("--print-only") && !args.includes("--dry-run")) {
    await launcher(args.includes("--web") ? targets.appUrl : targets.deeplink);
  }

  const opened = !args.includes("--print-only") && !args.includes("--dry-run");
  return {
    opened,
    conversationId: id,
    appUrl: targets.appUrl,
    deeplink: targets.deeplink,
    target: args.includes("--web") ? targets.appUrl : targets.deeplink,
    note: opened
      ? args.includes("--web")
        ? "Opened app URL via macOS open."
        : "Opened Front deeplink via macOS open. Use --web to open the web URL instead."
      : "Print-only mode. No app was opened.",
  };
}

export function buildOpenTargets(context: FrontRouteContext, conversationId: string) {
  const routes = buildFrontRoutes(context);
  const path = new URL(routes.conversation(conversationId)).pathname;
  return {
    appUrl: `${context.origin}/open${path}`,
    deeplink: `frontapp:/go${path}`,
  };
}

async function macOpen(target: string) {
  try {
    await run("open", [target]);
  } catch (error) {
    throw new CliError(String(error) || "Failed to open Front conversation", 69);
  }
}
