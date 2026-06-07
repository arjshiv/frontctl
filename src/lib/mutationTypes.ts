import type { MutationActor } from "./audit.js";
import type { createFrontPrivateClient } from "./frontPrivate.js";
import type { FrontPaths } from "./paths.js";
import type { WriteVerification } from "./writeVerification.js";

export type MutationMode = "dry-run" | "execute";
export type FrontPrivateClient = Awaited<ReturnType<typeof createFrontPrivateClient>>;

export interface MutationSpec {
  action: string;
  conversationId?: string;
  actor?: MutationActor;
  reason?: string;
  method?: string;
  url?: string;
  body?: unknown;
  details?: unknown;
  canExecute: boolean;
  verification?: WriteVerification;
  note?: string;
  execute?: (client: FrontPrivateClient) => Promise<unknown>;
}

export interface IdentifiedMutationSpec extends MutationSpec {
  actor: MutationActor;
  reason?: string;
}

export interface AgentIdentityComment {
  commentUid: string;
  activityId?: unknown;
  body: string;
}

export interface RunMutationOptions {
  args: string[];
  spec: MutationSpec;
  paths: FrontPaths;
}
