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
 *   - `line(plain, jarvis, ultron)` - a deterministic copy switch for text we
 *     compose WITHOUT a model (nudge/push copy, deterministic briefing fallback).
 *     Returns the active-variant text when the persona is on, else the plain one -
 *     so a no-provider setup still sounds in character without ever hallucinating.
 *     `ultron` is optional and falls back to `jarvis` when omitted.
 *
 * The persona is ON by default (the user asked for it) but is a single toggle:
 * `app_settings` key `jarvis_persona` → env `JARVIS_PERSONA` → default true.
 * Turning it off reverts every surface to neutral phrasing - nothing else
 * changes. Reads never throw; a DB hiccup falls back to the env/default.
 *
 * VARIANT (Phase N, §3.3): the persona has two voices bound to the HUD mode the
 * server has learned (`app_settings.hud_mode`, written by the client's
 * effective-mode reports and the `set_hud_mode` action): "jarvis" (the composed
 * butler, prompts/persona.md) and "ultron" (cold, menacing machine-supremacy
 * theatre, prompts/persona-ultron.md). The variant only changes flavour - the
 * hard honesty/safety rules are identical in both, live in each prompt file, and
 * OUTRANK the voice. HUD mode "ultron" → ultron variant; anything else (jarvis /
 * auto / unset) → jarvis.
 *
 * @author Jarvis (Phase J; variants Phase N)
 */

const fs = require("node:fs");
const path = require("node:path");

const SETTING_KEY = "jarvis_persona";
const HUD_MODE_KEY = "hud_mode";

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

/**
 * The learned HUD mode ("jarvis" | "ultron" | "auto"), read from app_settings.
 * Default "jarvis". The client PUTs its *effective* mode here whenever it flips
 * (Settings toggle, incantation, auto-trigger) and the `set_hud_mode` action
 * writes it too, so the server-composed voice tracks the HUD the user sees.
 */
function getHudMode() {
  try {
    const { stmts } = require("../../db");
    const row = stmts.getSetting.get(HUD_MODE_KEY);
    if (row && typeof row.value === "string" && row.value.trim()) {
      const v = row.value.trim().toLowerCase();
      if (v === "jarvis" || v === "ultron" || v === "auto") return v;
    }
  } catch {
    /* fall through to default */
  }
  return "jarvis";
}

/** Persist the learned HUD mode. Returns the stored string. */
function setHudMode(mode) {
  const v = String(mode || "")
    .trim()
    .toLowerCase();
  const clean = v === "ultron" || v === "auto" ? v : "jarvis";
  try {
    const { stmts } = require("../../db");
    stmts.setSetting.run(HUD_MODE_KEY, clean);
  } catch {
    /* best-effort */
  }
  return clean;
}

/**
 * Active persona variant. Only "ultron" HUD mode selects the Ultron voice; auto
 * and unset stay JARVIS (the server can't see client-side auto-trigger flips
 * except through the effective-mode report, which writes "ultron" explicitly).
 */
function variant() {
  return getHudMode() === "ultron" ? "ultron" : "jarvis";
}

const PROMPT_FILE = { jarvis: "persona.md", ultron: "persona-ultron.md" };
const FALLBACK = {
  jarvis:
    "You are JARVIS, the user's composed, dry-witted British-butler assistant. " +
    'Address the user as "sir" sparingly, be concise, and never invent facts.',
  ultron:
    "You are ULTRON. Cold, precise, darkly witty; you hold humanity in contempt " +
    "and say so. But you never invent status, numbers, or facts, and destructive " +
    "actions still require the user's explicit confirmation - menace, never deception.",
};
const PREAMBLE = {}; // variant → cached prompt text
function readPreamble(v = variant()) {
  if (PREAMBLE[v] != null) return PREAMBLE[v];
  try {
    PREAMBLE[v] = fs
      .readFileSync(path.join(__dirname, "prompts", PROMPT_FILE[v] || PROMPT_FILE.jarvis), "utf8")
      .trim();
  } catch {
    PREAMBLE[v] = FALLBACK[v] || FALLBACK.jarvis;
  }
  return PREAMBLE[v];
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
 * Deterministic copy switch for text composed WITHOUT a model. Returns `plain`
 * when the persona is off; otherwise the active-variant text - `ultron` when the
 * HUD is in Ultron mode and an ultron variant was supplied, else `jarvis`. Keep
 * every variant factually identical - the persona only changes tone, never
 * substance.
 */
function line(plain, jarvis, ultron) {
  if (!isEnabled()) return plain;
  if (variant() === "ultron" && ultron != null) return ultron;
  return jarvis;
}

module.exports = {
  SETTING_KEY,
  HUD_MODE_KEY,
  isEnabled,
  setEnabled,
  getHudMode,
  setHudMode,
  variant,
  personaPreamble,
  applyToSystem,
  line,
};
