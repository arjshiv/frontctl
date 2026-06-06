import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function run(command: string, args: string[], maxBuffer = 1024 * 1024) {
  const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer });
  return { stdout, stderr };
}
