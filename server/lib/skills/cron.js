/**
 * @file cron.js
 * @description Skill scheduling (Phase H, §H5). A skill may declare a 5-field
 * cron `schedule` in its frontmatter ("0 7 * * *"); this reuses the shared
 * scheduler's `registerRecurringTask` extension point (server/lib/scheduler.js
 * — the same one Phase G2's project-pulse task uses) to tick once a minute and
 * fire any due skill. This is deliberately NOT a second scheduler and NOT a new
 * cron dependency: a 5-field matcher is a small, well-understood piece of code,
 * and ticking every 60s is cheap enough to just check every scheduled skill.
 *
 * Cron-triggered runs go through engine.runSkill with trigger:"schedule", which
 * (per the engine's safety model) can only ever fire a `confirm: none` skill —
 * a skill requiring tap/typed confirmation is silently skipped here (logged,
 * never run unattended).
 */

const lastFired = new Map(); // skillId → "YYYY-MM-DDTHH:mm" of the last minute it fired

function parseCronField(field, min, max) {
  if (field === "*") return null; // null = "matches anything"
  const values = new Set();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepMatch) continue;
    const [, range, stepStr] = stepMatch;
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const rangeMatch = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) continue;
      lo = Number(rangeMatch[1]);
      hi = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Does a 5-field cron expression ("min hour dom month dow") match `date`? */
function matchesCron(expr, date) {
  const fields = String(expr || "")
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields;
  const min = parseCronField(minF, 0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dom = parseCronField(domF, 1, 31);
  const mon = parseCronField(monF, 1, 12);
  const dow = parseCronField(dowF, 0, 6);

  if (min && !min.has(date.getMinutes())) return false;
  if (hour && !hour.has(date.getHours())) return false;
  if (mon && !mon.has(date.getMonth() + 1)) return false;
  // Cron's day-of-month/day-of-week are OR'd together when both are restricted
  // (standard cron semantics); if only one is restricted, only that one applies.
  const domRestricted = Boolean(dom);
  const dowRestricted = Boolean(dow);
  if (domRestricted && dowRestricted) {
    if (!dom.has(date.getDate()) && !dow.has(date.getDay())) return false;
  } else if (domRestricted && !dom.has(date.getDate())) {
    return false;
  } else if (dowRestricted && !dow.has(date.getDay())) {
    return false;
  }
  return true;
}

function minuteKey(date) {
  return date.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

/** Check every skill with a `schedule` and fire the due ones. Fail-safe: one
 *  bad skill definition or a fire that throws never stops the sweep. */
function checkDueSkills() {
  const store = require("./store");
  const engine = require("./engine");
  const now = new Date();
  const key = minuteKey(now);
  let skills = [];
  try {
    skills = store.listScheduledSkills();
  } catch {
    return;
  }
  for (const skill of skills) {
    try {
      if (!matchesCron(skill.schedule, now)) continue;
      if (lastFired.get(skill.id) === key) continue; // already fired this minute
      lastFired.set(skill.id, key);
      if (skill.confirm !== "none") {
        console.warn(
          `[skills] cron skipped "${skill.name}" — schedule requires confirm:none (has "${skill.confirm}")`
        );
        continue;
      }
      engine.runSkill({ skillId: skill.id, params: {}, trigger: "schedule" });
    } catch (err) {
      console.warn(`[skills] cron fire failed for "${skill.name}":`, err?.message || err);
    }
  }
  // Bound the map so a long-running process doesn't accumulate one entry per
  // skill forever if skills are frequently renamed/recreated with new ids.
  if (lastFired.size > 500) lastFired.clear();
}

module.exports = { matchesCron, checkDueSkills };
