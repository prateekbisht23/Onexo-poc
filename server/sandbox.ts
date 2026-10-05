// CubeSandbox (E2B-compatible) client. Sandboxes are KVM microVMs on the AWS
// box, reached through the SSH tunnel: the Cube API (:3000) creates/kills them,
// and code execution goes through CubeProxy's nginx (:3080 → instance port 80)
// using the Host header trick — nginx routes `49999-<sandboxID>.cube.app` to
// the code-interpreter service inside the right microVM, so no DNS or TLS for
// the sandbox domain is needed on this machine.
const E2B_API_URL = process.env.E2B_API_URL ?? "http://localhost:3000";
const CUBE_PROXY_URL = process.env.CUBE_PROXY_URL ?? "http://localhost:3080";
const CUBE_TEMPLATE_ID = process.env.CUBE_TEMPLATE_ID ?? "tpl-4c59e8b4667f4d4682ddd65d";
const SANDBOX_DOMAIN = process.env.CUBE_SANDBOX_DOMAIN ?? "cube.app";
const EXEC_PORT = 49999;

// The t3.xlarge fits ~3 concurrent sandboxes (2 vCPU / 2GB each) and freed
// capacity comes back asynchronously (~10s after a kill), so creation retries
// instead of failing fast on "no more resource".
const CREATE_RETRIES = 5;
const CREATE_RETRY_DELAY_MS = 5000;
const EXEC_TIMEOUT_MS = Number(process.env.SANDBOX_EXEC_TIMEOUT_MS ?? 90_000);

export type RunCodeResult = {
  stdout: string;
  stderr: string;
  error: string | null;
  sandboxId: string | null;
};

type ExecEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; name?: string; value?: string; traceback?: string }
  | { type: "result"; text?: string }
  | { type: string; [k: string]: unknown };

// Jupyter-style tracebacks arrive with ANSI color codes — noise for an LLM.
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

async function createSandbox(): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= CREATE_RETRIES; attempt++) {
    const res = await fetch(`${E2B_API_URL}/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: CUBE_TEMPLATE_ID, timeout: 300 }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (res.ok) {
      const parsed = JSON.parse(body);
      if (parsed.sandboxID) return parsed.sandboxID;
      lastError = `create returned no sandboxID: ${body.slice(0, 200)}`;
    } else {
      lastError = `create failed (${res.status}): ${body.slice(0, 200)}`;
    }
    // "no more resource" resolves itself once a recently-killed VM is reaped
    if (attempt < CREATE_RETRIES) await Bun.sleep(CREATE_RETRY_DELAY_MS);
  }
  throw new Error(lastError);
}

async function killSandbox(sandboxId: string) {
  await fetch(`${E2B_API_URL}/sandboxes/${sandboxId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

export async function runCode(code: string, language?: string): Promise<RunCodeResult> {
  let sandboxId: string | null = null;
  try {
    sandboxId = await createSandbox();
    const res = await fetch(`${CUBE_PROXY_URL}/execute`, {
      method: "POST",
      headers: {
        Host: `${EXEC_PORT}-${sandboxId}.${SANDBOX_DOMAIN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(language ? { code, language } : { code }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      return { stdout: "", stderr: "", error: `execute failed (${res.status}): ${text.slice(0, 300)}`, sandboxId };
    }
    // The exec endpoint streams NDJSON events; the response body holds them all.
    let stdout = "";
    let stderr = "";
    let error: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: ExecEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "stdout") stdout += (event as any).text ?? "";
      else if (event.type === "stderr") stderr += (event as any).text ?? "";
      else if (event.type === "error") {
        const e = event as any;
        error = e.traceback || [e.name, e.value].filter(Boolean).join(": ") || "execution error";
      }
    }
    return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), error: error && stripAnsi(error), sandboxId };
  } finally {
    if (sandboxId) void killSandbox(sandboxId);
  }
}

export function sandboxConfigSummary(): string {
  return `api=${E2B_API_URL} proxy=${CUBE_PROXY_URL} template=${CUBE_TEMPLATE_ID}`;
}
