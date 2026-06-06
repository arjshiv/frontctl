import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAsarMetadata } from "../src/lib/asar.js";

test("readAsarMetadata parses header counts and selected files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "frontctl-asar-test-"));
  const filePath = join(tempDir, "app.asar");
  const header = {
    files: {
      "package.json": { size: 2, offset: "0" },
      src: {
        files: {
          "front.js": { size: 3, offset: "2" },
        },
      },
    },
  };
  const headerJson = JSON.stringify(header);
  const headerSize = Buffer.byteLength(headerJson) + 8;
  const buf = Buffer.concat([
    uint32(4),
    uint32(headerSize),
    uint32(Buffer.byteLength(headerJson) + 4),
    uint32(Buffer.byteLength(headerJson)),
    Buffer.from(headerJson),
    Buffer.from("{}abc"),
  ]);
  await writeFile(filePath, buf);

  const metadata = await readAsarMetadata(filePath);
  assert.equal(metadata.fileCount, 2);
  assert.deepEqual(metadata.topLevelEntries, ["package.json", "src"]);
  assert.equal(metadata.selectedFiles[0]?.path, "package.json");
  assert.equal(metadata.selectedFiles[0]?.size, 2);
});

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}
