// The harness plug: the coding-agent CLI that runs the loop (claude, codex, …).
// An adapter knows its CLI's flags, stdio protocol and on-disk layout, and how to
// point itself at a gateway given only a protocol-level HarnessGatewayConn —
// never which gateway or sandbox it is in.
import type { HarnessGatewayConn, WireProtocol } from "../gateway";

export type HarnessLaunchOpts = {
  resumeSessionId: string | null;
  systemPrompt?: string; // appended to the CLI's own system prompt
  mcpConfig?: string; // MCP config: a path or inline JSON
};

export interface HarnessAdapter {
  name: string;
  protocol: WireProtocol;
  bin: string;
  /** Long-lived stdio session: user turns go in on stdin, events come out on stdout. */
  args(o: HarnessLaunchOpts): string[];
  /** Env + extra args that route every model call through the gateway via the token helper. */
  gatewayConfig(c: HarnessGatewayConn): { env: Record<string, string>; args: string[] };
  /** One stdin line for a user turn. */
  encodeUserMessage(text: string): string;
  /** Parse one stdout line into a UI event (claude stream-json shape), or null to drop it. */
  decodeLine(line: string): any | null;
  /** Files the CLI needs under its HOME before first launch in a fresh machine. */
  setupFiles(home: string): Record<string, string>;
  /** Where the CLI keeps one session's transcript (for persist/restore across VMs). */
  transcriptPath(home: string, cwd: string, sessionId: string): string;
}
