/**
 * @file speech.js
 * @description Turn assistant/model text into a short, spoken-style variant that
 * Siri reads aloud (Phase D, §3.3). The spec: no markdown, at most ~2 sentences,
 * long decimals rounded, length-capped. Pure functions, no I/O - easy to test
 * with fixtures and reused by every intent handler in server/lib/assistant.js.
 *
 * @author Jarvis (Phase D)
 */

const DEFAULT_MAX_SENTENCES = 2;
const DEFAULT_MAX_CHARS = 240;

/**
 * Strip Markdown formatting to plain speakable text. Siri reading "**2** PRs" or
 * "`kill`" aloud is jarring, so remove the syntax while keeping the words.
 */
function stripMarkdown(input) {
  let s = String(input == null ? "" : input);
  // Fenced code blocks → drop the fences, keep the code text.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
  // Images ![alt](url) → alt; links [text](url) → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Inline code, bold, italic, strikethrough markers.
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1");
  // Leading heading #, list bullets, blockquote markers at line starts.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  // Table pipes → spaces.
  s = s.replace(/\|/g, " ");
  // Stray markers left over.
  s = s.replace(/[*_`~]/g, "");
  return s;
}

/**
 * Round noisy decimals so Siri doesn't read "three point one four one five nine".
 * Numbers with 3+ decimal places collapse to 2. Integers are left untouched.
 */
function roundNumbers(input) {
  return String(input == null ? "" : input).replace(/\d+\.\d{3,}/g, (m) => {
    const n = Number(m);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : m;
  });
}

/**
 * Full pipeline: strip markdown → round numbers → collapse whitespace → keep the
 * first N sentences → hard-cap length at a word boundary.
 */
function toSpeech(
  text,
  { maxSentences = DEFAULT_MAX_SENTENCES, maxChars = DEFAULT_MAX_CHARS } = {}
) {
  let s = roundNumbers(stripMarkdown(text));
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";

  // First `maxSentences` sentences. Split only on a terminator followed by
  // whitespace, so decimals ("1.23") and ids aren't mistaken for sentence ends.
  const sentences = s.split(/(?<=[.!?])\s+/);
  if (sentences.length > maxSentences) {
    s = sentences.slice(0, maxSentences).join(" ").replace(/\s+/g, " ").trim();
  }

  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return s;
}

module.exports = { toSpeech, stripMarkdown, roundNumbers };
