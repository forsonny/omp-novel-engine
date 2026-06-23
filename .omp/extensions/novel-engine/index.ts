import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCommands } from "./src/commands/registerCommands";
import { registerHooks } from "./src/hooks/registerHooks";
import { registerTools } from "./src/tools/registerTools";

export default function novelEngine(pi: ExtensionAPI) {
  pi.setLabel("OMP Novel Engine");
  registerHooks(pi);
  registerTools(pi);
  registerCommands(pi);
}
