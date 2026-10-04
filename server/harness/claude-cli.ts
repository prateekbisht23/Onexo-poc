// Claude Code CLI as the harness: `claude -p` with stream-json stdio, model access
// via ANTHROPIC_BASE_URL + an apiKeyHelper that fetches tokens from the broker.
import type { HarnessAdapter } from "./types";

// Runs inside the VM/container: curl where present (docker image), node otherwise (VM template).
const HELPER_CMD =
  `curl -sf -H "authorization: Bearer $ONEXO_HELPER_KEY" "$ONEXO_TOKEN_URL" || ` +
  `node -e 'fetch(process.env.ONEXO_TOKEN_URL,{headers:{authorization:"Bearer "+process.env.ONEXO_HELPER_KEY}})` +
  `.then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())},()=>process.exit(1))'`;

export const claudeCli: HarnessAdapter = {
  name: "claude-cli",
  protocol: "anthropic",
  bin: process.env.CLAUDE_BIN ?? "claude",

  args({ resumeSessionId, systemPrompt, mcpConfig }) {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
    ];
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (mcpConfig) args.push("--mcp-config", mcpConfig);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return args;
  },

  gatewayConfig(c) {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: c.baseUrls.anthropic!,
      ANTHROPIC_CUSTOM_HEADERS: Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join("\n"),
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(c.refreshMs),
      // the gateway is the only egress: no telemetry/update/feedback calls to anthropic.com
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ONEXO_TOKEN_URL: c.tokenUrl,
      ONEXO_HELPER_KEY: c.helperKey,
    };
    if (c.models.main) env.ANTHROPIC_MODEL = c.models.main;
    if (c.models.small) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = c.models.small;
    // inline --settings, never a settings file: the docker backend mounts the user's real ~/.claude
    return { env, args: ["--settings", JSON.stringify({ apiKeyHelper: HELPER_CMD })] };
  },

  encodeUserMessage(text) {
    return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  },

  decodeLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null; // non-JSON noise
    }
  },

  setupFiles(home) {
    return {
      [`${home}/.claude.json`]: JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }),
    };
  },

  transcriptPath(home, cwd, sessionId) {
    return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`;
  },
};
