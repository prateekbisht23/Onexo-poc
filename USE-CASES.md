# Use Cases — Claude Code Sandbox Platform

What the platform is: a chat app where **each conversation runs headless Claude Code in its own
isolated cloud sandbox**, brokered by a backend, with a React UI. Today that sandbox is a
CubeSandbox microVM on AWS. This is the list of what we need it to do — the basis for comparing
alternatives.

---

## Infrastructure use cases

- One **isolated sandbox per conversation** — runs untrusted agent code, kernel-level isolation.
- **Fast to start** a fresh sandbox (seconds).
- Run a **long-lived headless Claude Code process** inside, with **streaming stdio** (messages in, tokens out).
- Full Linux with tools (node, python, git, ripgrep) from a **custom image** we build.
- **Persistent per-conversation storage** that survives the sandbox dying, and **restores** into a new sandbox on resume.
- **Internet egress** from the sandbox (Claude API, npm/pip/apt, git, MCP servers), with optional allowlisting.
- A **programmatic API** to create / kill / exec / read files, driven entirely by our backend.
- **Backend is the only thing that touches sandboxes** — users never connect to them directly.
- **Lifecycle control**: idle timeout, hard cap, manual kill, evict-when-full (all lossless since files are on storage).
- **Filesystem access** for the UI: list dir, read file, watch for changes.
- **Inject per-user auth** (API key / OAuth) fresh at launch, never stored on the volume.
- **Multi-tenant scoping** — files, storage, MCP, credentials all scoped per org/user.
- **Horizontal scaling** — add nodes for more capacity.
- Runs on **ordinary cloud VMs** (no exotic hardware), self-hostable.
- Reach a **service running inside a sandbox by port** (preview servers, code exec).
- Run **Docker / Postgres / Redis inside a sandbox** for dev workflows.

## User use cases

- Chat with Claude Code in the browser, **responses stream live**.
- **New chat** → its own isolated sandbox; **resume** an old one with full history **and files**.
- **Multiple conversations at once**; switch between them without interrupting a running one.
- **Draft your next message while Claude is working** (only Send is blocked).
- **Long tasks keep running if you close/reload the browser**; reopening reconnects to them.
- A **sidebar** of past conversations with live status.
- **See the files Claude changed** — live file tree + before/after diffs.
- **See tool calls** (Bash commands, MCP calls) — click a badge to see its input and result.
- **See what a launched sub-agent is doing** — its steps, live and afterward.
- **Log in to Claude from the dashboard** (`/login`) — no shell needed.
- **Configure MCP servers from the UI** (`/mcp`) — one-click OAuth connect, or add by token/command.
- **Interactive question cards** when Claude needs to ask you something.
- **End a session** (keep files) or **delete a conversation** (wipe its files).
- Developer tasks inside: run code, run tests, install packages, use git, deploy/preview.

---

## Must-haves when picking an alternative

An alternative to CubeSandbox is only viable if it can do **all** of these:

1. Kernel-isolated sandbox per session, running untrusted code.
2. Long-lived process with streaming stdio (for headless Claude Code).
3. Persistent per-session storage that survives teardown and restores on resume.
4. Internet egress from the sandbox.
5. A programmatic API, driven from our backend as the sole trust boundary.
6. Horizontal scaling with shared/S3-style storage.
7. Custom images with our tooling baked in.
8. Runs on affordable, ordinary infra.

## Candidates to compare

Format: **name** — isolation · hosting · one-line note.

**Strongest fits (self-hostable and/or agent-focused):**
- **E2B** — Firecracker microVM · managed + self-host · our backend already speaks its API → lowest switching cost.
- **boat.dev** (by ASCII) — full Ubuntu VM · managed · cheap (~$0.036/hr), SSH + Docker + real networking + snapshot forking, built for agents & long sessions.
- **Northflank** — Firecracker microVM · managed + strong BYOC self-host (EKS/GKE/AKS, bare-metal, on-prem).
- **Firecracker** (raw) — microVM · self-host DIY · strongest isolation, but you build the orchestration.
- **microsandbox** — libkrun microVM · self-host (open source) · lightweight untrusted-code runner.
- **Kata Containers** — VM-isolated containers · self-host DIY · needs your own scheduling.

**Managed cloud (SaaS, little/no self-host):**
- **Modal** — gVisor · SaaS · GPU-strong, no self-host.
- **Blaxel** — Firecracker microVM · SaaS · ~25 ms resume, perpetual standby.
- **Morph Cloud** — microVM · SaaS · fast snapshot/fork.
- **Vercel Sandbox** — Firecracker microVM · SaaS.
- **Cloudflare Sandboxes** — microVM · SaaS.
- **Beam.cloud** — SaaS · stateful sandboxes, GPU.
- **CodeSandbox / Together Code Sandbox** — Firecracker · SaaS.
- **Koyeb Sandboxes** — bare-metal microVM · SaaS · ~250 ms cold start.
- **Fly.io Machines** — Firecracker · SaaS.
- **AWS Bedrock AgentCore** — Firecracker per session · managed AWS.

**Weaker isolation / dev-env oriented (note for the untrusted-code requirement):**
- **Daytona** — containers · SaaS (went closed-source mid-2026); shared-kernel = weaker for untrusted code.
- **Gitpod / Coder** — containers · managed + self-host · built for dev environments, not untrusted agent code.




echo 'command="echo tunnel-only; sleep infinity",no-pty,no-X11-forwarding,permitopen="localhost:3000",permitopen="localhost:80",permitopen="localhost:12088" ssh-ed25519 AAAA...their-key... alice' >> ~/.ssh/authorized_keys

echo 'command="echo tunnel-only; sleep infinity",no-pty,no-X11-forwarding,permitopen="localhost:3000",permitopen="localhost:80",permitopen="localhost:12088" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG6cf/ixNG7r0vSKSGZsBrTPVpL31fv8tA1JHkVAu1Jw vishvam' >> ~/.ssh/authorized_keys