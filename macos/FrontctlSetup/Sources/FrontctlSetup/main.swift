import AppKit
import SwiftUI

@main
struct FrontctlSetupApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 760, minHeight: 560)
        }
    }
}

struct ContentView: View {
    @StateObject private var model = SetupModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Frontctl Setup")
                    .font(.largeTitle.bold())
                Text("Connect Claude, ChatGPT, or Codex to your local Front desktop app. Frontctl never sends email.")
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button("Check Setup") {
                    model.runFrontctl(["readiness", "--json"], title: "Checking setup")
                }
                .keyboardShortcut(.defaultAction)

                Button("Install Agent Skills") {
                    model.runFrontctl(["setup", "--agent", "all", "--yes", "--json"], title: "Installing agent skills")
                }

                Button("Enable Live Mode") {
                    model.runFrontctl(["auth", "unlock", "--ttl-hours", "12", "--json"], title: "Enabling live mode")
                }

                Button("Support Bundle") {
                    model.generateSupportBundle()
                }

                Button("Open Front") {
                    model.openFront()
                }
            }
            .disabled(model.isRunning)

            GroupBox("Status") {
                ScrollView {
                    Text(model.statusText)
                        .font(.system(.body, design: .rounded))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 170)
            }

            GroupBox("Details") {
                ScrollView {
                    Text(model.detailText)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: .infinity)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Agent Prompts")
                    .font(.headline)
                HStack(alignment: .top, spacing: 10) {
                    Text(model.agentPrompt)
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Copy Short Prompt") {
                        model.copyAgentPrompt()
                    }
                    Button("Copy ChatGPT Instructions") {
                        model.copyChatGPTInstructions()
                    }
                    .disabled(model.isRunning)
                }
            }
        }
        .padding(24)
        .onAppear {
            model.runFrontctl(["readiness", "--json"], title: "Checking setup")
        }
    }
}

@MainActor
final class SetupModel: ObservableObject {
    @Published var statusText = "Checking setup..."
    @Published var detailText = ""
    @Published var isRunning = false

    let agentPrompt = "Use frontctl on this Mac. Check my Front setup, triage my inbox, and do not send email. Do not use the public Front API."

    func runFrontctl(_ arguments: [String], title: String) {
        guard let frontctl = resolveFrontctlPath() else {
            statusText = """
            frontctl is not installed yet.

            Run the frontctl installer package from this DMG first, then return here and click Check Setup.
            """
            detailText = """
            Expected paths:
            ~/.local/bin/frontctl
            ~/.local/share/frontctl/bin/frontctl
            /opt/frontctl/bin/frontctl
            /usr/local/bin/frontctl
            frontctl/bin/frontctl next to this setup app in the DMG
            """
            return
        }

        isRunning = true
        statusText = "\(title)..."
        detailText = commandLine(frontctl, arguments)

        Task.detached {
            let result = runProcess(executable: frontctl, arguments: arguments)
            let summary = summarizeFrontctl(arguments: arguments, result: result)
            await MainActor.run {
                self.statusText = summary.status
                self.detailText = summary.details
                self.isRunning = false
            }
        }
    }

    func generateSupportBundle() {
        let outputPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Desktop")
            .appendingPathComponent("frontctl-support.json")
            .path
        runFrontctl(["diagnose", "--output", outputPath, "--json"], title: "Generating support bundle")
    }

    func openFront() {
        isRunning = true
        statusText = "Opening Front..."
        detailText = commandLine("/usr/bin/open", ["-a", "Front"])
        Task.detached {
            let result = runProcess(executable: "/usr/bin/open", arguments: ["-a", "Front"])
            await MainActor.run {
                if result.exitCode == 0 {
                    self.statusText = "Front is opening. Sign in there, then return here and click Check Setup."
                } else {
                    self.statusText = "Front could not be opened. Install Front for macOS, then click Check Setup."
                }
                self.detailText = result.transcript
                self.isRunning = false
            }
        }
    }

    func copyAgentPrompt() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(agentPrompt, forType: .string)
        statusText = "Short agent prompt copied. Paste it into Claude, ChatGPT, or Codex after setup is ready."
    }

    func copyChatGPTInstructions() {
        guard let frontctl = resolveFrontctlPath() else {
            statusText = """
            frontctl is not installed yet.

            Run the frontctl installer package from this DMG first, then return here and click Check Setup.
            """
            detailText = """
            Expected paths:
            ~/.local/bin/frontctl
            ~/.local/share/frontctl/bin/frontctl
            /opt/frontctl/bin/frontctl
            /usr/local/bin/frontctl
            frontctl/bin/frontctl next to this setup app in the DMG
            """
            return
        }

        isRunning = true
        statusText = "Preparing ChatGPT instructions..."
        detailText = commandLine(frontctl, ["agents", "prompt", "--agent", "chatgpt", "--json"])

        Task.detached {
            let result = runProcess(executable: frontctl, arguments: ["agents", "prompt", "--agent", "chatgpt", "--json"])
            let prompt = extractAgentPrompt(result.stdout)
            await MainActor.run {
                if result.exitCode == 0, let prompt {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(prompt, forType: .string)
                    self.statusText = "ChatGPT instructions copied. Paste them into a ChatGPT session that has local terminal or Codex-style command access."
                } else {
                    self.statusText = "Could not copy ChatGPT instructions. Review the details, then click Check Setup."
                }
                self.detailText = result.transcript
                self.isRunning = false
            }
        }
    }
}

struct ProcessResult {
    let executable: String
    let arguments: [String]
    let exitCode: Int32
    let stdout: String
    let stderr: String

    var transcript: String {
        var body = commandLine(executable, arguments)
        if !stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body += "\n\nstdout:\n\(stdout)"
        }
        if !stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body += "\n\nstderr:\n\(stderr)"
        }
        body += "\n\nexit: \(exitCode)"
        return body
    }
}

func resolveFrontctlPath() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let bundleSibling = Bundle.main.bundleURL
        .deletingLastPathComponent()
        .appendingPathComponent("frontctl")
        .appendingPathComponent("bin")
        .appendingPathComponent("frontctl")
        .path
    let candidates = [
        "\(home)/.local/bin/frontctl",
        "\(home)/.local/share/frontctl/bin/frontctl",
        bundleSibling,
        "/opt/frontctl/bin/frontctl",
        "/usr/local/bin/frontctl"
    ]
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return nil
}

func runProcess(executable: String, arguments: [String]) -> ProcessResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    do {
        try process.run()
        process.waitUntilExit()
        return ProcessResult(
            executable: executable,
            arguments: arguments,
            exitCode: process.terminationStatus,
            stdout: readPipe(stdoutPipe),
            stderr: readPipe(stderrPipe)
        )
    } catch {
        return ProcessResult(
            executable: executable,
            arguments: arguments,
            exitCode: 1,
            stdout: "",
            stderr: "Failed to run command: \(error.localizedDescription)"
        )
    }
}

func readPipe(_ pipe: Pipe) -> String {
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8) ?? ""
}

func summarizeFrontctl(arguments: [String], result: ProcessResult) -> (status: String, details: String) {
    guard result.exitCode == 0 else {
        return (
            "Something needs attention. Review the details, fix the issue, then click Check Setup again.",
            result.transcript
        )
    }

    guard let json = parseJSONObject(result.stdout) else {
        return ("Command finished.", result.transcript)
    }

    if arguments.first == "readiness" {
        return summarizeReadiness(json, result: result)
    }

    if arguments.first == "setup" {
        return summarizeSetup(json, result: result)
    }

    if arguments.first == "auth", arguments.dropFirst().first == "unlock" {
        return summarizeAuthUnlock(json, result: result)
    }

    if arguments.first == "diagnose" {
        return summarizeDiagnose(json, result: result)
    }

    return ("Command finished.", result.transcript)
}

func summarizeReadiness(_ json: [String: Any], result: ProcessResult) -> (status: String, details: String) {
    let frontInstalled = boolAt(json, ["front", "appInstalled"]) ?? false
    let localProfileVisible = boolAt(json, ["front", "localProfileVisible"]) ?? false
    let authValid = boolAt(json, ["auth", "valid"]) ?? false
    let agentsInstalled = boolAt(json, ["agents", "allInstalled"]) ?? false
    let readinessState = stringAt(json, ["userReadiness", "state"]) ?? "unknown"
    let nextAction = stringAt(json, ["userReadiness", "nextAction"])
    let nextCommand = stringAt(json, ["nextCommand"])
    let promptsOnCheck = boolAt(json, ["auth", "promptsOnCheck"]) ?? false
    let promptsOnLiveRead = boolAt(json, ["auth", "promptsOnLiveRead"]) ?? false

    var lines: [String] = []
    if frontInstalled && localProfileVisible && authValid && agentsInstalled {
        lines.append("Frontctl is ready.")
    } else {
        lines.append("A setup step is still required.")
    }
    lines.append("")
    lines.append(statusLine("Front app", frontInstalled, ready: "Installed", missing: "Install Front for macOS"))
    lines.append(statusLine("Front sign-in", localProfileVisible, ready: "Detected", missing: "Open Front and sign in"))
    lines.append(statusLine("Live mode", authValid, ready: "Enabled", missing: "Click Enable Live Mode"))
    lines.append(statusLine("Agent skills", agentsInstalled, ready: "Installed", missing: "Click Install Agent Skills"))
    lines.append("")
    lines.append("Current state: \(readinessState)")

    if let nextAction, !nextAction.isEmpty {
        lines.append("Next action: \(nextAction)")
    }
    if let nextCommand, !nextCommand.isEmpty {
        lines.append("Agent command: \(nextCommand)")
    }

    lines.append("")
    lines.append("Setup checks ask for Keychain access: \(promptsOnCheck ? "yes" : "no")")
    lines.append("Live reads ask for Keychain access: \(promptsOnLiveRead ? "yes" : "no")")

    let details = """
    \(result.transcript)

    Support:
    Click Support Bundle to write a redacted diagnostic file to your Desktop.
    """
    return (lines.joined(separator: "\n"), details)
}

func summarizeSetup(_ json: [String: Any], result: ProcessResult) -> (status: String, details: String) {
    let frontInstalled = boolAt(json, ["front", "installed"]) ?? false
    let localProfileVisible = boolAt(json, ["front", "localProfileVisible"]) ?? false
    let authValid = boolAt(json, ["auth", "valid"]) ?? false
    let agentsInstalled = boolAt(json, ["agents", "status", "allInstalled"]) ?? false
    let failureMode = stringAt(json, ["failureMode"]) ?? "unknown"
    let readinessState = stringAt(json, ["userReadiness", "state"]) ?? failureMode
    let nextAction = stringAt(json, ["userReadiness", "nextAction"])
    let nextSteps = stringArrayAt(json, ["nextSteps"])

    var lines: [String] = []
    if frontInstalled && localProfileVisible && authValid && agentsInstalled {
        lines.append("Frontctl is ready.")
    } else {
        lines.append("A few setup steps remain.")
    }
    lines.append("")
    lines.append(statusLine("Front app", frontInstalled, ready: "Installed", missing: "Install Front for macOS"))
    lines.append(statusLine("Front sign-in", localProfileVisible, ready: "Detected", missing: "Open Front and sign in"))
    lines.append(statusLine("Live mode", authValid, ready: "Enabled", missing: "Click Enable Live Mode"))
    lines.append(statusLine("Agent skills", agentsInstalled, ready: "Installed", missing: "Click Install Agent Skills"))
    lines.append("")
    lines.append("Current state: \(readinessState)")

    if let nextAction, !nextAction.isEmpty {
        lines.append("Next action: \(nextAction)")
    }

    if !nextSteps.isEmpty {
        lines.append("")
        lines.append("Next steps:")
        for step in nextSteps {
            lines.append("- \(step)")
        }
    }

    let details = """
    \(result.transcript)

    Support:
    Click Support Bundle to write a redacted diagnostic file to your Desktop.
    """
    return (lines.joined(separator: "\n"), details)
}

func summarizeAuthUnlock(_ json: [String: Any], result: ProcessResult) -> (status: String, details: String) {
    let valid = boolAt(json, ["valid"]) ?? false
    let keychainAccessed = boolAt(json, ["keychainAccessed"]) ?? false
    let reusedExisting = boolAt(json, ["reusedExisting"]) ?? false
    let promptsOnCheck = boolAt(json, ["security", "promptsOnCheck"]) ?? false
    let promptsOnLiveRead = boolAt(json, ["security", "promptsOnLiveRead"]) ?? false

    var lines: [String] = []
    lines.append(valid ? "Live mode is enabled." : "Live mode is not enabled yet.")
    lines.append("")
    lines.append(statusLine("Session", valid, ready: "Unlocked", missing: "Unlock failed"))
    lines.append("Keychain used now: \(keychainAccessed ? "yes" : "no")")
    lines.append("Existing session reused: \(reusedExisting ? "yes" : "no")")
    lines.append("Future setup checks prompt: \(promptsOnCheck ? "yes" : "no")")
    lines.append("Future live reads prompt: \(promptsOnLiveRead ? "yes" : "no")")

    return (lines.joined(separator: "\n"), result.transcript)
}

func summarizeDiagnose(_ json: [String: Any], result: ProcessResult) -> (status: String, details: String) {
    let outputPath = stringAt(json, ["outputPath"]) ?? "your selected support file"
    let redacted = boolAt(json, ["redacted"]) ?? false
    let ok = boolAt(json, ["summary", "ok"]) ?? false

    let status = """
    Support bundle created.

    File: \(outputPath)
    Redacted: \(redacted ? "yes" : "no")
    Front setup: \(ok ? "ready" : "needs attention")
    """
    return (status, result.transcript)
}

func statusLine(_ label: String, _ ok: Bool, ready: String, missing: String) -> String {
    "\(label): \(ok ? ready : missing)"
}

func parseJSONObject(_ text: String) -> [String: Any]? {
    guard let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let dictionary = object as? [String: Any] else {
        return nil
    }
    return dictionary
}

func extractAgentPrompt(_ text: String) -> String? {
    guard let json = parseJSONObject(text),
          let prompts = json["prompts"] as? [[String: Any]],
          let first = prompts.first,
          let prompt = first["prompt"] as? String,
          !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
    }
    return prompt
}

func boolAt(_ dictionary: [String: Any], _ path: [String]) -> Bool? {
    valueAt(dictionary, path) as? Bool
}

func stringAt(_ dictionary: [String: Any], _ path: [String]) -> String? {
    valueAt(dictionary, path) as? String
}

func stringArrayAt(_ dictionary: [String: Any], _ path: [String]) -> [String] {
    valueAt(dictionary, path) as? [String] ?? []
}

func valueAt(_ dictionary: [String: Any], _ path: [String]) -> Any? {
    var current: Any? = dictionary
    for key in path {
        guard let dict = current as? [String: Any] else {
            return nil
        }
        current = dict[key]
    }
    return current
}

func commandLine(_ executable: String, _ arguments: [String]) -> String {
    ([executable] + arguments).map(shellQuote).joined(separator: " ")
}

func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
