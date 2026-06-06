import { readAsarMetadata } from "../lib/asar.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function inspectAsar(paths: FrontPaths = defaultFrontPaths()) {
  return readAsarMetadata(paths.asarPath);
}
