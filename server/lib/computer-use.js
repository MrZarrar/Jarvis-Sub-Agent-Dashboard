/**
 * @file server/lib/computer-use.js
 * @description Real desktop control for "computer use" (Phase Z, Tier 2). Unlike
 * `browser.js` (Tier 1, a headless Chromium Playwright drives), this drives the
 * actual Mac: `screencapture` for screenshots, macOS "System Events" (osascript)
 * UI scripting for click/type/keypress. Zero new dependencies - same
 * native-platform-over-dependency pattern as Phase Y's osascript → Messages.app.
 *
 * ponytail: no session/process to manage here (each action is a one-shot CLI
 * spawn), so there's no browser.js-style lazy-launch/idle-close lifecycle to
 * replicate - genuinely simpler than Tier 1.
 *
 * Requires the invoking process (Terminal/Node) to hold macOS "Accessibility"
 * permission (System Events UI scripting) and "Screen Recording" permission
 * (screencapture) in System Settings → Privacy & Security. Without them,
 * osascript/screencapture fail with a clear stderr message that surfaces
 * through the dispatcher's error path - no special-casing needed here.
 *
 * @author Jarvis (Phase Z2)
 */

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");

const MAX_STEPS = 10;

let lastFrame = null;

function broadcastFrame(frame) {
  lastFrame = frame;
  try {
    require("../websocket").broadcast("computer_use_frame", frame);
  } catch {
    /* no WS yet (e.g. tests) - the action's return value still carries the step count */
  }
}

function getLastFrame() {
  return lastFrame;
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

/** Escape a string for embedding inside a double-quoted AppleScript literal. */
function escapeAppleScriptString(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/** Single left-click at a screen coordinate. */
async function click(x, y) {
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    throw new Error("click needs numeric x and y");
  }
  await runOsascript(
    `tell application "System Events" to click at {${Math.round(cx)}, ${Math.round(cy)}}`
  );
}

/** Type literal text via keystroke. */
async function typeText(text) {
  await runOsascript(
    `tell application "System Events" to keystroke "${escapeAppleScriptString(text)}"`
  );
}

// ponytail: named keys only; add modifiers (cmd/shift/opt) when a task needs them.
const KEY_CODES = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

/** Press a named key (return/tab/space/delete/escape/arrows) or a single character. */
async function keyPress(key) {
  const k = String(key || "").trim();
  const lower = k.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_CODES, lower)) {
    await runOsascript(`tell application "System Events" to key code ${KEY_CODES[lower]}`);
    return;
  }
  if (k.length === 1) {
    await runOsascript(
      `tell application "System Events" to keystroke "${escapeAppleScriptString(k)}"`
    );
    return;
  }
  throw new Error(
    `unknown key "${key}" - use return/tab/space/delete/escape/left/right/up/down or a single character`
  );
}

async function takeScreenshot() {
  const tmp = path.join(os.tmpdir(), `jarvis-computer-use-${randomUUID()}.jpg`);
  await new Promise((resolve, reject) => {
    execFile("screencapture", ["-x", "-t", "jpg", tmp], (err, _stdout, stderr) => {
      if (err) {
        return reject(
          new Error(
            stderr?.trim() ||
              err.message ||
              "screencapture failed - grant Screen Recording permission in System Settings → Privacy & Security"
          )
        );
      }
      resolve();
    });
  });
  try {
    return await fsp.readFile(tmp);
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

/** Screenshot the real screen and stream it as a computer_use_frame; also return it. */
async function snap(note) {
  const buf = await takeScreenshot();
  const frame = {
    image: `data:image/jpeg;base64,${buf.toString("base64")}`,
    note: note || null,
    at: new Date().toISOString(),
  };
  broadcastFrame(frame);
  return frame;
}

async function runStep(step) {
  const s = step || {};
  switch (s.type) {
    case "click":
      await click(s.x, s.y);
      return `click ${s.x},${s.y}`;
    case "type":
      await typeText(s.text || "");
      return `type "${String(s.text || "").slice(0, 40)}"`;
    case "key":
      await keyPress(s.key || "");
      return `key ${s.key}`;
    case "screenshot":
      return null;
    default:
      return `unknown step type "${s.type}"`;
  }
}

/**
 * Run a bounded sequence of clicks/keystrokes/keypresses on the real Mac
 * desktop, screenshotting after every step (streamed to the dashboard as
 * `computer_use_frame`). Steps: `{type:"click",x,y}` | `{type:"type",text}` |
 * `{type:"key",key}` | `{type:"screenshot"}`. No steps = just take a shot.
 * @returns {Promise<{steps:number}>}
 */
async function computerUse({ steps } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("computer use only works on macOS (System Events + screencapture)");
  }
  const list =
    Array.isArray(steps) && steps.length ? steps.slice(0, MAX_STEPS) : [{ type: "screenshot" }];
  let count = 0;
  for (const step of list) {
    let note;
    try {
      note = await runStep(step);
    } catch (err) {
      note = `step failed: ${err.message}`;
    }
    await snap(note);
    count++;
  }
  return { steps: count };
}

module.exports = {
  computerUse,
  getLastFrame,
  escapeAppleScriptString,
  __state: () => ({ lastFrame }),
};
