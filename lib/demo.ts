import type { AppState } from "./types";

export const localDemoEnabled = () => process.env.NEXT_PUBLIC_LOCAL_DEMO === "true";

export function demoState(conversation = "demo-quarterly"): AppState {
  const conversationMessages: Record<string, AppState["messages"]> = {
    "demo-quarterly": [
      { id: "m1", role: "user", content: "Turn the product notes into a concise Q3 launch brief. Call out risks and cite the source material.", createdAt: "2026-08-27T10:31:00.000Z" },
      { id: "m2", role: "assistant", content: "I drafted a launch brief around one promise: teams can move from a visual harness to the same tested runtime without rebuilding their integration. The strongest evidence is the shared execution contract across Studio, CLI, SDK, and HTTP, plus an MCP surface for authoring and static validation.\n\nThe main launch risk is operational clarity: permissions, credentials, and artifacts cross several surfaces. Make the deny-by-default boundary part of the story, not a footnote. [1]", createdAt: "2026-08-27T10:32:00.000Z" },
    ],
    "demo-migration": [{ id: "m3", role: "assistant", content: "The migration plan keeps RLS enabled throughout, backfills in bounded batches, and verifies ownership before cutover.", createdAt: "2026-08-27T09:54:00.000Z" }],
    "demo-notes": [{ id: "m4", role: "assistant", content: "Interview synthesis is ready: teams value predictable approval boundaries more than breadth of integrations.", createdAt: "2026-08-26T14:20:00.000Z" }],
    "demo-api": [{ id: "m5", role: "assistant", content: "The stream trace isolates three reconnect attempts before a visible manual recovery state.", createdAt: "2026-08-25T16:45:00.000Z" }],
  };
  return {
    mode: "demo",
    errors: [],
    readiness: { ready: true, harnest: "ready", requiredConnections: [], missingConnections: [] },
    capabilities: ["file-attachments", "web-search", "code-sandbox", "dynamic-multi-agent", "memory"].map((id) => ({ id, label: id.replaceAll("-", " "), kind: "capability", ready: true })),
    user: { id: "local-demo", email: "local@deterministic.dev" },
    activeConversationId: conversationMessages[conversation] ? conversation : "demo-quarterly",
    conversations: [
      { id: "demo-quarterly", title: "Q3 product brief", preview: "A crisp launch narrative with evidence…", updatedAt: "Now", unread: true },
      { id: "demo-migration", title: "Database migration", preview: "RLS policies and rollout checklist", updatedAt: "18m" },
      { id: "demo-notes", title: "Research notes", preview: "Synthesize the uploaded interviews", updatedAt: "Tue" },
      { id: "demo-api", title: "API review", preview: "Trace the streaming failure", updatedAt: "Mon" },
    ],
    messages: conversationMessages[conversation] ?? conversationMessages["demo-quarterly"]!,
    files: [
      { id: "f1", name: "product-notes.md", mimeType: "text/markdown", size: 18420, status: "ready", downloadUrl: "/api/files?id=f1" },
      { id: "f2", name: "interviews.pdf", mimeType: "application/pdf", size: 842130, status: "indexed" },
    ],
    artifacts: [
      { id: "a1", name: "q3-launch-brief.md", mimeType: "text/markdown", size: 6820, status: "ready", kind: "document", summary: "Launch narrative, proof points, and mitigations", preview: "## Q3 launch brief\n\n**Promise:** one tested execution contract across every surface.\n\n- Lead with developer trust.\n- Show exact permission scope.\n- Ground claims in owned sources.", createdAt: "2026-08-27T10:32:00.000Z", downloadUrl: "/api/artifacts?id=a1" },
    ],
    memories: [
      { id: "mem1", key: "writing.style", value: "Concise, evidence-led, no inflated claims", updatedAt: "Today" },
      { id: "mem2", key: "team.priority", value: "Developer trust over feature breadth", updatedAt: "Yesterday" },
    ],
    pkmSources: [
      { id: "p1", title: "Product knowledge base", kind: "folder", status: "synced" },
      { id: "p2", title: "Customer interviews", kind: "collection", status: "12 chunks" },
    ],
    citations: [
      { id: "c1", index: 1, title: "Harnest product architecture", url: "https://example.com/harnest-architecture", excerpt: "Studio, CLI, SDK, and HTTP share the runtime contract; MCP supports authoring and static validation." },
      { id: "c2", index: 2, title: "Security boundary", url: "internal research note", excerpt: "Runtime capabilities are denied by default and granted at exact scope." },
    ],
    permissions: [{ id: "demo-permission-search", harnessId: "arc-reference", toolId: "builtin.web-search", capability: "network", resource: "https://example.com/*" }],
    connections: [
      { name: "gemini-main", kind: "provider", status: "ready" },
      { name: "search-main", kind: "api", status: "ready" },
    ],
    trace: [
      { id: "t1", type: "classifier", label: "Classified as research", status: "complete", at: "10:31:42", metadata: { sequence: 1, route: "research", confidence: 0.96 } },
      { id: "t2", type: "team", label: "Research team · 2 tasks", status: "complete", at: "10:31:44", metadata: { sequence: 2, agents: 2, strategy: "parallel" } },
      { id: "t3", type: "tool", label: "PKM retrieval · 8 chunks", status: "complete", at: "10:31:47", metadata: { sequence: 3, tool: "memory.search", durationMs: 184 } },
      { id: "t4", type: "evaluation", label: "Groundedness · 0.94", status: "passed", at: "10:32:03", metadata: { sequence: 4, score: 0.94, threshold: 0.8 } },
    ],
  };
}

export function demoInteractions(): Record<string, unknown>[] {
  const checkpoint = (sequence: number) => ({ digest: String(sequence).padStart(64, "a"), revision: 1, sequence });
  const permission = (sequence: number, title: string) => ({
    id: `demo-permission-${sequence}`, kind: "permission", title, message: "Review the exact safe scope and choose the requested decision.", requester: { kind: "tool", id: "builtin.file" }, blocking: "run", checkpoint: checkpoint(sequence),
    data: { previewLimited: false, resourceResolved: true, risk: "write", input: { path: "launch-brief.md", secret: "[REDACTED]" }, permission: { toolId: "builtin.file", action: "write", capability: "workspace-write", connectionId: "sandbox-main", resource: "launch-brief.md" } },
  });
  return [
    { id: "demo-select", kind: "select", title: "Choose launch audience", message: "Select the primary audience.", checkpoint: checkpoint(1), schema: { type: "string", enum: ["Developers", "Security teams", "Executives"] } },
    { id: "demo-input", kind: "input", title: "Set proof-point count", message: "Enter an integer from two through five.", checkpoint: checkpoint(2), schema: { type: "integer", minimum: 2, maximum: 5, default: 3 } },
    { id: "demo-form", kind: "form", title: "Confirm launch shape", message: "Complete the bounded launch form.", checkpoint: checkpoint(3), schema: { type: "object", additionalProperties: false, required: ["channel", "reviewed"], properties: { channel: { type: "string", title: "Channel", enum: ["Docs", "Blog", "Video"] }, reviewed: { type: "boolean", title: "Security reviewed" } } } },
    { id: "demo-file", kind: "file", title: "Attach final evidence", message: "Choose a local file to create a verified demo reference.", checkpoint: checkpoint(4) },
    { id: "demo-oauth", kind: "oauth", title: "Authorize demo source", message: "Complete a session-local authorization simulation.", checkpoint: checkpoint(5) },
    { id: "demo-decline", kind: "input", title: "Demonstrate decline", message: "Use Decline to continue without submitting a value.", checkpoint: checkpoint(6), schema: { type: "string", minLength: 1 } },
    { id: "demo-cancel", kind: "select", title: "Demonstrate cancel", message: "Use Cancel to demonstrate the explicit cancel response.", checkpoint: checkpoint(7), schema: { type: "string", enum: ["Continue"] } },
    permission(8, "Allow one exact call"), permission(9, "Allow matching calls for this run"), permission(10, "Persist this exact permission"), permission(11, "Deny the final call"),
  ];
}

export const demoAsset = (kind: "file" | "artifact", id: string) => kind === "file" && id === "f1"
  ? { name: "product-notes.md", mimeType: "text/markdown; charset=utf-8", content: "# Product notes\n\nOne runtime contract across Studio, CLI, SDK, and HTTP, with MCP for authoring and static validation.\n" }
  : kind === "artifact" && id === "a1"
    ? { name: "q3-launch-brief.md", mimeType: "text/markdown; charset=utf-8", content: "# Q3 launch brief\n\nLead with developer trust, exact permissions, and evidence.\n" }
    : undefined;

export const deterministicReply = (prompt: string) =>
  `Local deterministic result for “${prompt.slice(0, 72)}${prompt.length > 72 ? "…" : ""}”.\n\nThe production path sends the same input through the app-owned Harnest bridge, persists bounded events in Supabase, and returns citations and artifacts as owned references. This response is deliberately local and does not claim that a model, tool, or database ran.`;
