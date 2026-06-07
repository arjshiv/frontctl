#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const conversationId = process.argv[2] ?? process.env.FRONTCTL_LIVE_CONVERSATION_ID;

if (!conversationId) {
  console.error("Usage: node script/verify_live_writes.mjs CONVERSATION_ID");
  process.exit(64);
}

try {
  const { stdout } = await execFileAsync("node", [
    "dist/src/cli.js",
    "discovery",
    "verify-live-writes",
    conversationId,
    "--yes",
    "--json",
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(stdout);
} catch (error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
  process.stderr.write(stderr);
  process.exit(typeof error === "object" && error && "code" in error && typeof error.code === "number" ? error.code : 1);
}
