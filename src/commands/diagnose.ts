import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkFrontSession } from "../lib/auth.js";
import { defaultAuditPath, listAuditEntries } from "../lib/audit.js";
import { CliError } from "../lib/cli.js";
import { pathStatus } from "../lib/fsInfo.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { defaultStorePath, storeStats } from "../lib/store.js";
import { discoveryFixtureRoot, verifyAllWriteFixtures } from "../lib/writeVerification.js";
import { agentsStatus } from "./agents.js";
import { doctor } from "./doctor.js";

export async function diagnoseCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const outputPath = readStringFlag(args, "--output");
  const bundle = await redactedDiagnosticBundle(paths);
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  }
  return {
    ...bundle,
    outputPath,
  };
}

export async function redactedDiagnosticBundle(paths: FrontPaths = defaultFrontPaths()) {
  const [doctorResult, auth, agents, writes, audit, storePathStatus, fixtureStatus] = await Promise.all([
    doctor(paths),
    checkFrontSession(),
    agentsStatus("all"),
    verifyAllWriteFixtures(),
    listAuditEntries({ limit: 10 }),
    pathStatus(defaultStorePath()),
    pathStatus(discoveryFixtureRoot()),
  ]);
  const stats = storePathStatus.exists
    ? await storeStats(defaultStorePath()).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : undefined;
  const userReadiness = buildUserReadiness({
    frontAppInstalled: doctorResult.checks.find((check) => check.name === "frontApp")?.ok ?? false,
    localProfileVisible: doctorResult.onboarding.readyForAgentUse,
    authValid: auth.valid,
    agentsInstalled: agents.allInstalled,
  });

  return {
    generatedAt: new Date().toISOString(),
    redacted: true,
    publicApiUsed: false,
    sendsEmail: false,
    summary: {
      ok: doctorResult.ok,
      authValid: auth.valid,
      agentsInstalled: agents.allInstalled,
      writeRoutesVerified: writes.allVerified,
      userReady: userReadiness.ready,
      userReadinessState: userReadiness.state,
      firstIssue: doctorResult.issues[0]?.remedy,
    },
    userReadiness,
    front: {
      version: doctorResult.front.version,
      bundleIdentifier: doctorResult.front.bundleIdentifier,
      urlSchemes: doctorResult.front.urlSchemes,
      checks: doctorResult.checks,
    },
    auth: {
      sessionPath: auth.sessionPath,
      exists: auth.exists,
      valid: auth.valid,
      host: auth.host,
      cookieNames: auth.cookieNames,
      createdAt: auth.createdAt,
      expiresAt: auth.expiresAt,
      security: auth.security,
      note: auth.note,
    },
    agents,
    storage: {
      storePath: defaultStorePath(),
      storePathStatus,
      stats,
      auditPath: defaultAuditPath(),
      auditCount: audit.count,
      fixtureRoot: discoveryFixtureRoot(),
      fixtureStatus,
    },
    writes: {
      count: writes.count,
      verifiedCount: writes.verifiedCount,
      allVerified: writes.allVerified,
      actions: writes.actions.map((action) => ({
        action: action.action,
        verified: action.verified,
        expectedRouteKind: action.expectedRouteKind,
        source: action.source,
        requestBodyShapeMatched: action.requestBodyShapeMatched,
        reason: action.reason,
      })),
    },
    privacy: {
      includesCookieValues: false,
      includesAuthHeaders: false,
      includesMailboxBodies: false,
      includesSubjects: false,
      includesSignedAttachmentUrls: false,
    },
  };
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && !value) {
    throw new CliError(`Missing value for ${flag}`, 64);
  }
  return value;
}
