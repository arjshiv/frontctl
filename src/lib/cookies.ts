import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.js";

export interface CookieInventoryRow {
  host: string;
  name: string;
  httpOnly: boolean;
  secure: boolean;
  persistent: boolean;
  hasEncryptedValue: boolean;
  expiresUtc: string;
}

export interface CookieInventory {
  sourcePath: string;
  temporaryCopyRemoved: boolean;
  frontCookieCount: number;
  cookies: CookieInventoryRow[];
  note: string;
}

export async function inspectCookieInventory(cookiesPath: string): Promise<CookieInventory> {
  const tempDir = await mkdtemp(join(tmpdir(), "frontctl-cookies-"));
  const copiedPath = join(tempDir, "Cookies.sqlite");

  try {
    await copyFile(cookiesPath, copiedPath);
    const sql = [
      "select host_key as host, name, is_httponly as httpOnly, is_secure as secure,",
      "is_persistent as persistent, length(encrypted_value) > 0 as hasEncryptedValue,",
      "expires_utc as expiresUtc",
      "from cookies",
      "where host_key like '%frontapp%' or host_key like '%front.com%'",
      "order by host_key, name;",
    ].join(" ");
    const { stdout } = await run("sqlite3", ["-json", copiedPath, sql], 1024 * 1024);
    const rawRows = stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [];
    const cookies = rawRows.map((row) => ({
      host: String(row.host ?? ""),
      name: String(row.name ?? ""),
      httpOnly: row.httpOnly === 1,
      secure: row.secure === 1,
      persistent: row.persistent === 1,
      hasEncryptedValue: row.hasEncryptedValue === 1,
      expiresUtc: String(row.expiresUtc ?? ""),
    }));

    return {
      sourcePath: cookiesPath,
      temporaryCopyRemoved: true,
      frontCookieCount: cookies.length,
      cookies,
      note: "Cookie values are intentionally not read or printed. This command inventories names and flags only.",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
