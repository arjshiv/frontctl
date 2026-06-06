import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export interface PathStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  type?: "file" | "directory" | "other";
  sizeBytes?: number;
  mtime?: string;
}

export async function pathStatus(path: string): Promise<PathStatus> {
  try {
    const info = await stat(path);
    let readable = true;
    try {
      await access(path, constants.R_OK);
    } catch {
      readable = false;
    }

    return {
      path,
      exists: true,
      readable,
      type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      sizeBytes: info.size,
      mtime: info.mtime.toISOString(),
    };
  } catch {
    return {
      path,
      exists: false,
      readable: false,
    };
  }
}
