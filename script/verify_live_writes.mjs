#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const conversationId = process.argv[2] ?? process.env.FRONTCTL_LIVE_CONVERSATION_ID;
const frontctlCommand = frontctlCommandParts(process.env.FRONTCTL_BIN);

if (!conversationId) {
  console.error("Usage: node script/verify_live_writes.mjs CONVERSATION_ID");
  process.exit(64);
}

try {
  const { stdout } = await execFileAsync(frontctlCommand.executable, [
    ...frontctlCommand.prefixArgs,
    "discovery",
    "verify-live-writes",
    conversationId,
    "--actor",
    "Frontctl",
    "--yes",
    "--json",
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assertResult(result);
  process.stdout.write(stdout);
} catch (error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
  process.stderr.write(stderr);
  process.exit(typeof error === "object" && error && "code" in error && typeof error.code === "number" ? error.code : 1);
}

function frontctlCommandParts(value) {
  if (!value) {
    return {
      executable: "node",
      prefixArgs: ["dist/src/cli.js"],
    };
  }
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  if (parts.length === 0) {
    return {
      executable: "frontctl",
      prefixArgs: [],
    };
  }
  return {
    executable: parts[0],
    prefixArgs: parts.slice(1),
  };
}

function assertResult(result) {
  const failures = [];
  if (result?.source !== "live-private") failures.push("source is not live-private");
  if (result?.publicApiUsed !== false) failures.push("publicApiUsed is not false");
  if (result?.sendsEmail !== false) failures.push("sendsEmail is not false");
  if (result?.routeVerification?.allVerified !== true) failures.push("routeVerification.allVerified is not true");
  if (result?.after?.status !== "archived") failures.push("final status is not archived");
  if (result?.after?.reminders !== 0) failures.push("final reminders were not cleared");
  if (result?.after?.hasDrafts !== false) failures.push("drafts remain after verification");
  if (result?.after?.containsMarker !== false) failures.push("temporary marker remains after verification");
  if (failures.length > 0) {
    throw new Error(`Live write verification failed: ${failures.join("; ")}`);
  }
}
