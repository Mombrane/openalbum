export type RefreshSnapshot = {
  revokedAt: Date | null;
  expiresAt: Date;
};

export type RefreshDecision = { kind: "missing" | "expired" | "replay" | "rotate" };

export function decideRefresh(row: RefreshSnapshot | null, now: Date): RefreshDecision {
  if (row === null) return { kind: "missing" };
  if (row.revokedAt !== null) return { kind: "replay" };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  return { kind: "rotate" };
}
