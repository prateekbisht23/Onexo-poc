# Setup Guide — Running Claude Code Chat locally

This app has three parts:
- **Frontend** (React) — runs on your machine.
- **Backend** (Bun server) — runs on your machine.
- **Sandbox server** — a shared cloud machine (CubeSandbox) that actually runs Claude Code in
  isolated VMs. You don't install this; you **tunnel** to the owner's server over SSH.

You do **not** need Docker for this. You need: `git`, an SSH client (built into macOS/Linux and
Windows 10+), and [**Bun**](https://bun.sh).

Follow the steps in order. Steps 1–2 are a one-time handshake with the person who shared this
(the "owner"). Steps 3–6 are how you run the app every time.

---

## Step 1 — Create an SSH key

This makes a key **pair**: a private key (stays on your machine, secret) and a public key (safe to
share). You'll send the owner only the **public** one.

**macOS / Linux** (Terminal):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/claude-sandbox -C "your-name"
```
- Press Enter to accept the location. You may set a passphrase or leave it empty.
- This creates `~/.ssh/claude-sandbox` (private) and `~/.ssh/claude-sandbox.pub` (public).

**Windows** (PowerShell):
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\claude-sandbox -C "your-name"
```

⚠️ **Never share the file without `.pub`** (the private key). Only ever send the `.pub` file.

---

## Step 2 — Send your public key to the owner

Print your **public** key and copy the whole line:

**macOS / Linux:**
```bash
cat ~/.ssh/claude-sandbox.pub
```
**Windows (PowerShell):**
```powershell
Get-Content $HOME\.ssh\claude-sandbox.pub
```

It looks like: `ssh-ed25519 AAAAC3NzaC1lZDI1... your-name`

Send that entire line to the owner (chat/email is fine — it's not secret). Also tell them **what
username you want** in the app (e.g. `alice`) — this keeps your chats and files separate from
everyone else's.

Then **wait for the owner to reply with**:
- ✅ confirmation they've added your key, and
- the **server address** (an IP like `13.235.76.136`).

---

## Step 3 — Get the code and install dependencies

```bash
git clone <the repo URL or unzip the folder they shared>
cd claude-code-poc

# install Bun if you don't have it:
#   macOS/Linux:  curl -fsSL https://bun.sh/install | bash
#   Windows:      powershell -c "irm bun.sh/install.ps1 | iex"

cd web && bun install && cd ..
cd server && bun install && cd ..
```

---

## Step 4 — Open the tunnel to the sandbox server

This connects your machine's `localhost:3000` and `localhost:3080` to the owner's sandbox server.
**Leave this terminal open** the whole time you use the app (closing it disconnects the sandbox).

Replace `<SERVER_IP>` with the address the owner gave you:

```bash
ssh -i ~/.ssh/claude-sandbox -N \
  -L 3000:localhost:3000 \
  -L 3080:localhost:80 \
  -L 12088:localhost:12088 \
  ubuntu@13.205.162.52
```
(Windows: use `$HOME\.ssh\claude-sandbox` for the key path.)

It will look like it's hanging with no output — that's correct (`-N` = tunnel only, no shell).
If it exits immediately with a permission error, the owner hasn't added your key yet, or you're
using the wrong key/IP.

**If ports 3000 or 3080 are already used on your machine**, pick different **local** ports (the
left-hand numbers). Keep the **server** ports (`:3000` and `:80`, the right-hand numbers) exactly
as-is. Example using 4000 and 4080 locally:
```bash
ssh -i ~/.ssh/claude-sandbox -N \
  -L 4000:localhost:3000 \
  -L 4080:localhost:80 \
  ubuntu@<SERVER_IP>
```
Then in Step 5 tell the backend where to find them by adding two env vars (matching your chosen
local ports):
```bash
E2B_API_URL=http://localhost:4000 CUBE_PROXY_URL=http://localhost:4080 POC_USER=alice bun run dev
```
Windows PowerShell:
```powershell
$env:E2B_API_URL="http://localhost:4000"; $env:CUBE_PROXY_URL="http://localhost:4080"; $env:POC_USER="alice"; bun run dev
```

---

## Step 5 — Run the backend and frontend

Open **two more terminals** in the `claude-code-poc` folder.

**Terminal A — backend** (use the username you told the owner):
```bash
cd server
POC_USER=alice bun run dev
```
Windows PowerShell:
```powershell
cd server
$env:POC_USER="alice"; bun run dev
```

**Terminal B — frontend:**
```bash
cd web
bun run dev
```

---

## Step 6 — Open the app

1. Make sure `server/.env` has the OneXO gateway config (see `server/.env.example`) and your
   tunnel includes `-R 0.0.0.0:18000:localhost:8000 -R 0.0.0.0:18091:localhost:8091` so the VMs
   can reach OneXO's Kong and this backend's token endpoint.
2. Open **http://localhost:5173** in your browser.
3. Send a message — Claude Code runs in an isolated cloud sandbox and every model call goes
   through the OneXO AI gateway. No login needed.

---

## Everyday use (after the one-time setup)

Each time you want to use it, just:
1. Open the tunnel (Step 4).
2. Start backend + frontend (Step 5).
3. Open http://localhost:5173.

---

## Troubleshooting

- **"Sandbox unavailable" / messages fail** → your tunnel isn't running, or the server IP changed.
  Restart the tunnel (Step 4); ask the owner for the current IP.
- **Tunnel exits with "Permission denied (publickey)"** → the owner hasn't added your key, or the
  key path/username is wrong. Use `-i <path-to-your-private-key>` and `ubuntu@<SERVER_IP>`.
- **"address already in use" on 3000/3080** → something else is using those local ports; close it,
  or ask the owner how to remap.
- **Everything's slow / "no more resource"** → the shared server has limited capacity (a few
  concurrent sessions total). Try again in a bit, or coordinate with the group.
- **Claude fails with 401 / "gateway token mint failed"** → local OneXO isn't running, the client
  secret in `server/.env` is wrong, or a reverse tunnel (port 18000 or 18091) is down.

> Note: your chats and files live on the shared server, scoped to your `POC_USER` name. Don't put
> anything sensitive there — it's a shared demo environment.


claude-sandbox

