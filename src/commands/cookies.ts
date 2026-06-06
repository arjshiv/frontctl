import { inspectCookieInventory } from "../lib/cookies.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function inspectCookies(paths: FrontPaths = defaultFrontPaths()) {
  return inspectCookieInventory(paths.cookiesPath);
}
