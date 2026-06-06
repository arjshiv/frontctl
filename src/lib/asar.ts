import { readFile } from "node:fs/promises";

export interface AsarFileEntry {
  path: string;
  size: number;
  offset?: string;
  unpacked?: boolean;
}

export interface AsarMetadata {
  headerSize: number;
  jsonSize: number;
  fileCount: number;
  topLevelEntries: string[];
  selectedFiles: AsarFileEntry[];
}

interface RawAsarNode {
  files?: Record<string, RawAsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
}

export async function readAsarMetadata(path: string): Promise<AsarMetadata> {
  const buffer = await readFile(path);
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString("utf8")) as RawAsarNode;

  const selectedPaths = [
    "package.json",
    "src/front.js",
    "src/services/app_config.js",
    "src/controls/main_window.js",
    "src/controls/window_bridge.js",
    "src/preload/preload.js",
    "src/util/front-desktop-protocol-handler.js",
  ];

  return {
    headerSize,
    jsonSize,
    fileCount: countFiles(header),
    topLevelEntries: Object.keys(header.files ?? {}).sort(),
    selectedFiles: selectedPaths.map((filePath) => {
      const entry = findEntry(header, filePath);
      return {
        path: filePath,
        size: entry?.size ?? 0,
        offset: entry?.offset,
        unpacked: entry?.unpacked,
      };
    }),
  };
}

function countFiles(node: RawAsarNode): number {
  if (!node.files) {
    return typeof node.size === "number" ? 1 : 0;
  }

  return Object.values(node.files).reduce((sum, child) => sum + countFiles(child), 0);
}

function findEntry(root: RawAsarNode, path: string): RawAsarNode | undefined {
  return path.split("/").reduce<RawAsarNode | undefined>((node, part) => node?.files?.[part], root);
}
