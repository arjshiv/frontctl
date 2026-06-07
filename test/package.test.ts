import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { makeTempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("package metadata publishes the frontctl bin and build lifecycle", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    name?: string;
    private?: boolean;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
    files?: string[];
  };

  assert.equal(pkg.name, "frontctl");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin?.frontctl, "./dist/src/cli.js");
  assert.equal(pkg.scripts?.["test:readonly"], "npm run build && node --test dist/test/readonly-matrix.test.js");
  assert.equal(pkg.scripts?.["check:commit"], "npm test");
  assert.equal(pkg.scripts?.["check:package:local"], "npm test && npm run build:package && npm run release:check:local");
  assert.equal(pkg.scripts?.["hooks:install"], "script/install_git_hooks.sh");
  assert.equal(pkg.scripts?.prepack, "npm run build");
  assert.equal(pkg.scripts?.prepare, "npm run build");
  assert.equal(pkg.scripts?.["build:package"], "script/build_package.sh");
  assert.equal(pkg.scripts?.["build:setup-app"], "script/build_setup_app.sh");
  assert.equal(pkg.scripts?.["release:doctor"], "script/check_signing_prereqs.sh");
  assert.equal(pkg.scripts?.["release:doctor:json"], "script/check_signing_prereqs.sh --json");
  assert.equal(pkg.scripts?.["release:check"], "script/check_release.sh");
  assert.equal(pkg.scripts?.["release:check:local"], "script/check_release.sh --allow-unsigned");
  assert.equal(pkg.scripts?.["release:homebrew-cask"], "script/generate_homebrew_cask.sh");
  assert.equal(pkg.scripts?.["release:verify:local"], "script/verify_release_ready.sh --local");
  assert.equal(pkg.scripts?.["release:verify:strict"], "script/verify_release_ready.sh --strict");
  assert.ok(pkg.files?.includes("dist/src"));
  assert.ok(pkg.files?.includes("skills"));
  assert.ok(pkg.files?.includes("AGENTS.md"));
  assert.ok(pkg.files?.includes("agentcookie.toml"));
  assert.ok(pkg.files?.includes(".github/workflows"));
  assert.ok(pkg.files?.includes("script"));
  assert.ok(pkg.files?.includes("packaging"));
  assert.ok(pkg.files?.includes("macos/FrontctlSetup/Package.swift"));
  assert.ok(pkg.files?.includes("macos/FrontctlSetup/Sources"));

  const setupScript = await readFile("script/build_setup_app.sh", "utf8");
  assert.match(setupScript, /DEVELOPER_ID_APPLICATION/);
  assert.match(setupScript, /--sign -/);

  const packageScript = await readFile("script/build_package.sh", "utf8");
  assert.match(packageScript, /COPYFILE_DISABLE=1/);
  assert.match(packageScript, /DEVELOPER_ID_INSTALLER and DEVELOPER_ID_APPLICATION/);
  assert.match(packageScript, /DMG_README\.txt/);
  assert.match(packageScript, /Install Frontctl for This User\.command/);
  assert.match(packageScript, /DMG_SRC\/frontctl/);
  assert.match(packageScript, /START HERE\.txt/);
  assert.match(packageScript, /Uninstall Frontctl\.command/);
  assert.match(packageScript, /FINAL_MANIFEST/);
  assert.match(packageScript, /shasum -a 256/);
  assert.match(packageScript, /nodeRuntimeVersion/);
  assert.match(packageScript, /pkg\.dependencies/);
  assert.match(packageScript, /node_modules/);
  assert.match(packageScript, /xattr -cr "\$PKG_ROOT"/);
  assert.match(packageScript, /find "\$PKG_ROOT" -name '\._\*' -delete/);
  assert.ok(packageScript.includes('--filter ".*\\\\._.*"'));
  assert.ok(packageScript.indexOf('notarytool submit "$FINAL_PKG"') < packageScript.indexOf('mkdir -p "$DMG_SRC"'));
  assert.ok(packageScript.indexOf('notarytool submit "$FINAL_DMG"') > packageScript.indexOf('/usr/bin/hdiutil create'));

  const userInstaller = await readFile("packaging/Install Frontctl for This User.command", "utf8");
  assert.match(userInstaller, /\.local\/share\/frontctl\/runtime\/node/);
  assert.match(userInstaller, /\.local\/share\/frontctl\/dist\/src\/cli\.js/);
  assert.doesNotMatch(userInstaller, /ln -sf "\$DEST\/bin\/frontctl"/);

  const releaseCheck = await readFile("script/check_release.sh", "utf8");
  assert.match(releaseCheck, /check_expanded_payload/);
  assert.match(releaseCheck, /expanded package payload is runnable/);
  assert.match(releaseCheck, /pkgutil --expand-full/);
  assert.match(releaseCheck, /opt\/frontctl\/runtime\/node/);
  assert.match(releaseCheck, /opt\/frontctl\/dist\/src\/cli\.js/);
  assert.match(releaseCheck, /opt\/frontctl\/node_modules\/zod\/package\.json/);
  assert.match(releaseCheck, /Install Frontctl for This User\.command/);
  assert.match(releaseCheck, /frontctl\/bin\/frontctl/);
  assert.match(releaseCheck, /doctor --json/);
  assert.match(releaseCheck, /\/opt\/homebrew/);
  assert.doesNotMatch(releaseCheck, /dist\/package\/work\/root/);
  assert.match(releaseCheck, /dmg gatekeeper assessment/);
  assert.match(releaseCheck, /START HERE\.txt/);
  assert.match(releaseCheck, /Uninstall Frontctl\.command/);
  assert.match(releaseCheck, /release manifest matches artifacts/);
  assert.match(releaseCheck, /pkg sha256 mismatch/);

  const hookInstaller = await readFile("script/install_git_hooks.sh", "utf8");
  assert.match(hookInstaller, /pre-push/);
  assert.match(hookInstaller, /npm test/);
  assert.match(hookInstaller, /FRONTCTL_SKIP_HOOKS=1/);

  const signingDoctor = await readFile("script/check_signing_prereqs.sh", "utf8");
  assert.match(signingDoctor, /Developer ID Application/);
  assert.match(signingDoctor, /Developer ID Installer/);
  assert.match(signingDoctor, /APPLE_APP_PASSWORD/);

  const releaseVerifier = await readFile("script/verify_release_ready.sh", "utf8");
  assert.match(releaseVerifier, /--with-live-front/);
  assert.match(releaseVerifier, /npm pack --dry-run/);
  assert.match(releaseVerifier, /FRONTCTL_NOTARIZE=1 npm run build:package/);
  assert.match(releaseVerifier, /npm run release:check:local/);
  assert.match(releaseVerifier, /npm run release:check/);
  assert.match(releaseVerifier, /node dist\/src\/cli\.js send --json/);
  assert.match(releaseVerifier, /Sending is intentionally blocked/);
  assert.match(releaseVerifier, /frontctl readiness --json/);
  assert.match(releaseVerifier, /promptsOnLiveRead/);
  assert.match(releaseVerifier, /publicApiUsed/);

  const caskScript = await readFile("script/generate_homebrew_cask.sh", "utf8");
  assert.match(caskScript, /FRONTCTL_DOWNLOAD_BASE_URL/);
  assert.match(caskScript, /artifacts\.dmg\.sha256/);
  assert.match(caskScript, /pkg "\$PKG_PATH"/);
  assert.match(caskScript, /pkgutil: "ai\.frontctl\.cli"/);
  assert.match(caskScript, /frontctl readiness --json/);

  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ciWorkflow, /npm run release:verify:local/);

  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(releaseWorkflow, /DEVELOPER_ID_APPLICATION_CERT_BASE64/);
  assert.match(releaseWorkflow, /DEVELOPER_ID_INSTALLER_CERT_BASE64/);
  assert.match(releaseWorkflow, /APPLE_APP_PASSWORD/);
  assert.match(releaseWorkflow, /npm run build:package/);
  assert.match(releaseWorkflow, /npm run release:check/);
  assert.match(releaseWorkflow, /npm run release:homebrew-cask/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release/);

  const previewWorkflow = await readFile(".github/workflows/preview-release.yml", "utf8");
  assert.match(previewWorkflow, /Preview Release/);
  assert.match(previewWorkflow, /workflow_dispatch/);
  assert.match(previewWorkflow, /npm run release:verify:local/);
  assert.match(previewWorkflow, /npm run release:homebrew-cask/);
  assert.match(previewWorkflow, /prerelease: true/);
  assert.match(previewWorkflow, /unsigned preview/);
  assert.match(previewWorkflow, /dist\/package\/frontctl-\*\.dmg/);

  const distributionDoc = await readFile("docs/distribution.md", "utf8");
  assert.match(distributionDoc, /signing-notarization-setup\.md/);
  assert.match(distributionDoc, /GitHub preview release/);
  assert.match(distributionDoc, /does not require the Mac App Store/);

  const releaseChecklist = await readFile("docs/release-checklist.md", "utf8");
  assert.match(releaseChecklist, /release:verify:local/);
  assert.match(releaseChecklist, /release:verify:strict/);
  assert.match(releaseChecklist, /signing-notarization-setup\.md/);
  assert.match(releaseChecklist, /GitHub Preview Release Gates/);

  const previewDoc = await readFile("docs/github-preview-release.md", "utf8");
  assert.match(previewDoc, /does not need the Mac App Store/);
  assert.match(previewDoc, /No Apple Developer ID or notarization secrets required/);
  assert.match(previewDoc, /Preview Release/);

  const signingGuide = await readFile("docs/signing-notarization-setup.md", "utf8");
  assert.match(signingGuide, /Developer ID Application/);
  assert.match(signingGuide, /Developer ID Installer/);
  assert.match(signingGuide, /APPLE_APP_PASSWORD/);
  assert.match(signingGuide, /DEVELOPER_ID_APPLICATION_CERT_BASE64/);
  assert.match(signingGuide, /npm run release:verify:strict/);
  assert.match(signingGuide, /spctl --assess/);

  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /docs\/signing-notarization-setup\.md/);
  assert.match(readme, /docs\/distribution\.md/);
  assert.match(readme, /does not send email/i);
  assert.match(readme, /Local package and DMG validation/);
  assert.match(readme, /npm run check:package:local/);
  assert.match(readme, /--source default-browser/);
  assert.match(readme, /frontctl discovery browser-probe/);
  assert.match(readme, /--actor/);
  assert.match(readme, /--reason/);

  const agents = await readFile("AGENTS.md", "utf8");
  assert.match(agents, /Chrome\/Edge\/default-browser session unlock/);
  assert.match(agents, /Do not force-refresh browser cookies/);
  assert.match(agents, /local memory profiling/);
  assert.match(agents, /local daily workflows/);
  assert.match(agents, /--actor NAME/);

  const agentcookieManifest = await readFile("agentcookie.toml", "utf8");
  assert.match(agentcookieManifest, /app\.frontapp\.com/);
  assert.match(agentcookieManifest, /~\/\.frontctl\/session\.json/);

  const postinstall = await readFile("packaging/pkg-scripts/postinstall", "utf8");
  assert.match(postinstall, /missing \/opt\/frontctl\/runtime\/node/);
  assert.match(postinstall, /ln -sf \/opt\/frontctl\/bin\/frontctl \/usr\/local\/bin\/frontctl/);
  assert.match(postinstall, /frontctl --version/);

  const chatgptPrompt = await readFile("skills/chatgpt/frontctl/INSTRUCTIONS.md", "utf8");
  assert.match(chatgptPrompt, /ChatGPT Instructions/);
  assert.match(chatgptPrompt, /local terminal or Codex-style command execution access/);
  assert.match(chatgptPrompt, /frontctl readiness --json/);
  assert.match(chatgptPrompt, /frontctl memory init --limit 500 --json/);
  assert.match(chatgptPrompt, /frontctl workflows daily --actor ChatGPT --json/);
  assert.match(chatgptPrompt, /--actor ChatGPT/);
});

test("DMG readme is non-technical and safety focused", async () => {
  const readme = await readFile("packaging/DMG_README.txt", "utf8");

  assert.match(readme, /Double-click Install Frontctl for This User\.command/);
  assert.match(readme, /does not need an administrator password/);
  assert.match(readme, /Open Frontctl Setup\.app/);
  assert.match(readme, /frontctl readiness --json/);
  assert.match(readme, /Copy ChatGPT Instructions/);
  assert.match(readme, /Uninstall Frontctl\.command/);
  assert.match(readme, /never sends email/i);
  assert.match(readme, /Support Bundle/);
  assert.doesNotMatch(readme, /npm install|npm link|tsc|node_modules/);
});

test("DMG uninstall helper removes only frontctl package assets", async () => {
  const script = await readFile("packaging/Uninstall Frontctl.command", "utf8");

  assert.match(script, /frontctl local data, installed agent skills/);
  assert.match(script, /\$FRONTCTL" uninstall --yes/);
  assert.match(script, /\.local\/bin\/frontctl/);
  assert.match(script, /\.local\/share\/frontctl/);
  assert.match(script, /sudo rm -f \/usr\/local\/bin\/frontctl/);
  assert.match(script, /sudo rm -rf \/opt\/frontctl/);
  assert.match(script, /pkgutil --forget ai\.frontctl\.cli/);
  assert.match(script, /Front for macOS and your Front account are not modified/);
  assert.doesNotMatch(script, /Front\.app|Library\/Application Support\/Front/);
});

test("setup app exposes non-technical recovery actions", async () => {
  const source = await readFile("macos/FrontctlSetup/Sources/FrontctlSetup/main.swift", "utf8");

  assert.match(source, /frontctl is not installed yet/);
  assert.match(source, /Install Agent Skills/);
  assert.match(source, /Enable Live Mode/);
  assert.match(source, /Support Bundle/);
  assert.match(source, /frontctl-support\.json/);
  assert.match(source, /Agent Prompts/);
  assert.match(source, /Copy ChatGPT Instructions/);
  assert.match(source, /userReadiness/);
  assert.match(source, /\.local\/bin\/frontctl/);
  assert.match(source, /\.local\/share\/frontctl\/bin\/frontctl/);
  assert.match(source, /Next action/);
  assert.match(source, /agents", "prompt", "--agent", "chatgpt", "--json"/);
  assert.match(source, /extractAgentPrompt/);
  assert.match(source, /parseJSONObject/);
});

test("notarized package build fails fast without signing identities", async () => {
  await assert.rejects(
    execFileAsync("script/build_package.sh", [], {
      env: {
        ...process.env,
        FRONTCTL_NOTARIZE: "1",
        DEVELOPER_ID_INSTALLER: "",
        DEVELOPER_ID_APPLICATION: "",
      },
    }),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      assert.match(stderr, /DEVELOPER_ID_INSTALLER and DEVELOPER_ID_APPLICATION/);
      return true;
    },
  );
});

test("release signing doctor returns machine-readable prerequisite status", async () => {
  const { stdout } = await execFileAsync("script/check_signing_prereqs.sh", ["--json"], {
    env: {
      ...process.env,
      DEVELOPER_ID_APPLICATION: "",
      DEVELOPER_ID_INSTALLER: "",
      APPLE_ID: "",
      APPLE_TEAM_ID: "",
      APPLE_APP_PASSWORD: "",
    },
  });
  const result = JSON.parse(stdout) as {
    ok: boolean;
    checks: {
      developerIdApplicationIdentity: { ok: boolean; count: number };
      developerIdInstallerCertificate: { ok: boolean; count: number };
      signingEnvironment: { ok: boolean };
      notarizationEnvironment: { ok: boolean };
    };
  };

  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.checks.developerIdApplicationIdentity.count, "number");
  assert.equal(typeof result.checks.developerIdInstallerCertificate.count, "number");
  assert.equal(result.checks.signingEnvironment.ok, false);
  assert.equal(result.checks.notarizationEnvironment.ok, false);
});

test("homebrew cask generator uses manifest artifact metadata", async () => {
  const root = await makeTempDir("frontctl-cask");
  const manifestPath = join(root, "manifest.json");
  const outputPath = join(root, "frontctl.rb");
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    artifacts: {
      dmg: {
        path: "frontctl-0.1.0.dmg",
        sha256: "a".repeat(64),
      },
      pkg: {
        path: "frontctl-0.1.0.pkg",
      },
    },
  }));

  await execFileAsync("script/generate_homebrew_cask.sh", [], {
    env: {
      ...process.env,
      FRONTCTL_CASK_MANIFEST: manifestPath,
      FRONTCTL_CASK_OUTPUT: outputPath,
      FRONTCTL_DOWNLOAD_BASE_URL: "https://downloads.example.com/frontctl/v0.1.0",
    },
  });
  const cask = await readFile(outputPath, "utf8");

  assert.match(cask, /cask "frontctl"/);
  assert.match(cask, /sha256 "aaaaaaaa/);
  assert.match(cask, /url "https:\/\/downloads\.example\.com\/frontctl\/v0\.1\.0\/frontctl-0\.1\.0\.dmg"/);
  assert.match(cask, /pkg "frontctl-0\.1\.0\.pkg"/);
  assert.match(cask, /pkgutil: "ai\.frontctl\.cli"/);
  assert.match(cask, /frontctl readiness --json/);
});
