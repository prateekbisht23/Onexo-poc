# CubeSandbox on AWS — instance runbook

Self-hosted [CubeSandbox](https://github.com/TencentCloud/CubeSandbox) v0.7.2 serving as the
code-execution backend for this POC (claude's `run_code` MCP tool). Set up 2026-09-26/27.

## The instance

| | |
|---|---|
| Region | ap-south-1 (Mumbai) |
| Name | `Onexo_poc` |
| Type | t3.xlarge (4 vCPU / 16 GB, **x86_64 — required, PVM doesn't do ARM**) |
| OS | Ubuntu 24.04, running the **PVM host kernel** (`kernel-release-260921-1`) |
| SSH | `ssh -i ~/.ssh/onexo-poc-mumbai.pem ubuntu@<public-ip>` |
| Security group | SSH only, from home IP. Ports 3000/80/443/12088 are **not** exposed — everything goes over the SSH tunnel |
| Storage | root + 60 GiB XFS (`reflink=1`) at `/data/cubelet` (hard requirement — CoW snapshots break on ext4) |
| Templates | `tpl-4c59e8b4667f4d4682ddd65d` (sandbox-code — run_code tool) · alias **`claude-code`** (node 22 + Claude Code — per-conversation VM sessions) |
| Auth | none configured (`CUBE_API_KEY` unset) — safe only because nothing is exposed beyond SSH |

## Daily use

Start the tunnel (all three forwards; the backend expects 3000 + 3080):

```bash
ssh -i ~/.ssh/onexo-poc-mumbai.pem -N \
  -L 3000:localhost:3000 \      # Cube API (E2B-compatible)
  -L 3080:localhost:80 \        # CubeProxy nginx — code exec via Host header
  -L 12088:localhost:12088 \    # WebUI console → http://localhost:12088
  ubuntu@<EC2_PUBLIC_IP>
```

Health check from the Mac: `curl http://localhost:3000/health` → `{"status":"ok","sandboxes":N}`.

**Stop (never terminate) the instance when idle** — it's on free-tier credits; running 24/7 eats
~$120/mo, stopped costs ~$7/mo in EBS. **The public IP changes on every stop/start** — update the
tunnel command's IP after each start. Services come back automatically on boot.

## How code execution flows

1. `POST /sandboxes` on :3000 with `{"templateID": "...", "timeout": 300}` → `{sandboxID, domain: "cube.app"}`
2. `POST /execute` on :3080 with header `Host: 49999-<sandboxID>.cube.app` and `{"code": "..."}`
   — nginx on the instance routes that hostname to the microVM; response is NDJSON events
   (`stdout` / `stderr` / `error` / `end_of_execution`)
3. `DELETE /sandboxes/<id>`

## Gotchas (learned the hard way)

- **Custom ENA driver**: the stock PVM kernel has no AWS ENA network driver — one was built into
  it during setup. **A PVM kernel upgrade will kill networking** unless the ENA driver is rebuilt
  for the new kernel. Snapshot the instance before touching the kernel.
- **v1 API only**: the modern `e2b` JS SDK (2.x) calls `POST /v2/sandboxes` → 405. Talk to the
  v1 REST API directly (as `server/sandbox.ts` does) or pin an old SDK.
- **Async resource release**: after `DELETE`, capacity returns ~10 s later. A create right after
  a kill can get `130597: no more resource` — retry, don't panic.
- **Capacity**: each sandbox reserves 2 vCPU / 2 GB → ~3 concurrent microVMs on a t3.xlarge.
- Stale sandboxes hold capacity until their `timeout` expires. List: `curl localhost:3000/sandboxes`,
  kill: `curl -X DELETE localhost:3000/sandboxes/<id>` (through the tunnel or on the box).

## The claude-code template (per-conversation VM sessions)

Built on the instance from `/root/claude-template/Dockerfile`: `node:22-bookworm-slim`
+ `@anthropic-ai/claude-code` + git/curl/ripgrep/python3, a non-root account `user`
(claude refuses `bypassPermissions` as root), and — the part that cost three attempts —
**`/usr/bin/envd` copied from the stock `sandbox-code` image and started as the CMD**:

- The platform does **not** inject envd into templates; the image must ship and start it.
- The image must end as `USER root` with envd as CMD; envd runs requested processes as
  `user` when the request carries `Authorization: Basic base64("user:")`.
- Images are served to the template builder from a local registry:
  `docker run -d --restart=always -p 127.0.0.1:5000:5000 --name registry registry:2`.

Rebuild + republish (on the instance):
```bash
sudo docker build -t 127.0.0.1:5000/claude-sandbox:latest /root/claude-template
sudo docker push 127.0.0.1:5000/claude-sandbox:latest
sudo cubemastercli tpl delete --template-id <old-id>   # alias must be freed first
sudo cubemastercli tpl create-from-image \
  --image 127.0.0.1:5000/claude-sandbox:latest --alias claude-code \
  --writable-layer-size 2G --expose-port 49983 --probe 49983 \
  --allow-internet-access --memory 3000
```
`--probe 49983` makes sandbox creation block until envd answers `/health` — clients
get a ready VM straight from `POST /sandboxes`.

VMs hold no model credentials: claude's token helper fetches short-lived OneXO gateway
tokens from the backend and claude calls OneXO's Kong `/llm/anthropic`, both through
reverse SSH tunnels (`-R 0.0.0.0:18000:localhost:8000 -R 0.0.0.0:18091:localhost:8091`;
needs `GatewayPorts clientspecified` in this box's sshd_config). See README "Model access".

## Viewing VM files (envd Filesystem API)

The web app's **Files** panel reads the VM's files through envd's Filesystem API, proxied by
the backend (never exposed to the browser directly). Verified endpoints on the `claude-code`
template's envd, all Host-routed to `49983-<id>.cube.app` with `Basic base64("user:")`:
- `POST /filesystem.Filesystem/ListDir` — **plain JSON** body `{path}` → `{entries:[{name,type,
  path,size,modifiedTime,...}]}` (`type` is `FILE_TYPE_FILE` / `FILE_TYPE_DIRECTORY`).
- `POST /filesystem.Filesystem/Stat` — plain JSON, same entry shape.
- `POST /filesystem.Filesystem/WatchDir` — **enveloped connect stream** (5-byte frame prefix,
  like process Start) with `{path, recursive:true}` → frames `{filesystem:{name, type}}` where
  type is `EVENT_TYPE_CREATE|WRITE|CHMOD|REMOVE|RENAME`. Claude's editor writes atomically
  (temp file + rename), so expect `.tmp.*` churn followed by the real file — the UI filters it.
- File contents reuse the existing `GET /files?path=...&username=user`.

### Fallback: a full editable IDE in the VM (not built)
The current file view is deliberately read-only and multi-tenant-safe (backend-brokered). If a
literal, editable VS Code UI against a VM is ever required, add **code-server** to the template
and `--expose-port <its port>`; CubeProxy already routes `<port>-<id>.cube.app` and handles the
websockets, so it's reachable through the same tunnel behind the backend's auth. Cost: a full
IDE process in every VM, so raise `--memory` / instance size accordingly.

## On-instance references

- Config: `/usr/local/services/cubetoolbox/.one-click.env`
- Templates: `sudo cubemastercli tpl list`
- New template: `sudo cubemastercli tpl create-from-image --image <img> --writable-layer-size 1G --expose-port 49999 --expose-port 49983 --probe 49999`, then `cubemastercli tpl watch --job-id <id>`
