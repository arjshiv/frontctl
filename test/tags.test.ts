import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { extractTags, listCachedTags, resolveTagIdentifier } from "../src/lib/tags.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("extractTags returns sanitized unique tag metadata", () => {
  const tags = extractTags({
    user: { email: "person@example.com" },
    tags: [
      { id: "tag-1", alias: "needs-reply", name: "Needs Reply", color: "#ff0000", email: "secret@example.com" },
      { id: "tag-duplicate", alias: "needs-reply", name: "Needs Reply Duplicate" },
      { id: "tag-2", name: "VIP" },
    ],
    nested: {
      tag: { type: "tag", uid: "tag-3", slug: "billing", display_name: "Billing" },
    },
  });

  assert.deepEqual(tags, [
    { id: "tag-3", alias: "billing", name: "Billing" },
    { id: "tag-1", alias: "needs-reply", name: "Needs Reply", color: "#ff0000" },
    { id: "tag-2", name: "VIP" },
  ]);
  assert.doesNotMatch(JSON.stringify(tags), /person@example|secret@example/);
});

test("listCachedTags reads cached Front tag documents", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-tags-cache"));
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
        { id: "tag-2", alias: "vip", name: "VIP" },
      ],
    }),
  );

  const result = await listCachedTags(paths.cacheDataPath);

  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.tags.map((tag) => tag.alias), ["needs-reply", "vip"]);
});

test("resolveTagIdentifier resolves alias, id, and unique name", () => {
  const tags = [
    { id: "tag-1", alias: "needs-reply", name: "Needs Reply" },
    { id: "tag-2", alias: "vip", name: "VIP" },
  ];

  assert.deepEqual(resolveTagIdentifier("needs-reply", tags), {
    input: "needs-reply",
    resolvedAlias: "needs-reply",
    matchedBy: "alias",
    tag: tags[0],
  });
  assert.deepEqual(resolveTagIdentifier("tag-2", tags), {
    input: "tag-2",
    resolvedAlias: "vip",
    matchedBy: "id",
    tag: tags[1],
  });
  assert.deepEqual(resolveTagIdentifier("Needs Reply", tags), {
    input: "Needs Reply",
    resolvedAlias: "needs-reply",
    matchedBy: "name",
    tag: tags[0],
  });
});

test("resolveTagIdentifier falls back to literal aliases and rejects ambiguous names", () => {
  const literal = resolveTagIdentifier("unknown-alias", []);
  assert.equal(literal.resolvedAlias, "unknown-alias");
  assert.equal(literal.matchedBy, "literal");
  assert.match(literal.warning ?? "", /literal/);

  assert.throws(
    () => resolveTagIdentifier("Support", [
      { id: "tag-1", alias: "support-one", name: "Support" },
      { id: "tag-2", alias: "support-two", name: "Support" },
    ]),
    /ambiguous/,
  );
});
