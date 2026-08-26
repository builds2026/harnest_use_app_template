import type { AppState } from "./types";

export const localDemoEnabled = () => process.env.NEXT_PUBLIC_LOCAL_DEMO === "true";

export function demoState(): AppState {
  return {
    mode: "demo",
    user: { id: "local-demo", email: "local@deterministic.dev" },
    activeConversationId: "demo-quarterly",
    conversations: [
      { id: "demo-quarterly", title: "Q3 product brief", preview: "A crisp launch narrative with evidence…", updatedAt: "Now", unread: true },
      { id: "demo-migration", title: "Database migration", preview: "RLS policies and rollout checklist", updatedAt: "18m" },
      { id: "demo-notes", title: "Research notes", preview: "Synthesize the uploaded interviews", updatedAt: "Tue" },
      { id: "demo-api", title: "API review", preview: "Trace the streaming failure", updatedAt: "Mon" },
    ],
    messages: [
      { id: "m1", role: "user", content: "Turn the product notes into a concise Q3 launch brief. Call out risks and cite the source material.", createdAt: "10:31" },
      { id: "m2", role: "assistant", content: "I drafted a launch brief around one promise: teams can move from a visual harness to the same tested runtime without rebuilding their integration. The strongest evidence is the shared execution contract across Studio, CLI, SDK, HTTP, and MCP.\n\nThe main launch risk is operational clarity: permissions, credentials, and artifacts cross several surfaces. Make the deny-by-default boundary part of the story, not a footnote. [1]", createdAt: "10:32" },
    ],
    files: [
      { id: "f1", name: "product-notes.md", mimeType: "text/markdown", size: 18420, status: "ready" },
      { id: "f2", name: "interviews.pdf", mimeType: "application/pdf", size: 842130, status: "indexed" },
    ],
    artifacts: [
      { id: "a1", name: "q3-launch-brief.md", mimeType: "text/markdown", size: 6820, status: "ready", kind: "document", summary: "Launch narrative, proof points, and mitigations", createdAt: "10:32" },
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
      { id: "c1", index: 1, title: "Harnest product architecture", excerpt: "Studio, CLI, SDK, HTTP and MCP execute the same materialized spec." },
      { id: "c2", index: 2, title: "Security boundary", excerpt: "Runtime capabilities are denied by default and granted at exact scope." },
    ],
    permissions: [],
    connections: [
      { name: "gemini-main", kind: "provider", status: "ready" },
      { name: "search-main", kind: "api", status: "ready" },
    ],
    trace: [
      { id: "t1", type: "classifier", label: "Classified as research", status: "complete", at: "10:31:42" },
      { id: "t2", type: "team", label: "Research team · 2 tasks", status: "complete", at: "10:31:44" },
      { id: "t3", type: "tool", label: "PKM retrieval · 8 chunks", status: "complete", at: "10:31:47" },
      { id: "t4", type: "evaluation", label: "Groundedness · 0.94", status: "passed", at: "10:32:03" },
    ],
  };
}

export const deterministicReply = (prompt: string) =>
  `Local deterministic result for “${prompt.slice(0, 72)}${prompt.length > 72 ? "…" : ""}”.\n\nThe production path sends the same input through the app-owned Harnest bridge, persists bounded events in Supabase, and returns citations and artifacts as owned references. This response is deliberately local and does not claim that a model, tool, or database ran.`;
