import { homedir } from "node:os";
import { join } from "node:path";

export interface FrontPaths {
  appPath: string;
  infoPlistPath: string;
  asarPath: string;
  supportPath: string;
  cookiesPath: string;
  cacheDataPath: string;
  localStorageLevelDbPath: string;
  indexedDbLevelDbPath: string;
  preferencesPath: string;
}

export function defaultFrontPaths(env: NodeJS.ProcessEnv = process.env): FrontPaths {
  const home = homedir();
  const appPath = env.FRONTCTL_FRONT_APP_PATH ?? "/Applications/Front.app";
  const supportPath =
    env.FRONTCTL_FRONT_SUPPORT_PATH ?? join(home, "Library", "Application Support", "Front");

  return {
    appPath,
    infoPlistPath: env.FRONTCTL_FRONT_INFO_PLIST_PATH ?? join(appPath, "Contents", "Info.plist"),
    asarPath: env.FRONTCTL_FRONT_ASAR_PATH ?? join(appPath, "Contents", "Resources", "app.asar"),
    supportPath,
    cookiesPath: env.FRONTCTL_FRONT_COOKIES_PATH ?? join(supportPath, "Cookies"),
    cacheDataPath: env.FRONTCTL_FRONT_CACHE_DATA_PATH ?? join(supportPath, "Cache", "Cache_Data"),
    localStorageLevelDbPath:
      env.FRONTCTL_FRONT_LOCAL_STORAGE_PATH ?? join(supportPath, "Local Storage", "leveldb"),
    indexedDbLevelDbPath:
      env.FRONTCTL_FRONT_INDEXED_DB_PATH ??
      join(supportPath, "IndexedDB", "https_app.frontapp.com_0.indexeddb.leveldb"),
    preferencesPath: env.FRONTCTL_FRONT_PREFERENCES_PATH ?? join(supportPath, "Preferences"),
  };
}
