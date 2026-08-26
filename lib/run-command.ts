import { createHash } from "node:crypto";
import type { RunCommand } from "@harnestai/protocol";

export const runCommandKey = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function retrySafeCommand(command: RunCommand, key: string): RunCommand {
  return command.commandId ? command : { ...command, commandId: `command_${key}` };
}
