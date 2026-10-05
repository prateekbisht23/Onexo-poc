# VM egress lockdown (run on the CubeSandbox EC2)

Goal: a VM reaches **only** the reverse-tunnel ports on its host — the OneXO gateway and this
backend's token endpoint — so claude cannot bypass the gateway or reach the internet.
Today the `claude-code` template is built with `--allow-internet-access` (full egress).

| VM → | After lockdown |
|---|---|
| host `:18000` (tunnel → OneXO Kong `/llm`) | allow |
| host `:18091` (tunnel → POC `/internal/gateway-token`) | allow |
| `api.anthropic.com:443` — only if VMs must serve users who `/login` with an **Anthropic account** | optional, see below |
| replies on host-initiated connections (envd stdio, Files panel) | allow |
| everything else (internet, `api.anthropic.com`, npm/pip, other host ports) | drop |

## 0. Discover the VM network
```bash
# inside a VM (ask claude in a chat: "run ip addr and ip route")
ip addr; ip route                         # VM IP; its default gateway = HOST_IP as seen from the VM
# on the EC2 host
ip -br addr; ip route
sudo iptables -S; sudo iptables -t nat -S # a MASQUERADE rule for the VM subnet ⇒ option B fits
```
Baseline from a VM: `curl -sI https://api.anthropic.com` succeeds; `curl -i http://HOST_IP:18000/llm/anthropic/v1/messages` → 401.
No MASQUERADE rule for the VM subnet means CubeSandbox uses its own datapath — use option A.

## Option A — CubeSandbox switch (try first)
Recreate the template **without** `--allow-internet-access`:
```bash
sudo cubemastercli tpl delete --template-id <current-id>
sudo cubemastercli tpl create-from-image --image 127.0.0.1:5000/claude-sandbox:latest \
  --alias claude-code --writable-layer-size 2G --expose-port 49983 --probe 49983 --memory 3000
```
Keep it only if the internet is blocked **and** `HOST_IP:18000`/`:18091` still answer; otherwise
recreate with `--allow-internet-access` and use option B.

## Option B — host iptables
```bash
VM_NET=192.168.0.0/18   # from step 0
HOST_IP=192.168.0.1     # from step 0
sudo iptables -I INPUT 1 -s $VM_NET -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo iptables -I INPUT 2 -s $VM_NET -d $HOST_IP -p tcp -m multiport --dports 18000,18091 -j ACCEPT
sudo iptables -I INPUT 3 -s $VM_NET -j DROP
sudo iptables -I FORWARD 1 -s $VM_NET -m conntrack --ctstate NEW -j DROP
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
```
Rollback:
```bash
sudo iptables -D FORWARD -s $VM_NET -m conntrack --ctstate NEW -j DROP
sudo iptables -D INPUT -s $VM_NET -j DROP
sudo iptables -D INPUT -s $VM_NET -d $HOST_IP -p tcp -m multiport --dports 18000,18091 -j ACCEPT
sudo iptables -D INPUT -s $VM_NET -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

## Verify
From a VM: `curl -sI --max-time 5 https://api.anthropic.com` and `https://pypi.org` time out;
`curl -i http://HOST_IP:18000/llm/anthropic/v1/messages` still → 401. Then from your laptop:
`bun scripts/conformance.ts --sandboxes cubesandbox --gateways connectra` (all PASS, unknown-model WARN),
and check files survive an "End session" + reopen (if the S3 volume mounts over the VM's network,
the lockdown breaks it — allow the S3 endpoint too).

## The Anthropic-account login and the lockdown

Users who `/login` with their own Anthropic account need their VM to reach `api.anthropic.com`
directly. The host can't tell which VM belongs to which login, so allowing it opens that route for
**every** VM — a pasted Anthropic key would then bypass the OneXO gateway again. Pick one:
- **Strict (recommended for shared use):** don't allow it; only the OneXO login works on locked
  hosts. Run Anthropic-account users on a separate, non-locked sandbox host.
- **Permissive:** add `-d <api.anthropic.com IPs> -p tcp --dport 443 -j ACCEPT` (or a domain
  allowlist proxy) — accept that the gateway is now the default, not the only path.

## Trade-offs
- No `npm install` / `pip install` / `git clone` from the internet inside VMs. If needed later:
  an allowlist proxy on the host (e.g. tinyproxy: registry.npmjs.org, pypi.org, github.com) and
  `HTTPS_PROXY` in the VM env.
- Remote MCP servers (Notion, Linear, …) stop working in VMs for the same reason.
- Keep `18000`/`18091` closed in the EC2 security group; option B's INPUT rules also keep them VM-only.
