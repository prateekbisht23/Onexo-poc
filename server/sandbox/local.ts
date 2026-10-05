// The non-VM sandbox plugs: the harness runs in the shared local docker container
// (`docker exec`) or straight on this host. One process per WebSocket (index.ts).
import { mkdirSync } from "fs";
import { join } from "path";
import type { Vantage } from "../gateway";

export type LocalSandbox = {
  name: "docker" | "local";
  vantage: Vantage;
  cwd: string | undefined; // host cwd for the spawn (docker uses -w instead)
  /** Full argv. envKeys are forwarded by name (`-e KEY`) so values never land in argv. */
  command(bin: string, args: string[], envKeys: string[]): string[];
  describe(): string;
};

const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER ?? "claude-poc";
const CONTAINER_WORKDIR = process.env.CONTAINER_WORKDIR ?? "/home/onexo/projects";
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? join(process.env.HOME ?? "/", "projects");

export const dockerSandbox: LocalSandbox = {
  name: "docker",
  vantage: "container",
  cwd: undefined,
  command(bin, args, envKeys) {
    // -i keeps stdin open: the persistent harness reads user turns from it
    const envFlags = envKeys.flatMap((k) => ["-e", k]);
    return ["docker", "exec", "-i", ...envFlags, "-w", CONTAINER_WORKDIR, DOCKER_CONTAINER, bin, ...args];
  },
  describe: () => `inside docker container "${DOCKER_CONTAINER}" (cwd ${CONTAINER_WORKDIR})`,
};

// A missing spawn cwd surfaces as ENOENT naming the *binary*, which misleads — create it.
if (process.env.SANDBOX === "local") mkdirSync(PROJECTS_DIR, { recursive: true });

export const hostSandbox: LocalSandbox = {
  name: "local",
  vantage: "host",
  cwd: PROJECTS_DIR,
  command: (bin, args) => [bin, ...args],
  describe: () => `locally on this host, cwd ${PROJECTS_DIR}`,
};
