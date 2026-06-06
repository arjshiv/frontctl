import { readPlistJson } from "../lib/plist.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function inspectFront(paths: FrontPaths = defaultFrontPaths()) {
  const plist = (await readPlistJson(paths.infoPlistPath)) as Record<string, unknown>;

  return {
    bundleIdentifier: plist.CFBundleIdentifier,
    displayName: plist.CFBundleDisplayName,
    version: plist.CFBundleShortVersionString,
    build: plist.CFBundleVersion,
    executable: plist.CFBundleExecutable,
    electronAsarIntegrity: plist.ElectronAsarIntegrity,
    urlTypes: plist.CFBundleURLTypes,
    userActivityTypes: plist.NSUserActivityTypes,
  };
}
