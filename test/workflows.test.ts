import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { buildWorkflowReport } from "../src/lib/workflows.js";
import { syncStore } from "../src/lib/store.js";
import { makeTempDir } from "./helpers.js";

test("buildWorkflowReport creates simple agent workflows from recent local usage", async () => {
  const root = await makeTempDir("frontctl-workflows");
  const dbPath = join(root, "frontctl.sqlite");
  process.env.FRONTCTL_NOW = "2026-06-06T12:00:00.000Z";
  try {
    await syncStore([
      {
        source: "live-private",
        syncedAt: "2026-06-06T11:00:00.000Z",
        conversation: {
          id: "noise-archived-1",
          subject: "Weekly digest",
          status: "archived",
          contact: "Digest Sender",
          summary: "Newsletter summary",
          numMessages: 1,
          hasAttachments: false,
        },
      },
      {
        source: "live-private",
        syncedAt: "2026-06-06T11:00:00.000Z",
        conversation: {
          id: "noise-open-1",
          subject: "Monthly newsletter",
          status: "unassigned",
          contact: "Digest Sender",
          summary: "Read online and subscribe",
          numMessages: 1,
          hasAttachments: false,
        },
      },
      {
        source: "live-private",
        syncedAt: "2026-06-06T11:00:00.000Z",
        conversation: {
          id: "follow-up-1",
          subject: "Contract renewal meeting",
          status: "unassigned",
          contact: "Customer",
          summary: "Need scheduling and pricing follow-up",
          numMessages: 4,
          hasAttachments: true,
        },
      },
      {
        source: "live-private",
        syncedAt: "2026-06-06T11:00:00.000Z",
        conversation: {
          id: "risk-1",
          subject: "Critical security violation found",
          status: "unassigned",
          contact: "Security Tool",
          summary: "Critical risk alert",
          numMessages: 1,
          hasAttachments: false,
        },
      },
      {
        source: "live-private",
        syncedAt: "2025-01-01T00:00:00.000Z",
        conversation: {
          id: "old-1",
          subject: "Old ignored item",
          status: "unassigned",
        },
      },
    ], dbPath);

    const report = await buildWorkflowReport({ dbPath, actor: "Claude", months: 6 });
    const noise = report.workflows.find((workflow) => workflow.id === "noise-review");
    const followUp = report.workflows.find((workflow) => workflow.id === "follow-up");
    const opsRisk = report.workflows.find((workflow) => workflow.id === "ops-risk");
    const tagHygiene = report.workflows.find((workflow) => workflow.id === "tag-hygiene");
    const serialized = JSON.stringify(report);

    assert.equal(report.publicApiUsed, false);
    assert.equal(report.observedWindow.conversations, 4);
    assert.equal(noise?.items[0].id, "noise-open-1");
    assert.match(noise?.items[0].commands.archivePreview ?? "", /--actor Claude/);
    assert.match(noise?.items[0].commands.archivePreview ?? "", /--reason/);
    assert.equal(followUp?.items[0].id, "follow-up-1");
    assert.match(followUp?.items[0].commands.snoozePreview ?? "", /tomorrow-9am/);
    assert.ok(opsRisk?.items.some((item) => item.id === "risk-1"));
    assert.ok(tagHygiene?.items.some((item) => item.commands.tagList === "frontctl tag list --json"));
    assert.doesNotMatch(serialized, /old-1/);
  } finally {
    delete process.env.FRONTCTL_NOW;
  }
});

test("buildWorkflowReport filters open-action queues through current live inbox rows", async () => {
  const root = await makeTempDir("frontctl-workflows-live-filter");
  const dbPath = join(root, "frontctl.sqlite");
  process.env.FRONTCTL_NOW = "2026-06-06T12:00:00.000Z";
  try {
    await syncStore([
      {
        source: "live-private",
        syncedAt: "2026-06-06T10:00:00.000Z",
        conversation: {
          id: "stale-open",
          subject: "New Snowflake Notification",
          status: "unassigned",
          contact: "Snowflake Computing",
          summary: "Notification that has since been archived",
          numMessages: 1,
          hasAttachments: false,
        },
      },
      {
        source: "live-private",
        syncedAt: "2026-06-06T10:00:00.000Z",
        conversation: {
          id: "archived-pattern",
          subject: "[Trust Center] 1 critical security violation found",
          status: "archived",
          contact: "Snowflake Computing",
          summary: "Archived Snowflake signal",
          numMessages: 1,
          hasAttachments: false,
        },
      },
    ], dbPath);

    const report = await buildWorkflowReport({
      dbPath,
      actor: "Codex",
      months: 6,
      currentOpenRows: [
        {
          id: "live-open",
          subject: "Weekly digest",
          status: "unassigned",
          contact: "Digest Sender",
          summary: "Read online and subscribe",
          numMessages: 1,
          hasAttachments: false,
          bumpedAt: "2026-06-06T11:00:00.000Z",
        },
      ],
    });
    const serialized = JSON.stringify(report.workflows);

    assert.equal(report.liveVerification?.source, "live-private");
    assert.equal(report.liveVerification?.activeConversations, 1);
    assert.match(serialized, /live-open/);
    assert.doesNotMatch(serialized, /stale-open/);
  } finally {
    delete process.env.FRONTCTL_NOW;
  }
});
