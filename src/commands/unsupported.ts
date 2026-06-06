import { CliError } from "../lib/cli.js";

export function unsupportedMutation(command: string, reason?: string) {
  return async () => {
    throw new CliError(
      reason ??
        [
          `${command} is not implemented.`,
          "Run endpoint discovery first, then add this command with --dry-run, --yes, audit logging, and tests.",
        ].join(" "),
      command === "send" ? 78 : 69,
    );
  };
}
