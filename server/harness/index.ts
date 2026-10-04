// HARNESS=<name> picks the coding-agent CLI. Adding one = a new adapter + an entry here.
import { claudeCli } from "./claude-cli";
import type { HarnessAdapter } from "./types";

const ADAPTERS: Record<string, HarnessAdapter> = {
  [claudeCli.name]: claudeCli,
};

export function selectHarness(name = process.env.HARNESS ?? "claude-cli"): HarnessAdapter {
  const h = ADAPTERS[name];
  if (!h) throw new Error(`unknown HARNESS "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return h;
}

export type { HarnessAdapter, HarnessLaunchOpts } from "./types";
