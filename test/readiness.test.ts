import { strict as assert } from "node:assert";
import test from "node:test";
import { buildUserReadiness } from "../src/lib/readiness.js";

test("buildUserReadiness reports ready only when every user gate passes", () => {
  const result = buildUserReadiness({
    frontAppInstalled: true,
    localProfileVisible: true,
    authValid: true,
    agentsInstalled: true,
  });

  assert.equal(result.ready, true);
  assert.equal(result.state, "ready");
  assert.equal(result.gates.every((gate) => gate.ok), true);
  assert.match(result.nextAction, /Do not send email/);
});

test("buildUserReadiness returns the first actionable missing setup gate", () => {
  assert.equal(buildUserReadiness({
    frontAppInstalled: false,
    localProfileVisible: false,
    authValid: false,
    agentsInstalled: false,
  }).state, "front-not-installed");

  assert.equal(buildUserReadiness({
    frontAppInstalled: true,
    localProfileVisible: false,
    authValid: false,
    agentsInstalled: false,
  }).state, "front-sign-in-missing");

  assert.equal(buildUserReadiness({
    frontAppInstalled: true,
    localProfileVisible: true,
    authValid: false,
    agentsInstalled: false,
  }).state, "live-mode-locked");

  assert.equal(buildUserReadiness({
    frontAppInstalled: true,
    localProfileVisible: true,
    authValid: true,
    agentsInstalled: false,
  }).state, "agent-skills-missing");
});
