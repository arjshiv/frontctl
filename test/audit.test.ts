import { strict as assert } from "node:assert";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { auditMutation, listAuditEntries } from "../src/lib/audit.js";
import { makeTempDir } from "./helpers.js";

test("listAuditEntries returns redacted newest-first mutation entries", async () => {
  const auditPath = join(await makeTempDir("frontctl-audit"), "audit.jsonl");
  await auditMutation({
    action: "comment.add",
    mode: "dry-run",
    conversationId: "conversation-1",
    method: "POST",
    path: "/comments",
    body: { body: "SECRET COMMENT BODY" },
  }, auditPath);
  await appendFile(auditPath, "{not-json}\n");
  await auditMutation({
    action: "tag.add",
    mode: "execute",
    conversationId: "conversation-2",
    method: "POST",
    path: "/tag/needs-reply",
  }, auditPath);

  const result = await listAuditEntries({ auditPath, limit: 10 });
  const commentOnly = await listAuditEntries({ auditPath, action: "comment.add" });
  const conversationOnly = await listAuditEntries({ auditPath, conversationId: "conversation-2" });
  const executeOnly = await listAuditEntries({ auditPath, mode: "execute" });

  assert.equal(result.count, 2);
  assert.deepEqual(result.entries.map((entry) => entry.action), ["tag.add", "comment.add"]);
  assert.equal(commentOnly.count, 1);
  assert.equal(commentOnly.entries[0].conversationId, "conversation-1");
  assert.deepEqual(commentOnly.entries[0].bodyKeys, ["body"]);
  assert.match(commentOnly.entries[0].bodySha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(conversationOnly.count, 1);
  assert.equal(conversationOnly.entries[0].action, "tag.add");
  assert.equal(executeOnly.entries[0].action, "tag.add");
  assert.doesNotMatch(JSON.stringify(result), /SECRET COMMENT BODY/);
});
