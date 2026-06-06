import { strict as assert } from "node:assert";
import test from "node:test";
import { unsupportedMutation } from "../src/commands/unsupported.js";
import { CliError } from "../src/lib/cli.js";

test("send command is hard blocked", async () => {
  const send = unsupportedMutation("send", "Sending is intentionally blocked by this project.");

  await assert.rejects(send(), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 78);
    assert.match(error.message, /blocked/);
    return true;
  });
});
