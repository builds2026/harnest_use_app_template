export interface FileFingerprint { size: number; sha256: string }

export const sameFile = (left: FileFingerprint | undefined, right: FileFingerprint) =>
  Boolean(left && left.size === right.size && left.sha256 === right.sha256);

export const providerArtifactPath = (userId: string, conversationId: string, providerRef: string, name: string) =>
  `${userId}/${conversationId}/${providerRef}/${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`;

export function fileCommitRecovery(state: {
  status: "pending" | "committed";
  requested: FileFingerprint;
  expected?: FileFingerprint;
  stored?: FileFingerprint;
  artifact?: FileFingerprint;
}) {
  if (state.expected && !sameFile(state.expected, state.requested)) return "reject" as const;
  if (state.status === "committed") return sameFile(state.artifact, state.requested) ? "complete" as const : "reject" as const;
  if (!state.stored) return "upload" as const;
  if (!sameFile(state.stored, state.requested) || state.artifact && !sameFile(state.artifact, state.requested)) return "cleanup" as const;
  return "finalize" as const;
}
