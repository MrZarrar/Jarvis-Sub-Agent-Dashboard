/**
 * @file brain/persona.js
 * @description Jarvis's PERSONALITY layer (Phase J). One place that decides
 * whether the assistant/briefing voice wears the "JARVIS" character (dry,
 * formal-but-warm British butler, addresses the user as "sir") or stays plain,
 * and that supplies:
 *
 *   - `personaPreamble()` - the system-prompt block (prompts/persona.md) that is
 *     prepended to the brain's model calls (assistant chat + briefing prose) so
 *     the *model-generated* voice is in character.
 *   - `line(plain, jarvis)` - a deterministic copy switch for text we compose
 *     WITHOUT a model (nudge/push copy, deterministic briefing fallback). Returns
 *     the JARVIS variant when the persona is on, else the plain one - so a
 *     no-provider setup still sounds like Jarvis without ever hallucinating.
 *
 * The persona is ON by default (the user asked for it) but is a single toggle:
 * `app_settings` key `jarvis_persona` → env `JARVIS_PERSONA` → default true.
 * Turning it off reverts every surface to neutral phrasing - nothing else
 * changes. Reads never throw; a DB hiccup falls back to the env/default.
 *
 * @author Jarvis (Phase J)
 */

const fs = require("node:fs");
const path = require("node:path");

const SETTING_KEY = "jarvis_persona";

/** Env fallback: JARVIS_PERSONA=0/false/off disables; anything else / unset → on. */
function envDefault() {
  const raw = process.env.JARVIS_PERSONA;
  if (raw == null || raw === "") return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * Is the JARVIS persona currently enabled? app_settings override wins over the
 * env default. Fail-safe: any read error falls back to the env/default so the
 * voice is never accidentally silenced (or forced) by a broken settings read.
 */
function isEnabled() {
  try {
    // Lazy-require db so this module loads even in the rare test that stubs it.
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(SETTING_KEY);
    if (row && typeof row.value === "string" && row.value.trim()) {
      return !/^(0|false|off|no)$/i.test(row.value.trim());
    }
  } catch {
    /* fall through to env default */
  }
  return envDefault();
}

/** Persist the toggle. Returns the new boolean. */
function setEnabled(on) {
  const value = on ? "1" : "0";
  try {
    const { stmts } = require("../../db");
    stmts.setSetting.run(SETTING_KEY, value);
  } catch {
    /* best-effort - the in-memory answer still reflects the request */
  }
  return Boolean(on);
}

let PREAMBLE = null;
function readPreamble() {
  if (PREAMBLE != null) return PREAMBLE;
  try {
    PREAMBLE = fs.readFileSync(path.join(__dirname, "prompts", "persona.md"), "utf8").trim();
  } catch {
    PREAMBLE =
      "You are JARVIS, the user's composed, dry-witted British-butler assistant. " +
      'Address the user as "sir" sparingly, be concise, and never invent facts.';
  }
  return PREAMBLE;
}

/** The persona system block to prepend to a model call, or "" when disabled. */
function personaPreamble() {
  return isEnabled() ? readPreamble() : "";
}

/**
 * Compose the persona block in front of a base system prompt. When the persona
 * is off, returns the base unchanged. When the base is empty, returns just the
 * persona. Used by the brain (assistant) and the briefing composer.
 */
function applyToSystem(baseSystem) {
  const base = typeof baseSystem === "string" ? baseSystem.trim() : "";
  const pre = personaPreamble();
  if (!pre) return base;
  return base ? `${pre}\n\n${base}` : pre;
}

/**
 * Deterministic copy switch for text composed WITHOUT a model. Returns the
 * `jarvis` variant when the persona is on, else `plain`. Keep both variants
 * factually identical - the persona only changes tone, never substance.
 */
function line(plain, jarvis) {
  return isEnabled() ? jarvis : plain;
}

module.exports = {
  SETTING_KEY,
  isEnabled,
  setEnabled,
  personaPreamble,
  applyToSystem,
  line,
};
