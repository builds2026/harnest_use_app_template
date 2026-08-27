export type AppMode = "setup" | "demo" | "production";
export type MessageRole = "user" | "assistant" | "system";

export interface Conversation {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  unread?: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  pending?: boolean;
}

export interface FileItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  status: string;
  downloadUrl?: string;
}

export interface ArtifactItem extends FileItem {
  kind: string;
  summary?: string;
  preview?: string;
  createdAt: string;
}

export interface CitationItem {
  id: string;
  title: string;
  url?: string;
  excerpt?: string;
  index: number;
}

export interface TraceItem {
  id: string;
  type: string;
  label: string;
  status: string;
  at: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface HarnessCapability {
  id: string;
  label: string;
  kind: "capability" | "tool";
  ready: boolean;
  connectionId?: string;
}

export interface AppReadiness {
  ready: boolean;
  harnest: "ready" | "unreachable" | "not-configured";
  requiredConnections: string[];
  missingConnections: string[];
  message?: string;
}

export interface AppState {
  mode: AppMode;
  setup?: { missing: string[] };
  readiness?: AppReadiness;
  capabilities: HarnessCapability[];
  errors: string[];
  user?: { id: string; email?: string };
  conversations: Conversation[];
  activeConversationId?: string;
  activeRun?: { id: string; status: string; interactions?: Record<string, unknown>[] };
  messages: Message[];
  files: FileItem[];
  artifacts: ArtifactItem[];
  memories: { id: string; key: string; value: string; updatedAt: string }[];
  pkmSources: { id: string; title: string; kind: string; status: string }[];
  citations: CitationItem[];
  trace: TraceItem[];
  permissions: { id: string; harnessId: string; toolId: string; capability: string; resource?: string }[];
  connections: { name: string; kind: string; status: string; lastError?: string; updatedAt?: string }[];
}

export interface BridgeEvent {
  type: "status" | "delta" | "done" | "error" | "interaction" | "citation" | "artifact";
  sequence?: number;
  [key: string]: unknown;
}
