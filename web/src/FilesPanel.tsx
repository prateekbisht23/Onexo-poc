import { useCallback, useEffect, useRef, useState } from "react";

export type FsEntry = { name: string; path: string; dir: boolean; size: number; modifiedTime?: string };
type FileMsg =
  | { type: "fs_tree"; sessionId?: string; path: string; entries: FsEntry[]; changed: string[] }
  | { type: "fs_file"; sessionId?: string; path: string; content: string }
  | { type: "fs_change"; sessionId?: string; path: string; kind: "created" | "modified" | "deleted" };

// Claude edits atomically (temp file + rename) and repos carry noise dirs —
// hide both so the panel shows real source, not churn.
const HIDDEN_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv"]);
const isNoise = (name: string) =>
  name.includes(".tmp.") || name.endsWith("~") || name.endsWith(".swp");

// The VM path is absolute (/home/user/projects/...); show it relative to the root.
const ROOT = "/home/user/projects";
const rel = (p: string) => (p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : p.replace(/^\//, ""));

type DiffLine = { kind: " " | "+" | "-"; text: string };
// Minimal LCS line diff — enough to show what changed, no dependency.
function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: " ", text: x[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "-", text: x[i] }); i++; }
    else { out.push({ kind: "+", text: y[j] }); j++; }
  }
  while (i < n) out.push({ kind: "-", text: x[i++] });
  while (j < m) out.push({ kind: "+", text: y[j++] });
  return out;
}

export default function FilesPanel({
  sessionId,
  send,
  subscribe,
}: {
  sessionId: string | null;
  send: (msg: unknown) => void;
  subscribe: (fn: (msg: FileMsg) => void) => () => void;
}) {
  const [trees, setTrees] = useState<Record<string, FsEntry[]>>({}); // dir path → entries
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [view, setView] = useState<"raw" | "diff">("raw");
  const baselineRef = useRef<Record<string, string>>({}); // path → first-seen content
  const selectedRef = useRef<string | null>(null);

  // Reset everything when the conversation changes.
  useEffect(() => {
    setTrees({});
    setExpanded(new Set());
    setChanged(new Set());
    setSelected(null);
    setContent(null);
    baselineRef.current = {};
    selectedRef.current = null;
    if (sessionId) send({ type: "fs_tree", sessionId });
  }, [sessionId, send]);

  const openFile = useCallback(
    (path: string) => {
      selectedRef.current = path;
      setSelected(path);
      send({ type: "fs_open", sessionId, path });
    },
    [send, sessionId],
  );

  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (msg.sessionId && msg.sessionId !== sessionId) return;
      if (msg.type === "fs_tree") {
        setTrees((prev) => ({ ...prev, [msg.path]: msg.entries }));
        if (msg.changed?.length) setChanged(new Set(msg.changed.map(rel)));
      } else if (msg.type === "fs_file") {
        if (baselineRef.current[msg.path] === undefined) baselineRef.current[msg.path] = msg.content;
        setContent(msg.content);
      } else if (msg.type === "fs_change") {
        const r = rel(msg.path);
        if (isNoise(msg.path.split("/").pop() ?? "")) return;
        setChanged((prev) => {
          const next = new Set(prev);
          if (msg.kind === "deleted") next.delete(r);
          else next.add(r);
          return next;
        });
        // refresh the open file live, and the tree of its directory
        if (selectedRef.current && rel(selectedRef.current) === r) {
          send({ type: "fs_open", sessionId, path: selectedRef.current });
          setView("diff");
        }
      }
    });
    return unsub;
  }, [subscribe, sessionId, send]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!trees[path]) send({ type: "fs_tree", sessionId, path });
      }
      return next;
    });
  };

  const renderTree = (dirPath: string, depth: number) => {
    const entries = (trees[dirPath] ?? [])
      .filter((e) => !(e.dir && HIDDEN_DIRS.has(e.name)) && !isNoise(e.name))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return entries.map((e) => (
      <div key={e.path}>
        <button
          className={`fp-row ${selected === e.path ? "sel" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.dir ? toggleDir(e.path) : openFile(e.path))}
        >
          <span className="fp-ic">{e.dir ? (expanded.has(e.path) ? "▾" : "▸") : "·"}</span>
          <span className="fp-name">{e.name}</span>
          {!e.dir && changed.has(rel(e.path)) && <span className="fp-dot" title="changed" />}
        </button>
        {e.dir && expanded.has(e.path) && renderTree(e.path, depth + 1)}
      </div>
    ));
  };

  if (!sessionId) {
    return <div className="fp-empty">Files appear here once a conversation starts.</div>;
  }

  const changedList = [...changed].sort();
  const diff = selected && baselineRef.current[selected] !== undefined && content !== null
    ? lineDiff(baselineRef.current[selected], content)
    : null;
  const hasDiff = diff?.some((l) => l.kind !== " ") ?? false;

  return (
    <div className="fp">
      <div className="fp-head">Files on VM</div>

      {changedList.length > 0 && (
        <div className="fp-changed">
          <div className="fp-section">Changed ({changedList.length})</div>
          {changedList.map((r) => (
            <button
              key={r}
              className={`fp-chg ${selected && rel(selected) === r ? "sel" : ""}`}
              onClick={() => openFile(ROOT + "/" + r)}
            >
              <span className="fp-dot" /> {r}
            </button>
          ))}
        </div>
      )}

      <div className="fp-tree">{renderTree(".", 0)}</div>

      {selected && (
        <div className="fp-viewer">
          <div className="fp-viewer-head">
            <span className="fp-viewer-name" title={selected}>{rel(selected)}</span>
            {hasDiff && (
              <div className="fp-toggle">
                <button className={view === "diff" ? "on" : ""} onClick={() => setView("diff")}>Diff</button>
                <button className={view === "raw" ? "on" : ""} onClick={() => setView("raw")}>Raw</button>
              </div>
            )}
          </div>
          {content === null ? (
            <div className="fp-loading">loading…</div>
          ) : view === "diff" && diff ? (
            <pre className="fp-code">
              {diff.map((l, i) => (
                <div key={i} className={`dl ${l.kind === "+" ? "add" : l.kind === "-" ? "del" : ""}`}>
                  <span className="dl-sign">{l.kind}</span>
                  {l.text}
                </div>
              ))}
            </pre>
          ) : (
            <pre className="fp-code">
              {content.split("\n").map((l, i) => (
                <div key={i} className="dl">{l}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
