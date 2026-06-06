import { strict as assert } from "node:assert";
import test from "node:test";
import { onboarding } from "../src/commands/onboarding.js";

test("onboarding is non-technical and reinforces safety boundaries", async () => {
  const result = await onboarding();

  assert.match(result.audience, /non-technical/i);
  assert.match(result.promise, /No Front API token/i);
  assert.ok(result.steps.length >= 5);
  assert.ok(result.steps.some((step) => step.check === "frontctl doctor --json"));
  assert.ok(result.steps.some((step) => step.check === "frontctl readiness --json"));
  assert.match(JSON.stringify(result), /never send email/i);
});
