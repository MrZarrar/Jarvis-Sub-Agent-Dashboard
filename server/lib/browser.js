/**
 * @file server/lib/browser.js
 * @description Headless browser session for "search this and show me" (Phase Z,
 * Tier 1). Drives Chromium via Playwright, and streams a screenshot of every
 * step to the dashboard over the existing WebSocket as a `browse_frame` message -
 * so the user watches from wherever they are (crucially, their phone), not just
 * at the Mac the browser actually runs on.
 *
 * ponytail: single global session, one page, launched lazily and auto-closed
 * after idle. Pool + parallel sessions later if throughput ever matters.
 *
 * Playwright is a lazy require: if it (or its Chromium) isn't installed the
 * action degrades to an honest error ("run: npx playwright install chromium")
 * instead of crashing the server at boot.
 *
 * @author Jarvis (Phase Z1)
 */

const IDLE_CLOSE_MS = 2 * 60_000;
const NAV_TIMEOUT_MS = 30_000;
const MAX_STEPS = 12;

let browser = null;
let page = null;
let idleTimer = null;
let launching = null;

function broadcastFrame(frame) {
  try {
    require("../websocket").broadcast("browse_frame", frame);
  } catch {
    /* no WS yet (e.g. tests) - the action's return value still carries the url */
  }
}

/** Turn a plain query into a search URL; pass a real URL through untouched. */
function toUrl(query, url) {
  const u = String(url || "").trim();
  if (u) return /^https?:\/\//i.test(u) ? u : `https://${u}`;
  const q = String(query || "").trim();
  if (!q) return null;
  return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
}

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeSession().catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (launching) return launching;
  launching = (async () => {
    let chromium;
    try {
      ({ chromium } = require("playwright"));
    } catch {
      throw new Error(
        "Playwright isn't installed - run `npm install` then `npx playwright install chromium`."
      );
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    return page;
  })();
  try {
    return await launching;
  } catch (err) {
    browser = null;
    page = null;
    throw err;
  } finally {
    launching = null;
  }
}

/** Screenshot the current page and stream it as a browse_frame; also return it. */
async function snap(note) {
  const buf = await page.screenshot({ type: "jpeg", quality: 55 });
  const frame = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    image: `data:image/jpeg;base64,${buf.toString("base64")}`,
    note: note || null,
    at: new Date().toISOString(),
  };
  broadcastFrame(frame);
  return frame;
}

/**
 * Navigate to a query/url, run optional simple steps, and stream a frame after
 * each. Steps are `{ type: "type"|"click"|"press", selector?, text?, key? }`.
 * @returns {Promise<{url:string,title:string,frames:number}>}
 */
async function browse({ query, url, steps } = {}) {
  const target = toUrl(query, url);
  if (!target) throw new Error("browse needs a `query` or a `url`");
  await ensurePage();
  armIdleClose();

  await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  let frames = 1;
  await snap(query ? `Searched: ${query}` : `Opened ${target}`);

  const list = Array.isArray(steps) ? steps.slice(0, MAX_STEPS) : [];
  for (const step of list) {
    const s = step || {};
    try {
      if (s.type === "type" && s.selector) {
        await page.fill(String(s.selector), String(s.text || ""));
      } else if (s.type === "click" && s.selector) {
        await page.click(String(s.selector), { timeout: NAV_TIMEOUT_MS });
        await page
          .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
          .catch(() => {});
      } else if (s.type === "press") {
        await page.keyboard.press(String(s.key || "Enter"));
        await page
          .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
          .catch(() => {});
      } else {
        continue;
      }
      frames++;
      await snap(`${s.type}${s.selector ? ` ${s.selector}` : ""}`);
    } catch (err) {
      await snap(`step failed: ${err.message}`);
    }
  }

  armIdleClose();
  return { url: page.url(), title: await page.title().catch(() => ""), frames };
}

async function closeSession() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const b = browser;
  browser = null;
  page = null;
  if (b) {
    try {
      await b.close();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { browse, closeSession, toUrl, __state: () => ({ open: !!page }) };
