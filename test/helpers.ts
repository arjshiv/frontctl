import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FrontPaths } from "../src/lib/paths.js";

const execFileAsync = promisify(execFile);

export async function makeTempDir(name: string) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), `${name}-`));
}

export async function makeFakeFrontInstall(root: string): Promise<FrontPaths> {
  const appPath = join(root, "Front.app");
  const supportPath = join(root, "Application Support", "Front");
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  const asarPath = join(appPath, "Contents", "Resources", "app.asar");
  const cookiesPath = join(supportPath, "Cookies");
  const cacheDataPath = join(supportPath, "Cache", "Cache_Data");
  const localStorageLevelDbPath = join(supportPath, "Local Storage", "leveldb");
  const indexedDbLevelDbPath = join(
    supportPath,
    "IndexedDB",
    "https_app.frontapp.com_0.indexeddb.leveldb",
  );
  const preferencesPath = join(supportPath, "Preferences");

  await mkdir(join(appPath, "Contents", "Resources"), { recursive: true });
  await mkdir(cacheDataPath, { recursive: true });
  await mkdir(localStorageLevelDbPath, { recursive: true });
  await mkdir(indexedDbLevelDbPath, { recursive: true });
  await writeFile(infoPlistPath, frontInfoPlistXml());
  await writeFile(asarPath, makeFakeAsarBuffer());
  await writeFile(preferencesPath, "{}");
  await makeCookieDb(cookiesPath);

  return {
    appPath,
    infoPlistPath,
    asarPath,
    supportPath,
    cookiesPath,
    cacheDataPath,
    localStorageLevelDbPath,
    indexedDbLevelDbPath,
    preferencesPath,
  };
}

export async function makeCookieDb(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  const sql = `
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL,
      source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL
    );
    INSERT INTO cookies VALUES
      (1, 'app.frontapp.com', '', 'front.id', 'SECRET_COOKIE_VALUE', X'010203', '/', 42, 1, 1, 1, 1, 1, 1, 1, 2, 443, 1, 1, 0),
      (1, 'app.frontapp.com', '', 'front.id.sig', 'SECRET_SIG_VALUE', X'040506', '/', 43, 1, 1, 1, 1, 1, 1, 1, 2, 443, 1, 1, 0),
      (1, 'example.com', '', 'not-front', 'NOPE', X'070809', '/', 44, 1, 1, 1, 1, 1, 1, 1, 2, 443, 1, 1, 0);
  `;
  await execFileAsync("sqlite3", [path, sql]);
}

export async function writeFakeFrontCacheFixture(paths: FrontPaths) {
  const inbox = {
    fetch_at: Date.parse("2026-06-05T18:26:22.041Z"),
    conversations: [
      {
        id: "93727705553",
        subject: "Re: Your O-1A onboarding with Deel | Arjun Kannan",
        status: "unassigned",
        message_type: "email",
        contact: { name: "Ricky Espana (Support)", email: "ricky@example.com" },
        summary: "Deel onboarding follow-up with document next steps.",
        updated_at: Date.parse("2026-06-05T16:28:52.065Z"),
        bumped_at: Date.parse("2026-06-05T16:28:52.065Z"),
        num_messages: 4,
        has_attachments: true,
      },
      {
        id: "95907812305",
        subject: "Re: call on Friday 2026",
        status: "assigned",
        message_type: "email",
        contact: { display_name: "Erica Hernandez", email: "erica@example.com" },
        summary: "Scheduling a Friday call.",
        updated_at: Date.parse("2026-06-04T20:00:00.000Z"),
        num_messages: 2,
        has_attachments: false,
      },
      {
        id: "95843954129",
        subject: "Re: ResiDesk <> Sparrow Partners Yardi integration setup steps",
        status: "archived",
        message_type: "email",
        contact: { name: "Bryant Patterson" },
        summary: "Integration setup steps for ResiDesk and Sparrow Partners.",
        updated_at: Date.parse("2026-06-03T19:00:00.000Z"),
        num_messages: 3,
        has_attachments: false,
      },
    ],
  };
  const conversation = {
    id: "93727705553",
    updated_at: Date.parse("2026-06-05T16:28:52.065Z"),
    subject: "Re: Your O-1A onboarding with Deel | Arjun Kannan",
    timeline: [
      {
        id: "timeline-1",
        type: "message",
        date: Date.parse("2026-06-05T16:28:52.065Z"),
        message: {
          id: "message-1",
          subject: "Re: Your O-1A onboarding with Deel | Arjun Kannan",
          from: { name: "Ricky Espana (Support)" },
          text: "Thanks Arjun, please upload the remaining materials when ready.",
          has_attachments: true,
          attachments: [
            {
              id: "attachment-1",
              filename: "checklist.pdf",
              content_type: "application/pdf",
              size: 12345,
              url: "https://signed.example.invalid/SECRET_ATTACHMENT_TOKEN",
            },
          ],
        },
      },
      {
        id: "timeline-2",
        type: "comment",
        date: Date.parse("2026-06-05T17:00:00.000Z"),
        message: {
          id: "message-2",
          from: { name: "Arjun Kannan" },
          blurb: "Internal note about collecting O-1A evidence.",
        },
      },
    ],
  };

  await writeFile(
    join(paths.cacheDataPath, "inbox-cache"),
    `https://api2.frontapp.com/conversations/inbox?access_token=SECRET_CACHE_TOKEN\n${JSON.stringify(inbox)}\ntrailing-metadata`,
  );
  await writeFile(
    join(paths.cacheDataPath, "conversation-cache"),
    `https://api2.frontapp.com/conversations/93727705553?access_token=SECRET_CACHE_TOKEN\n${JSON.stringify(conversation)}\ntrailing-metadata`,
  );
}

export async function writeFakeFrontSession(
  sessionPath: string,
  options: { expiresAt?: string; cookieHeader?: string } = {},
) {
  await mkdir(join(sessionPath, ".."), { recursive: true });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", frontSessionEncryptionKeyForTest(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ cookieHeader: options.cookieHeader ?? "front.id=test; front.id.sig=test" }), "utf8"),
    cipher.final(),
  ]);
  await writeFile(
    sessionPath,
    JSON.stringify(
      {
        version: 1,
        host: "app.frontapp.com",
        cookieNames: ["front.id", "front.id.sig"],
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(sessionPath, 0o600);
}

function frontSessionEncryptionKeyForTest() {
  return createHash("sha256").update(`${homedir()}:frontctl-local-session:v1`).digest();
}

export function frontInfoPlistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Front</string>
  <key>CFBundleExecutable</key>
  <string>Front</string>
  <key>CFBundleIdentifier</key>
  <string>com.frontapp.Front</string>
  <key>CFBundleShortVersionString</key>
  <string>9.9.9-test</string>
  <key>CFBundleVersion</key>
  <string>999</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Open</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>front</string>
        <string>frontapp</string>
      </array>
    </dict>
  </array>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright test</string>
</dict>
</plist>`;
}

export function makeFakeAsarBuffer() {
  const header = {
    files: {
      "package.json": { size: 2, offset: "0" },
      src: {
        files: {
          "front.js": { size: 3, offset: "2" },
          services: {
            files: {
              "app_config.js": { size: 4, offset: "5" },
            },
          },
          controls: {
            files: {
              "main_window.js": { size: 5, offset: "9" },
              "window_bridge.js": { size: 6, offset: "14" },
            },
          },
          preload: {
            files: {
              "preload.js": { size: 7, offset: "20" },
            },
          },
          util: {
            files: {
              "front-desktop-protocol-handler.js": { size: 8, offset: "27" },
            },
          },
        },
      },
    },
  };
  const headerJson = JSON.stringify(header);
  const headerSize = Buffer.byteLength(headerJson) + 8;
  return Buffer.concat([
    uint32(4),
    uint32(headerSize),
    uint32(Buffer.byteLength(headerJson) + 4),
    uint32(Buffer.byteLength(headerJson)),
    Buffer.from(headerJson),
    Buffer.from("{}abc123456789012345678901234567890"),
  ]);
}

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}
