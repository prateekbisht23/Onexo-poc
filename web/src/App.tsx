import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import FilesPanel from "./FilesPanel";
import McpPanel, { type McpServer } from "./McpPanel";

type Role = "user" | "assistant" | "tool" | "error" | "answer";

type AgentItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id?: string; name: string; input?: any; result?: string };

type ToolInfo = {
  name: string;
  id?: string; // tool_use_id, used to attach input + result
  input?: any;
  result?: string;
  isError?: boolean;
  agentPath?: string; // live sub-agent: the JSONL transcript path in the VM
  agentId?: string; // persisted sub-agent: fetch its transcript from the host
};

type Message = {
  id: number;
  role: Role;
  text: string;
  streaming?: boolean;
  tool?: ToolInfo;
};

type QuestionOption = { label: string; description?: string };
type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

type ServerMessage =
  | { type: "ready" }
  | { type: "session"; sessionId: string; tempId?: string; prev?: string }
  | { type: "claude_event"; sessionId?: string; event: any }
  | { type: "done"; sessionId?: string; tempId?: string; code: number; stderr?: string }
  | { type: "error"; sessionId?: string; tempId?: string; error: string }
  | { type: "live"; sessions: { sessionId: string; busy: boolean }[] }
  | { type: "turn_user"; sessionId: string; text: string }
  | { type: "fs_tree"; sessionId?: string; path: string; entries: any[]; changed: string[] }
  | { type: "fs_file"; sessionId?: string; path: string; content: string }
  | { type: "fs_change"; sessionId?: string; path: string; kind: "created" | "modified" | "deleted" }
  | { type: "login_url"; url: string }
  | { type: "login_result"; ok: boolean; error?: string }
  | { type: "mcp_servers"; servers: McpServer[] }
  | { type: "mcp_auth_url"; name: string; url: string }
  | { type: "mcp_connect_error"; name: string; error: string }
  | { type: "agent_update"; sessionId: string; toolUseId: string; items: AgentItem[]; running: boolean };

let nextId = 1;

const ASK_RE = /<ask_user>([\s\S]*?)<\/ask_user>/;

// Hide the ask_user block (even a partially streamed one) from rendered text.
function stripAskBlock(text: string): string {
  return text.replace(/<ask_user>[\s\S]*$/, "").trimEnd();
}

function parseQuestions(finalText: string): Question[] | null {
  const match = finalText.match(ASK_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed.questions)) return null;
    const questions = parsed.questions.filter(
      (q: any) =>
        typeof q?.question === "string" &&
        Array.isArray(q?.options) &&
        q.options.every((o: any) => typeof o?.label === "string"),
    );
    return questions.length ? questions : null;
  } catch {
    return null;
  }
}

function QuestionCard({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: Question[];
  onSubmit: (answerText: string, displayText: string) => void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>[]>(questions.map(() => new Set()));
  const [otherText, setOtherText] = useState<string[]>(questions.map(() => ""));
  const [otherOpen, setOtherOpen] = useState<boolean[]>(questions.map(() => false));

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multi) {
        next[qi].has(label) ? next[qi].delete(label) : next[qi].add(label);
      } else {
        next[qi] = next[qi].has(label) ? new Set() : new Set([label]);
      }
      return next;
    });
  };

  const answered = questions.every(
    (_, i) => selected[i].size > 0 || (otherOpen[i] && otherText[i].trim()),
  );

  const submit = () => {
    const answers = questions.map((q, i) => {
      const parts = [...selected[i]];
      if (otherOpen[i] && otherText[i].trim()) parts.push(otherText[i].trim());
      return { label: q.header ?? q.question, value: parts.join(", ") };
    });
    // Full protocol text goes to claude; the transcript shows just the choices.
    const sendStr = `My answer${questions.length > 1 ? "s" : ""}:\n${answers
      .map((a) => `- ${a.label}: ${a.value}`)
      .join("\n")}`;
    const displayStr = answers
      .map((a) => (questions.length > 1 ? `${a.label}: ${a.value}` : a.value))
      .join("\n");
    onSubmit(sendStr, displayStr);
  };

  return (
    <div className="question-card">
      {questions.map((q, qi) => (
        <div key={qi} className="question">
          {q.header && <span className="question-header">{q.header}</span>}
          <div className="question-text">{q.question}</div>
          <div className="options">
            {q.options.map((opt) => (
              <button
                key={opt.label}
                className={`option ${selected[qi].has(opt.label) ? "selected" : ""}`}
                onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
              >
                <span className="option-label">
                  {q.multiSelect ? (selected[qi].has(opt.label) ? "☑" : "☐") : selected[qi].has(opt.label) ? "◉" : "○"}{" "}
                  {opt.label}
                </span>
                {opt.description && <span className="option-desc">{opt.description}</span>}
              </button>
            ))}
            <button
              className={`option ${otherOpen[qi] ? "selected" : ""}`}
              onClick={() =>
                setOtherOpen((prev) => prev.map((v, i) => (i === qi ? !v : v)))
              }
            >
              <span className="option-label">{otherOpen[qi] ? "◉" : "○"} Other…</span>
            </button>
            {otherOpen[qi] && (
              <input
                className="other-input"
                autoFocus
                placeholder="Type your own answer"
                value={otherText[qi]}
                onChange={(e) =>
                  setOtherText((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))
                }
              />
            )}
          </div>
        </div>
      ))}
      <div className="question-actions">
        <button className="skip" onClick={onSkip}>
          Skip
        </button>
        <button className="submit" disabled={!answered} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}

type Conversation = {
  id: number;
  session_id: string;
  title: string;
  updated_at: string;
};

// Past turns come back as raw protocol text; restore the compact answer pills.
function mapHistoryMessage(m: { role: string; text: string; tool?: ToolInfo & { agentId?: string } }): Message {
  if (m.role === "user" && m.text.startsWith("My answer")) {
    const text = m.text
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^- /, ""))
      .join("\n");
    return { id: nextId++, role: "answer", text };
  }
  if (m.role === "user" && m.text.startsWith("I'll skip that question")) {
    return { id: nextId++, role: "answer", text: "Skipped" };
  }
  if (m.role === "tool") {
    return { id: nextId++, role: "tool", text: m.text, tool: m.tool ?? { name: m.text } };
  }
  return { id: nextId++, role: m.role as Role, text: m.text };
}

// A clickable tool badge that expands to show the call's input and result — and,
// for sub-agent launches, the agent's live transcript (its own steps).
function ToolChip({ tool, expanded, onToggle, agentRun }: { tool: ToolInfo; expanded: boolean; onToggle: () => void; agentRun?: { items: AgentItem[]; running: boolean } }) {
  const inp = tool.input;
  let inputText = "";
  if (inp) {
    if (typeof inp.command === "string") inputText = inp.command; // Bash
    else if (typeof inp.prompt === "string") inputText = [inp.description && `# ${inp.description}`, inp.subagent_type && `(agent: ${inp.subagent_type})`, inp.prompt].filter(Boolean).join("\n"); // Task/Agent
    else if (typeof inp.file_path === "string") inputText = `${inp.file_path}\n\n${inp.content ?? inp.new_string ?? inp.old_string ?? ""}`; // Write/Edit
    else inputText = JSON.stringify(inp, null, 2);
  }
  const isAgent = !!tool.agentPath || !!tool.agentId;
  const hasDetail = !!inputText || !!tool.result || isAgent;
  return (
    <div className="tool-item">
      <button className={`tool-chip ${expanded ? "open" : ""}`} onClick={onToggle} disabled={!hasDetail}>
        <span className="tool-caret">{hasDetail ? (expanded ? "▾" : "▸") : "·"}</span>
        🔧 {tool.name}
        {isAgent && <span className="tool-agent-tag">sub-agent</span>}
        {tool.isError && <span className="tool-err-dot" title="errored">●</span>}
      </button>
      {expanded && hasDetail && (
        <div className="tool-detail">
          {inputText && (
            <div className="tool-sec">
              <div className="tool-sec-label">{isAgent ? "task given to the agent" : "input"}</div>
              <pre className="tool-pre">{inputText}</pre>
            </div>
          )}
          {isAgent ? (
            <div className="tool-sec">
              <div className="tool-sec-label">
                agent activity {agentRun?.running ? "· running…" : agentRun ? "· done" : "· loading…"}
              </div>
              {!agentRun && <div className="tool-pending">fetching the agent's transcript…</div>}
              {agentRun && agentRun.items.length === 0 && <div className="tool-pending">agent is starting…</div>}
              <div className="agent-feed">
                {agentRun?.items.map((it, i) =>
                  it.kind === "text" ? (
                    <div key={i} className="agent-text">{it.text}</div>
                  ) : (
                    <div key={i} className="agent-tool">
                      <div className="agent-tool-name">🔧 {it.name}</div>
                      {typeof it.input?.command === "string" && <pre className="tool-pre agent-mini">{it.input.command}</pre>}
                      {it.result && <pre className="tool-pre agent-mini">{it.result.slice(0, 2000)}</pre>}
                    </div>
                  ),
                )}
              </div>
            </div>
          ) : (
            <>
              {tool.result != null && (
                <div className="tool-sec">
                  <div className="tool-sec-label">{tool.isError ? "error" : "result"}</div>
                  <pre className="tool-pre">{tool.result}</pre>
                </div>
              )}
              {!tool.result && <div className="tool-pending">running… (result will appear here)</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<Question[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // sessions with a live VM on the server: sessionId → currently generating?
  const [liveMap, setLiveMap] = useState<Record<string, boolean>>({});
  const [showFiles, setShowFiles] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [showMcp, setShowMcp] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  // sub-agent transcripts, keyed by the Agent tool's tool_use_id
  const [agentRuns, setAgentRuns] = useState<Record<string, { items: AgentItem[]; running: boolean }>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const tempIdRef = useRef<string | null>(null); // pending new conversation marker
  const liveRef = useRef<Record<string, boolean>>({});
  const turnHadTextRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // fan-out of fs_* server messages to the Files panel
  const fileSubsRef = useRef(new Set<(m: any) => void>());

  const sendMsg = useCallback((obj: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(obj));
  }, []);
  const subscribeFiles = useCallback((fn: (m: any) => void) => {
    fileSubsRef.current.add(fn);
    return () => void fileSubsRef.current.delete(fn);
  }, []);

  const pushMessage = useCallback((role: Role, text: string, streaming = false) => {
    setMessages((prev) => [...prev, { id: nextId++, role, text, streaming }]);
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
    } catch {
      // backend not up yet; the list refreshes after the next turn
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Conversations run server-side now — switching away never interrupts one.
  const newChat = useCallback(() => {
    sessionRef.current = null;
    tempIdRef.current = null;
    turnHadTextRef.current = false;
    setSessionId(null);
    setMessages([]);
    setPendingQuestions(null);
    setRunning(false);
    try { localStorage.removeItem("onexo:lastSession"); } catch {}
    wsRef.current?.send(JSON.stringify({ type: "watch" }));
  }, []);

  const openConversationById = useCallback(
    async (session_id: string) => {
      try {
        const res = await fetch(`/api/conversations/${session_id}/messages`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sessionRef.current = session_id;
        tempIdRef.current = null;
        turnHadTextRef.current = false;
        setSessionId(session_id);
        try { localStorage.setItem("onexo:lastSession", session_id); } catch {}
        setMessages(data.messages.map(mapHistoryMessage));
        setPendingQuestions(null);
        setRunning(!!liveRef.current[session_id]);
        // subscribe to live events; a mid-flight turn is replayed by the server
        wsRef.current?.send(JSON.stringify({ type: "watch", sessionId: session_id }));
      } catch (err) {
        pushMessage("error", `Could not load conversation: ${String(err)}`);
      }
    },
    [pushMessage],
  );
  const openConversation = useCallback((c: Conversation) => openConversationById(c.session_id), [openConversationById]);

  // Reopen the last-viewed conversation after a reload (the VM keeps running).
  useEffect(() => {
    let last: string | null = null;
    try { last = localStorage.getItem("onexo:lastSession"); } catch {}
    if (last) openConversationById(last);
  }, [openConversationById]);

  const appendAssistantText = useCallback((text: string) => {
    turnHadTextRef.current = true;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: nextId++, role: "assistant", text, streaming: true }];
    });
  }, []);

  const finalizeAssistant = useCallback(() => {
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  // Create a tool badge as soon as the tool call starts (name + id); input and
  // result get filled in from the full assistant/user events by matching id.
  const pushTool = useCallback((name: string, id?: string) => {
    setMessages((prev) => [...prev, { id: nextId++, role: "tool", text: name, tool: { name, id } }]);
  }, []);

  // Merge details into the tool message whose tool.id matches.
  const enrichTool = useCallback((id: string, patch: Partial<ToolInfo>) => {
    setMessages((prev) => prev.map((m) => (m.tool?.id === id ? { ...m, tool: { ...m.tool, ...patch } } : m)));
  }, []);

  const handleClaudeEvent = useCallback(
    (ev: any) => {
      // Only render the top-level agent's stream, not subagent chatter.
      if (ev.type === "stream_event" && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          appendAssistantText(e.delta.text);
        } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
          finalizeAssistant();
          pushTool(e.content_block.name, e.content_block.id);
        }
      } else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        // Full assistant message — carries complete tool_use inputs.
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use" && block.id) enrichTool(block.id, { name: block.name, input: block.input });
        }
      } else if (ev.type === "user" && !ev.parent_tool_use_id) {
        // Tool results come back on the following user message.
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
              : typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            const agentPath = text.match(/output_file:\s*(\S+\.output)/)?.[1];
            enrichTool(block.tool_use_id, { result: text, isError: !!block.is_error, ...(agentPath ? { agentPath } : {}) });
          }
        }
      } else if (ev.type === "result") {
        if (!turnHadTextRef.current && typeof ev.result === "string" && ev.result) {
          pushMessage("assistant", ev.result);
        }
        finalizeAssistant();
        if (typeof ev.result === "string") {
          setPendingQuestions(parseQuestions(ev.result));
        }
      }
    },
    [appendAssistantText, finalizeAssistant, pushMessage, pushTool, enrichTool],
  );

  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // after a reconnect, re-attach to the conversation we're viewing
        if (sessionRef.current) {
          ws.send(JSON.stringify({ type: "watch", sessionId: sessionRef.current }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (raw) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw.data);
        } catch {
          return;
        }
        if (msg.type === "fs_tree" || msg.type === "fs_file" || msg.type === "fs_change") {
          fileSubsRef.current.forEach((fn) => fn(msg));
          return;
        }
        if (msg.type === "agent_update") {
          setAgentRuns((prev) => ({ ...prev, [msg.toolUseId]: { items: msg.items, running: msg.running } }));
          return;
        }
        if (msg.type === "mcp_servers") {
          setMcpServers(msg.servers);
          return;
        }
        if (msg.type === "mcp_auth_url") {
          window.open(msg.url, "_blank", "noopener");
          pushMessage("assistant", `Opening authorization for “${msg.name}” in a new tab — approve there and it'll connect automatically.`);
          return;
        }
        if (msg.type === "mcp_connect_error") {
          pushMessage("error", `Couldn't start OAuth for “${msg.name}”: ${msg.error}`);
          return;
        }
        if (msg.type === "login_url") {
          setLoginUrl(msg.url);
          return;
        }
        if (msg.type === "login_result") {
          setLoginUrl(null);
          setLoginCode("");
          pushMessage(
            msg.ok ? "assistant" : "error",
            msg.ok
              ? "✅ Connected your Claude account. New sessions will use it."
              : `Login failed: ${msg.error ?? "unknown error"}`,
          );
          return;
        }
        // Is this message about the conversation currently on screen?
        const forCurrent = (m: { sessionId?: string; tempId?: string }) =>
          (m.tempId && m.tempId === tempIdRef.current) ||
          (m.sessionId && m.sessionId === sessionRef.current) ||
          (!m.sessionId && !m.tempId);

        if (msg.type === "session") {
          const adopt =
            (msg.tempId && msg.tempId === tempIdRef.current) ||
            (msg.prev && msg.prev === sessionRef.current) ||
            (!msg.tempId && !msg.prev);
          if (adopt) {
            sessionRef.current = msg.sessionId;
            tempIdRef.current = null;
            setSessionId(msg.sessionId);
            try { localStorage.setItem("onexo:lastSession", msg.sessionId); } catch {}
          }
        } else if (msg.type === "claude_event") {
          if (forCurrent(msg)) handleClaudeEvent(msg.event);
        } else if (msg.type === "turn_user") {
          if (msg.sessionId === sessionRef.current) {
            setMessages((prev) => [...prev, mapHistoryMessage({ role: "user", text: msg.text })]);
          }
        } else if (msg.type === "live") {
          const map: Record<string, boolean> = {};
          for (const s of msg.sessions) map[s.sessionId] = s.busy;
          liveRef.current = map;
          setLiveMap(map);
          if (sessionRef.current) setRunning(!!map[sessionRef.current]);
          // a newly-started conversation may not be in the sidebar yet — refresh
          setConversations((cur) => {
            if (msg.sessions.some((s) => !cur.find((c) => c.session_id === s.sessionId))) loadConversations();
            return cur;
          });
        } else if (msg.type === "done") {
          loadConversations();
          if (!forCurrent(msg)) return; // another conversation finished in the background
          finalizeAssistant();
          setRunning(false);
          if (msg.code !== 0) {
            pushMessage("error", `claude exited with code ${msg.code}\n${msg.stderr ?? ""}`.trim());
          }
        } else if (msg.type === "error") {
          if (!forCurrent(msg)) return;
          pushMessage("error", msg.error);
          setRunning(false);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, [handleClaudeEvent, finalizeAssistant, pushMessage, loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingQuestions]);

  // `display` is what appears in the transcript; `text` is what claude receives.
  const sendText = useCallback(
    (text: string, display?: string, role: Role = "user") => {
      if (!text || running || wsRef.current?.readyState !== WebSocket.OPEN) return;
      turnHadTextRef.current = false;
      setPendingQuestions(null);
      pushMessage(role, display ?? text);
      // a brand-new conversation gets a tempId so the minted session id
      // can be matched back to this view even with others running
      if (!sessionRef.current && !tempIdRef.current) {
        tempIdRef.current = crypto.randomUUID();
      }
      wsRef.current.send(
        JSON.stringify({
          type: "chat",
          text,
          sessionId: sessionRef.current ?? undefined,
          tempId: sessionRef.current ? undefined : tempIdRef.current,
        }),
      );
      setRunning(true);
    },
    [running, pushMessage],
  );

  const send = () => {
    const text = input.trim();
    if (!text) return;
    // Dashboard slash-commands — handled here, never sent to Claude.
    if (text === "/login") {
      pushMessage("user", "/login");
      sendMsg({ type: "login" });
      setInput("");
      return;
    }
    if (text === "/mcp") {
      sendMsg({ type: "mcp_list" });
      setShowMcp(true);
      setInput("");
      return;
    }
    // A conversation runs one turn at a time — if this one is busy, keep the
    // draft (don't send or clear) so the user can wait or switch to another chat.
    if (running) return;
    sendText(text);
    setInput("");
  };

  const submitLoginCode = () => {
    const code = loginCode.trim();
    if (!code) return;
    sendMsg({ type: "login", code });
    pushMessage("assistant", "Completing login…");
  };

  // Shut down this conversation's VM now. Files persist on its volume; the next
  // message boots a fresh VM and restores them. Server broadcasts `live` so the
  // button/dot update on their own.
  const endSessionNow = useCallback(() => {
    const sid = sessionRef.current;
    if (!sid) return;
    wsRef.current?.send(JSON.stringify({ type: "end_session", sessionId: sid }));
  }, []);

  const visible = messages.filter(
    (m) => m.role !== "assistant" || stripAskBlock(m.text).length > 0 || m.streaming,
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <button className="new-chat" onClick={newChat}>
          + New chat
        </button>
        <div className="conv-list">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conv ${c.session_id === sessionId ? "active" : ""}`}
              onClick={() => openConversation(c)}
            >
              <span className="conv-title">
                {c.session_id in liveMap && (
                  <span
                    className={`conv-dot ${liveMap[c.session_id] ? "busy" : "idle"}`}
                    title={liveMap[c.session_id] ? "generating…" : "VM alive"}
                  />
                )}
                {c.title}
              </span>
              <span className="conv-time">
                {new Date(c.updated_at.replace(" ", "T") + "Z").toLocaleString()}
              </span>
            </button>
          ))}
          {conversations.length === 0 && <div className="conv-empty">No conversations yet</div>}
        </div>
      </aside>

      <div className="app">
      <header>
        <span className="title">Claude Code Chat</span>
        <span className={`status ${connected ? "on" : "off"}`}>
          {connected ? "connected" : "disconnected"}
        </span>
        {sessionId && <span className="session">session {sessionId.slice(0, 8)}</span>}
        <button
          className="files-toggle"
          onClick={() => setShowMcp(true)}
          title="Configure MCP servers for your sessions"
        >
          MCP
        </button>
        <button
          className={`files-toggle ${showFiles ? "on" : ""}`}
          onClick={() => setShowFiles((v) => !v)}
          disabled={!sessionId}
          title={sessionId ? "Show files Claude changed on the VM" : "Start a conversation first"}
        >
          {showFiles ? "Hide files" : "Files"}
        </button>
        <button
          className="end-session"
          onClick={endSessionNow}
          disabled={!sessionId || !(sessionId in liveMap) || running}
          title={
            sessionId && sessionId in liveMap
              ? "Shut down this conversation's VM now (files are kept; the next message restarts it)"
              : "No running VM for this conversation"
          }
        >
          End session
        </button>
      </header>

      <main className="transcript">
        {messages.length === 0 && (
          <div className="empty">Say “hi” to start a Claude Code session.</div>
        )}
        {visible.map((m) =>
          m.role === "tool" ? (
            <ToolChip
              key={m.id}
              tool={m.tool ?? { name: m.text }}
              expanded={expandedTools.has(m.id)}
              agentRun={m.tool?.id ? agentRuns[m.tool.id] : undefined}
              onToggle={() => {
                const willExpand = !expandedTools.has(m.id);
                setExpandedTools((prev) => {
                  const next = new Set(prev);
                  next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                  return next;
                });
                // Sub-agent activity: stream live if the VM is up (agentPath),
                // else fetch the persisted transcript (agentId).
                const t = m.tool;
                if (willExpand && t?.agentPath && t.id && sessionRef.current) {
                  sendMsg({ type: "agent_watch", sessionId: sessionRef.current, toolUseId: t.id, path: t.agentPath });
                } else if (!willExpand && t?.agentPath && t.id && sessionRef.current) {
                  sendMsg({ type: "agent_unwatch", sessionId: sessionRef.current, toolUseId: t.id });
                } else if (willExpand && !t?.agentPath && t?.agentId && t.id && sessionRef.current) {
                  const key = t.id;
                  fetch(`/api/agents/${sessionRef.current}/${t.agentId}`)
                    .then((r) => r.json())
                    .then((d) => setAgentRuns((prev) => ({ ...prev, [key]: { items: d.items ?? [], running: false } })))
                    .catch(() => {});
                }
              }}
            />
          ) : (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.role === "answer" && <span className="answer-check">✓ </span>}
              {m.role === "assistant" ? (
                <Markdown remarkPlugins={[remarkGfm]}>{stripAskBlock(m.text)}</Markdown>
              ) : (
                m.text
              )}
              {m.streaming && <span className="cursor">▍</span>}
            </div>
          ),
        )}
        {pendingQuestions && !running && (
          <QuestionCard
            questions={pendingQuestions}
            onSubmit={(text, display) => sendText(text, display, "answer")}
            onSkip={() =>
              sendText(
                "I'll skip that question — proceed with your best judgment.",
                "Skipped",
                "answer",
              )
            }
          />
        )}
        {loginUrl && (
          <div className="login-card">
            <div className="login-step">
              <span className="login-num">1</span>
              <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                Open the Anthropic login page ↗
              </a>
            </div>
            <div className="login-step">
              <span className="login-num">2</span>
              <span>Approve access, copy the code it shows, and paste it here:</span>
            </div>
            <div className="login-input-row">
              <input
                className="other-input"
                placeholder="Paste authorization code"
                value={loginCode}
                onChange={(e) => setLoginCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLoginCode()}
                autoFocus
              />
              <button className="submit" disabled={!loginCode.trim()} onClick={submitLoginCode}>
                Connect
              </button>
            </div>
          </div>
        )}
        {running && !messages.some((m) => m.streaming) && (
          <div className="thinking">Claude is thinking…</div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          value={input}
          placeholder={running ? "Claude is working — draft your next message (send enabled when it finishes)" : "Message Claude Code  ·  /login  /mcp"}
          disabled={!connected}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
        />
        <button onClick={send} disabled={!connected || running || !input.trim()}>
          Send
        </button>
      </footer>
      </div>

      {showFiles && (
        <aside className="files-col">
          <FilesPanel sessionId={sessionId} send={sendMsg} subscribe={subscribeFiles} />
        </aside>
      )}

      {showMcp && (
        <McpPanel servers={mcpServers} send={sendMsg} onClose={() => setShowMcp(false)} />
      )}
    </div>
  );
}
