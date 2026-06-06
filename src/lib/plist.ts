import { readFile } from "node:fs/promises";
import { run } from "./process.js";

export async function readPlistJson(path: string): Promise<unknown> {
  const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path]);
  return JSON.parse(stdout);
}

export async function readPlistString(path: string): Promise<string> {
  return readFile(path, "utf8");
}
