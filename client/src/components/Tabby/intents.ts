/**
 * @file intents.ts
 * @description Tabby's local "Ask" brain. Matches a free-text question against a
 *   small set of intents answerable from cached dashboard status. Anything it
 *   can't answer becomes a handoff to the Run page (spawn a real `claude`).
 *   Pure function - no network, no DOM - so it's fully unit-testable.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import type { TabbyStatus } from "./brain";

export type AskResult = { kind: "answer"; text: string } | { kind: "handoff"; prompt: string };

const plural = (n: number) => (n === 1 ? "" : "s");

export function matchIntent(query: string, status: TabbyStatus): AskResult {
  const q = query.trim().toLowerCase();
  if (!q) {
    return {
      kind: "answer",
      text: "ask me about your sessions - what's running, any errors, or a quick status.",
    };
  }

  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has("help", "what can you", "what do you do")) {
    return {
      kind: "answer",
      text: 'I watch your sessions. Try "what\'s running", "any errors", or "status". Anything else, I\'ll hand to Claude.',
    };
  }

  // Errors first: "any failed runs" should report errors, not live count.
  if (has("error", "broke", "broken", "fail", "wrong", "crash")) {
    return {
      kind: "answer",
      text:
        status.errorCount > 0
          ? `${status.errorCount} session${plural(status.errorCount)} errored - open the panel to jump to them.`
          : "no errors - all clean ✅",
    };
  }

  if (has("waiting", "stuck", "blocked", "input", "my turn", "paused")) {
    return {
      kind: "answer",
      text:
        status.waitingCount > 0
          ? `${status.waitingCount} session${plural(status.waitingCount)} waiting on you 👀`
          : "nothing's waiting on you right now ◉",
    };
  }

  if (has("running", "active", "live", "going on", "happening", "in progress")) {
    const tail = status.waitingCount > 0 ? ` (${status.waitingCount} waiting on you 👀)` : "";
    return {
      kind: "answer",
      text:
        status.liveCount > 0
          ? `${status.liveCount} session${plural(status.liveCount)} live right now ◉${tail}`
          : "nothing's running right now - all quiet.",
    };
  }

  if (has("status", "summary", "overview", "how are things", "how's it", "how is it")) {
    return {
      kind: "answer",
      text: `${status.liveCount} live · ${status.waitingCount} waiting · ${status.errorCount} errored · ${
        status.connected ? "connected" : "offline"
      }.`,
    };
  }

  return { kind: "handoff", prompt: query.trim() };
}
