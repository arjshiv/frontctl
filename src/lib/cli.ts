import { inspect } from "node:util";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface GlobalOptions {
  json: boolean;
  plain: boolean;
  color: boolean;
  dryRun: boolean;
}

export function parseGlobalOptions(argv: string[]): { globals: GlobalOptions; rest: string[] } {
  const globals: GlobalOptions = {
    json: false,
    plain: false,
    color: true,
    dryRun: false,
  };
  const rest: string[] = [];

  for (const arg of argv) {
    if (arg === "--json") {
      globals.json = true;
    } else if (arg === "--plain") {
      globals.plain = true;
    } else if (arg === "--no-color") {
      globals.color = false;
    } else if (arg === "--dry-run") {
      globals.dryRun = true;
    } else {
      rest.push(arg);
    }
  }

  return { globals, rest };
}

export function printResult(value: unknown, globals: GlobalOptions) {
  if (globals.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    console.log(value);
    return;
  }

  console.log(inspect(value, { colors: globals.color && !globals.plain, depth: null, compact: false }));
}
