"use client";

import { Tabs } from "@base-ui/react/tabs";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppState, BridgeEvent, Message, TraceItem } from "@/lib/types";

const empty: AppState = { mode: "setup", conversations: [], messages: [], files: [], artifacts: [], memories: [], pkmSources: [], citations: [], trace: [], permissions: [], connections: [] };
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
const formatTimestamp = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const today = new Date();
  return new Intl.DateTimeFormat(undefined, date.toDateString() === today.toDateString()
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
};

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="mark" aria-hidden="true">{children}</span>;
}

async function readSse(response: Response, onEvent: (event: BridgeEvent) => void) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("The response did not include a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6);
      if (data) onEvent(JSON.parse(data) as BridgeEvent);
    }
    if (done) break;
  }
}

export function Workspace() {
  const router = useRouter();
  const [state, setState] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState("Ready");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState("artifact");
  const [conversationSearch, setConversationSearch] = useState("");
  const [activeRunId, setActiveRunId] = useState<string>();
  const [interaction, setInteraction] = useState<Record<string, unknown>>();
  const [interactionQueue, setInteractionQueue] = useState<Record<string, unknown>[]>([]);
  const [interactionValue, setInteractionValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const openTools = () => { setRightTab("tools"); setRightOpen(true); };

  const load = async (conversation?: string) => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/state${conversation ? `?conversation=${encodeURIComponent(conversation)}` : ""}`, { cache: "no-store" });
      const value = await response.json();
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok && response.status !== 503) throw new Error(value.error ?? "Could not load workspace");
      const next = value as AppState;
      setState(next);
      setActiveRunId(next.activeRun?.id);
      const queued = next.activeRun?.interactions ?? [];
      setInteractionQueue(queued);
      setInteraction(queued[0]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load workspace"); }
    finally { setLoading(false); }
  };

  // Initial data arrives from an external service; load owns its lifecycle state.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.messages, running]);
  useEffect(() => {
    if (!state.activeRun?.id || running) return;
    const runId = state.activeRun.id;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    source.onmessage = (message) => {
      const bridge = JSON.parse(message.data) as BridgeEvent;
      if (bridge.type === "delta" && typeof bridge.text === "string") setState((current) => {
        const recoveredId = `recovered-${runId}`;
        const exists = current.messages.some(({ id }) => id === recoveredId);
        return { ...current, messages: exists ? current.messages.map((item) => item.id === recoveredId ? { ...item, content: item.content + bridge.text } : item) : [...current.messages, { id: recoveredId, role: "assistant", content: bridge.text as string, createdAt: "Recovered", pending: true }] };
      });
      if ((bridge.type === "status" || bridge.type === "interaction") && typeof bridge.label === "string") setRunStatus(bridge.label);
      if (bridge.type === "interaction" && bridge.request && typeof bridge.request === "object") {
        const next = bridge.request as Record<string, unknown>;
        setInteractionQueue((current) => current.some(({ id }) => id === next.id) ? current : [...current, next]);
        setInteraction((current) => current ?? next);
      }
      if (bridge.type === "done") { source.close(); setActiveRunId(undefined); setInteraction(undefined); setInteractionQueue([]); void load(typeof bridge.conversationId === "string" ? bridge.conversationId : state.activeConversationId); }
      if (bridge.type === "error") { source.close(); setError(String(bridge.message ?? "Run failed")); setRunStatus("Failed"); }
    };
    source.onerror = () => setRunStatus("Reconnecting…");
    return () => source.close();
    // The durable run id owns one EventSource lifecycle; load is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeRun?.id, running]);

  const selectConversation = (id: string) => { setLeftOpen(false); void load(id); };
  const newConversation = () => {
    setState((current) => ({ ...current, activeConversationId: undefined, messages: [], files: [], artifacts: [], citations: [], trace: [] }));
    setLeftOpen(false); setDraft("");
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || running) return;
    const user: Message = { id: crypto.randomUUID(), role: "user", content: message, createdAt: "Now" };
    const assistantId = crypto.randomUUID();
    setState((current) => ({ ...current, messages: [...current.messages, user, { id: assistantId, role: "assistant", content: "", createdAt: "Now", pending: true }] }));
    setDraft(""); setRunning(true); setRunStatus("Starting"); setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId: state.activeConversationId, fileIds: state.files.map(({ id }) => id) }),
      });
      await readSse(response, (bridge) => {
        if (bridge.type === "delta" && typeof bridge.text === "string") {
          setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: item.content + bridge.text } : item) }));
        }
        if ((bridge.type === "status" || bridge.type === "interaction") && typeof bridge.label === "string") {
          setRunStatus(bridge.label);
          const trace: TraceItem = { id: crypto.randomUUID(), type: String(bridge.phase ?? bridge.type), label: bridge.label, status: "running", at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) };
          setState((current) => ({ ...current, trace: [...current.trace, trace] }));
        }
        if (bridge.type === "status" && typeof bridge.runId === "string") {
          setActiveRunId(bridge.runId);
          setState((current) => ({ ...current, activeRun: { id: bridge.runId as string, status: String(bridge.phase ?? "running"), interactions: interactionQueue } }));
        }
        if (bridge.type === "interaction" && bridge.request && typeof bridge.request === "object") {
          const next = bridge.request as Record<string, unknown>;
          setInteractionQueue((current) => current.some(({ id }) => id === next.id) ? current : [...current, next]);
          setInteraction((current) => current ?? next);
        }
        if (bridge.type === "done") {
          setRunStatus("Complete");
          setInteraction(undefined); setInteractionQueue([]);
          setState((current) => ({
            ...current,
            activeConversationId: typeof bridge.conversationId === "string" ? bridge.conversationId : current.activeConversationId,
            messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: typeof bridge.output === "string" ? bridge.output : item.content, pending: false } : item),
          }));
          if (typeof bridge.conversationId === "string") void load(bridge.conversationId);
        }
        if (bridge.type === "error") throw new Error(String(bridge.message ?? "Run failed"));
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Run failed";
      setError(message); setRunStatus("Failed");
      setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: `Run failed: ${message}`, pending: false } : item) }));
    } finally { setRunning(false); }
  };

  const respond = async (action: "submit" | "decline" | "cancel", permission?: "allow_once" | "allow_for_run" | "allow_always" | "deny", submittedValue?: unknown) => {
    const checkpoint = interaction?.checkpoint && typeof interaction.checkpoint === "object" ? interaction.checkpoint as { digest?: unknown } : {};
    if (!activeRunId || typeof interaction?.id !== "string" || typeof checkpoint.digest !== "string") return;
    const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: {
        interactionId: interaction.id, checkpointDigest: checkpoint.digest, action,
        ...(action === "submit" && submittedValue !== undefined ? { value: submittedValue } : action === "submit" && interactionValue ? { value: interactionValue } : {}), ...(permission ? { permission } : {}),
      } }),
    });
    const value = await response.json();
    if (!response.ok) { setError(value.error ?? "Interaction response failed"); return; }
    const remaining = interactionQueue.filter(({ id }) => id !== interaction?.id);
    setInteractionQueue(remaining); setInteraction(remaining[0]); setInteractionValue(""); setRunStatus(remaining.length ? "More input required" : "Resuming");
  };

  const upload = async (file?: File, forInteraction = false) => {
    if (!file) return;
    const form = new FormData(); form.set("file", file);
    if (state.activeConversationId) form.set("conversationId", state.activeConversationId);
    else if (state.mode === "demo") form.set("conversationId", "demo-quarterly");
    if (forInteraction && activeRunId) form.set("runId", activeRunId);
    const response = await fetch("/api/files", { method: "POST", body: form });
    const value = await response.json();
    if (!response.ok) { setError(value.error ?? "Upload failed"); return undefined; }
    setState((current) => ({ ...current, activeConversationId: typeof value.conversationId === "string" ? value.conversationId : current.activeConversationId, files: [...current.files, value] }));
    return value as { fileRef?: string; mimeType: string; size: number; sha256?: string };
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login"); router.refresh();
  };
  const revokePermission = async (id: string) => {
    const response = await fetch("/api/permissions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    if (!response.ok) { const body = await response.json(); setError(body.error ?? "Permission revoke failed"); return; }
    setState((current) => ({ ...current, permissions: current.permissions.filter((grant) => grant.id !== id) }));
  };

  return (
    <main className={`workspace ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`}>
      <aside className="rail left-rail" aria-label="Conversations">
        <div className="brand-row"><div className="brand"><Mark>⌁</Mark><span>arc</span></div><button className="icon-button mobile-only" onClick={() => setLeftOpen(false)} aria-label="Close conversations">×</button></div>
        <button className="new-chat" onClick={newConversation}><span>＋</span> New conversation <kbd>⌘ K</kbd></button>
        <label className="search"><span>⌕</span><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
        <div className="rail-label">Recent</div>
        <nav className="conversation-list">
          {state.conversations.filter(({ title, preview }) => `${title}\n${preview}`.toLocaleLowerCase().includes(conversationSearch.toLocaleLowerCase())).map((conversation) => (
            <button key={conversation.id} className={conversation.id === state.activeConversationId ? "conversation active" : "conversation"} onClick={() => selectConversation(conversation.id)}>
              <span className="conversation-top"><strong>{conversation.title}</strong><time>{formatTimestamp(conversation.updatedAt)}</time></span>
              <span className="conversation-preview">{conversation.preview}</span>
            </button>
          ))}
          {!loading && state.conversations.length === 0 && <p className="empty-small">No conversations yet.</p>}
        </nav>
        <div className="rail-footer"><span className="avatar">{state.user?.email?.[0]?.toUpperCase() ?? "?"}</span><span><strong>{state.user?.email ?? "Setup required"}</strong><small>{state.mode === "demo" ? "Local developer" : "Supabase account"}</small></span><button className="icon-button" aria-label="로그아웃" title="로그아웃" onClick={() => void signOut()}>↪</button></div>
      </aside>

      <section className="chat-column">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setLeftOpen(true)} aria-label="Open conversations">☰</button>
          <div><h1>{state.conversations.find(({ id }) => id === state.activeConversationId)?.title ?? "New conversation"}</h1><p><span className={`live-dot ${running ? "working" : ""}`} /> {running ? runStatus : "Harnest ready"}</p></div>
          <div className="top-actions"><button className="icon-button mobile-only" onClick={() => setRightOpen(true)} aria-label="Open context panel">◫</button></div>
        </header>

        {state.mode === "demo" && <div className="mode-banner"><strong>Local deterministic development path</strong><span>No Supabase, model, tool, or Harnest service is being simulated as production.</span></div>}
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss">×</button></div>}

        <div className="messages" aria-live="polite">
          {loading ? <div className="center-state"><span className="spinner" />Loading workspace…</div> : null}
          {!loading && state.mode === "setup" ? (
            <SetupCard missing={state.setup?.missing ?? []} />
          ) : null}
          {!loading && state.mode !== "setup" && state.messages.length === 0 ? (
            <div className="welcome"><Mark>⌁</Mark><h2>What should we make?</h2><p>Ask a direct question, research a topic, or hand off an engineering task.</p></div>
          ) : null}
          {state.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-avatar">{message.role === "user" ? (state.user?.email?.[0]?.toUpperCase() ?? "Y") : "⌁"}</div>
              <div className="message-body"><div className="message-meta"><strong>{message.role === "user" ? "You" : "Arc"}</strong><time>{formatTimestamp(message.createdAt)}</time>{message.pending && <span className="streaming-label">streaming</span>}</div>
                <div className="message-copy">{message.content || <span className="thinking"><i /><i /><i /></span>}</div>
                {message.role === "assistant" && message.content && <div className="message-actions"><button onClick={() => void navigator.clipboard.writeText(message.content)} aria-label="Copy response">Copy</button></div>}
              </div>
            </article>
          ))}
          {interaction && <InteractionCard runId={activeRunId} request={interaction} value={interactionValue} setValue={setInteractionValue} respond={respond} upload={(file) => upload(file, true)} />}
          {running && <div className="run-card"><span className="spinner" /><span><strong>{runStatus}</strong><small>Runtime events are available in Trace.</small></span><span className="run-time">live</span></div>}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          {state.files.length > 0 && <div className="attachment-row">{state.files.slice(-3).map((file) => <span key={file.id}>▱ {file.name}<small>{file.status}</small></span>)}</div>}
          <form className="composer" onSubmit={send}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Message Arc…" aria-label="Message" rows={1} disabled={state.mode === "setup"} />
            <div className="composer-tools">
              <input ref={fileRef} hidden type="file" onChange={(event) => void upload(event.target.files?.[0])} />
              <button type="button" className="tool-button" onClick={() => fileRef.current?.click()} disabled={state.mode === "setup"} aria-label="Attach input file">＋ <span>Input</span></button>
              <button type="button" className="tool-button" onClick={openTools} aria-label="Open Harness tools">⌘ <span>Tools</span></button>
              <span className="composer-hint">Enter to send · Shift Enter for newline</span>
              <button className="send-button" disabled={!draft.trim() || running || state.mode === "setup"} aria-label="Send message">↑</button>
            </div>
          </form>
          <p className="disclaimer">Arc can make mistakes. Verify important results and citations.</p>
        </div>
      </section>

      <aside className="rail right-rail" aria-label="Context and run details">
        <div className="right-mobile-head mobile-only"><strong>Workspace context</strong><button className="icon-button" onClick={() => setRightOpen(false)} aria-label="Close context panel">×</button></div>
        <Tabs.Root value={rightTab} onValueChange={setRightTab} className="tabs">
          <Tabs.List className="tab-list" aria-label="Run data">
            {["Artifact", "Files", "Tools", "Memory", "PKM Sources", "Citations", "Permissions", "Trace"].map((label) => <Tabs.Tab key={label} value={label.toLowerCase().replace(" ", "-")} className="tab">{label}</Tabs.Tab>)}
          </Tabs.List>
          <div className="panel-scroll">
            <Tabs.Panel value="artifact" className="tab-panel"><ArtifactPanel state={state} /></Tabs.Panel>
            <Tabs.Panel value="files" className="tab-panel"><ListHeading title="Files" count={state.files.length} action="Upload" onAction={() => fileRef.current?.click()} />{state.files.map((file) => <ItemCard key={file.id} icon="▱" title={file.name} meta={`${formatBytes(file.size)} · ${file.status}`} href={`/api/files?id=${encodeURIComponent(file.id)}`} />)}{!state.files.length && <Empty text="Attached files appear here." />}</Tabs.Panel>
            <Tabs.Panel value="tools" className="tab-panel"><ToolPanel onUsePrompt={(prompt) => { setDraft(prompt); setRightOpen(false); }} /></Tabs.Panel>
            <Tabs.Panel value="memory" className="tab-panel"><MemoryPanel state={state} reload={() => load(state.activeConversationId)} /></Tabs.Panel>
            <Tabs.Panel value="pkm-sources" className="tab-panel"><PkmPanel state={state} reload={() => load(state.activeConversationId)} /></Tabs.Panel>
            <Tabs.Panel value="citations" className="tab-panel"><ListHeading title="Citations" count={state.citations.length} />{state.citations.map((citation) => <a className="citation-card" key={citation.id} href={citation.url} target="_blank" rel="noreferrer"><span>{citation.index}</span><div><strong>{citation.title}</strong><p>{citation.excerpt}</p></div></a>)}{!state.citations.length && <Empty text="Grounded sources appear with an answer." />}</Tabs.Panel>
            <Tabs.Panel value="permissions" className="tab-panel"><ListHeading title="Always allowed" count={state.permissions.length} />{state.permissions.map((grant) => <div className="item-card" key={grant.id}><span>✓</span><div><strong>{grant.toolId}</strong><small>{grant.capability}{grant.resource ? ` · ${grant.resource}` : ""}</small></div><button onClick={() => void revokePermission(grant.id)}>Revoke</button></div>)}{!state.permissions.length && <Empty text="No persistent tool permissions." />}</Tabs.Panel>
            <Tabs.Panel value="trace" className="tab-panel"><ListHeading title="Trace" count={state.trace.length} /> <div className="trace-list">{state.trace.map((trace) => <div className="trace-row" key={trace.id}><span className="trace-dot" /><div><strong>{trace.label}</strong><small>{trace.type} · {trace.at}</small></div><em>{trace.status}</em></div>)}</div>{!state.trace.length && <Empty text="Run events will stream here." />}</Tabs.Panel>
          </div>
        </Tabs.Root>
      </aside>
      {(leftOpen || rightOpen) && <button className="scrim mobile-only" onClick={() => { setLeftOpen(false); setRightOpen(false); }} aria-label="Close panels" />}
    </main>
  );
}

function SetupCard({ missing }: { missing: string[] }) {
  return <section className="setup-card"><div className="setup-icon">⌁</div><p className="eyebrow">SETUP REQUIRED</p><h2>Connect the production boundary</h2><p>This app never substitutes in-memory data when Supabase is unavailable. Apply the migration, configure private Storage, then authenticate.</p>
    {missing.length > 0 && <pre>{missing.join("\n")}</pre>}
    <a className="setup-login" href="/login">로그인 페이지로 이동</a>
    <div className="setup-steps"><span><b>1</b> supabase db push</span><span><b>2</b> copy .env.example</span><span><b>3</b> start Harnest HTTP</span></div>
    <small>For a no-credential UI check only, set <code>NEXT_PUBLIC_LOCAL_DEMO=true</code>. The app labels that path everywhere.</small>
  </section>;
}

function ListHeading({ title, count, action, onAction }: { title: string; count: number; action?: string; onAction?: () => void }) { return <div className="list-heading"><span><strong>{title}</strong><small>{count} items</small></span>{action && <button onClick={onAction}>{action}</button>}</div>; }
function ItemCard({ icon, title, meta, href }: { icon: string; title: string; meta: string; href?: string }) { return <div className="item-card"><span>{icon}</span><div><strong>{title}</strong><small>{meta}</small></div>{href && <a href={href} aria-label={`Download ${title}`}>↓</a>}</div>; }
function Empty({ text }: { text: string }) { return <p className="panel-empty">{text}</p>; }

function ToolPanel({ onUsePrompt }: { onUsePrompt: (prompt: string) => void }) {
  const tools = [
    { name: "Multimodal input", ready: true, detail: "Images, PDFs, and attached files", prompt: "Analyze the attached file and explain the important findings." },
    { name: "Web search", ready: true, detail: "Firecrawl search and page extraction", prompt: "Research the latest reliable information about this topic, verify it with web sources, and cite the URLs: " },
    { name: "Code interpreter", ready: true, detail: "Isolated code, shell, and file workspace", prompt: "Use the code interpreter to analyze this task, verify the result, and return any generated artifact: " },
    { name: "Dynamic agent team", ready: true, detail: "Planner, researcher, engineer, and reviewer", prompt: "Create a team plan, delegate the work, verify the result, and give me only the final answer: " },
    { name: "Memory + PKM", ready: true, detail: "External conversation, memory, and knowledge providers", prompt: "Use my saved memory and PKM sources when relevant, cite the used sources, and answer: " },
  ];
  return <><ListHeading title="Harness tools" count={tools.length} /><p className="panel-intro">These are capabilities of the running Harness, not credential fields. Pick a test prompt or describe the goal directly; routing chooses the smallest required path.</p>{tools.map((tool) => <div className="item-card" key={tool.name}><span>✓</span><div><strong>{tool.name}</strong><small>{tool.detail}</small></div><button onClick={() => onUsePrompt(tool.prompt)}>Test</button></div>)}</>;
}

function MemoryPanel({ state, reload }: { state: AppState; reload: () => Promise<void> }) {
  const [key, setKey] = useState(""); const [value, setValue] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true); setMessage("");
    const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "memory", key, value }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Memory save failed"); return; }
    setKey(""); setValue(""); setMessage("Memory saved."); await reload();
  };
  const remove = async (id: string) => { await fetch("/api/context", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "memory", id }) }); await reload(); };
  return <><ListHeading title="Memory" count={state.memories.length} /><form className="context-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><input value={key} onChange={(event) => setKey(event.target.value)} placeholder="Key, e.g. writing.style" aria-label="Memory key" /><textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder="What should the harness remember?" aria-label="Memory value" rows={3} /><button disabled={busy || !key.trim() || !value.trim()}>{busy ? "Saving…" : "Save memory"}</button></form>{message && <p className="connection-message" role="status">{message}</p>}{state.memories.map((memory) => <div className="memory-card" key={memory.id}><code>{memory.key}</code><p>{memory.value}</p><small>{memory.updatedAt}</small><button onClick={() => void remove(memory.id)}>Remove</button></div>)}{!state.memories.length && <Empty text="No saved memory for this account." />}</>;
}

function PkmPanel({ state, reload }: { state: AppState; reload: () => Promise<void> }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true); setMessage("");
    const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "pkm", title, content }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "PKM import failed"); return; }
    setTitle(""); setContent(""); setMessage(`Knowledge indexed in ${body.chunks} chunk(s).`); await reload();
  };
  const remove = async (id: string) => { await fetch("/api/context", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "pkm", id }) }); await reload(); };
  return <><ListHeading title="PKM Sources" count={state.pkmSources.length} /><form className="context-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Source title" aria-label="PKM source title" /><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Paste knowledge text to index" aria-label="PKM source content" rows={5} /><button disabled={busy || !title.trim() || !content.trim()}>{busy ? "Indexing…" : "Add knowledge"}</button></form>{message && <p className="connection-message" role="status">{message}</p>}{state.pkmSources.map((source) => <div className="item-card" key={source.id}><span>◇</span><div><strong>{source.title}</strong><small>{source.kind} · {source.status}</small></div><button onClick={() => void remove(source.id)}>Remove</button></div>)}{!state.pkmSources.length && <Empty text="No owned knowledge sources yet." />}</>;
}

function InteractionCard({ runId, request, value, setValue, respond, upload }: {
  runId?: string; request: Record<string, unknown>; value: string; setValue: (value: string) => void;
  respond: (action: "submit" | "decline" | "cancel", permission?: "allow_once" | "allow_for_run" | "allow_always" | "deny", value?: unknown) => Promise<void>;
  upload: (file: File) => Promise<{ fileRef?: string; mimeType: string; size: number; sha256?: string } | undefined>;
}) {
  const kind = String(request.kind ?? "input");
  const schema = request.schema && typeof request.schema === "object" ? request.schema as Record<string, unknown> : {};
  const data = request.data && typeof request.data === "object" ? request.data as Record<string, unknown> : {};
  const checkpoint = request.checkpoint && typeof request.checkpoint === "object" ? request.checkpoint as Record<string, unknown> : {};
  const [form, setForm] = useState<Record<string, unknown>>({});
  const primitive = () => kind === "select" && Array.isArray(schema.enum) ? schema.enum[Number(value)] : schema.type === "number" || schema.type === "integer" ? Number(value) : schema.type === "boolean" ? value === "true" : value;
  const enumAt = (field: Record<string, unknown>, index: number) => Array.isArray(field.enum) ? field.enum[index] : undefined;
  const fields = schema.properties && typeof schema.properties === "object" ? Object.entries(schema.properties as Record<string, Record<string, unknown>>) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const formValid = fields.every(([name, field]) => {
    const fieldValue = form[name];
    if (required.has(name) && fieldValue === undefined) return false;
    if (fieldValue === undefined) return true;
    if (typeof fieldValue === "number" && ((typeof field.minimum === "number" && fieldValue < field.minimum) || (typeof field.maximum === "number" && fieldValue > field.maximum))) return false;
    if (typeof fieldValue === "string" && ((typeof field.minLength === "number" && fieldValue.length < field.minLength) || (typeof field.maxLength === "number" && fieldValue.length > field.maxLength))) return false;
    return !Array.isArray(field.enum) || field.enum.some((candidate) => Object.is(candidate, fieldValue));
  });
  const persistentPermissionAllowed = data.previewLimited === false && data.resourceResolved === true;
  const interactionId = typeof request.id === "string" ? request.id : undefined;
  useEffect(() => {
    if (kind !== "oauth" || !interactionId) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
      const payload = event.data as Record<string, unknown>;
      if (Object.keys(payload).some((key) => !["type", "interactionId", "connectionRef"].includes(key))) return;
      if (payload.type === "harnest.oauth.complete" && payload.interactionId === interactionId && typeof payload.connectionRef === "string") void respond("submit", undefined, { connectionRef: payload.connectionRef });
    };
    addEventListener("message", receive); return () => removeEventListener("message", receive);
  }, [interactionId, kind, respond]);
  return <section className="interaction-card"><p className="eyebrow">INPUT REQUIRED · {kind}</p><h3>{String(request.title ?? "Harnest needs input")}</h3><p>{String(request.message ?? "Review this request before the run continues.")}</p>
    <small>Checkpoint {String(checkpoint.revision ?? "—")} · sequence {String(checkpoint.sequence ?? "—")}{typeof request.expiresAt === "string" ? ` · expires ${new Date(request.expiresAt).toLocaleString()}` : ""}</small>
    {kind === "select" && <select required value={value} onChange={(event) => setValue(event.target.value)} aria-label="Select response"><option value="">Choose…</option>{(Array.isArray(schema.enum) ? schema.enum : []).map((option, index) => <option key={`${typeof option}:${String(option)}`} value={index}>{String(option)}</option>)}</select>}
    {kind === "input" && schema.type === "boolean" && <label><input type="checkbox" checked={value === "true"} onChange={(event) => setValue(String(event.target.checked))} /> Yes</label>}
    {kind === "input" && schema.type !== "boolean" && <input required type={schema.type === "number" || schema.type === "integer" ? "number" : "text"} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Response" aria-label="Interaction response" />}
    {kind === "form" && <div>{fields.map(([name, field]) => <label key={name}>{String(field.title ?? name)}{Array.isArray(field.enum) ? <select required={required.has(name)} defaultValue="" onChange={(event) => setForm((current) => ({ ...current, [name]: enumAt(field, Number(event.target.value)) }))}><option value="">Choose…</option>{field.enum.map((option, index) => <option key={`${typeof option}:${String(option)}`} value={index}>{String(option)}</option>)}</select> : <input required={required.has(name)} min={typeof field.minimum === "number" ? field.minimum : undefined} max={typeof field.maximum === "number" ? field.maximum : undefined} minLength={typeof field.minLength === "number" ? field.minLength : undefined} maxLength={typeof field.maxLength === "number" ? field.maxLength : undefined} type={field.type === "number" || field.type === "integer" ? "number" : field.type === "boolean" ? "checkbox" : "text"} onChange={(event) => setForm((current) => ({ ...current, [name]: field.type === "boolean" ? event.target.checked : field.type === "number" || field.type === "integer" ? Number(event.target.value) : event.target.value }))} />}</label>)}</div>}
    {kind === "file" && <input type="file" aria-label="Interaction file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void (async () => { const uploaded = await upload(file); if (uploaded?.fileRef && uploaded.sha256) await respond("submit", undefined, { fileRef: uploaded.fileRef, mimeType: uploaded.mimeType, size: uploaded.size, sha256: uploaded.sha256 }); })(); }} />}
    {kind === "oauth" && <div><button disabled={!runId || !interactionId} onClick={() => window.open(`/api/oauth/start?runId=${encodeURIComponent(runId ?? "")}&interactionId=${encodeURIComponent(interactionId ?? "")}`, "harnest-oauth", "popup,width=640,height=760")}>Open secure authorization</button></div>}
    <div>{kind === "permission" ? <><button onClick={() => void respond("submit", "allow_once")}>Allow once</button><button onClick={() => void respond("submit", "allow_for_run")}>For this run</button><button disabled={!persistentPermissionAllowed} title={persistentPermissionAllowed ? undefined : "Always allow requires a complete preview and exact resource"} onClick={() => void respond("submit", "allow_always")}>Always</button><button className="quiet" onClick={() => void respond("submit", "deny")}>Deny</button></> : kind === "file" || kind === "oauth" ? null : <button disabled={kind === "form" ? !formValid : kind === "select" && value === ""} onClick={() => void respond("submit", undefined, kind === "form" ? form : primitive())}>Submit</button>}<button className="quiet" onClick={() => void respond("decline")}>Decline</button><button className="quiet" onClick={() => void respond("cancel")}>Cancel</button></div>
  </section>;
}

function ArtifactPanel({ state }: { state: AppState }) {
  const artifact = state.artifacts[0];
  if (!artifact) return <><ListHeading title="Artifact" count={0} /><Empty text="Generated documents and code appear here." /></>;
  return <><div className="artifact-head"><div><p className="eyebrow">LATEST ARTIFACT</p><h2>{artifact.name}</h2><span>{artifact.kind} · {formatBytes(artifact.size)}</span></div><a href={`/api/artifacts?id=${encodeURIComponent(artifact.id)}`} aria-label={`Download ${artifact.name}`}>Download</a></div>
    <article className="artifact-preview artifact-summary"><h3>{artifact.name}</h3><p>{artifact.summary || "No summary was supplied for this artifact."}</p></article>
    <div className="artifact-meta"><span><small>Created</small><strong>{formatTimestamp(artifact.createdAt)}</strong></span><span><small>Status</small><strong className="success">● {artifact.status}</strong></span></div></>;
}
