"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form as BaseForm } from "@base-ui/react/form";
import { Tabs } from "@base-ui/react/tabs";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { LocaleSwitch, ThemeSwitch, useLocale } from "@/components/locale-context";
import { ActionMenu, ConfirmDialog, SelectControl, useProductToast } from "@/components/ui";
import { clientId } from "@/lib/client-id";
import { CONNECTION_PRESETS, connectionLabel, type ConnectionPreset } from "@/lib/connections";
import { demoInteractions, demoState, deterministicReply } from "@/lib/demo";
import type { MessageKey } from "@/lib/i18n";
import { safeDownloadUrl, safeExternalUrl } from "@/lib/safe-url";
import type { AppState, BridgeEvent, CitationItem, Message, TraceItem } from "@/lib/types";

const empty: AppState = { mode: "setup", capabilities: [], errors: [], conversations: [], messages: [], files: [], artifacts: [], memories: [], pkmSources: [], citations: [], trace: [], permissions: [], connections: [] };
const tabs: [string, MessageKey][] = [["artifact", "tab.artifact"], ["files", "tab.files"], ["tools", "tab.tools"], ["memory", "tab.memory"], ["pkm-sources", "tab.pkm"], ["citations", "tab.citations"], ["permissions", "tab.permissions"], ["trace", "tab.trace"]];
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
const formatTimestamp = (value: string, locale: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const today = new Date();
  return new Intl.DateTimeFormat(locale, date.toDateString() === today.toDateString()
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
};
const fallbackCopy = (content: string) => {
  const field = document.createElement("textarea");
  field.value = content; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.append(field); field.select();
  try { return document.execCommand("copy"); }
  finally { field.remove(); }
};
const conversationFromUrl = () => new URL(window.location.href).searchParams.get("conversation") ?? undefined;
const setConversationUrl = (conversation: string | undefined, mode: "push" | "replace") => {
  const url = new URL(window.location.href);
  if (conversation) url.searchParams.set("conversation", conversation); else url.searchParams.delete("conversation");
  window.history[`${mode}State`](window.history.state, "", url);
};
const recoveredRunStatus = (status?: string) => status === "queued" ? "workspace.status.queued"
  : status === "running" ? "workspace.status.running"
    : status === "waiting" || status === "paused" ? "workspace.status.input"
      : status === "failed" ? "workspace.status.failed"
        : status === "cancelled" ? "workspace.status.cancelled"
          : status === "succeeded" ? "workspace.status.complete" : "workspace.status.ready";
const MAX_STREAM_FAILURES = 3;
const STREAM_RECONNECT_TIMEOUT = 10_000;
const DEMO_SESSION_PREFIX = "arc.demo.workspace.v1:";
const demoDelay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const leftRailDialog = Dialog.createHandle();
const rightRailDialog = Dialog.createHandle();

const traceKind = (item: TraceItem): "run" | "agent" | "tool" | "interaction" | "other" => /interaction|approval|permission/iu.test(item.type) ? "interaction"
  : /tool/iu.test(item.type) ? "tool"
    : /agent|team|task|handoff|message|plan/iu.test(item.type) ? "agent"
      : /run|node|edge|retry|iteration|evaluation|usage|context|cache/iu.test(item.type) ? "run" : "other";

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="mark" aria-hidden="true">{children}</span>;
}

export function Workspace() {
  const router = useRouter();
  const { locale, t } = useLocale();
  const toast = useProductToast();
  const [state, setState] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<string>("workspace.status.ready");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState("artifact");
  const [conversationSearch, setConversationSearch] = useState("");
  const [activeRunId, setActiveRunId] = useState<string>();
  const [interaction, setInteraction] = useState<Record<string, unknown>>();
  const [interactionQueue, setInteractionQueue] = useState<Record<string, unknown>[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [streamError, setStreamError] = useState("");
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const runMessages = useRef(new Map<string, string>());
  const lastSequence = useRef({ runId: "", value: 0 });
  const loadAbort = useRef<AbortController | undefined>(undefined);
  const loadToken = useRef(0);
  const uploadLock = useRef(false);
  const signOutLock = useRef(false);
  const demoRunToken = useRef(0);
  const translateRef = useRef(t);
  const openTools = () => setRightTab("tools");
  const toggleFile = (id: string) => setSelectedFileIds((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  const load = useCallback(async (conversation?: string) => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    const token = ++loadToken.current;
    loadAbort.current = controller;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/state${conversation ? `?conversation=${encodeURIComponent(conversation)}` : ""}`, { cache: "no-store", signal: controller.signal });
      const value = await response.json();
      if (token !== loadToken.current) return;
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok && response.status !== 503) throw new Error(value.error ?? translateRef.current("workspace.error.load"));
      let next = value as AppState;
      if (next.mode === "demo") {
        const key = `${DEMO_SESSION_PREFIX}${conversation ?? next.activeConversationId ?? "new"}`;
        try {
          const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as AppState | null;
          if (saved?.mode === "demo" && Array.isArray(saved.messages) && Array.isArray(saved.trace)) next = { ...saved, activeRun: undefined, messages: saved.messages.map((message) => message.pending ? { ...message, pending: false } : message) };
        } catch { sessionStorage.removeItem(key); }
      }
      setState(next);
      setActiveRunId(next.activeRun?.id);
      setRunning(Boolean(next.activeRun?.id));
      setRunStatus(recoveredRunStatus(next.activeRun?.status));
      setStreamError("");
      const queued = next.activeRun?.interactions ?? [];
      setInteractionQueue(queued);
      setInteraction(queued[0]);
      if (!conversation && next.activeConversationId) setConversationUrl(next.activeConversationId, "replace");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (token === loadToken.current) setError(cause instanceof Error ? cause.message : translateRef.current("workspace.error.load"));
    } finally { if (token === loadToken.current) setLoading(false); }
  }, [router]);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);
  useEffect(() => {
    if (!loading && state.mode === "demo") sessionStorage.setItem(`${DEMO_SESSION_PREFIX}${state.activeConversationId ?? "new"}`, JSON.stringify(state));
  }, [loading, state]);
  useEffect(() => {
    const navigate = () => { setSelectedFileIds(new Set()); void load(conversationFromUrl()); };
    // Initial external state is discovered after hydration from the durable URL.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(conversationFromUrl());
    addEventListener("popstate", navigate);
    return () => { removeEventListener("popstate", navigate); loadAbort.current?.abort(); };
  }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.messages, running]);
  useEffect(() => {
    if (!activeRunId || state.mode === "demo") return;
    const runId = activeRunId;
    let failures = 0;
    let reconnectTimer: number | undefined;
    let closed = false;
    if (lastSequence.current.runId !== runId) lastSequence.current = { runId, value: 0 };
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    const closeSource = () => {
      closed = true;
      source.close();
      if (reconnectTimer !== undefined) { window.clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    };
    const stopReconnect = () => {
      if (closed) return;
      closeSource();
      setStreamError(translateRef.current("workspace.error.stream"));
      setRunStatus("workspace.status.disconnected");
    };
    source.onmessage = (message) => {
      failures = 0;
      if (reconnectTimer !== undefined) { window.clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      setStreamError("");
      let bridge: BridgeEvent;
      try { bridge = JSON.parse(message.data) as BridgeEvent; }
      catch { setError(translateRef.current("workspace.error.event")); return; }
      const sequence = bridge.sequence;
      if (Number.isSafeInteger(sequence)) {
        if (sequence! <= lastSequence.current.value) return;
        lastSequence.current.value = sequence!;
      }
      const assistantId = runMessages.current.get(runId) ?? `recovered-${runId}`;
      if (bridge.type === "delta" && typeof bridge.text === "string") setState((current) => {
        const exists = current.messages.some(({ id }) => id === assistantId);
        return { ...current, messages: exists ? current.messages.map((item) => item.id === assistantId ? { ...item, content: item.content + bridge.text } : item) : [...current.messages, { id: assistantId, role: "assistant", content: bridge.text as string, createdAt: new Date().toISOString(), pending: true }] };
      });
      if ((bridge.type === "status" || bridge.type === "interaction") && typeof bridge.label === "string") {
        setRunStatus(bridge.label);
        if (Number.isSafeInteger(bridge.sequence)) {
          const trace: TraceItem = { id: `${runId}-${bridge.sequence}`, type: String(bridge.phase ?? bridge.type), label: bridge.label, status: "running", at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) };
          setState((current) => current.trace.some(({ id }) => id === trace.id) ? current : { ...current, trace: [...current.trace, trace] });
        }
      }
      if (bridge.type === "interaction" && bridge.request && typeof bridge.request === "object") {
        const next = bridge.request as Record<string, unknown>;
        setInteractionQueue((current) => current.some(({ id }) => id === next.id) ? current : [...current, next]);
        setInteraction((current) => current ?? next);
      }
      if (bridge.type === "done") {
        closeSource(); setActiveRunId(undefined); setRunning(false); setRunStatus("workspace.status.complete"); setInteraction(undefined); setInteractionQueue([]);
        setState((current) => ({ ...current, activeRun: undefined, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: typeof bridge.output === "string" ? bridge.output : item.content, pending: false } : item) }));
        void load(typeof bridge.conversationId === "string" ? bridge.conversationId : state.activeConversationId);
      }
      if (bridge.type === "error") { closeSource(); setActiveRunId(undefined); setRunning(false); setError(String(bridge.message ?? translateRef.current("workspace.error.run"))); setRunStatus("workspace.status.failed"); }
    };
    source.onerror = () => {
      if (closed) return;
      failures += 1;
      setRunStatus(translateRef.current("workspace.status.reconnectingAttempt", { attempt: failures, max: MAX_STREAM_FAILURES }));
      if (reconnectTimer === undefined) reconnectTimer = window.setTimeout(stopReconnect, STREAM_RECONNECT_TIMEOUT);
      if (failures >= MAX_STREAM_FAILURES || source.readyState === EventSource.CLOSED) stopReconnect();
    };
    return closeSource;
    // The durable run id owns exactly one native EventSource lifecycle; native reconnect sends Last-Event-ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, state.mode, streamAttempt]);

  const selectConversation = (id: string) => {
    setLeftOpen(false);
    if (running && id !== state.activeConversationId) return;
    setSelectedFileIds(new Set()); setConversationUrl(id, "push"); void load(id);
  };
  const newConversation = () => {
    if (running) return;
    setConversationUrl(undefined, "push");
    setState((current) => ({ ...current, activeConversationId: undefined, messages: [], files: [], artifacts: [], citations: [], trace: [] }));
    setActiveRunId(undefined); setRunStatus("workspace.status.ready"); setStreamError("");
    setLeftOpen(false); setDraft(""); setSelectedFileIds(new Set());
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || running || loading) return;
    const now = new Date().toISOString();
    const user: Message = { id: clientId(), role: "user", content: message, createdAt: now };
    const assistantId = clientId();
    setState((current) => ({ ...current, messages: [...current.messages, user, { id: assistantId, role: "assistant", content: "", createdAt: now, pending: true }] }));
    setDraft(""); setRunning(true); setRunStatus("workspace.status.starting"); setError("");
    if (state.mode === "demo") {
      const token = ++demoRunToken.current;
      const runId = `demo-run-${clientId()}`;
      const conversationId = state.activeConversationId ?? `demo-${clientId()}`;
      setConversationUrl(conversationId, "replace");
      setActiveRunId(runId);
      setState((current) => ({
        ...current, activeConversationId: conversationId, activeRun: { id: runId, status: "running", interactions: [] },
        conversations: current.conversations.some(({ id }) => id === conversationId) ? current.conversations.map((conversation) => conversation.id === conversationId ? { ...conversation, preview: message.slice(0, 90), updatedAt: now } : conversation) : [{ id: conversationId, title: message.slice(0, 48), preview: message.slice(0, 90), updatedAt: now }, ...current.conversations],
        trace: [...current.trace, { id: `${runId}-1`, type: "run.started", label: "Demo run accepted", status: "running", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, mode: "session-local", attachments: selectedFileIds.size } }],
      }));
      await demoDelay(180);
      if (token !== demoRunToken.current) return;
      setRunStatus("Classifying request");
      await demoDelay(180);
      if (token !== demoRunToken.current) return;
      setRunStatus("Composing deterministic result");
      const reply = deterministicReply(message);
      for (const part of reply.match(/.{1,28}(?:\s|$)/gu) ?? [reply]) {
        await demoDelay(24);
        if (token !== demoRunToken.current) return;
        setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: item.content + part } : item) }));
      }
      setState((current) => ({ ...current, activeRun: undefined, messages: current.messages.map((item) => item.id === assistantId ? { ...item, pending: false } : item), trace: [...current.trace, { id: `${runId}-2`, type: "evaluation", label: "Deterministic demo completed", status: "passed", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, durationMs: 640, outputCharacters: reply.length } }] }));
      setSelectedFileIds(new Set()); setActiveRunId(undefined); setRunning(false); setRunStatus("workspace.status.complete");
      return;
    }
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId: state.activeConversationId, fileIds: [...selectedFileIds] }),
      });
      const value = await response.json().catch(() => ({})) as { error?: string; runId?: string; conversationId?: string; status?: string; output?: string };
      if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
      if (response.status === 202 && value.status === "succeeded" && typeof value.output === "string") {
        if (typeof value.conversationId === "string") setConversationUrl(value.conversationId, "replace");
        setState((current) => ({ ...current, activeConversationId: value.conversationId ?? current.activeConversationId, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: value.output!, pending: false } : item) }));
        setRunning(false); setRunStatus("workspace.status.complete"); setSelectedFileIds(new Set()); return;
      }
      if (response.status !== 202 || typeof value.runId !== "string" || typeof value.conversationId !== "string") throw new Error("Chat did not return a durable run.");
      runMessages.current.set(value.runId, assistantId);
      setConversationUrl(value.conversationId, "replace");
      setSelectedFileIds(new Set()); setActiveRunId(value.runId); setRunStatus("workspace.status.queued");
      setState((current) => ({ ...current, activeConversationId: value.conversationId, activeRun: { id: value.runId!, status: value.status ?? "queued", interactions: [] } }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("workspace.error.run");
      setError(message); setRunStatus("workspace.status.failed"); setRunning(false);
      setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === assistantId ? { ...item, content: `Run failed: ${message}`, pending: false } : item) }));
    }
  };

  const respond = async (action: "submit" | "decline" | "cancel", permission?: "allow_once" | "allow_for_run" | "allow_always" | "deny", submittedValue?: unknown) => {
    const checkpoint = interaction?.checkpoint && typeof interaction.checkpoint === "object" ? interaction.checkpoint as { digest?: unknown } : {};
    if (!activeRunId || typeof interaction?.id !== "string" || typeof checkpoint.digest !== "string") throw new Error("Interaction is no longer active.");
    if (state.mode === "demo") {
      await demoDelay(180);
      const remaining = interactionQueue.filter(({ id }) => id !== interaction.id);
      const decision = permission ?? action;
      setInteractionQueue(remaining); setInteraction(remaining[0]); setRunStatus(remaining.length ? "workspace.status.input" : "workspace.status.complete");
      setState((current) => ({
        ...current,
        ...(remaining.length ? { activeRun: { id: activeRunId, status: "waiting", interactions: remaining } } : { activeRun: undefined }),
        permissions: permission === "allow_always" && !current.permissions.some(({ id }) => id === "demo-permission-file") ? [...current.permissions, { id: "demo-permission-file", harnessId: "arc-reference", toolId: "builtin.file", capability: "workspace-write", resource: "launch-brief.md" }] : current.permissions,
        trace: [...current.trace, { id: `demo-interaction-${clientId()}`, type: "interaction.resolved", label: `${String(interaction.kind ?? "input")} · ${decision}`, status: "complete", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, action, decision, valueType: submittedValue === undefined ? "none" : Array.isArray(submittedValue) ? "array" : typeof submittedValue } }],
      }));
      if (!remaining.length) { setActiveRunId(undefined); setRunning(false); toast.add({ title: t("workspace.demoTourComplete") }); }
      return;
    }
    const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: {
        interactionId: interaction.id, checkpointDigest: checkpoint.digest, action,
        ...(action === "submit" && submittedValue !== undefined ? { value: submittedValue } : {}), ...(permission ? { permission } : {}),
      } }),
    });
    const value = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(value.error ?? "Interaction response failed");
    const remaining = interactionQueue.filter(({ id }) => id !== interaction?.id);
    setInteractionQueue(remaining); setInteraction(remaining[0]); setRunStatus(remaining.length ? "workspace.status.input" : "workspace.status.resuming");
  };

  const cancelRun = async () => {
    if (!activeRunId) return false;
    if (state.mode === "demo") {
      demoRunToken.current += 1;
      setActiveRunId(undefined); setRunning(false); setInteraction(undefined); setInteractionQueue([]); setRunStatus("workspace.status.cancelled");
      setState((current) => ({ ...current, activeRun: undefined, messages: current.messages.map((message) => message.pending ? { ...message, content: message.content || t("workspace.demoCancelledOutput"), pending: false } : message), trace: [...current.trace, { id: `demo-cancel-${clientId()}`, type: "run.cancelled", label: "Demo run cancelled", status: "cancelled", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, mode: "session-local" } }] }));
      toast.add({ title: t("workspace.runCancelled") });
      return true;
    }
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/commands`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancel: true }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("workspace.error.cancelRun"));
      setActiveRunId(undefined); setRunning(false); setInteraction(undefined); setInteractionQueue([]); setRunStatus("workspace.status.cancelled");
      setState((current) => ({ ...current, activeRun: undefined }));
      toast.add({ title: t("workspace.runCancelled") });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspace.error.cancelRun"));
      return false;
    }
  };

  const upload = async (file?: File, forInteraction = false) => {
    if (!file || uploadLock.current) return;
    uploadLock.current = true; setUploading(true); setError("");
    try {
      const form = new FormData(); form.set("file", file);
      if (state.activeConversationId) form.set("conversationId", state.activeConversationId);
      else if (state.mode === "demo") form.set("conversationId", "demo-quarterly");
      if (forInteraction && activeRunId) form.set("runId", activeRunId);
      const response = await fetch("/api/files", { method: "POST", body: form });
      const value = await response.json().catch(() => ({})) as AppState["files"][number] & { error?: string; conversationId?: string; fileRef?: string };
      if (!response.ok) throw new Error(value.error ?? t("workspace.error.upload"));
      if (state.mode === "demo") value.downloadUrl = URL.createObjectURL(file);
      const uploadedConversationId = state.mode === "demo" ? state.activeConversationId ?? "demo-quarterly" : value.conversationId;
      if (uploadedConversationId) setConversationUrl(uploadedConversationId, "replace");
      setState((current) => ({ ...current, activeConversationId: uploadedConversationId ?? current.activeConversationId, files: [...current.files, value] }));
      if (!forInteraction && value.id) setSelectedFileIds((current) => new Set(current).add(value.id));
      return value;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("workspace.error.upload")); return undefined; }
    finally { uploadLock.current = false; setUploading(false); }
  };

  const signOut = async () => {
    if (signOutLock.current) return;
    signOutLock.current = true; setSigningOut(true); setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("workspace.error.signOut"));
      router.replace("/login"); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("workspace.error.signOut")); }
    finally { signOutLock.current = false; setSigningOut(false); }
  };
  const revokePermission = async (id: string) => {
    try {
      if (state.mode === "demo") {
        await demoDelay(160);
        setState((current) => ({ ...current, permissions: current.permissions.filter((grant) => grant.id !== id), trace: [...current.trace, { id: `demo-revoke-${clientId()}`, type: "permission.revoked", label: "Persistent permission revoked", status: "complete", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, permissionId: id } }] }));
        toast.add({ title: t("permission.revoked") });
        return true;
      }
      const response = await fetch("/api/permissions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("workspace.error.permission"));
      setState((current) => ({ ...current, permissions: current.permissions.filter((grant) => grant.id !== id) }));
      toast.add({ title: t("permission.revoked") });
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("workspace.error.permission")); return false; }
  };

  const copyResponse = async (content: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(content);
      else if (!fallbackCopy(content)) throw new Error("copy failed");
      toast.add({ title: t("workspace.copied") });
    } catch {
      if (fallbackCopy(content)) toast.add({ title: t("workspace.copied") }); else setError(t("workspace.error.copy"));
    }
  };

  const startDemoTour = () => {
    if (state.mode !== "demo" || running) return;
    const queue = demoInteractions();
    const runId = `demo-interactions-${clientId()}`;
    demoRunToken.current += 1;
    setActiveRunId(runId); setRunning(true); setRunStatus("workspace.status.input"); setInteractionQueue(queue); setInteraction(queue[0]); setError("");
    setState((current) => ({ ...current, activeRun: { id: runId, status: "waiting", interactions: queue }, trace: [...current.trace, { id: `${runId}-start`, type: "interaction.requested", label: "Human Interaction tour started", status: "waiting", at: new Date().toLocaleTimeString(), metadata: { sequence: current.trace.length + 1, kinds: 6, decisions: 7 } }] }));
  };
  const resetDemo = () => {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) { const key = sessionStorage.key(index); if (key?.startsWith(DEMO_SESSION_PREFIX)) sessionStorage.removeItem(key); }
    demoRunToken.current += 1;
    const next = demoState();
    setState(next); setActiveRunId(undefined); setRunning(false); setInteraction(undefined); setInteractionQueue([]); setSelectedFileIds(new Set()); setError(""); setRunStatus("workspace.status.ready"); setConversationUrl(next.activeConversationId, "replace");
    toast.add({ title: t("workspace.demoReset") });
  };
  const saveDemoMemory = async (key: string, value: string) => {
    await demoDelay(160);
    setState((current) => ({ ...current, memories: [{ id: `demo-memory-${clientId()}`, key, value, updatedAt: new Date().toISOString() }, ...current.memories.filter((memory) => memory.key !== key)] }));
  };
  const removeDemoMemory = async (id: string) => {
    await demoDelay(120); setState((current) => ({ ...current, memories: current.memories.filter((memory) => memory.id !== id) })); return true;
  };
  const saveDemoPkm = async (title: string, content: string) => {
    await demoDelay(180); const chunks = Math.max(1, Math.ceil(content.length / 900));
    setState((current) => ({ ...current, pkmSources: [{ id: `demo-pkm-${clientId()}`, title, kind: "text", status: `${chunks} chunk${chunks === 1 ? "" : "s"}` }, ...current.pkmSources] })); return chunks;
  };
  const removeDemoPkm = async (id: string) => {
    await demoDelay(120); setState((current) => ({ ...current, pkmSources: current.pkmSources.filter((source) => source.id !== id) })); return true;
  };

  const conversationContent = (close?: React.ReactNode) => <>
    <div className="brand-row"><div className="brand"><Mark>⌁</Mark><span>arc</span></div>{close}</div>
    <button className="new-chat" disabled={running} title={running ? t("workspace.newConversationRunning") : undefined} aria-label={running ? `${t("workspace.newConversation")}. ${t("workspace.newConversationRunning")}` : t("workspace.newConversation")} onClick={newConversation}><span aria-hidden="true">＋</span> {t("workspace.newConversation")}</button>
    {running && <p className="new-chat-reason" role="status">{t("workspace.newConversationRunning")}</p>}
    <label className="search"><span aria-hidden="true">⌕</span><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder={t("workspace.searchConversations")} aria-label={t("workspace.searchConversations")} /></label>
    <div className="rail-label">{t("workspace.recent")}</div>
    <nav className="conversation-list">
      {state.conversations.filter(({ title, preview }) => `${title}\n${preview}`.toLocaleLowerCase().includes(conversationSearch.toLocaleLowerCase())).map((conversation) => {
        const blocked = running && conversation.id !== state.activeConversationId;
        return <button key={conversation.id} disabled={blocked} title={blocked ? t("workspace.switchConversationRunning") : undefined} aria-current={conversation.id === state.activeConversationId ? "page" : undefined} className={conversation.id === state.activeConversationId ? "conversation active" : "conversation"} onClick={() => selectConversation(conversation.id)}>
          <span className="conversation-top"><strong>{conversation.title}</strong><time>{formatTimestamp(conversation.updatedAt, locale)}</time></span>
          <span className="conversation-preview">{conversation.preview}</span>
        </button>;
      })}
      {!loading && state.conversations.length === 0 && <p className="empty-small">{t("workspace.noConversations")}</p>}
    </nav>
    <div className="rail-footer"><span className="avatar">{state.user?.email?.[0]?.toUpperCase() ?? "?"}</span><span><strong>{state.user?.email ?? t("workspace.setupRequired")}</strong><small>{t(state.mode === "demo" ? "workspace.localDeveloper" : "workspace.supabaseAccount")}</small></span><ActionMenu className="account-menu" label={t("workspace.accountMenu")} items={state.mode === "demo" ? [{ label: t("workspace.resetDemo"), description: t("workspace.resetDemoDescription"), icon: "↻", onClick: resetDemo }] : [{ label: t(signingOut ? "workspace.signingOut" : "workspace.signOut"), description: t("workspace.signOutDescription"), icon: "↪", disabled: signingOut, onClick: () => void signOut() }]}>•••</ActionMenu></div>
  </>;

  const contextContent = (close?: React.ReactNode) => <>
    <div className="context-head"><div><strong>{t("workspace.context")}</strong><span>{t("workspace.contextDescription")}</span></div>{close}</div>
    <Tabs.Root value={rightTab} onValueChange={setRightTab} className="tabs">
      <Tabs.List className="tab-list" aria-label={t("workspace.runData")}>{tabs.map(([value, key]) => <Tabs.Tab key={value} value={value} className="tab">{t(key)}</Tabs.Tab>)}</Tabs.List>
      <div className="panel-scroll">
        <Tabs.Panel value="artifact" className="tab-panel"><PanelError state={state} sections={["artifacts"]} reload={() => load(state.activeConversationId)} /><ArtifactPanel state={state} /></Tabs.Panel>
        <Tabs.Panel value="files" className="tab-panel"><PanelError state={state} sections={["files"]} reload={() => load(state.activeConversationId)} /><ListHeading title={t("tab.files")} count={state.files.length} action={uploading ? t("panel.uploading") : t("panel.upload")} actionDisabled={uploading} onAction={() => fileRef.current?.click()} />{state.files.map((file) => <ItemCard key={file.id} icon="▱" title={file.name} meta={`${formatBytes(file.size)} · ${file.status}`} href={state.mode === "demo" ? safeDownloadUrl(file.downloadUrl) : `/api/files?id=${encodeURIComponent(file.id)}`} selected={selectedFileIds.has(file.id)} onSelect={() => toggleFile(file.id)} />)}{!state.files.length && !panelFailed(state, ["files"]) && <Empty text={t("panel.filesEmpty")} />}</Tabs.Panel>
        <Tabs.Panel value="tools" className="tab-panel"><PanelError state={state} sections={["connections"]} reload={() => load(state.activeConversationId)} /><ToolPanel state={state} reload={() => load(state.activeConversationId)} onUsePrompt={(prompt) => { setDraft(prompt); setRightOpen(false); }} /></Tabs.Panel>
        <Tabs.Panel value="memory" className="tab-panel"><PanelError state={state} sections={["memory"]} reload={() => load(state.activeConversationId)} /><MemoryPanel state={state} reload={() => load(state.activeConversationId)} demoSave={state.mode === "demo" ? saveDemoMemory : undefined} demoRemove={state.mode === "demo" ? removeDemoMemory : undefined} /></Tabs.Panel>
        <Tabs.Panel value="pkm-sources" className="tab-panel"><PanelError state={state} sections={["pkm sources"]} reload={() => load(state.activeConversationId)} /><PkmPanel state={state} reload={() => load(state.activeConversationId)} demoSave={state.mode === "demo" ? saveDemoPkm : undefined} demoRemove={state.mode === "demo" ? removeDemoPkm : undefined} /></Tabs.Panel>
        <Tabs.Panel value="citations" className="tab-panel"><PanelError state={state} sections={["citations"]} reload={() => load(state.activeConversationId)} /><ListHeading title={t("tab.citations")} count={state.citations.length} />{state.citations.map((citation) => <CitationCard key={citation.id} citation={citation} />)}{!state.citations.length && !panelFailed(state, ["citations"]) && <Empty text={t("panel.citationsEmpty")} />}</Tabs.Panel>
        <Tabs.Panel value="permissions" className="tab-panel"><PanelError state={state} sections={["permissions"]} reload={() => load(state.activeConversationId)} /><ListHeading title={t("panel.alwaysAllowed")} count={state.permissions.length} />{state.permissions.map((grant) => <div className="item-card" key={grant.id}><span>✓</span><div><strong>{grant.toolId}</strong><small>{grant.capability}{grant.resource ? ` · ${grant.resource}` : ""}</small></div><ConfirmAction label={t("common.revoke")} title={t("confirm.permission.title")} description={t("confirm.permission.description")} onConfirm={() => revokePermission(grant.id)} /></div>)}{!state.permissions.length && !panelFailed(state, ["permissions"]) && <Empty text={t("panel.permissionsEmpty")} />}</Tabs.Panel>
        <Tabs.Panel value="trace" className="tab-panel"><PanelError state={state} sections={["trace", "active run", "interactions"]} reload={() => load(state.activeConversationId)} /><ListHeading title={t("tab.trace")} count={state.trace.length} /> <div className="trace-list">{state.trace.map((trace) => <div className="trace-row" key={trace.id}><span className="trace-dot" /><div><strong>{trace.label}</strong><small>{t(`trace.${traceKind(trace)}`)} · {trace.type} · {trace.at}</small>{trace.metadata && <span className="trace-metadata">{Object.entries(trace.metadata).map(([key, value]) => <code key={key}>{key}={String(value)}</code>)}</span>}</div><em>{trace.status}</em></div>)}</div>{!state.trace.length && !panelFailed(state, ["trace", "active run", "interactions"]) && <Empty text={t("panel.traceEmpty")} />}</Tabs.Panel>
      </div>
    </Tabs.Root>
  </>;

  return (
    <Dialog.Root handle={rightRailDialog} open={rightOpen} onOpenChange={setRightOpen} modal>
      <Dialog.Root handle={leftRailDialog} open={leftOpen} onOpenChange={setLeftOpen} modal>
      <main className="workspace">
      <aside className="rail left-rail desktop-rail" aria-label={t("workspace.conversations")}>{conversationContent()}</aside>

      <section className="chat-column">
        <header className="topbar">
          <Dialog.Trigger handle={leftRailDialog} className="icon-button mobile-only" aria-label={t("workspace.openConversations")}>☰</Dialog.Trigger>
          <div><h1>{state.conversations.find(({ id }) => id === state.activeConversationId)?.title ?? t("workspace.newConversation")}</h1><p role="status"><span className={`live-dot ${running ? "working" : state.readiness?.ready || state.mode === "demo" ? "" : "not-ready"}`} /> {running ? runStatus.startsWith("workspace.status.") ? t(runStatus as MessageKey) : runStatus : t(state.readiness?.ready || state.mode === "demo" ? "workspace.harnestReady" : "workspace.setupRequired")}</p></div>
          <div className="top-actions"><ThemeSwitch /><LocaleSwitch /><Dialog.Trigger handle={rightRailDialog} className="icon-button mobile-only" aria-label={t("workspace.openContext")}>◫</Dialog.Trigger></div>
        </header>

        <div className="feedback-stack">
          {state.mode === "demo" && <div className="mode-banner"><span><strong>{t("workspace.demoTitle")}</strong><small>{t("workspace.demoBody")}</small></span><div className="demo-actions"><button disabled={running} onClick={startDemoTour}>{t("workspace.demoTour")}</button><button disabled={running} onClick={resetDemo}>{t("workspace.resetDemo")}</button></div></div>}
          {error && <div className="error-banner" role="alert">{error}<button onClick={() => void load(state.activeConversationId)}>{t("common.retry")}</button><button onClick={() => setError("")} aria-label={t("common.dismiss")}>×</button></div>}
        </div>

        <div className="messages" role="log" aria-live="polite" aria-relevant="additions text">
          {loading ? <div className="center-state"><span className="spinner" />{t("workspace.loading")}</div> : null}
          {!loading && state.mode === "setup" ? (
            <SetupCard missing={state.setup?.missing ?? []} />
          ) : null}
          {!loading && state.mode !== "setup" && state.messages.length === 0 ? (
            <div className="welcome"><Mark>⌁</Mark><h2>{t("workspace.welcome")}</h2><p>{t("workspace.welcomeBody")}</p>{!state.readiness?.ready && <><button className="connection-notice desktop-tools-only" onClick={openTools}><strong>{t("workspace.runtimeIncomplete")}</strong><span>{state.setup?.missing.map(connectionLabel).join(", ") || state.readiness?.message || t("workspace.openCapabilities")}</span></button><Dialog.Trigger handle={rightRailDialog} className="connection-notice rail-dialog-trigger" onClick={openTools}><strong>{t("workspace.runtimeIncomplete")}</strong><span>{state.setup?.missing.map(connectionLabel).join(", ") || state.readiness?.message || t("workspace.openCapabilities")}</span></Dialog.Trigger></>}</div>
          ) : null}
          {state.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-avatar">{message.role === "user" ? (state.user?.email?.[0]?.toUpperCase() ?? "Y") : "⌁"}</div>
              <div className="message-body"><div className="message-meta"><strong>{message.role === "user" ? t("workspace.you") : "Arc"}</strong><time>{formatTimestamp(message.createdAt, locale)}</time>{message.pending && <span className="streaming-label">{t("workspace.streaming")}</span>}</div>
                <div className="message-copy">{message.content ? message.role === "assistant" ? <ReactMarkdown skipHtml components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.content}</ReactMarkdown> : message.content : <span className="thinking"><i /><i /><i /></span>}</div>
                {message.role === "assistant" && message.content && <div className="message-actions"><button onClick={() => void copyResponse(message.content)} aria-label={t("workspace.copy")}>{t("workspace.copy")}</button></div>}
              </div>
            </article>
          ))}
          {interaction && <InteractionCard key={String(interaction.id ?? "interaction")} demo={state.mode === "demo"} runId={activeRunId} request={interaction} respond={respond} upload={(file) => upload(file, true)} />}
          {running && <div className="run-card">{streamError ? <span className="stream-paused-mark" aria-hidden="true">!</span> : <span className="spinner" />}<span><strong>{runStatus.startsWith("workspace.status.") ? t(runStatus as MessageKey) : runStatus}</strong><small role={streamError ? "alert" : undefined}>{streamError || t("workspace.runtimeEvents")}</small></span><span className="run-time">{streamError ? t("workspace.streamPaused") : t("workspace.live")}</span>{streamError && <button className="retry-stream" onClick={() => { setStreamError(""); setRunStatus("workspace.status.reconnecting"); setStreamAttempt((current) => current + 1); }}>{t("workspace.retryStream")}</button>}<ConfirmAction label={t("workspace.cancelRun")} title={t("confirm.run.title")} description={t("confirm.run.description")} onConfirm={cancelRun} /></div>}
          <div ref={endRef} />
        </div>

        <div className="composer-wrap">
          {selectedFileIds.size > 0 && <div className="attachment-row" aria-label={t("workspace.selectedFiles")}>{state.files.filter(({ id }) => selectedFileIds.has(id)).map((file) => <button type="button" key={file.id} onClick={() => toggleFile(file.id)} aria-label={t("workspace.removeFile", { name: file.name })}>▱ {file.name}<span aria-hidden="true">×</span></button>)}</div>}
          <form className="composer" onSubmit={send}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={t("workspace.messagePlaceholder")} aria-label={t("workspace.message")} rows={1} disabled={loading || state.mode === "setup" || state.readiness?.ready === false} />
            <div className="composer-tools">
              <input ref={fileRef} hidden disabled={uploading} type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void upload(file); }} />
              <button type="button" className="tool-button" onClick={() => fileRef.current?.click()} disabled={state.mode === "setup" || uploading} aria-busy={uploading} aria-label={t("workspace.attachFile")}>＋ <span>{uploading ? t("panel.uploading") : t("workspace.input")}</span></button>
              <button type="button" className="tool-button desktop-tools-only" onClick={openTools} aria-label={t("workspace.openTools")}>⌘ <span>{t("workspace.tools")}</span></button>
              <Dialog.Trigger handle={rightRailDialog} className="tool-button rail-dialog-trigger" onClick={openTools} aria-label={t("workspace.openTools")}>⌘ <span>{t("workspace.tools")}</span></Dialog.Trigger>
              <span className="composer-hint">{t("workspace.sendHint")}</span>
              <button className="send-button" disabled={!draft.trim() || running || loading || state.mode === "setup" || state.readiness?.ready === false} aria-label={t("workspace.send")}>↑</button>
            </div>
          </form>
          <p className="disclaimer">{t("workspace.disclaimer")}</p>
        </div>
      </section>

      <aside className="rail right-rail desktop-rail" aria-label={t("workspace.context")}>{contextContent()}</aside>
      </main>
      <Dialog.Portal>
        <Dialog.Backdrop className="rail-dialog-backdrop" />
        <Dialog.Viewport className="rail-dialog-viewport left">
          <Dialog.Popup className="rail left-rail rail-dialog" aria-label={t("workspace.conversations")}>
            <Dialog.Title className="sr-only">{t("workspace.conversations")}</Dialog.Title>
            <Dialog.Description className="sr-only">{t("workspace.conversationsDescription")}</Dialog.Description>
            {conversationContent(<Dialog.Close className="icon-button" aria-label={t("workspace.closeConversations")}>×</Dialog.Close>)}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Portal>
        <Dialog.Backdrop className="rail-dialog-backdrop" />
        <Dialog.Viewport className="rail-dialog-viewport right">
          <Dialog.Popup className="rail right-rail rail-dialog" aria-label={t("workspace.context")}>
            <Dialog.Title className="sr-only">{t("workspace.context")}</Dialog.Title>
            <Dialog.Description className="sr-only">{t("workspace.contextDescription")}</Dialog.Description>
            {contextContent(<Dialog.Close className="icon-button" aria-label={t("workspace.closeContext")}>×</Dialog.Close>)}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SetupCard({ missing }: { missing: string[] }) {
  const { t } = useLocale();
  return <section className="setup-card"><div className="setup-icon">⌁</div><p className="eyebrow">{t("setup.eyebrow")}</p><h2>{t("setup.title")}</h2><p>{t("setup.body")}</p>
    {missing.length > 0 && <pre>{missing.join("\n")}</pre>}
    <a className="setup-login" href="/login">{t("setup.login")}</a>
    <div className="setup-steps"><span><b>1</b> supabase db push</span><span><b>2</b> .env.example → .env.local</span><span><b>3</b> npm run harnest</span></div>
    <small>{t("setup.demo")}</small>
  </section>;
}

function ListHeading({ title, count, action, actionDisabled, onAction }: { title: string; count: number; action?: string; actionDisabled?: boolean; onAction?: () => void }) { const { t } = useLocale(); return <div className="list-heading"><span><strong>{title}</strong><small>{t("common.items", { count })}</small></span>{action && <button disabled={actionDisabled} onClick={onAction}>{action}</button>}</div>; }
function ItemCard({ icon, title, meta, href, selected, onSelect }: { icon: string; title: string; meta: string; href?: string; selected?: boolean; onSelect?: () => void }) { const { t } = useLocale(); return <div className="item-card"><span>{icon}</span><div><strong>{title}</strong><small>{meta}</small></div>{onSelect && <label className="file-select"><input type="checkbox" checked={selected} onChange={onSelect} /><span className="sr-only">{t("workspace.useFile", { name: title })}</span></label>}{href && <a href={href} aria-label={`${t("common.download")} ${title}`}>↓</a>}</div>; }
function Empty({ text }: { text: string }) { return <div className="panel-empty"><span aria-hidden="true">◇</span><p>{text}</p></div>; }
function CitationCard({ citation }: { citation: CitationItem }) {
  const { t } = useLocale();
  const href = safeExternalUrl(citation.url);
  const content = <><span>{citation.index}</span><div><strong>{citation.title}</strong><p>{citation.excerpt}</p>{!href && <small>{t("citation.internal")}</small>}</div></>;
  return href ? <a className="citation-card" href={href} target="_blank" rel="noopener noreferrer">{content}</a> : <article className="citation-card citation-static">{content}</article>;
}
function ConfirmAction({ label, title, description, onConfirm }: { label: string; title: string; description: string; onConfirm: () => Promise<boolean | void> }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { if (await onConfirm() !== false) setOpen(false); }
    finally { setBusy(false); }
  };
  return <><button className="danger-action" onClick={() => setOpen(true)}>{label}</button><ConfirmDialog open={open} title={title} description={description} confirmLabel={label} cancelLabel={t("common.cancel")} danger busy={busy} onConfirm={() => void confirm()} onOpenChange={setOpen} /></>;
}
const panelFailed = (state: AppState, sections: string[]) => state.errors.some((error) => sections.some((section) => error.toLocaleLowerCase().includes(section)));
function PanelError({ state, sections, reload }: { state: AppState; sections: string[]; reload: () => Promise<void> }) {
  const { t } = useLocale();
  const error = state.errors.find((item) => sections.some((section) => item.toLocaleLowerCase().includes(section)));
  return error ? <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void reload()}>{t("common.retry")}</button></div> : null;
}

function ToolPanel({ state, reload, onUsePrompt }: { state: AppState; reload: () => Promise<void>; onUsePrompt: (prompt: string) => void }) {
  const { t } = useLocale();
  const missing = state.readiness?.missingConnections ?? [];
  return <><ListHeading title={t("capabilities.title")} count={state.capabilities.length} /><p className="panel-intro">{t("capabilities.intro")}</p>{state.readiness && <p className="connection-message" role="status">{t("capabilities.runtime")}: {state.readiness.harnest}{missing.length ? ` · ${t("capabilities.missing")}: ${missing.map(connectionLabel).join(", ")}` : ""}</p>}
    <ConnectionSetup missing={missing} connections={state.connections} reload={reload} />
    {state.capabilities.map((capability) => <div className="item-card" key={capability.id}><span aria-label={t(capability.ready ? "common.ready" : "common.notReady")}>{capability.ready ? "✓" : "!"}</span><div><strong>{capability.label}</strong><small>{capability.kind}{capability.connectionId ? ` · ${connectionLabel(capability.connectionId)}` : ""}</small></div><button disabled={!capability.ready} onClick={() => onUsePrompt(`Use ${capability.label} when relevant and answer: `)}>{t("common.use")}</button></div>)}{!state.capabilities.length && <Empty text={t("capabilities.empty")} />}</>;
}

function ConnectionSetup({ missing, connections, reload }: { missing: string[]; connections: AppState["connections"]; reload: () => Promise<void> }) {
  const { t } = useLocale();
  const toast = useProductToast();
  const presets = (Object.entries(CONNECTION_PRESETS) as [ConnectionPreset, (typeof CONNECTION_PRESETS)[ConnectionPreset]][])
    .filter(([, preset]) => missing.includes(preset.name));
  const [secrets, setSecrets] = useState<Partial<Record<ConnectionPreset, string>>>({});
  const [busy, setBusy] = useState<ConnectionPreset>();
  const [message, setMessage] = useState("");
  const connect = async (preset: ConnectionPreset) => {
    setBusy(preset); setMessage("");
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset, secret: secrets[preset] }) });
      const body = await response.json() as { error?: string; connection?: { label?: string } };
      if (!response.ok) throw new Error(body.error ?? t("connections.failed"));
      setSecrets((current) => ({ ...current, [preset]: "" }));
      const readyMessage = t("connections.ready", { name: body.connection?.label ?? CONNECTION_PRESETS[preset].label });
      setMessage(readyMessage);
      toast.add({ title: readyMessage });
      await reload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("connections.failed")); }
    finally { setBusy(undefined); }
  };
  if (!presets.length && !connections.length) return null;
  return <section aria-label={t("connections.title")}>
    {presets.map(([preset, info]) => <form className="connection-card" key={preset} onSubmit={(event) => { event.preventDefault(); void connect(preset); }}>
      <div><span className="connection-state" /><strong>{info.label}</strong><small>{t("connections.keyRequired")}</small></div>
      <label>{t("connections.apiKey")}<input type="password" autoComplete="off" spellCheck={false} required minLength={10} value={secrets[preset] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [preset]: event.target.value }))} /></label>
      <button disabled={busy !== undefined || (secrets[preset]?.trim().length ?? 0) < 10}>{t(busy === preset ? "connections.testing" : "connections.connect")}</button>
    </form>)}
    {connections.map((connection) => <div className="connection-card" key={connection.name}><div><span className={`connection-state ${connection.status === "ready" ? "ready" : ""}`} /><strong>{connectionLabel(connection.name)}</strong><small>{connection.status}</small></div>{connection.lastError && <p role="alert">{connection.lastError}</p>}</div>)}
    {message && <p className="connection-message" role="status">{message}</p>}
  </section>;
}

function MemoryPanel({ state, reload, demoSave, demoRemove }: { state: AppState; reload: () => Promise<void>; demoSave?: (key: string, value: string) => Promise<void>; demoRemove?: (id: string) => Promise<boolean> }) {
  const { t } = useLocale();
  const toast = useProductToast();
  const [key, setKey] = useState(""); const [value, setValue] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      if (demoSave) { await demoSave(key, value); setKey(""); setValue(""); toast.add({ title: t("memory.saved") }); return; }
      const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "memory", key, value }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("memory.failed"));
      setKey(""); setValue(""); setMessage(""); toast.add({ title: t("memory.saved") }); await reload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("memory.failed")); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try {
      if (demoRemove) { const removed = await demoRemove(id); if (removed) toast.add({ title: t("memory.removed") }); return removed; }
      const response = await fetch("/api/context", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "memory", id }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("memory.removeFailed"));
      toast.add({ title: t("memory.removed") }); await reload(); return true;
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("memory.removeFailed")); return false; }
  };
  return <><ListHeading title={t("tab.memory")} count={state.memories.length} /><form className="context-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><input value={key} onChange={(event) => setKey(event.target.value)} placeholder={t("memory.key")} aria-label={t("memory.key")} /><textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("memory.value")} aria-label={t("memory.value")} rows={3} /><button disabled={busy || !key.trim() || !value.trim()}>{t(busy ? "memory.saving" : "memory.save")}</button></form>{message && <p className="connection-message" role="status">{message}</p>}{state.memories.map((memory) => <div className="memory-card" key={memory.id}><code>{memory.key}</code><p>{memory.value}</p><small>{memory.updatedAt}</small><ConfirmAction label={t("common.remove")} title={t("confirm.memory.title")} description={t("confirm.memory.description")} onConfirm={() => remove(memory.id)} /></div>)}{!state.memories.length && !panelFailed(state, ["memory"]) && <Empty text={t("memory.empty")} />}</>;
}

function PkmPanel({ state, reload, demoSave, demoRemove }: { state: AppState; reload: () => Promise<void>; demoSave?: (title: string, content: string) => Promise<number>; demoRemove?: (id: string) => Promise<boolean> }) {
  const { t } = useLocale();
  const toast = useProductToast();
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      if (demoSave) { const chunks = await demoSave(title, content); setTitle(""); setContent(""); toast.add({ title: t("pkm.saved", { count: chunks }) }); return; }
      const response = await fetch("/api/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "pkm", title, content }) });
      const body = await response.json().catch(() => ({})) as { error?: string; chunks?: number };
      if (!response.ok) throw new Error(body.error ?? t("pkm.failed"));
      setTitle(""); setContent(""); setMessage(""); toast.add({ title: t("pkm.saved", { count: body.chunks ?? 0 }) }); await reload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("pkm.failed")); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try {
      if (demoRemove) { const removed = await demoRemove(id); if (removed) toast.add({ title: t("pkm.removed") }); return removed; }
      const response = await fetch("/api/context", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "pkm", id }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t("pkm.removeFailed"));
      toast.add({ title: t("pkm.removed") }); await reload(); return true;
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("pkm.removeFailed")); return false; }
  };
  return <><ListHeading title={t("tab.pkm")} count={state.pkmSources.length} /><form className="context-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("pkm.title")} aria-label={t("pkm.title")} /><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={t("pkm.content")} aria-label={t("pkm.content")} rows={5} /><button disabled={busy || !title.trim() || !content.trim()}>{t(busy ? "pkm.indexing" : "pkm.add")}</button></form>{message && <p className="connection-message" role="status">{message}</p>}{state.pkmSources.map((source) => <div className="item-card" key={source.id}><span>◇</span><div><strong>{source.title}</strong><small>{source.kind} · {source.status}</small></div><ConfirmAction label={t("common.remove")} title={t("confirm.pkm.title")} description={t("confirm.pkm.description")} onConfirm={() => remove(source.id)} /></div>)}{!state.pkmSources.length && !panelFailed(state, ["pkm sources"]) && <Empty text={t("pkm.empty")} />}</>;
}

function InteractionCard({ demo, runId, request, respond, upload }: {
  demo?: boolean; runId?: string; request: Record<string, unknown>;
  respond: (action: "submit" | "decline" | "cancel", permission?: "allow_once" | "allow_for_run" | "allow_always" | "deny", value?: unknown) => Promise<void>;
  upload: (file: File) => Promise<{ fileRef?: string; mimeType: string; size: number; sha256?: string } | undefined>;
}) {
  const { locale, t } = useLocale();
  const kind = String(request.kind ?? "input");
  const schema = request.schema && typeof request.schema === "object" ? request.schema as Record<string, unknown> : {};
  const data = request.data && typeof request.data === "object" ? request.data as Record<string, unknown> : {};
  const checkpoint = request.checkpoint && typeof request.checkpoint === "object" ? request.checkpoint as Record<string, unknown> : {};
  const fields = schema.properties && typeof schema.properties === "object" ? Object.entries(schema.properties as Record<string, Record<string, unknown>>) : [];
  const [value, setValue] = useState<unknown>(() => schema.default);
  const [form, setForm] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.flatMap(([name, field]) => field.default === undefined ? [] : [[name, field.default]])));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const busyLock = useRef(false);
  const oauthPopup = useRef<Window | null>(null);
  const expiresAt = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : Number.NaN;
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(expiresAt) || expiresAt <= clock) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(expiresAt - clock + 10, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [clock, expiresAt]);
  const expired = Number.isFinite(expiresAt) && expiresAt <= clock;
  const primitiveValid = (field: Record<string, unknown>, fieldValue: unknown) => {
    const typeValid = field.type === "string" ? typeof fieldValue === "string"
      : field.type === "boolean" ? typeof fieldValue === "boolean"
        : field.type === "integer" ? typeof fieldValue === "number" && Number.isInteger(fieldValue)
          : field.type === "number" ? typeof fieldValue === "number" && Number.isFinite(fieldValue) : false;
    if (!typeValid || Array.isArray(field.enum) && !field.enum.some((candidate) => Object.is(candidate, fieldValue))) return false;
    if (typeof fieldValue === "string" && (typeof field.minLength === "number" && [...fieldValue].length < field.minLength || typeof field.maxLength === "number" && [...fieldValue].length > field.maxLength)) return false;
    if (typeof fieldValue === "number" && (typeof field.minimum === "number" && fieldValue < field.minimum || typeof field.maximum === "number" && fieldValue > field.maximum)) return false;
    return true;
  };
  const primitive = () => kind === "select" ? value
    : schema.type === "number" || schema.type === "integer" ? value === "" || value === undefined ? undefined : Number(value)
      : schema.type === "boolean" ? typeof value === "boolean" ? value : undefined : value;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const formValid = fields.every(([name, field]) => {
    const fieldValue = form[name];
    if (required.has(name) && fieldValue === undefined) return false;
    return fieldValue === undefined || primitiveValid(field, fieldValue);
  });
  const inputValid = kind === "select" ? value !== undefined && primitiveValid(schema, primitive()) : kind !== "input" || primitiveValid(schema, primitive());
  const persistentPermissionAllowed = data.previewLimited === false && data.resourceResolved === true;
  const interactionId = typeof request.id === "string" ? request.id : undefined;
  const requester = request.requester && typeof request.requester === "object" ? request.requester as Record<string, unknown> : {};
  const permission = data.permission && typeof data.permission === "object" ? data.permission as Record<string, unknown> : {};
  const resolve = useCallback(async (action: "submit" | "decline" | "cancel", decision?: "allow_once" | "allow_for_run" | "allow_always" | "deny", submittedValue?: unknown) => {
    if (busyLock.current || expired) return;
    busyLock.current = true; setBusy(true); setActionError("");
    try { await respond(action, decision, submittedValue); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : t("interaction.failed")); }
    finally { busyLock.current = false; setBusy(false); }
  }, [expired, respond, t]);
  useEffect(() => {
    if (kind !== "oauth" || !interactionId) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
      const payload = event.data as Record<string, unknown>;
      if (Object.keys(payload).some((key) => !["type", "interactionId", "connectionRef"].includes(key))) return;
      if (payload.type === "harnest.oauth.complete" && payload.interactionId === interactionId && typeof payload.connectionRef === "string") void resolve("submit", undefined, { connectionRef: payload.connectionRef });
    };
    addEventListener("message", receive); return () => removeEventListener("message", receive);
  }, [interactionId, kind, resolve]);
  const canSubmit = !busy && !expired && (kind === "form" ? formValid : inputValid);
  return <section className="interaction-card" aria-busy={busy}><p className="eyebrow">{t("interaction.required", { kind })}</p><h3>{String(request.title ?? t("interaction.title"))}</h3><p>{String(request.message ?? t("interaction.body"))}</p>
    <small>{t("interaction.checkpoint", { revision: String(checkpoint.revision ?? "—"), sequence: String(checkpoint.sequence ?? "—") })}{typeof request.expiresAt === "string" ? ` · ${t("interaction.expires", { time: new Date(request.expiresAt).toLocaleString(locale) })}` : ""}</small>
    {expired && <p className="interaction-error" role="alert">{t("interaction.expired")}</p>}
    {actionError && <p className="interaction-error" role="alert">{actionError}</p>}
    {kind === "permission" && <><dl className="permission-scope"><div><dt>{t("interaction.requester")}</dt><dd>{String(requester.kind ?? "—")} · {String(requester.id ?? "—")}</dd></div><div><dt>{t("interaction.blocking")}</dt><dd>{String(request.blocking ?? "—")}</dd></div><div><dt>{t("interaction.risk")}</dt><dd>{String(data.risk ?? "—")}</dd></div><div><dt>{t("interaction.tool")}</dt><dd>{String(permission.toolId ?? "—")}</dd></div><div><dt>{t("interaction.action")}</dt><dd>{String(permission.action ?? "—")}</dd></div><div><dt>{t("interaction.capability")}</dt><dd>{String(permission.capability ?? "—")}</dd></div><div><dt>{t("interaction.connection")}</dt><dd>{String(permission.connectionId ?? "—")}</dd></div><div><dt>{t("interaction.resource")}</dt><dd>{String(permission.resource ?? "—")}</dd></div></dl>{Object.hasOwn(data, "input") && <div className="permission-preview"><strong>{t("interaction.preview")}</strong><pre>{JSON.stringify(data.input, null, 2)}</pre></div>}</>}
    <BaseForm className="interaction-form" validationMode="onBlur" onFormSubmit={() => { if (canSubmit && kind !== "permission" && kind !== "file" && kind !== "oauth") void resolve("submit", undefined, kind === "form" ? form : primitive()); }}>
      {kind === "select" && <SelectControl<unknown> disabled={busy || expired} required name="response" className="interaction-select" fieldClassName="interaction-field" label={t("interaction.select")} value={value} placeholder={t("interaction.choose")} errorMessage={t("interaction.invalid")} options={(Array.isArray(schema.enum) ? schema.enum : []).map((option) => ({ value: option, label: String(option) }))} onValueChange={setValue} />}
      {kind === "input" && schema.type === "boolean" && <SelectControl<unknown> disabled={busy || expired} required name="response" className="interaction-select" fieldClassName="interaction-field" label={t("interaction.response")} value={value} placeholder={t("common.choose")} errorMessage={t("interaction.invalid")} options={[{ value: true, label: t("interaction.yes") }, { value: false, label: t("interaction.no") }]} onValueChange={setValue} />}
      {kind === "input" && schema.type !== "boolean" && <Field.Root className="interaction-field" name="response" disabled={busy || expired}><Field.Label>{t("interaction.response")}</Field.Label><Field.Control required type={schema.type === "number" || schema.type === "integer" ? "number" : "text"} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} value={value === undefined ? "" : String(value)} onValueChange={setValue} placeholder={t("interaction.response")} /><Field.Error>{t("interaction.invalid")}</Field.Error></Field.Root>}
      {kind === "form" && <div className="interaction-fields">{fields.map(([name, field]) => Array.isArray(field.enum) ? <SelectControl<unknown> key={name} disabled={busy || expired} required={required.has(name)} name={name} fieldClassName="interaction-field" label={String(field.title ?? name)} value={form[name]} placeholder={t("common.choose")} errorMessage={t("interaction.invalid")} options={field.enum.map((option) => ({ value: option, label: String(option) }))} onValueChange={(next) => setForm((current) => ({ ...current, [name]: next }))} /> : field.type === "boolean" ? <SelectControl<unknown> key={name} disabled={busy || expired} required={required.has(name)} name={name} fieldClassName="interaction-field" label={String(field.title ?? name)} value={form[name]} placeholder={t("common.choose")} errorMessage={t("interaction.invalid")} options={[{ value: true, label: t("interaction.yes") }, { value: false, label: t("interaction.no") }]} onValueChange={(next) => setForm((current) => ({ ...current, [name]: next }))} /> : <Field.Root className="interaction-field" key={name} name={name} disabled={busy || expired}><Field.Label>{String(field.title ?? name)}</Field.Label><Field.Control required={required.has(name)} min={typeof field.minimum === "number" ? field.minimum : undefined} max={typeof field.maximum === "number" ? field.maximum : undefined} minLength={typeof field.minLength === "number" ? field.minLength : undefined} maxLength={typeof field.maxLength === "number" ? field.maxLength : undefined} type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={form[name] === undefined ? "" : String(form[name])} onValueChange={(next) => setForm((current) => { const updated = { ...current }; if ((field.type === "number" || field.type === "integer") && next === "") delete updated[name]; else updated[name] = field.type === "number" || field.type === "integer" ? Number(next) : next; return updated; })} /><Field.Error>{t("interaction.invalid")}</Field.Error></Field.Root>)}</div>}
      {kind === "file" && <Field.Root className="interaction-field" name="file" disabled={busy || expired}><Field.Label>{t("interaction.file")}</Field.Label><Field.Control type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file && !busyLock.current) void (async () => { busyLock.current = true; setBusy(true); setActionError(""); try { const uploaded = await upload(file); if (!uploaded?.fileRef || !uploaded.sha256) throw new Error(t("interaction.fileFailed")); await respond("submit", undefined, { fileRef: uploaded.fileRef, mimeType: uploaded.mimeType, size: uploaded.size, sha256: uploaded.sha256 }); } catch (cause) { setActionError(cause instanceof Error ? cause.message : t("interaction.fileFailed")); } finally { busyLock.current = false; setBusy(false); } })(); }} /></Field.Root>}
      {kind === "oauth" && <div className="interaction-oauth"><button type="button" disabled={busy || expired || !runId || !interactionId} onClick={() => { if (demo) { void resolve("submit", undefined, { connectionRef: "demo-session-oauth" }); return; } if (oauthPopup.current && !oauthPopup.current.closed) { oauthPopup.current.focus(); return; } oauthPopup.current = window.open(`/api/oauth/start?runId=${encodeURIComponent(runId ?? "")}&interactionId=${encodeURIComponent(interactionId ?? "")}`, "harnest-oauth", "popup,width=640,height=760"); if (!oauthPopup.current) setActionError(t("interaction.popupBlocked")); }}>{t(demo ? "interaction.oauthDemo" : "interaction.oauth")}</button></div>}
      <div className={`interaction-actions ${kind === "permission" ? "permission-options" : ""}`}>{kind === "permission" ? <><button type="button" aria-label={t("interaction.allowOnce")} disabled={busy || expired} onClick={() => void resolve("submit", "allow_once")}><strong>{t("interaction.allowOnce")}</strong><small>{t("interaction.allowOnceHint")}</small></button><button type="button" aria-label={t("interaction.allowRun")} disabled={busy || expired} onClick={() => void resolve("submit", "allow_for_run")}><strong>{t("interaction.allowRun")}</strong><small>{t("interaction.allowRunHint")}</small></button><button type="button" aria-label={t("interaction.allowAlways")} disabled={busy || expired || !persistentPermissionAllowed} title={persistentPermissionAllowed ? undefined : t("interaction.allowAlwaysHint")} onClick={() => void resolve("submit", "allow_always")}><strong>{t("interaction.allowAlways")}</strong><small>{t("interaction.allowAlwaysScope")}</small></button><button type="button" aria-label={t("interaction.deny")} disabled={busy || expired} className="quiet danger" onClick={() => void resolve("submit", "deny")}><strong>{t("interaction.deny")}</strong><small>{t("interaction.denyHint")}</small></button></> : kind === "file" || kind === "oauth" ? null : <button type="submit" disabled={!canSubmit}>{busy ? t("interaction.working") : t("interaction.submit")}</button>}<button type="button" disabled={busy || expired} className="quiet" title={t("interaction.declineHint")} onClick={() => void resolve("decline")}>{t("interaction.decline")}</button><button type="button" disabled={busy || expired} className="quiet" title={t("interaction.cancelHint")} onClick={() => void resolve("cancel")}>{t("interaction.cancel")}</button></div>
    </BaseForm>
  </section>;
}

function ArtifactPanel({ state }: { state: AppState }) {
  const { locale, t } = useLocale();
  const artifact = state.artifacts[0];
  if (!artifact) return <><ListHeading title={t("tab.artifact")} count={0} />{!panelFailed(state, ["artifacts"]) && <Empty text={t("artifact.empty")} />}</>;
  const href = state.mode === "demo" ? safeDownloadUrl(artifact.downloadUrl) : `/api/artifacts?id=${encodeURIComponent(artifact.id)}`;
  return <><div className="artifact-head"><div><p className="eyebrow">{t("artifact.latest")}</p><h2>{artifact.name}</h2><span>{artifact.kind} · {formatBytes(artifact.size)}</span></div>{href ? <a href={href} aria-label={`${t("common.download")} ${artifact.name}`}>{t("common.download")}</a> : <span className="download-pending">{t("artifact.downloadPending")}</span>}</div>
    <article className="artifact-preview artifact-summary"><h3>{artifact.name}</h3>{artifact.preview ? <ReactMarkdown skipHtml>{artifact.preview}</ReactMarkdown> : <p>{artifact.summary || t("artifact.noSummary")}</p>}</article>
    <div className="artifact-meta"><span><small>{t("artifact.created")}</small><strong>{formatTimestamp(artifact.createdAt, locale)}</strong></span><span><small>{t("artifact.status")}</small><strong className="success">● {artifact.status}</strong></span></div></>;
}
