/**
 * @file brain/dump.js
 * @description Brain-dump reformatting (Phase G2, §G2.4). A raw brain dump —
 * from the Notes quick-capture box, a chat message, or Siri "note: …" — is sent
 * through the brain (standard tier → Gemini, with fallback) to be reshaped into a
 * structured markdown note: a title, a cleaned body, extracted todos, and
 * suggested tags. The ORIGINAL text is always preserved (stored in the note's
 * frontmatter) so nothing the user said is lost.
 *
 * Honest-degradation: if no provider is configured (or the model errors / returns
 * unparseable output), we fall back to a deterministic pass-through — the note is
 * still created from the raw text with a first-line title and heuristic todos —
 * and `formatted:false` tells the caller it wasn't model-reformatted.
 *
 * @author Jarvis (Phase G)
 */

const fs = require("node:fs");
const path = require("node:path");
const router = require("./router");

let SYSTEM = null;
function systemPrompt() {
  if (SYSTEM != null) return SYSTEM;
  try {
    SYSTEM = fs.readFileSync(path.join(__dirname, "prompts", "reformat.md"), "utf8");
  } catch {
    SYSTEM =
      "Reformat the user's brain dump into a clean markdown note and return JSON with title, body, tags, todos.";
  }
  return SYSTEM;
}

/**
 * Reformat a raw dump. Never throws — always returns a usable result.
 * @returns {Promise<{title,body,tags,todos,formatted,provider,taskClass,fellBack}>}
 */
async function reformatDump(text, { projectHint = null } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { ...deterministic(""), formatted: false, provider: null };

  if (!router.anyProviderConfigured()) {
    return { ...deterministic(raw), formatted: false, provider: null };
  }

  try {
    const {
      text: out,
      provider,
      taskClass,
      fellBack,
    } = await router.complete({
      prompt: projectHint
        ? `${raw}\n\n(Context: this likely belongs to project "${projectHint}".)`
        : raw,
      system: systemPrompt(),
      taskClass: "standard",
      intent: "reformat",
    });
    const parsed = parseJsonObject(out);
    if (parsed) {
      return {
        title: cleanTitle(parsed.title) || firstLine(raw),
        body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : raw,
        tags: normalizeStrings(parsed.tags).slice(0, 8),
        todos: normalizeStrings(parsed.todos).slice(0, 30),
        formatted: true,
        provider,
        taskClass,
        fellBack,
      };
    }
    // Model answered but not as JSON — keep its prose as the body, still a win.
    return {
      title: firstLine(raw),
      body: out,
      tags: [],
      todos: heuristicTodos(raw),
      formatted: true,
      provider,
      taskClass,
      fellBack,
    };
  } catch {
    return { ...deterministic(raw), formatted: false, provider: null };
  }
}

// ── Deterministic fallback (no model) ───────────────────────────────────────

function deterministic(raw) {
  const todos = heuristicTodos(raw);
  let body = raw;
  if (todos.length) {
    body = `${raw}\n\n## Todos\n\n${todos.map((t) => `- [ ] ${t}`).join("\n")}`;
  }
  return {
    title: firstLine(raw) || "Note",
    body,
    tags: [],
    todos,
    taskClass: "standard",
    fellBack: false,
  };
}

// Pull "TODO: x", "- [ ] x", or lines starting with an imperative-ish marker.
function heuristicTodos(raw) {
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const m =
      line.match(/^\s*(?:todo|action|task)\s*[:\-]\s*(.+)$/i) ||
      line.match(/^\s*-\s*\[\s*\]\s*(.+)$/) ||
      line.match(/^\s*[-*]\s+(?:need to|remember to|must)\s+(.+)$/i);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

function firstLine(raw) {
  const l = String(raw || "").split(/\r?\n/)[0] || "";
  return l
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 80);
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  // Strip a ```json fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Otherwise isolate the outermost {...}.
  if (!s.startsWith("{")) {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function cleanTitle(v) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null;
}

function normalizeStrings(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => String(v).trim()).filter(Boolean);
}

module.exports = { reformatDump };
