# Persistent Sandbox Sessions — Decisions & Plan

*September 2026 · follows the plan in `~/.majdoor/plans/lucky-singing-melody.md` · architecture details in `architecture.html`*

## The problem, in one line

Each conversation used to get a throwaway microVM — close it and every file Claude wrote was gone. Now every conversation owns a **persistent S3 volume**, and the VM becomes disposable.

## How it works now

- **New conversation** → create an S3 volume (`vol-<org>-<user>-<id>`) and boot a fresh microVM with that volume mounted at `/home/user/projects`. Claude Code runs headless inside the VM, so everything it writes lands on the volume.
- **Close / go idle** → the VM is destroyed after ≈5 minutes of inactivity. The volume stays. The chat transcript is synced out to the backend after every turn.
- **Reopen + prompt** → a fresh VM boots, mounts the **same** volume, the transcript is put back, and `claude --resume <session-id>` restores the conversation. Files and history are both intact.
- **"End session"** → kills the VM immediately, keeps the volume (reopening still restores everything).
- **"Delete conversation"** → kills the VM *and* destroys the volume. Storage reclaimed, next open starts clean.

## The eight questions, answered

**1. How many sandboxes fit on the t3.xlarge?**
Memory is the limit. After ≈3 GB of control-plane overhead: **≈4 lean VMs** (3 GB each) or **≈2 heavy VMs** (6 GB, with Docker + a database). The backend enforces this with `MAX_LIVE_VMS` (default 3).

**2. How does session resume work?**
Volume restore, not VM pause. The backend maps each conversation to its volume in SQLite; reopening boots a new VM, remounts the volume, and runs `claude --resume`. Chosen over CubeSandbox pause/resume because it's simpler, works across nodes, and avoids known pause bugs in v0.x.

**3. Can a user close a session?**
Yes — two levels:

| Action | VM | Volume (files) | Next reopen |
|---|---|---|---|
| End session | destroyed | kept | full restore |
| Delete conversation | destroyed | destroyed | starts clean |
| (automatic) idle 5 min | destroyed | kept | full restore |

**4. How do MCPs work?**
Injected per session with `--mcp-config` at launch (Claude's args are built centrally in `buildClaudeArgs`). Local stdio servers run inside the VM (baked into the template or installed onto the volume); remote HTTP servers are reached via the VM's egress. Secrets are passed as env at launch, never stored on the volume.

**5. How many concurrent sessions?**
Two different numbers. **Logical sessions are unbounded** — a closed session is just a DB row plus an idle volume, costing roughly storage only. **Live VMs are RAM-bound** — ≈4 on the current box, ≈9 per m6i.2xlarge worker node, linear as you add nodes. Idle timeout + LRU eviction keep the live set inside capacity.

**6. How do we scale horizontally?**
Two layers:
- **CubeSandbox**: CubeAPI/CubeMaster are stateless (coordinate via Redis) — just add Cubelet worker nodes. S3 volumes make sessions node-independent, so any node can resume any session.
- **Our Bun backend**: the conversation registry is in-memory today. To run replicas, move it to Redis (session map + pub/sub), put replicas behind a load balancer with sticky WebSockets, and move MySQL→RDS, Redis→ElastiCache, MinIO→real S3.

**7. Docker / Postgres / Redis inside a sandbox?**
Supported — each microVM has its own kernel, so a session can run a private `dockerd` or run Postgres/Redis natively. It needs a heavier template (tools baked in) and ≈6 GB per VM, which halves density. Deferred until needed (see Decisions).

**8. What does it cost?** See the table below.

## Cost estimate (AWS, on-demand unless noted)

Assumptions: usage spread over a ≈9 h window; a VM is live ≈60 % of a session's wall-clock (short idle timeout); provision for 1.6× average concurrency; lean 3 GB VMs on m6i.2xlarge workers (≈9 VMs/node, $0.404/h); one m6i.xlarge control node 24/7 (≈$147/mo); volumes ≈ 3 GB/user on S3.

| Scenario | Peak live VMs | Worker nodes | Business-hours (on-demand) | Always-on 24/7 | Business-hours on **spot** |
|---|---|---|---|---|---|
| 50 users · 3 h/day | ≈16 | 2 | **≈$310/mo** | ≈$740/mo | ≈$210/mo |
| 100 users · 3 h/day | ≈32 | 4 | **≈$475/mo** | ≈$1,335/mo | ≈$270/mo |
| 50 users · 8 h/day | ≈43 | 5 | **≈$550/mo** | ≈$1,625/mo | ≈$290/mo |

Notes:
- Roughly **$5–11 per user per month** in the business-hours on-demand mode.
- **Spot is the big lever**: since volumes make VMs disposable, a spot reclaim just means the session resumes on another node — worker compute drops 60–70 %.
- Heavy profile (Docker + DB) ≈ 1.8–2× the worker cost. Storage and egress are negligible (a few $/mo).
- 1-yr Savings Plans take ≈40 % off the always-on parts. These are estimates — re-check against real peak-concurrent-VM counts once running.

## Decisions

- **Identity**: stubbed in the PoC (`getIdentity()` reads `x-poc-org` / `x-poc-user` headers or env). In production the same function validates a JWT from SSO and reads org/user claims — one function swap, no refactor. Everything (volumes, VMs, files) is scoped through it.
- **Profile**: **lean coding first** (Node + Claude Code + git/python). The heavy Docker+DB template is explicitly deferred.
- **Teardown**: never close on task-done — keep the VM warm between turns; idle timeout ≈5 min (lossless now); a 2 h hard cap as a runaway safety net; LRU-evict an idle VM when at capacity instead of blocking.

## Implementation plan & status

| Step | What | Status |
|---|---|---|
| 0 | Live verification: volume create → mount → write → destroy VM → remount → file survives. Captured the REST shapes. | ✅ Done |
| 1 | Volume lifecycle in `server/vmclaude.ts` — create/reuse per-session volume, mount at `/home/user/projects`, one-time `chown`, ephemeral credentials | ✅ Done |
| 2 | Lifecycle in `server/index.ts` — `getIdentity()` seam, conversation→volume mapping, 5-min idle, LRU eviction, End session / Delete conversation | ✅ Done |
| 3 | Per-user MCP config → `--mcp-config` at VM launch | Planned |
| 4 | Scale-out: registry → Redis, backend replicas behind LB, add Cubelet worker nodes, managed RDS/ElastiCache/S3 | When needed |
| 5 | Heavy dev template (Docker + Postgres/Redis baked in, 6 GB VMs) | Deferred |

## API shapes captured in Step 0 (for reference)

```
POST /volumes            {"name": "...", "driver": "s3"}        → {"volumeID": "<name>"}
POST /sandboxes          {"templateID": "claude-code",
                          "volumeMounts": [{"name": "<vol>", "path": "/home/user/projects"}]}
DELETE /volumes/<name>   destroys the volume and all its data
```

Gotchas: the wire format is `volumeMounts` (an array of `{name, path}`), not the SDK's `volume_mounts` map — an unknown field is **silently ignored** (you get a 201 and no mount). The volume mounts root-owned via virtiofs, so a one-time `chown user:user` (run as root through envd) is needed; it persists on the volume.
