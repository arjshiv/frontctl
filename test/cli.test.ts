import { strict as assert } from "node:assert";
import test from "node:test";
import { parseGlobalOptions } from "../src/lib/cli.js";

test("parseGlobalOptions separates global flags from command args", () => {
  const parsed = parseGlobalOptions(["--dry-run", "doctor", "--json", "extra", "--no-color"]);
  assert.deepEqual(parsed.globals, { json: true, plain: false, color: false, dryRun: true });
  assert.deepEqual(parsed.rest, ["doctor", "extra"]);
});
