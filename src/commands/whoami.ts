import { getBoot } from "../lib/frontPrivate.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function whoami(_args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const boot = await getBoot(paths);
  return {
    source: "live-private",
    publicApiUsed: false,
    user: pickIdentity(boot.user),
    workspace: pickIdentity(boot.workspace),
    company: pickIdentity(boot.company),
    team: pickIdentity(boot.team),
    counts: {
      teams: Array.isArray(boot.teams) ? boot.teams.length : undefined,
      inboxes: Array.isArray(boot.inboxes) ? boot.inboxes.length : undefined,
      channels: Array.isArray(boot.channels) ? boot.channels.length : undefined,
    },
  };
}

function pickIdentity(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    id: stringField(raw.id),
    name: stringField(raw.name),
    email: stringField(raw.email),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
