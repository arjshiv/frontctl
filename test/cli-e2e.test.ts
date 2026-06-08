import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontCacheFixture, writeFakeFrontSession } from "./helpers.js";
import type { FrontPaths } from "../src/lib/paths.js";

const execFileAsync = promisify(execFile);

test("CLI version supports human and JSON install verification", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };

  const human = await execFileAsync("node", ["dist/src/cli.js", "--version"]);
  assert.equal(human.stdout.trim(), pkg.version);

  const structured = await execFileAsync("node", ["dist/src/cli.js", "version", "--json"]);
  const result = JSON.parse(structured.stdout) as { name: string; version: string };
  assert.equal(result.name, pkg.name);
  assert.equal(result.version, pkg.version);
});

test("CLI doctor works against overridden fake Front paths", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli"));
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "doctor", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as { ok: boolean; front: { version: string } };

  assert.equal(result.ok, true);
  assert.equal(result.front.version, "9.9.9-test");
});

test("CLI front inspect works against overridden fake Front paths", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-front"));
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "front", "inspect", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as { bundleIdentifier: string; version: string };

  assert.equal(result.bundleIdentifier, "com.frontapp.Front");
  assert.equal(result.version, "9.9.9-test");
});

test("CLI asar inspect works against overridden fake Front paths", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-asar"));
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "asar", "inspect", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as { fileCount: number; selectedFiles: Array<{ path: string }> };

  assert.equal(result.fileCount, 7);
  assert.deepEqual(
    result.selectedFiles.map((file) => file.path),
    [
      "package.json",
      "src/front.js",
      "src/services/app_config.js",
      "src/controls/main_window.js",
      "src/controls/window_bridge.js",
      "src/preload/preload.js",
      "src/util/front-desktop-protocol-handler.js",
    ],
  );
});

test("CLI cookies inspect redacts cookie values end to end", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-cookies"));
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "cookies", "inspect", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as { frontCookieCount: number; cookies: Array<{ name: string }> };

  assert.equal(result.frontCookieCount, 2);
  assert.deepEqual(
    result.cookies.map((cookie) => cookie.name),
    ["front.id", "front.id.sig"],
  );
  assert.doesNotMatch(stdout, /SECRET_COOKIE_VALUE|SECRET_SIG_VALUE|NOPE/);
});

test("CLI onboarding returns non-technical setup steps", async () => {
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "onboarding", "--json"]);
  const result = JSON.parse(stdout) as { audience: string; steps: unknown[] };

  assert.match(result.audience, /non-technical/i);
  assert.ok(result.steps.length >= 5);
});

test("CLI auth check is non-prompting and reports missing unlock session", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-auth"));
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "auth", "check", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as {
    exists: boolean;
    valid: boolean;
    note: string;
    security: { authorizationModel: string; promptsOnCheck: boolean; promptsOnLiveRead: boolean };
  };

  assert.equal(result.exists, false);
  assert.equal(result.valid, false);
  assert.equal(result.security.authorizationModel, "one-time-keychain-unlock");
  assert.equal(result.security.promptsOnCheck, false);
  assert.equal(result.security.promptsOnLiveRead, false);
  assert.match(result.note, /auth unlock/);
});

test("CLI auth security reports prompt behavior without requiring Front", async () => {
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "auth", "security", "--json"]);
  const result = JSON.parse(stdout) as {
    authorizationModel: string;
    keychainService: string;
    promptsOnCheck: boolean;
    promptsOnUnlock: boolean;
    promptsOnExplicitKeychainUnlock: boolean;
    promptsOnLiveRead: boolean;
  };

  assert.equal(result.authorizationModel, "one-time-keychain-unlock");
  assert.equal(result.keychainService, "Front Safe Storage");
  assert.equal(result.promptsOnCheck, false);
  assert.equal(result.promptsOnUnlock, false);
  assert.equal(result.promptsOnExplicitKeychainUnlock, true);
  assert.equal(result.promptsOnLiveRead, false);
});

test("CLI auth unlock reuses an existing session without touching Keychain", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-auth-reuse"));
  const env = envForPaths(paths);
  await writeFakeFrontSession(env.FRONTCTL_SESSION_PATH as string);
  env.FRONTCTL_FRONT_COOKIES_PATH = join(paths.supportPath, "missing-cookies.sqlite");

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "auth", "unlock", "--json"], { env });
  const result = JSON.parse(stdout) as {
    valid: boolean;
    keychainAccessed: boolean;
    reusedExisting: boolean;
    note: string;
    security: { promptsOnCheck: boolean };
  };

  assert.equal(result.valid, true);
  assert.equal(result.keychainAccessed, false);
  assert.equal(result.reusedExisting, true);
  assert.equal(result.security.promptsOnCheck, false);
  assert.match(result.note, /Keychain was not accessed/);
});

test("CLI browser list reports default browser and sanitized profiles", async () => {
  const root = await makeTempDir("frontctl-cli-browser");
  const chromeRoot = join(root, "Chrome");
  const edgeRoot = join(root, "Edge");
  await mkdir(join(edgeRoot, "Default"), { recursive: true });
  await mkdir(join(chromeRoot, "Default", "Network"), { recursive: true });
  await writeFile(join(edgeRoot, "Default", "Cookies"), "SECRET_EDGE_COOKIE_DB");
  await writeFile(join(chromeRoot, "Default", "Network", "Cookies"), "SECRET_CHROME_COOKIE_DB");

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "browser", "list", "--json"], {
    env: {
      ...process.env,
      FRONTCTL_DEFAULT_BROWSER: "edge",
      FRONTCTL_EDGE_USER_DATA_DIR: edgeRoot,
      FRONTCTL_CHROME_USER_DATA_DIR: chromeRoot,
    },
  });
  const result = JSON.parse(stdout) as {
    defaultBrowser: { browser: string };
    profiles: Array<{ browser: string; cookiesExists: boolean }>;
  };

  assert.equal(result.defaultBrowser.browser, "edge");
  assert.ok(result.profiles.some((profile) => profile.browser === "edge" && profile.cookiesExists));
  assert.ok(result.profiles.some((profile) => profile.browser === "chrome" && profile.cookiesExists));
  assert.doesNotMatch(stdout, /SECRET_EDGE_COOKIE_DB|SECRET_CHROME_COOKIE_DB/);
});

test("CLI browser inspect reports Safari as open-only", async () => {
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "browser", "inspect", "--browser", "safari", "--json"]);
  const result = JSON.parse(stdout) as {
    profiles: Array<{ browser: string; supportsCookieImport: boolean }>;
  };

  assert.equal(result.profiles[0].browser, "safari");
  assert.equal(result.profiles[0].supportsCookieImport, false);
});

test("CLI inbox list reads cached Front conversations without leaking cache tokens", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-inbox"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "inbox", "list", "--offline-cache", "--limit", "1", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as {
    count: number;
    conversations: Array<{ id: string; subject: string; status: string }>;
  };

  assert.equal(result.count, 1);
  assert.equal(result.conversations[0].id, "93727705553");
  assert.equal(result.conversations[0].status, "unassigned");
  assert.doesNotMatch(stdout, /SECRET_CACHE_TOKEN|access_token|api2\.frontapp\.com/);
});

test("CLI inbox list can include archived cached Front conversations", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-inbox-all"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "inbox", "list", "--offline-cache", "--all", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as {
    conversations: Array<{ id: string; status: string }>;
  };

  assert.ok(result.conversations.some((conversation) => conversation.status === "archived"));
});

test("CLI read returns cached conversation timeline", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-read"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "read", "93727705553", "--offline-cache", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as {
    id: string;
    timeline: Array<{ from: string; text: string; attachments?: Array<{ filename: string; urlPresent: boolean }> }>;
  };

  assert.equal(result.id, "93727705553");
  assert.equal(result.timeline.length, 2);
  assert.match(result.timeline[0].text, /upload the remaining materials/);
  assert.equal(result.timeline[0].attachments?.[0].filename, "checklist.pdf");
  assert.doesNotMatch(stdout, /SECRET_CACHE_TOKEN|access_token|api2\.frontapp\.com/);
  assert.doesNotMatch(stdout, /SECRET_ATTACHMENT_TOKEN|signed\.example/);
});

test("CLI attachments list returns sanitized cached attachment metadata", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-attachments"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "attachments", "list", "93727705553", "--offline-cache", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as { count: number; attachments: Array<{ filename: string; urlPresent: boolean }> };

  assert.equal(result.count, 1);
  assert.equal(result.attachments[0].filename, "checklist.pdf");
  assert.equal(result.attachments[0].urlPresent, true);
  assert.doesNotMatch(stdout, /SECRET_ATTACHMENT_TOKEN|signed\.example/);
});

test("CLI summarize returns a compact cached conversation summary", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-summary"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "summarize", "93727705553", "--offline-cache", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as {
    summary: { subject: string; suggestedNextStep: string; timelineHighlights: unknown[] };
  };

  assert.equal(result.summary.subject, "Re: Your O-1A onboarding with Deel | Arjun Kannan");
  assert.ok(result.summary.timelineHighlights.length > 0);
  assert.match(result.summary.suggestedNextStep, /reply|waiting|review/i);
});

test("CLI triage inbox groups cached conversations without leaking cache tokens", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-triage"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "triage", "inbox", "--offline-cache", "--all", "--json"], {
    env: envForPaths(paths),
  });
  const markdown = await execFileAsync(
    "node",
    ["dist/src/cli.js", "triage", "inbox", "--offline-cache", "--limit", "2", "--format", "markdown"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as {
    count: number;
    buckets: {
      withAttachments: Array<{ id: string; commands: { read: string } }>;
      archived: Array<{ id: string }>;
    };
  };

  assert.equal(result.count, 3);
  assert.deepEqual(result.buckets.withAttachments.map((item) => item.id), ["93727705553"]);
  assert.deepEqual(result.buckets.archived.map((item) => item.id), ["95843954129"]);
  assert.match(result.buckets.withAttachments[0].commands.read, /frontctl read 93727705553 --json/);
  assert.match(markdown.stdout, /^# Front Inbox Triage/m);
  assert.doesNotMatch(`${stdout}\n${markdown.stdout}`, /SECRET_CACHE_TOKEN|access_token|api2\.frontapp\.com|SECRET_ATTACHMENT_TOKEN/);
});

test("CLI read supports markdown format without leaking cache tokens", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-read-markdown"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "read", "93727705553", "--offline-cache", "--format", "markdown"],
    { env: envForPaths(paths) },
  );

  assert.match(stdout, /^# Re: Your O-1A onboarding with Deel \| Arjun Kannan/m);
  assert.match(stdout, /## Timeline/);
  assert.match(stdout, /checklist\.pdf/);
  assert.doesNotMatch(stdout, /SECRET_CACHE_TOKEN|SECRET_ATTACHMENT_TOKEN|access_token|signed\.example/);
});

test("CLI search markdown format does not include format value in the query", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-search-markdown"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "search", "Friday", "--offline-cache", "--format", "markdown", "--limit", "1"],
    { env: envForPaths(paths) },
  );

  assert.match(stdout, /^# Search: Friday/m);
  assert.doesNotMatch(stdout, /Search: Friday markdown/);
  assert.match(stdout, /95907812305/);
});

test("CLI summarize supports plain format", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-summary-plain"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "summarize", "93727705553", "--offline-cache", "--format", "plain"],
    { env: envForPaths(paths) },
  );

  assert.match(stdout, /Next step:/);
  assert.match(stdout, /Highlights:/);
});

test("CLI open print-only builds Front deep link without launching", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-open"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );

  const [{ stdout }, { stdout: webStdout }] = await Promise.all([
    execFileAsync(
      "node",
      ["dist/src/cli.js", "open", "93727705553", "--print-only", "--json"],
      { env: envForPaths(paths) },
    ),
    execFileAsync(
      "node",
      ["dist/src/cli.js", "open", "93727705553", "--web", "--print-only", "--json"],
      { env: envForPaths(paths) },
    ),
  ]);
  const result = JSON.parse(stdout) as { opened: boolean; deeplink: string; appUrl: string; target: string };
  const webResult = JSON.parse(webStdout) as { opened: boolean; deeplink: string; appUrl: string; target: string };

  assert.equal(result.opened, false);
  assert.match(result.deeplink, /^frontapp:\/go\/cell-00017\/api\/1\/companies\//);
  assert.match(result.appUrl, /^https:\/\/app\.frontapp\.com\/open\/cell-00017\/api\/1\/companies\//);
  assert.equal(result.target, result.deeplink);
  assert.equal(webResult.target, webResult.appUrl);
});

test("CLI setup reports install steps and agent prompt", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-setup"));
  const home = await makeTempDir("frontctl-cli-setup-home");

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "setup", "--json"], {
    env: { ...envForPaths(paths), ...envForHome(home) },
  });
  const result = JSON.parse(stdout) as {
    install: { development: string[] };
    agents: { status: { allInstalled: boolean }; install?: unknown; installCommand: string; chatgptPromptCommand: string };
    userReadiness: { ready: boolean; state: string; nextAction: string };
    nextSteps: string[];
    agentPrompt: string;
  };

  assert.ok(result.install.development.includes("npm link"));
  assert.equal(result.agents.status.allInstalled, false);
  assert.equal(result.agents.install, undefined);
  assert.equal(result.userReadiness.ready, false);
  assert.equal(result.userReadiness.state, "live-mode-locked");
  assert.match(result.userReadiness.nextAction, /Enable Live Mode|auth unlock/);
  assert.match(result.agents.installCommand, /frontctl setup --agent all --yes --json/);
  assert.equal(result.agents.chatgptPromptCommand, "frontctl agents prompt --agent chatgpt --json");
  assert.ok(result.nextSteps.some((step) => step === "frontctl workflows daily --actor Codex --json"));
  assert.match(result.agentPrompt, /frontctl workflows daily --actor Codex --json/);
  assert.match(result.agentPrompt, /Do not send email/);
});

test("CLI setup ready state does not recommend enabling live mode again after CDP proof", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-setup-cdp-ready"));
  const home = await makeTempDir("frontctl-cli-setup-cdp-ready-home");
  await writeFakeFrontCacheFixture(paths);

  const env = {
    ...envForPaths(paths),
    ...envForHome(home),
    FRONTCTL_CDP_BRIDGE: "1",
    FRONTCTL_CDP_BRIDGE_PROOF_PATH: join(home, ".frontctl", "browser-bridge.json"),
    FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT: JSON.stringify({
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "32390a17805cd26f7349",
      teamId: "6088721",
    }),
    FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES: JSON.stringify({
      "/boot/app/8": { user: { id: "usr_123" } },
    }),
  };

  await execFileAsync("node", ["dist/src/cli.js", "setup", "--agent", "all", "--yes", "--enable-live", "--json"], { env });
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "setup", "--json"], { env });
  const result = JSON.parse(stdout) as {
    userReadiness: { ready: boolean; state: string };
    auth: { valid: boolean };
    bridge: { status: { proofValid: boolean } };
    nextSteps: string[];
  };

  assert.equal(result.userReadiness.ready, true);
  assert.equal(result.userReadiness.state, "ready");
  assert.equal(result.auth.valid, false);
  assert.equal(result.bridge.status.proofValid, true);
  assert.ok(result.nextSteps.includes("frontctl inbox list --limit 20 --json"));
  assert.ok(!result.nextSteps.includes("frontctl setup --enable-live --json"));
  assert.ok(!result.nextSteps.includes("frontctl discovery launch --remote-debugging-port 9222 --json"));
});

test("CLI setup enable-live is idempotent when a non-prompting session is already valid", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-setup-session-ready"));
  await writeFakeFrontCacheFixture(paths);
  const env = envForPaths(paths);
  await writeFakeFrontSession(env.FRONTCTL_SESSION_PATH as string);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "setup", "--enable-live", "--json"], { env });
  const result = JSON.parse(stdout) as {
    auth: { valid: boolean };
    bridge: { test?: unknown; enableSkipped?: boolean; enableNote?: string };
    userReadiness: { state: string };
  };

  assert.equal(result.auth.valid, true);
  assert.notEqual(result.userReadiness.state, "live-mode-locked");
  assert.equal(result.bridge.test, undefined);
  assert.equal(result.bridge.enableSkipped, true);
  assert.match(result.bridge.enableNote ?? "", /already available/);
});

test("CLI setup distinguishes installed Front from incomplete sign-in state", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-setup-partial"));
  const home = await makeTempDir("frontctl-cli-setup-partial-home");
  paths.cookiesPath = `${paths.cookiesPath}.missing`;

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "setup", "--json"], {
    env: { ...envForPaths(paths), ...envForHome(home) },
  });
  const result = JSON.parse(stdout) as {
    ok: boolean;
    front: { installed: boolean; appInstalled: boolean; bundleReady: boolean; localProfileVisible: boolean };
    userReadiness: { ready: boolean; state: string; nextAction: string };
    failureMode: string;
    nextSteps: string[];
  };

  assert.equal(result.ok, false);
  assert.equal(result.front.installed, true);
  assert.equal(result.front.appInstalled, true);
  assert.equal(result.front.bundleReady, true);
  assert.equal(result.front.localProfileVisible, false);
  assert.equal(result.userReadiness.ready, false);
  assert.equal(result.userReadiness.state, "front-sign-in-missing");
  assert.match(result.userReadiness.nextAction, /sign in/i);
  assert.equal(result.failureMode, "front-not-ready");
  assert.ok(result.nextSteps.some((step) => /sign in|inbox/i.test(step)));
});

test("CLI readiness returns concise non-prompting user gates", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-readiness"));
  const home = await makeTempDir("frontctl-cli-readiness-home");

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "readiness", "--json"], {
    env: { ...envForPaths(paths), ...envForHome(home) },
  });
  const result = JSON.parse(stdout) as {
    ok: boolean;
    userReadiness: { ready: boolean; state: string; nextAction: string; gates: Array<{ name: string }> };
    auth: { promptsOnCheck: boolean; promptsOnLiveRead: boolean };
    safety: { touchesKeychain: boolean; sendsEmail: boolean; publicApiUsed: boolean };
  };

  assert.equal(result.ok, false);
  assert.equal(result.userReadiness.ready, false);
  assert.equal(result.userReadiness.state, "live-mode-locked");
  assert.equal(result.userReadiness.gates.length, 4);
  assert.equal(result.auth.promptsOnCheck, false);
  assert.equal(result.auth.promptsOnLiveRead, false);
  assert.equal(result.safety.touchesKeychain, false);
  assert.equal(result.safety.sendsEmail, false);
  assert.equal(result.safety.publicApiUsed, false);
});

test("CLI setup can install selected agent skills with --yes", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-setup-install"));
  const home = await makeTempDir("frontctl-cli-setup-install-home");

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "setup", "--agent", "all", "--yes", "--json"],
    { env: { ...envForPaths(paths), ...envForHome(home) } },
  );
  const result = JSON.parse(stdout) as {
    agents: {
      status: { allInstalled: boolean };
      install: { installed: boolean; count: number; skills: Array<{ destinationPath: string }> };
    };
  };

  assert.equal(result.agents.install.installed, true);
  assert.equal(result.agents.install.count, 2);
  assert.equal(result.agents.status.allInstalled, true);
  for (const skill of result.agents.install.skills) {
    assert.equal(await pathExists(skill.destinationPath), true);
  }
});

test("CLI agents check reports installable Codex and Claude skills", async () => {
  const home = await makeTempDir("frontctl-cli-agents-home");
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "agents", "check", "--json"], {
    env: envForHome(home),
  });
  const result = JSON.parse(stdout) as {
    count: number;
    allInstalled: boolean;
    skills: Array<{ agent: string; sourcePath: string; destinationPath: string; sourceExists: boolean; installed: boolean }>;
  };

  assert.equal(result.count, 2);
  assert.equal(result.allInstalled, false);
  assert.deepEqual(result.skills.map((skill) => skill.agent), ["codex", "claude"]);
  assert.ok(result.skills.every((skill) => skill.sourceExists));
  assert.ok(result.skills.every((skill) => !skill.installed));
  assert.match(result.skills[0].sourcePath, /skills\/codex\/frontctl\/SKILL\.md$/);
  assert.match(result.skills[0].destinationPath, /frontctl-cli-agents-home-.+\/\.codex\/skills\/frontctl\/SKILL\.md$/);
});

test("CLI agents install is dry-run without --yes", async () => {
  const home = await makeTempDir("frontctl-cli-agents-dry-home");
  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "agents", "install", "--agent", "codex", "--json"],
    { env: envForHome(home) },
  );
  const result = JSON.parse(stdout) as { installed: boolean; skills: Array<{ destinationPath: string; note: string }> };

  assert.equal(result.installed, false);
  assert.match(result.skills[0].note, /Dry run/);
  assert.equal(await pathExists(result.skills[0].destinationPath), false);
});

test("CLI agents install copies selected skill with --yes", async () => {
  const home = await makeTempDir("frontctl-cli-agents-install-home");
  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "agents", "install", "--agent", "claude", "--yes", "--json"],
    { env: envForHome(home) },
  );
  const result = JSON.parse(stdout) as { installed: boolean; count: number; skills: Array<{ agent: string; destinationPath: string }> };

  assert.equal(result.installed, true);
  assert.equal(result.count, 1);
  assert.equal(result.skills[0].agent, "claude");
  const installed = await readFile(result.skills[0].destinationPath, "utf8");
  assert.match(installed, /^---\nname: frontctl/m);
  assert.match(installed, /Never send email/);
});

test("CLI agents prompt exports ChatGPT instructions", async () => {
  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "agents", "prompt", "--agent", "chatgpt", "--json"],
  );
  const result = JSON.parse(stdout) as {
    count: number;
    prompts: Array<{ agent: string; installable: boolean; prompt: string; note: string }>;
  };

  assert.equal(result.count, 1);
  assert.equal(result.prompts[0].agent, "chatgpt");
  assert.equal(result.prompts[0].installable, false);
  assert.match(result.prompts[0].prompt, /local terminal or Codex-style command execution access/);
  assert.match(result.prompts[0].note, /Paste these instructions into ChatGPT/);
});

test("CLI sync indexes cached Front data into local store", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-sync"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "sync", "--offline-cache", "--all", "--json"], {
    env: envForPaths(paths),
  });
  const result = JSON.parse(stdout) as { source: string; conversations: number; timelineItems: number };

  assert.equal(result.source, "cache");
  assert.equal(result.conversations, 3);
  assert.ok(result.timelineItems >= 2);
});

test("CLI cache search/read/stats use the local SQLite store", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-cache"));
  await writeFakeFrontCacheFixture(paths);
  const env = envForPaths(paths);
  await execFileAsync("node", ["dist/src/cli.js", "sync", "--offline-cache", "--all", "--json"], { env });

  const [
    { stdout: searchStdout },
    { stdout: readStdout },
    { stdout: statsStdout },
    { stdout: markdownStdout },
    { stdout: statsMarkdownStdout },
  ] = await Promise.all([
    execFileAsync("node", ["dist/src/cli.js", "cache", "search", "remaining materials", "--json"], { env }),
    execFileAsync("node", ["dist/src/cli.js", "cache", "read", "93727705553", "--offline-cache", "--json"], { env }),
    execFileAsync("node", ["dist/src/cli.js", "cache", "stats", "--json"], { env }),
    execFileAsync("node", ["dist/src/cli.js", "cache", "read", "93727705553", "--offline-cache", "--format", "markdown"], { env }),
    execFileAsync("node", ["dist/src/cli.js", "cache", "stats", "--format", "markdown"], { env }),
  ]);
  const search = JSON.parse(searchStdout) as { count: number; conversations: Array<{ id: string }>; freshness: { fresh: boolean } };
  const read = JSON.parse(readStdout) as { conversation?: { id: string }; timeline: unknown[]; freshness: { fresh: boolean } };
  const stats = JSON.parse(statsStdout) as { conversations: number; attachments: number; ftsRows: number; freshness: { fresh: boolean } };

  assert.equal(search.count, 1);
  assert.equal(search.conversations[0].id, "93727705553");
  assert.equal(search.freshness.fresh, true);
  assert.equal(read.conversation?.id, "93727705553");
  assert.ok(read.timeline.length >= 2);
  assert.equal(read.freshness.fresh, true);
  assert.equal(stats.conversations, 3);
  assert.equal(stats.attachments, 1);
  assert.equal(stats.ftsRows, 3);
  assert.equal(stats.freshness.fresh, true);
  assert.match(markdownStdout, /^# Re: Your O-1A onboarding with Deel \| Arjun Kannan/m);
  assert.doesNotMatch(markdownStdout, /SECRET_CACHE_TOKEN|SECRET_ATTACHMENT_TOKEN|signed\.example/);
  assert.match(statsMarkdownStdout, /^# Front Local Cache/m);
  assert.match(statsMarkdownStdout, /Fresh: yes/);
});

test("CLI memory init writes a local preference profile from the store", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-memory"));
  await writeFakeFrontCacheFixture(paths);
  const env = envForPaths(paths);

  await execFileAsync("node", ["dist/src/cli.js", "sync", "--offline-cache", "--all", "--json"], { env });
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "memory", "init", "--json"], { env });
  const result = JSON.parse(stdout) as {
    written: boolean;
    profile: {
      privacy: { localOnly: boolean; storesRawTimelineBodies: boolean };
      corpus: { conversations: number };
      suggestedNextCommands: string[];
    };
  };

  assert.equal(result.written, true);
  assert.equal(result.profile.privacy.localOnly, true);
  assert.equal(result.profile.privacy.storesRawTimelineBodies, false);
  assert.ok(result.profile.corpus.conversations >= 1);
  assert.ok(result.profile.suggestedNextCommands.some((command) => /memory init/.test(command)));
  assert.doesNotMatch(stdout, /SECRET_COOKIE_VALUE|AUTHORIZATION|front.id/);
});

test("CLI workflows daily returns agent-ready workflow queues", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-workflows"));
  await writeFakeFrontCacheFixture(paths);
  const env = { ...envForPaths(paths), FRONTCTL_NOW: "2026-06-06T12:00:00.000Z" };

  await execFileAsync("node", ["dist/src/cli.js", "sync", "--offline-cache", "--all", "--json"], { env });
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "workflows", "daily", "--actor", "Codex", "--json"], { env });
  const result = JSON.parse(stdout) as {
    publicApiUsed: boolean;
    workflows: Array<{ id: string; items: Array<{ commands: { read: string; archivePreview?: string; snoozePreview?: string } }> }>;
  };

  assert.equal(result.publicApiUsed, false);
  assert.ok(result.workflows.some((workflow) => workflow.id === "daily-triage"));
  assert.ok(result.workflows.some((workflow) => workflow.id === "noise-review"));
  assert.match(stdout, /--actor Codex/);
  assert.doesNotMatch(stdout, /SECRET_COOKIE_VALUE|AUTHORIZATION|front.id/);
});

test("CLI discovery sanitize redacts captured Front network fixtures", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-discovery"));
  const input = join(paths.supportPath, "capture.har");
  await writeFile(input, JSON.stringify({
    entries: [
      {
        method: "POST",
        url: "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/timeline?auth=SECRET",
        postData: { text: JSON.stringify({ body: "SECRET BODY", metadata: { ok: true } }) },
      },
    ],
  }));

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "discovery", "sanitize", "--input", input, "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as { count: number; routeKinds: string[] };

  assert.equal(result.count, 1);
  assert.deepEqual(result.routeKinds, ["comment.add"]);
  assert.doesNotMatch(stdout, /SECRET BODY|auth=SECRET/);
});

test("CLI global dry-run is accepted before mutation commands and wins over --yes", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-dry-run"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "--dry-run", "archive", "conversation-1", "--yes", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as { mode: string; canExecute: boolean; action: string; verification: { source?: string } };

  assert.equal(result.action, "archive");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.canExecute, true);
  assert.equal(result.verification.source, "known-route");
});

test("CLI tag list returns cached sanitized tag aliases", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-tag-list"));
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "needs-reply", name: "Needs Reply", email: "secret@example.com" },
        { id: "tag-2", alias: "vip", name: "VIP" },
      ],
    }),
  );

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "tag", "list", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as { source: string; stale: boolean; count: number; tags: Array<{ alias?: string }> };

  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.tags.map((tag) => tag.alias), ["needs-reply", "vip"]);
  assert.doesNotMatch(stdout, /secret@example/);
});

test("CLI tag add resolves cached tag names to aliases in preview", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-tag-resolve"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "123", alias: "needs-reply", name: "Needs Reply" },
      ],
    }),
  );

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "tag", "add", "conversation-1", "Needs Reply", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as {
    request: { path: string; body: unknown };
    details: { tag: { input: string; resolvedAlias: string; matchedBy: string } };
  };

  assert.match(result.request.path, /\/conversations$/);
  assert.deepEqual(result.request.body, { conversations: [{ id: "conversation-1", tags: { add: [123] } }] });
  assert.equal(result.details.tag.input, "Needs Reply");
  assert.equal(result.details.tag.resolvedAlias, "needs-reply");
  assert.equal(result.details.tag.matchedBy, "name");
});

test("CLI snooze normalizes relative time in mutation preview", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-snooze-time"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const env = {
    ...envForPaths(paths),
    FRONTCTL_NOW: "2026-06-05T16:00:00.000Z",
  };

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "snooze", "conversation-1", "in:2h", "--json"],
    { env },
  );
  const result = JSON.parse(stdout) as {
    sendsEmail: boolean;
    request: { body: { conversations: Array<{ reminder: number }> } };
    details: { input: string; normalizedUntil: string; parser: string };
  };

  assert.equal(result.sendsEmail, false);
  assert.equal(result.request.body.conversations[0].reminder, Date.parse("2026-06-05T18:00:00.000Z"));
  assert.equal(result.details.input, "in:2h");
  assert.equal(result.details.normalizedUntil, "2026-06-05T18:00:00.000Z");
  assert.equal(result.details.parser, "relative");
});

test("CLI comment add accepts body-file while remaining preview-only", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-comment-body-file"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const bodyPath = join(paths.supportPath, "comment.md");
  await writeFile(bodyPath, "CLI internal note body");

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "comment", "add", "conversation-1", "--body-file", bodyPath, "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as {
    mode: string;
    canExecute: boolean;
    sendsEmail: boolean;
    request: { path: string; body: { type: string; comment: { uid: string }; meta: { trackers: unknown[] } } };
  };

  assert.equal(result.mode, "dry-run");
  assert.equal(result.canExecute, true);
  assert.equal(result.sendsEmail, false);
  assert.match(result.request.path, /\/conversations\/conversation-1\/timeline$/);
  assert.equal(result.request.body.type, "comment");
  assert.equal(result.request.body.comment.uid.length, 32);
  assert.deepEqual(result.request.body.meta, { trackers: [] });
});

test("CLI audit list shows redacted mutation previews", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-audit"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const bodyPath = join(paths.supportPath, "audit-note.md");
  await writeFile(bodyPath, "CLI SECRET AUDIT BODY");
  const env = {
    ...envForPaths(paths),
    FRONTCTL_AUDIT_PATH: join(paths.supportPath, "audit.jsonl"),
  };

  await execFileAsync(
    "node",
    ["dist/src/cli.js", "comment", "add", "conversation-1", "--body-file", bodyPath, "--json"],
    { env },
  );
  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "audit", "list", "--action", "comment.add", "--conversation", "conversation-1", "--json"],
    { env },
  );
  const result = JSON.parse(stdout) as {
    count: number;
    entries: Array<{ action: string; conversationId: string; bodyKeys?: string[]; bodySha256?: string }>;
  };

  assert.equal(result.count, 1);
  assert.equal(result.entries[0].action, "comment.add");
  assert.equal(result.entries[0].conversationId, "conversation-1");
  assert.deepEqual(result.entries[0].bodyKeys, ["comment", "meta", "type"]);
  assert.match(result.entries[0].bodySha256 ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(stdout, /CLI SECRET AUDIT BODY/);
});

test("CLI mq install is print-only unless explicitly approved", async () => {
  const { stdout } = await execFileAsync("node", ["dist/src/cli.js", "mq", "install", "--print-only", "--json"]);
  const result = JSON.parse(stdout) as { installed: boolean; command: string[]; note: string };

  assert.equal(result.installed, false);
  assert.deepEqual(result.command, ["brew", "install", "mq"]);
  assert.match(result.note, /--yes/);
});

test("CLI mq query delegates to mq on PATH", async () => {
  const dir = await makeTempDir("frontctl-cli-mq");
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const mqPath = join(binDir, "mq");
  await writeFile(
    mqPath,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo mq-test; exit 0; fi\necho \"mq query:$5 file:$6\"\n",
    { mode: 0o755 },
  );
  await chmod(mqPath, 0o755);
  const input = join(dir, "conversation.md");
  await writeFile(input, "# Conversation\n\nBody");

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "mq", "query", "--query", ".h", "--input", input, "--output-format", "text"],
    { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
  );

  assert.equal(stdout.trim(), `mq query:.h file:${input}`);
});

test("CLI draft list/read and body-file previews are non-sending", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-drafts"));
  await writeFile(
    join(paths.indexedDbLevelDbPath, "000001.ldb"),
    `draft-compose /cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/messages/abc123def456 blurb"Cached CLI draft body" DRAFT`,
  );
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const bodyPath = join(paths.supportPath, "reply.md");
  await writeFile(bodyPath, "CLI draft body file");
  const env = envForPaths(paths);

  const { stdout: listStdout } = await execFileAsync("node", ["dist/src/cli.js", "draft", "list", "--json"], { env });
  const list = JSON.parse(listStdout) as { count: number; drafts: Array<{ id: string }> };
  assert.ok(list.count >= 1);

  const { stdout: readStdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "draft", "read", list.drafts[0].id, "--json"],
    { env },
  );
  assert.match(readStdout, /Cached CLI draft body/);

  const { stdout: previewStdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "draft", "reply", "conversation-1", "--body-file", bodyPath, "--json"],
    { env },
  );
  const preview = JSON.parse(previewStdout) as {
    sendsEmail: boolean;
    canExecute: boolean;
    request: { method: string; path: string; body: Record<string, unknown> };
  };
  assert.equal(preview.sendsEmail, false);
  assert.equal(preview.canExecute, true);
  assert.equal(preview.request.method, "PUT");
  assert.match(preview.request.path, /\/conversations\/conversation-1\/messages\/[a-f0-9]{32}$/);
  assert.equal(preview.request.body.text, "CLI draft body file");
  assert.equal("version" in preview.request.body, false);

  const { stdout: composeStdout } = await execFileAsync(
    "node",
    [
      "dist/src/cli.js",
      "draft",
      "compose",
      "--to",
      "alice@example.com,bob@example.com",
      "--subject",
      "CLI draft subject",
      "--body",
      "CLI compose body",
      "--json",
    ],
    { env },
  );
  const compose = JSON.parse(composeStdout) as {
    sendsEmail: boolean;
    request: { body: { to: string[]; subject: string; body: string; kind: string } };
  };
  assert.equal(compose.sendsEmail, false);
  assert.deepEqual(compose.request.body.to, ["alice@example.com", "bob@example.com"]);
  assert.equal(compose.request.body.subject, "CLI draft subject");
  assert.equal(compose.request.body.body, "CLI compose body");
  assert.equal(compose.request.body.kind, "compose");
});

test("CLI search preserves numeric query terms while honoring --limit", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-cli-search"));
  await writeFakeFrontCacheFixture(paths);

  const { stdout } = await execFileAsync(
    "node",
    ["dist/src/cli.js", "search", "Friday", "2026", "--offline-cache", "--limit", "1", "--json"],
    { env: envForPaths(paths) },
  );
  const result = JSON.parse(stdout) as {
    query: string;
    count: number;
    conversations: Array<{ id: string }>;
  };

  assert.equal(result.query, "Friday 2026");
  assert.equal(result.count, 1);
  assert.equal(result.conversations[0].id, "95907812305");
});

test("CLI unknown command exits with usage error JSON", async () => {
  await assert.rejects(
    execFileAsync("node", ["dist/src/cli.js", "nope", "--json"]),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 64);
      assert.match(err.stderr ?? "", /Unknown command: nope/);
      return true;
    },
  );
});

function envForPaths(paths: FrontPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FRONTCTL_FRONT_APP_PATH: paths.appPath,
    FRONTCTL_FRONT_SUPPORT_PATH: paths.supportPath,
    FRONTCTL_FRONT_INFO_PLIST_PATH: paths.infoPlistPath,
    FRONTCTL_FRONT_ASAR_PATH: paths.asarPath,
    FRONTCTL_FRONT_COOKIES_PATH: paths.cookiesPath,
    FRONTCTL_FRONT_CACHE_DATA_PATH: paths.cacheDataPath,
    FRONTCTL_FRONT_LOCAL_STORAGE_PATH: paths.localStorageLevelDbPath,
    FRONTCTL_FRONT_INDEXED_DB_PATH: paths.indexedDbLevelDbPath,
    FRONTCTL_FRONT_PREFERENCES_PATH: paths.preferencesPath,
    FRONTCTL_SESSION_PATH: join(paths.supportPath, "frontctl-session.json"),
    FRONTCTL_STORE_PATH: join(paths.supportPath, "frontctl.sqlite"),
    FRONTCTL_MEMORY_PATH: join(paths.supportPath, "memory.json"),
  };
}

function envForHome(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined));
}
