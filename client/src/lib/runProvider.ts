type ResumeProvider = {
  provider?: string | null;
};

type ResumeSession = ResumeProvider & {
  id: string;
  metadata?: string | null;
};

export function providerForResume(item: ResumeProvider, fallback: string): string {
  return item.provider || fallback;
}

export function sessionIdForResume(session: ResumeSession): string {
  if (session.provider !== "codex") return session.id;

  if (session.metadata) {
    try {
      const metadata = JSON.parse(session.metadata) as { threadId?: unknown };
      if (typeof metadata.threadId === "string" && metadata.threadId) return metadata.threadId;
    } catch {
      // Fall through to the stable dashboard-id convention.
    }
  }

  return session.id.replace(/^codex-/, "");
}
