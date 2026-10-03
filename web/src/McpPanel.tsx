import { useEffect, useState } from "react";

// Hosted MCP servers whose one-click OAuth (dynamic client registration) is
// verified to actually work end-to-end. Servers that gate/omit registration
// (GitHub, Figma, Stripe) are intentionally excluded — add those via Advanced
// with a token. Picking one fills name + URL; "Custom…" lets you type your own.
const PRESETS: { label: string; name: string; url: string }[] = [
  { label: "Notion", name: "notion", url: "https://mcp.notion.com/mcp" },
  { label: "Linear", name: "linear", url: "https://mcp.linear.app/mcp" },
  { label: "Sentry", name: "sentry", url: "https://mcp.sentry.dev/mcp" },
  { label: "Asana", name: "asana", url: "https://mcp.asana.com/sse" },
  { label: "PayPal", name: "paypal", url: "https://mcp.paypal.com/sse" },
  { label: "Square", name: "square", url: "https://mcp.squareup.com/sse" },
  { label: "Vercel", name: "vercel", url: "https://mcp.vercel.com" },
  { label: "Webflow", name: "webflow", url: "https://mcp.webflow.com/sse" },
  { label: "Wix", name: "wix", url: "https://mcp.wix.com/sse" },
  { label: "Canva", name: "canva", url: "https://mcp.canva.com/mcp" },
];

export type McpServer = {
  id: number;
  name: string;
  transport: string;
  config_json: string;
  enabled: number;
  connected?: boolean;
};

// Parse "Key: value" lines → object (for HTTP headers).
function parseKV(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export default function McpPanel({
  servers,
  send,
  onClose,
}: {
  servers: McpServer[];
  send: (msg: unknown) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // OAuth "Connect" form
  const [connName, setConnName] = useState("");
  const [connUrl, setConnUrl] = useState("");
  const [preset, setPreset] = useState(""); // "" = none, "custom", or a preset label

  useEffect(() => { send({ type: "mcp_list" }); }, [send]);

  const onPreset = (label: string) => {
    setPreset(label);
    setErr(null);
    const p = PRESETS.find((x) => x.label === label);
    if (p) { setConnName(p.name); setConnUrl(p.url); }
    else { setConnName(""); setConnUrl(""); } // custom / none
  };

  const connect = () => {
    if (!connName.trim() || !connUrl.trim()) return setErr("Give the server a name and its URL.");
    setErr(null);
    send({ type: "mcp_connect", name: connName.trim(), url: connUrl.trim() });
    setConnName(""); setConnUrl(""); setPreset("");
  };

  const add = () => {
    if (!name.trim()) return setErr("Give the server a name.");
    let config: Record<string, unknown>;
    if (transport === "stdio") {
      if (!command.trim()) return setErr("stdio servers need a command.");
      config = {
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        ...(envText.trim() ? { env: parseKV(envText, "=") } : {}),
      };
    } else {
      if (!url.trim()) return setErr("http/sse servers need a URL.");
      config = { url: url.trim(), ...(headers.trim() ? { headers: parseKV(headers, ":") } : {}) };
    }
    setErr(null);
    send({ type: "mcp_add", name: name.trim(), transport, config });
    setName(""); setUrl(""); setHeaders(""); setCommand(""); setArgs(""); setEnvText("");
  };

  const summarize = (s: McpServer) => {
    try {
      const c = JSON.parse(s.config_json);
      return s.transport === "stdio" ? `${c.command} ${(c.args || []).join(" ")}` : c.url;
    } catch { return s.config_json; }
  };

  return (
    <div className="mcp-overlay" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-head">
          <span>MCP servers</span>
          <button className="mcp-x" onClick={onClose}>✕</button>
        </div>
        <p className="mcp-hint">Servers here are given to Claude in every new session (via <code>--mcp-config</code>). Changes apply to the next session.</p>

        <div className="mcp-list">
          {servers.length === 0 && <div className="mcp-empty">No servers yet.</div>}
          {servers.map((s) => (
            <div key={s.id} className={`mcp-row ${s.enabled ? "" : "off"}`}>
              <label className="mcp-toggle">
                <input type="checkbox" checked={!!s.enabled} onChange={(e) => send({ type: "mcp_toggle", id: s.id, enabled: e.target.checked })} />
              </label>
              <div className="mcp-info">
                <div className="mcp-name">
                  {s.name} <span className="mcp-transport">{s.transport}</span>
                  {s.connected && <span className="mcp-connected">● connected</span>}
                </div>
                <div className="mcp-cmd">{summarize(s)}</div>
              </div>
              <button className="mcp-del" onClick={() => send({ type: "mcp_remove", id: s.id })}>Remove</button>
            </div>
          ))}
        </div>

        <div className="mcp-add">
          <div className="mcp-add-title">Connect a hosted server (OAuth)</div>
          <select className="mcp-in" value={preset} onChange={(e) => onPreset(e.target.value)}>
            <option value="">Choose a server…</option>
            {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
          {preset === "custom" && (
            <div className="mcp-field-row">
              <input className="mcp-in" placeholder="name (e.g. myserver)" value={connName} onChange={(e) => setConnName(e.target.value)} />
              <input className="mcp-in" placeholder="https://…/mcp" value={connUrl} onChange={(e) => setConnUrl(e.target.value)} />
            </div>
          )}
          {preset && preset !== "custom" && <div className="mcp-cmd">{connUrl}</div>}
          <button className="mcp-add-btn" disabled={!connName.trim() || !connUrl.trim()} onClick={connect}>
            {preset && preset !== "custom" ? `Connect ${preset} →` : "Connect →"}
          </button>
          <div className="mcp-sub">Opens the provider's login in a new tab; approve it and the server connects automatically.</div>
        </div>

        <button className="mcp-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "▾" : "▸"} Advanced: add manually (URL + token, or an in-VM command)
        </button>
        {showAdvanced && (
        <div className="mcp-add">
          <div className="mcp-add-title">Add a server manually</div>
          <div className="mcp-field-row">
            <input className="mcp-in" placeholder="name (e.g. github)" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="mcp-in" value={transport} onChange={(e) => setTransport(e.target.value as any)}>
              <option value="http">http (remote)</option>
              <option value="sse">sse (remote)</option>
              <option value="stdio">stdio (in-VM command)</option>
            </select>
          </div>
          {transport === "stdio" ? (
            <>
              <input className="mcp-in" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
              <input className="mcp-in" placeholder="args (e.g. -y @modelcontextprotocol/server-github)" value={args} onChange={(e) => setArgs(e.target.value)} />
              <textarea className="mcp-in" rows={2} placeholder="env, one KEY=value per line (optional)" value={envText} onChange={(e) => setEnvText(e.target.value)} />
            </>
          ) : (
            <>
              <input className="mcp-in" placeholder="url (https://…/mcp)" value={url} onChange={(e) => setUrl(e.target.value)} />
              <textarea className="mcp-in" rows={2} placeholder="headers, one 'Key: value' per line (optional)" value={headers} onChange={(e) => setHeaders(e.target.value)} />
            </>
          )}
          <button className="mcp-add-btn" onClick={add}>Add server</button>
        </div>
        )}
        {err && <div className="mcp-err">{err}</div>}
      </div>
    </div>
  );
}
