/**
 * @file AgentRoom.tsx
 * @description The Ops Room - a 2D pixel-art office rendered on a canvas, staffed
 * by a FIXED team of five named characters (no per-session spawns). Live agents
 * from the hooks pipeline route to the matching teammate by NAME first (the
 * `.claude/agents/` team files spawn subagents literally called scout/forge/
 * sentinel/ops - the ruflo-style delegation revamp), then by current_tool:
 *   - Jarvis   (robot,    liaison, GPT-5.6 Sol) - mission owner and orchestrator
 *   - Scout    (sherlock, recon,   Claude Haiku)  - Grep/Glob/Read/Web*
 *   - Forge    (monkey,   coder,   Claude Sonnet) - Edit/Write/Notebook
 *   - Sentinel (bat,      review,  Claude Opus)   - review/audit subagents
 *   - Ops      (ninja,    runner,  Claude Haiku)  - Bash/shell
 * Active teammates sit at their desks typing under a glowing monitor; off-duty
 * ones goof off - arcade cabinet, dancing by the boombox, couch naps, coffee -
 * with activity bubbles. Sentinel is the one exception: he skips the couch
 * and naps hanging upside down in his own wall-mounted batcave instead (see
 * BATCAVE / drawBatcave / drawHangingSprite). A #ops-room Slack-style panel
 * beside the office narrates the live event stream in the team's voice,
 * including "@Scout - ..." delegation callouts (pass `events`; omit it - e.g.
 * on the Wall - to hide it).
 * Sprites are inline per-character pixel grids (drawn with CC0 sheets from
 * OpenGameArt/LPC as reference only), zero dependencies. Purely presentational:
 * takes the data the parent already polls, no fetching.
 *
 * Business mode (Phase BM): the same five desks are re-skinned to the business
 * crew (Deal Scout / Lister / Underwriter / Bookkeeper via applyRoomSkin), and
 * roleForName routes the ~/JarvisBusiness agent names (deal-scout, underwriter,
 * listing-writer, cs-drafter, bookkeeper, ops-manager) to the matching desks.
 *
 * Ultron mode (see ../lib/hudMode): when the app-wide HUD flips to ULTRON,
 * Jarvis's sprite swaps from the calm cyan ROBOT to the larger, red-visored
 * ULTRON sprite (drawn at ULTRON_SCALE) - everyone else is unaffected. A
 * standalone effect subscribes to hudMode into a ref (ultronRef) so a mode
 * flip doesn't tear down the animation loop, matching the pattern CoreSphere3D
 * uses for the same live-mode read.
 *
 * Canvas sizing: `size="panel"` (default) scales to the wrapper's width only
 * and lets the page scroll for the rest, matching the office's fixed aspect
 * ratio. `size="wall"` fit-contains on width AND height, since the Wall has
 * a fixed-height slot and never scrolls - the whole room must stay visible,
 * which can letterbox on very wide screens rather than crop or distort it.
 *
 * Sidebar: clicking a teammate (desk on the canvas, or their chip) opens a
 * side panel with a big portrait, the model on shift, the live task, what's
 * already done, and what's queued next - mined from the session's TodoWrite
 * events plus recent completed tool calls (see latestTodos/recentToolWins).
 * The panel replaces the old click-through-to-session behavior; each agent
 * row inside the panel is now the thing that navigates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Agent, DashboardEvent, Session } from "../lib/types";
import { buildEventSummary } from "../lib/event-summary";
import { useWorkMode } from "../lib/workMode";
import { hudMode } from "../lib/hudMode";

// ── The team ────────────────────────────────────────────────────────────────

type RoleId = "jarvis" | "scout" | "forge" | "sentinel" | "ops";

/** Per-character pixel art: rows of chars indexed into `colors`. '.' = clear. */
interface Sprite {
  colors: Record<string, string>;
  body: string[];
  legsStand: string[];
  legsWalk: string[];
}

interface RoleDef {
  id: RoleId;
  name: string;
  title: string;
  verb: string; // what the chip says while active
  model: string; // which model this teammate's agent file pins (docs/agents)
  tone: string;
  sprite: Sprite;
  desk: { x: number; y: number; w: number }; // art-space desk top-left + width
}

const PANTS = "#334155";
const SHOES = "#111827";
const EYES = "#0f172a";

// Jarvis: the robot. Antenna, cyan eyes, navy chassis.
const ROBOT: Sprite = {
  colors: { a: "#22d3ee", m: "#94a3b8", d: "#475569", b: "#1e3a8a", e: "#22d3ee" },
  body: [
    ".....aa.....",
    ".....dd.....",
    "..mmmmmmmm..",
    "..meemmeem..",
    "..mmmmmmmm..",
    "..mddddddm..",
    "...dddddd...",
    "..dbbbbbbd..",
    ".mdbbbbbbdm.",
    "..dbbbbbbd..",
  ],
  legsStand: ["...dd..dd...", "...dd..dd...", "...mm..mm..."],
  legsWalk: ["..dd....dd..", "..dd....dd..", "..mm....mm.."],
};

// Jarvis, gone rogue: jagged crown, a single glowing red visor instead of
// two cyan eyes, a wider gunmetal-and-black chassis with a red core. Only
// swapped in while hudMode is "ultron" (see AgentRoom's ultronRef) - drawn
// at ULTRON_SCALE so he looms over his own desk instead of just recoloring.
const ULTRON: Sprite = {
  colors: { m: "#52525b", d: "#27272a", b: "#09090b", r: "#ef4444" },
  body: [
    "..m..m..m...",
    ".mmmmmmmmmm.",
    "mmmmmmmmmmmm",
    ".rrrrrrrrrr.",
    "..mmmmmmmm..",
    "...dddddd...",
    "..dddddddd..",
    ".ddbbbbbbdd.",
    "ddbbbbbbbbdd",
    ".ddbbrrbbdd.",
  ],
  legsStand: ["...dd..dd...", "...dd..dd...", "...mm..mm..."],
  legsWalk: ["..dd....dd..", "..dd....dd..", "..mm....mm.."],
};
const ULTRON_SCALE = 1.6;

// Scout: the sleuth. Deerstalker hat, black trench coat, white collar - the
// coat used to share the skin tone (#cfa15c on #e0ac69) so it read as bare
// chest; now it's PANTS/SHOES-dark like a real coat, with a white collar sliver.
const SHERLOCK: Sprite = {
  colors: {
    h: "#78350f",
    H: "#b45309",
    s: "#e0ac69",
    e: EYES,
    c: PANTS,
    k: SHOES,
    w: "#e2e8f0",
    p: PANTS,
    o: SHOES,
  },
  body: [
    "....hhhh....",
    "..hHhhhhHh..",
    ".hhhhhhhhhh.",
    "..ssssssss..",
    "..seessees..",
    "..ssssssss..",
    "...cwwwwc...",
    "..cccccccc..",
    ".sccccccccs.",
    "..ckkkkkkc..",
  ],
  legsStand: ["...pp..pp...", "...pp..pp...", "...oo..oo..."],
  legsWalk: ["..pp....pp..", "..pp....pp..", "..oo....oo.."],
};

// Forge: the code monkey. Ears, muzzle, tail poking past the legs.
const MONKEY: Sprite = {
  colors: { f: "#8b5a2b", F: "#e0ac69", e: EYES, b: "#059669", t: "#8b5a2b", o: SHOES },
  body: [
    ".ff......ff.",
    ".fff....fff.",
    "..ffffffff..",
    "..fFeFFeFf..",
    "..fFFFFFFf..",
    "..fFFffFFf..",
    "...bbbbbb...",
    "..bbbbbbbb..",
    ".fbbbbbbbbf.",
    "..bbbbbbbb..",
  ],
  legsStand: ["...ff..ff..t", "...ff..ff.t.", "...oo..oo..."],
  legsWalk: ["..ff....ff.t", "..ff....fft.", "..oo....oo.."],
};

// Sentinel: the caped night-watch. Cowl ears, white eye slits, utility belt.
const BAT: Sprite = {
  colors: { k: "#1f2937", K: "#0b1120", e: "#e2e8f0", s: "#e0ac69", g: "#374151", y: "#eab308" },
  body: [
    "..k......k..",
    "..kk....kk..",
    "..kkkkkkkk..",
    "..keekkeek..",
    "..kssssssk..",
    "..kkkkkkkk..",
    "...gggggg...",
    ".Kggkkkkggk.",
    ".KggggggggK.",
    "..yyyyyyyy..",
  ],
  legsStand: ["...kk..kk...", "...kk..kk...", "...KK..KK..."],
  legsWalk: ["..kk....kk..", "..kk....kk..", "..KK....KK.."],
};

// Ops: the ninja. Masked, accent headband with a flying tail.
const NINJA: Sprite = {
  colors: { n: "#1e293b", s: "#e0ac69", e: EYES, a: "#f472b6", o: SHOES },
  body: [
    "...nnnnnn...",
    "..aaaaaaaa.a",
    "..nsseessn..",
    "..nnnnnnnn..",
    "...nnnnnn...",
    "...nnnnnn...",
    "..nnnaannn..",
    ".nnnnnnnnnn.",
    "..nnnnnnnn..",
  ],
  legsStand: ["...nn..nn...", "...nn..nn...", "...oo..oo..."],
  legsWalk: ["..nn....nn..", "..nn....nn..", "..oo....oo.."],
};

export const TEAM: RoleDef[] = [
  {
    id: "jarvis",
    name: "Jarvis",
    title: "liaison",
    verb: "coordinating",
    model: "gpt-5.6-sol",
    tone: "#22d3ee",
    sprite: ROBOT,
    desk: { x: 148, y: 52, w: 44 },
  },
  {
    id: "scout",
    name: "Scout",
    title: "recon",
    verb: "sleuthing",
    model: "haiku",
    tone: "#60a5fa",
    sprite: SHERLOCK,
    desk: { x: 34, y: 74, w: 36 },
  },
  {
    id: "forge",
    name: "Forge",
    title: "code",
    verb: "typing code",
    model: "sonnet",
    tone: "#34d399",
    sprite: MONKEY,
    desk: { x: 266, y: 74, w: 36 },
  },
  {
    id: "sentinel",
    name: "Sentinel",
    title: "review",
    verb: "reviewing",
    model: "opus",
    tone: "#a78bfa",
    sprite: BAT,
    desk: { x: 34, y: 138, w: 36 },
  },
  {
    id: "ops",
    name: "Ops",
    title: "terminal",
    verb: "running commands",
    model: "haiku",
    tone: "#f472b6",
    sprite: NINJA,
    desk: { x: 266, y: 138, w: 36 },
  },
];

const ROLE_BY_ID = new Map(TEAM.map((r) => [r.id, r]));

// Business mode (Phase BM): the same office, a different crew on shift. Only
// the display fields swap - ids, desks, sprites and tones stay put, so every
// TEAM consumer (draw loop, chat, chips) keeps working unchanged. The five
// desks host the six ~/JarvisBusiness agents: deal-scout takes Scout's desk,
// listing-writer + cs-drafter share Forge's, underwriter takes Sentinel's,
// bookkeeper + ops-manager share Ops' (see roleForName).
type RoleSkin = Pick<RoleDef, "name" | "title" | "verb" | "model">;
const DEV_SKIN = new Map<RoleId, RoleSkin>(
  TEAM.map((r) => [r.id, { name: r.name, title: r.title, verb: r.verb, model: r.model }])
);
const BUSINESS_SKIN = new Map<RoleId, RoleSkin>([
  ["jarvis", DEV_SKIN.get("jarvis")!],
  [
    "scout",
    { name: "Deal Scout", title: "sourcing", verb: "hunting deals", model: "gpt-5.6-terra" },
  ],
  ["forge", { name: "Lister", title: "listings", verb: "writing listings", model: "gpt-5.6-luna" }],
  [
    "sentinel",
    { name: "Underwriter", title: "deal desk", verb: "judging deals", model: "gpt-5.6-terra" },
  ],
  ["ops", { name: "Bookkeeper", title: "ledger", verb: "keeping books", model: "gpt-5.6-terra" }],
]);

/** Swap the crew's display fields in place. Idempotent and cheap - called on
 *  every AgentRoom render so the canvas loop and JSX read the right roster. */
export function applyRoomSkin(mode: "dev" | "business"): void {
  const skin = mode === "business" ? BUSINESS_SKIN : DEV_SKIN;
  for (const role of TEAM) Object.assign(role, skin.get(role.id));
}

/** Named delegation: the `.claude/agents/` team files (scout/forge/sentinel/ops)
 * plus friendly aliases (demo crew, reviewer-type subagents) map straight to a
 * desk, so a delegated task lands on the teammate Jarvis actually called. */
function roleForName(raw: string): RoleId | null {
  const t = raw.toLowerCase();
  if (!t) return null;
  // Business crew (Phase BM) first - "deal-scout" must not fall through on
  // the generic /scout/ below with different intent, and the rest have no
  // dev-team overlap: underwriter → Sentinel's desk, listing-writer and
  // cs-drafter → Forge's, bookkeeper and ops-manager → Ops'.
  if (/underwrit/.test(t)) return "sentinel";
  if (/listing|lister|^cs-|drafter/.test(t)) return "forge";
  if (/bookkeep|ledger/.test(t)) return "ops";
  if (/scout|sherlock|sleuth|explore|research|deal/.test(t)) return "scout";
  if (/forge|monkey|implement/.test(t)) return "forge";
  if (/sentinel|review|audit|lie-detector|verif|bat\b/.test(t)) return "sentinel";
  if (/\bops\b|ops-|robot|ninja|runner/.test(t)) return "ops";
  if (/jarvis|strategist|^plan$/.test(t)) return "jarvis";
  return null;
}

function roleForTool(tool: string): RoleId | null {
  const t = tool.toLowerCase();
  if (!t) return null;
  if (/grep|glob|websearch|webfetch|search|^read/.test(t)) return "scout";
  if (/edit|write|notebook/.test(t)) return "forge";
  if (/bash|command|shell|monitor/.test(t)) return "ops";
  if (/task|agent|todo|plan/.test(t)) return "jarvis";
  return null;
}

/** Route a live agent to its teammate: by name first (real team delegation),
 * then by the tool in hand, otherwise mains sit with Jarvis and stray
 * subagents with Scout. */
export function roleForAgent(agent: Agent): RoleId {
  return (
    roleForName(agent.subagent_type || "") ??
    roleForName(agent.name || "") ??
    roleForTool(agent.current_tool || "") ??
    (agent.type === "main" ? "jarvis" : "scout")
  );
}

interface RoleWork {
  agents: Agent[];
  waiting: boolean; // someone at this desk is blocked on the user
}

function assignWork(agents: Agent[]): Map<RoleId, RoleWork> {
  const map = new Map<RoleId, RoleWork>();
  for (const a of agents) {
    if (a.status !== "working" && a.status !== "waiting") continue;
    const role = roleForAgent(a);
    const w = map.get(role) ?? { agents: [], waiting: false };
    w.agents.push(a);
    if (a.status === "waiting") w.waiting = true;
    map.set(role, w);
  }
  return map;
}

// ── Pixel sprites ───────────────────────────────────────────────────────────
// 12-wide per-character grids (see the Sprite defs above); each character has
// its own silhouette - antenna, hat brim, ears+tail, cowl, headband - so the
// team reads distinct at a glance instead of five recolors of one body.

/** Draw a teammate with feet at (x, y) in art space. `scale` blows up each
 * pixel (used for Ultron - see ULTRON_SCALE) while keeping the sprite
 * centered on x and feet-anchored on y like the scale-1 default. */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  sprite: Sprite,
  walkFrame: boolean,
  bob: number,
  scale = 1
): void {
  const rows = [...sprite.body, ...(walkFrame ? sprite.legsWalk : sprite.legsStand)];
  const top = y - rows.length * scale + bob;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = sprite.colors[row[c]!];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x - 6 * scale + c * scale, top + r * scale, scale, scale);
    }
  }
}

/** Sentinel hanging upside down from the batcave perch: the same pixel grid
 * as drawSprite, but row order flipped (legs at the top, gripping the bar;
 * head dangling below) and anchored from the perch bar downward instead of
 * from the feet upward. */
function drawHangingSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  barY: number,
  sprite: Sprite,
  bob: number
): void {
  const rows = [...sprite.body, ...sprite.legsStand].reverse();
  const top = barY + bob;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = sprite.colors[row[c]!];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x - 6 + c, top + r, 1, 1);
    }
  }
}

// ── Office scene (art space is 340x200, scaled to fit the container) ────────

const ART_W = 340;
const ART_H = 200;
const WALL_H = 34;

/** What an off-duty teammate does at an idle spot (drives anim + bubble). */
type Act = "coffee" | "chat" | "nap" | "dance" | "arcade";

const ACT_GLYPH: Record<Act, string> = {
  coffee: "☕",
  chat: "…",
  nap: "💤",
  dance: "♪",
  arcade: "🎮",
};

export interface CharState {
  x: number;
  y: number;
  tx: number;
  ty: number;
  act: Act; // what they're up to at the target spot
  idleUntil: number; // when idling at a spot, leave after this timestamp
}

const IDLE_SPOTS: Array<{ x: number; y: number; act: Act }> = [
  { x: 310, y: 82, act: "coffee" }, // by the coffee machine
  { x: 312, y: 150, act: "chat" }, // by the water cooler
  { x: 150, y: 184, act: "nap" }, // couch, left seat
  { x: 172, y: 184, act: "nap" }, // couch, right seat
  { x: 110, y: 124, act: "dance" }, // rug, by the boombox
  { x: 216, y: 124, act: "dance" }, // rug, by the boombox
  { x: 30, y: 168, act: "arcade" }, // at the arcade cabinet
];

// Sentinel's own hangout (see drawBatcave): a wall alcove between the two
// shelves, clear of every desk and the rug. He skips the couch and hangs
// upside down here instead - real bats (and Batman) sleep hanging, not lying
// on a sofa - while everything else off-duty (coffee/chat/dance/arcade) he
// still shares with the team.
const BATCAVE = { x: 118, y: 66 };
const SENTINEL_IDLE_SPOTS: Array<{ x: number; y: number; act: Act }> = [
  ...IDLE_SPOTS.filter((spot) => spot.act !== "nap"),
  { x: BATCAVE.x, y: BATCAVE.y, act: "nap" },
];

function idleSpotsFor(roleId: RoleId): Array<{ x: number; y: number; act: Act }> {
  return roleId === "sentinel" ? SENTINEL_IDLE_SPOTS : IDLE_SPOTS;
}

/** True while this teammate is hanging upside down asleep in the batcave -
 * drives both the flipped sprite draw and where its "zzz" bubble lands. */
function isHangingBat(roleId: RoleId, act: Act): boolean {
  return roleId === "sentinel" && act === "nap";
}

/** Seat is left-of-center behind the desk (the monitor sits on the right),
 * with the desk front covering the teammate from the waist down. */
function seatFor(role: RoleDef): { x: number; y: number } {
  return { x: role.desk.x + 12, y: role.desk.y + 6 };
}

/** One L-shaped step toward (tx, ty): walk x first, then y, SNAPPING each axis
 * to its target once within a pixel. Without the snap a character rests wherever
 * per-axis movement happens to stop (combined distance up to ~2), which is > the
 * `≤1` "settled" test the wander timer and idle activities use - so an idler
 * lands in that gap and freezes mid-floor instead of drifting on. Snapping lands
 * it exactly on target (distance 0) so every settled-check fires. Mutates `ch`. */
export function stepToward(ch: CharState, dist: number): void {
  if (Math.abs(ch.x - ch.tx) > 1) {
    ch.x += Math.sign(ch.tx - ch.x) * dist;
  } else {
    ch.x = ch.tx;
    if (Math.abs(ch.y - ch.ty) > 1) ch.y += Math.sign(ch.ty - ch.y) * dist;
    else ch.y = ch.ty;
  }
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  now: number,
  chars: Map<RoleId, CharState>,
  work: Map<RoleId, RoleWork>,
  reducedMotion: boolean,
  selected: RoleId | null,
  ultron: boolean
): void {
  ctx.clearRect(0, 0, ART_W, ART_H);

  // Floor + back wall
  ctx.fillStyle = "#0b1120";
  ctx.fillRect(0, 0, ART_W, ART_H);
  ctx.fillStyle = "#111a2e";
  ctx.fillRect(0, 0, ART_W, WALL_H);
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, WALL_H, ART_W, 2);
  // Windows with a faint night glow
  for (let i = 0; i < 4; i++) {
    const wx = 24 + i * 84;
    ctx.fillStyle = "#0e7490";
    ctx.globalAlpha = 0.25;
    ctx.fillRect(wx, 6, 34, 20);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    ctx.strokeRect(wx + 0.5, 6.5, 34, 20);
    ctx.beginPath();
    ctx.moveTo(wx + 17, 6);
    ctx.lineTo(wx + 17, 26);
    ctx.stroke();
  }
  // Floor tiles + rug
  ctx.strokeStyle = "rgba(148,163,184,0.06)";
  for (let gx = 0; gx < ART_W; gx += 20) {
    ctx.beginPath();
    ctx.moveTo(gx + 0.5, WALL_H);
    ctx.lineTo(gx + 0.5, ART_H);
    ctx.stroke();
  }
  for (let gy = WALL_H; gy < ART_H; gy += 20) {
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(ART_W, gy + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(34,211,238,0.07)";
  ctx.fillRect(84, 100, 172, 44);
  ctx.strokeStyle = "rgba(34,211,238,0.18)";
  ctx.strokeRect(84.5, 100.5, 171, 43);

  // Props (drawn before characters/desks that sit lower on screen)
  drawPlant(ctx, 10, 62);
  drawPlant(ctx, 320, 100);
  drawCoffeeMachine(ctx, 318, 56);
  drawWaterCooler(ctx, 320, 126);
  drawCouch(ctx, 136, 176);
  drawShelf(ctx, 64, WALL_H - 1);
  drawShelf(ctx, 248, WALL_H - 1);
  drawArcade(ctx, 8, 146, now, reducedMotion);
  drawBoombox(ctx, 158, 108);
  drawBatcave(ctx, BATCAVE.x, BATCAVE.y);

  // Painter's algorithm: desks + characters sorted by baseline y.
  type Drawable = { y: number; draw: () => void };
  const items: Drawable[] = [];

  for (const role of TEAM) {
    const w = work.get(role.id);
    const active = !!w && w.agents.length > 0;
    items.push({
      y: role.desk.y + 16,
      draw: () => drawDesk(ctx, role, active, now, reducedMotion, role.id === selected),
    });
  }

  for (const role of TEAM) {
    const ch = chars.get(role.id);
    if (!ch) continue;
    const w = work.get(role.id);
    const active = !!w && w.agents.length > 0;
    const moving = Math.abs(ch.x - ch.tx) + Math.abs(ch.y - ch.ty) > 1;
    const dancing = !active && !moving && ch.act === "dance" && !reducedMotion;
    const gaming = !active && !moving && ch.act === "arcade" && !reducedMotion;
    const hanging = !active && !moving && isHangingBat(role.id, ch.act);
    const jarvisUltron = role.id === "jarvis" && ultron;
    const sprite = jarvisUltron ? ULTRON : role.sprite;
    const scale = jarvisUltron ? ULTRON_SCALE : 1;
    const walkFrame =
      moving && !reducedMotion
        ? Math.floor(now / 160) % 2 === 1
        : dancing
          ? Math.floor(now / 240) % 2 === 1
          : false;
    const bob =
      hanging && !reducedMotion
        ? (Math.floor(now / 900) % 2) - 1
        : !moving && !reducedMotion && (active || gaming)
          ? (Math.floor(now / 450) % 2) - 1
          : dancing
            ? (Math.floor(now / 240) % 2) - 1
            : 0;
    items.push({
      y: ch.y,
      draw: () =>
        hanging
          ? drawHangingSprite(ctx, ch.x, ch.y, sprite, bob)
          : drawSprite(ctx, ch.x, ch.y, sprite, walkFrame, bob, scale),
    });
  }

  items.sort((a, b) => a.y - b.y);
  for (const it of items) it.draw();

  // Bubbles paint over everything so desks/monitors never swallow them.
  for (const role of TEAM) {
    const ch = chars.get(role.id);
    if (ch && work.get(role.id)?.waiting) drawBubble(ctx, ch.x, ch.y - 18, "!", "#fbbf24");
  }

  // Off-duty fun: settled idlers show what they're up to (🎮 ♪ 💤 ☕); two
  // idlers hanging out near each other trade a "…" bubble instead.
  const idlers = TEAM.filter((r) => {
    const w = work.get(r.id);
    const ch = chars.get(r.id);
    return (
      ch && (!w || w.agents.length === 0) && Math.abs(ch.x - ch.tx) + Math.abs(ch.y - ch.ty) <= 1
    );
  });
  const chatting = new Set<RoleId>();
  for (let i = 0; i < idlers.length; i++) {
    for (let j = i + 1; j < idlers.length; j++) {
      const a = chars.get(idlers[i]!.id)!;
      const b = chars.get(idlers[j]!.id)!;
      if (Math.abs(a.x - b.x) < 26 && Math.abs(a.y - b.y) < 14) {
        chatting.add(idlers[i]!.id);
        chatting.add(idlers[j]!.id);
        const talker = (reducedMotion ? 0 : Math.floor(now / 1200) % 2) === 0 ? a : b;
        drawBubble(ctx, talker.x, talker.y - 15, "…", "#94a3b8");
      }
    }
  }
  for (let i = 0; i < idlers.length; i++) {
    const role = idlers[i]!;
    if (chatting.has(role.id)) continue;
    const ch = chars.get(role.id)!;
    // Intermittent, staggered per teammate so the room doesn't bubble in sync.
    const show = reducedMotion || Math.floor((now + i * 900) / 2600) % 2 === 0;
    const scale = role.id === "jarvis" && ultron ? ULTRON_SCALE : 1;
    const spriteH = (role.sprite.body.length + role.sprite.legsStand.length) * scale;
    // Hanging upside down puts his head at the bottom, so the "zzz" belongs
    // below him, not floating above the perch bar.
    const bubbleY = isHangingBat(role.id, ch.act) ? ch.y + spriteH + 3 : ch.y - spriteH - 3;
    if (show) drawBubble(ctx, ch.x, bubbleY, ACT_GLYPH[ch.act], role.tone);
  }

  // Name plates above desks
  ctx.font = "6px ui-monospace, monospace";
  ctx.textAlign = "center";
  for (const role of TEAM) {
    const w = work.get(role.id);
    const n = w?.agents.length ?? 0;
    ctx.fillStyle = n > 0 ? role.tone : "rgba(148,163,184,0.55)";
    ctx.fillText(
      n > 1 ? `${role.name} ×${n}` : role.name,
      role.desk.x + role.desk.w / 2,
      role.desk.y - 22
    );
  }
}

function drawDesk(
  ctx: CanvasRenderingContext2D,
  role: RoleDef,
  active: boolean,
  now: number,
  reducedMotion: boolean,
  selected: boolean
): void {
  const { x, y, w } = role.desk;
  // Desk glow when the teammate is on the job
  if (active) {
    ctx.fillStyle = role.tone;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x - 4, y - 4, w + 8, 22);
    ctx.globalAlpha = 1;
  }
  // Selection ring: a soft outline around the whole desk footprint so it
  // reads even when the desk is off-duty (dim monitor, no glow).
  if (selected) {
    ctx.strokeStyle = role.tone;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(x - 5.5, y - 5.5, w + 11, 24);
    ctx.globalAlpha = 1;
  }
  // Desktop + front panel + legs
  ctx.fillStyle = "#475569";
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = "#334155";
  ctx.fillRect(x, y + 3, w, 8);
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(x + 1, y + 11, 2, 4);
  ctx.fillRect(x + w - 3, y + 11, 2, 4);
  // Monitor: dark when idle, flickering in the role's tone while working.
  // Offset right so it never hides the teammate seated left-of-center.
  const mx = x + w - 13;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(mx, y - 9, 10, 8);
  const flicker = reducedMotion ? 0.85 : 0.7 + 0.3 * Math.abs(Math.sin(now / 300 + x));
  ctx.fillStyle = active ? role.tone : "#1e293b";
  ctx.globalAlpha = active ? flicker : 1;
  ctx.fillRect(mx + 1, y - 8, 8, 6);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#334155";
  ctx.fillRect(mx + 4, y - 1, 2, 1);
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string
): void {
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(x - 5, y - 7, 10, 8);
  ctx.fillRect(x - 1, y + 1, 2, 2);
  ctx.fillStyle = color;
  ctx.font = "7px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#78350f";
  ctx.fillRect(x, y + 6, 8, 5);
  ctx.fillStyle = "#166534";
  ctx.fillRect(x + 1, y, 6, 6);
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(x + 2, y - 3, 4, 4);
}

function drawCoffeeMachine(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(x, y, 14, 18);
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(x + 3, y + 3, 8, 3);
  ctx.fillStyle = "#0ea5e9";
  ctx.fillRect(x + 5, y + 9, 4, 5);
}

function drawWaterCooler(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#38bdf8";
  ctx.fillRect(x + 2, y, 6, 6);
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(x, y + 6, 10, 12);
}

function drawCouch(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#7f1d1d";
  ctx.fillRect(x, y, 50, 10);
  ctx.fillStyle = "#991b1b";
  ctx.fillRect(x - 3, y - 4, 3, 14);
  ctx.fillRect(x + 50, y - 4, 3, 14);
  ctx.fillRect(x, y - 4, 50, 4);
}

/** Sentinel's own hangout: a dark rock alcove cut into the wall with a perch
 * bar (x, y is the bar's center). Off duty he skips the couch and hangs
 * upside down here instead (see isHangingBat / drawHangingSprite) - the way
 * an actual bat, or Batman, would nap. */
function drawBatcave(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Jagged cave mouth cut into the wall.
  ctx.fillStyle = "#020617";
  ctx.beginPath();
  ctx.moveTo(x - 20, y + 24);
  ctx.lineTo(x - 20, y - 10);
  ctx.lineTo(x - 10, y - 18);
  ctx.lineTo(x - 2, y - 10);
  ctx.lineTo(x + 8, y - 20);
  ctx.lineTo(x + 20, y - 8);
  ctx.lineTo(x + 20, y + 24);
  ctx.closePath();
  ctx.fill();
  // Perch bar he hangs from.
  ctx.fillStyle = "#4b5563";
  ctx.fillRect(x - 14, y - 2, 28, 2);
  // Faint bat-signal-ish glow on the rock, just for flavor.
  ctx.fillStyle = "#fbbf24";
  ctx.globalAlpha = 0.08;
  ctx.beginPath();
  ctx.arc(x, y + 6, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawArcade(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  now: number,
  reducedMotion: boolean
): void {
  // Cabinet with an attract-mode screen cycling through the team tones.
  ctx.fillStyle = "#312e81";
  ctx.fillRect(x, y, 16, 26);
  ctx.fillStyle = "#1e1b4b";
  ctx.fillRect(x, y, 16, 3);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(x + 2, y + 4, 12, 9);
  const attract = ["#22d3ee", "#f472b6", "#34d399", "#a78bfa"];
  ctx.fillStyle = attract[reducedMotion ? 0 : Math.floor(now / 800) % attract.length]!;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x + 3, y + 5, 10, 7);
  ctx.globalAlpha = 1;
  // Control deck: joystick + two buttons
  ctx.fillStyle = "#475569";
  ctx.fillRect(x + 2, y + 15, 12, 3);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(x + 4, y + 15, 2, 2);
  ctx.fillStyle = "#facc15";
  ctx.fillRect(x + 9, y + 15, 2, 2);
}

function drawBoombox(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(x, y, 14, 8);
  ctx.fillStyle = "#0ea5e9";
  ctx.fillRect(x + 2, y + 2, 4, 4);
  ctx.fillRect(x + 8, y + 2, 4, 4);
  ctx.fillStyle = "#94a3b8";
  ctx.fillRect(x + 6, y + 3, 2, 2);
  ctx.fillRect(x + 1, y - 2, 12, 1); // handle
}

function drawShelf(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#3f3f46";
  ctx.fillRect(x, y - 14, 26, 14);
  const books = ["#dc2626", "#2563eb", "#d97706", "#059669", "#7c3aed"];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = books[i]!;
    ctx.fillRect(x + 2 + i * 5, y - 12, 3, 10);
  }
}

// ── Sidebar data mining ─────────────────────────────────────────────────────

export interface TodoSnapshot {
  done: string[];
  doing: string[];
  next: string[];
}

/** Latest TodoWrite payload from any of the given sessions: the closest thing
 * the event stream has to "done so far / doing now / up next". `events` is
 * newest-first (the shape the dashboard already polls). */
export function latestTodos(
  events: DashboardEvent[],
  sessionIds: Set<string>
): TodoSnapshot | null {
  for (const e of events) {
    if (!sessionIds.has(e.session_id) || !/todo/i.test(e.tool_name || "")) continue;
    if (!e.data) continue;
    try {
      const input = (JSON.parse(e.data) as { tool_input?: { todos?: unknown } }).tool_input;
      const todos = input?.todos;
      if (!Array.isArray(todos)) continue;
      const snap: TodoSnapshot = { done: [], doing: [], next: [] };
      for (const t of todos) {
        const item = t as { content?: unknown; status?: unknown };
        if (typeof item?.content !== "string" || !item.content) continue;
        if (item.status === "completed") snap.done.push(item.content);
        else if (item.status === "in_progress") snap.doing.push(item.content);
        else snap.next.push(item.content);
      }
      if (snap.done.length + snap.doing.length + snap.next.length > 0) return snap;
    } catch {
      /* malformed payload - keep looking */
    }
  }
  return null;
}

/** Recent completed tool calls for the given agents, newest first. */
function recentToolWins(events: DashboardEvent[], agentIds: Set<string>, cap = 8): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.event_type !== "PostToolUse" || !e.agent_id || !agentIds.has(e.agent_id)) continue;
    const line = buildEventSummary(e)?.headline || (e.tool_name ? `${e.tool_name} ✓` : "");
    if (line) out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

// ── Sidebar UI ──────────────────────────────────────────────────────────────

/** Big pixel portrait: the sprite grid drawn ×8 on a plain 2D canvas. */
function RolePortrait({ role }: { role: RoleDef }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { sprite } = role;
    const rows = [...sprite.body, ...sprite.legsStand];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const color = sprite.colors[row[c]!];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(c * 8, r * 8, 8, 8);
      }
    }
  }, [role]);
  const h = (role.sprite.body.length + role.sprite.legsStand.length) * 8;
  return (
    <canvas
      ref={ref}
      width={96}
      height={h}
      className="rounded-lg p-1"
      style={{
        imageRendering: "pixelated",
        background: `radial-gradient(ellipse at 50% 30%, ${role.tone}2e, transparent 75%)`,
        border: `1px solid ${role.tone}44`,
      }}
    />
  );
}

function SidebarSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="text-[10px] font-semibold uppercase tracking-wider mb-1"
        style={{ color: tone }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function AgentSidebar({
  role,
  work,
  events,
  sessionsById,
  onClose,
}: {
  role: RoleDef;
  work: Map<RoleId, RoleWork>;
  events?: DashboardEvent[];
  sessionsById?: Map<string, Session>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const assigned = work.get(role.id)?.agents ?? [];
  const sessionIds = new Set(assigned.map((a) => a.session_id));
  const agentIds = new Set(assigned.map((a) => a.id));
  const todos = events && sessionIds.size > 0 ? latestTodos(events, sessionIds) : null;
  const wins = events && agentIds.size > 0 ? recentToolWins(events, agentIds) : [];
  const done = todos?.done.length ? todos.done : wins;
  // Live models: what the sessions on this desk actually run, else the pin.
  const liveModels = [
    ...new Set(assigned.map((a) => sessionsById?.get(a.session_id)?.model).filter(Boolean)),
  ] as string[];

  return (
    <div
      className="absolute top-0 right-0 bottom-0 w-72 max-w-full z-10 flex flex-col rounded-r-2xl border-l overflow-hidden"
      style={{
        backgroundColor: "rgba(2,6,23,0.92)",
        borderColor: `${role.tone}44`,
        backdropFilter: "blur(6px)",
      }}
      data-testid="agent-sidebar"
    >
      <div className="flex items-start gap-3 p-3 border-b border-border/60">
        <RolePortrait role={role} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold leading-tight" style={{ color: role.tone }}>
            {role.name}
          </p>
          <p className="text-[11px] text-gray-500">{role.title}</p>
          <p className="text-[11px] font-mono mt-1 text-gray-300">
            {liveModels.length > 0 ? liveModels.join(", ") : role.model}
            <span className="text-gray-600"> · {assigned.length > 0 ? role.verb : "off duty"}</span>
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close agent details"
          className="text-gray-500 hover:text-gray-200 text-sm leading-none px-1"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        <SidebarSection title="Now" tone={role.tone}>
          {assigned.length === 0 ? (
            <p className="text-[11px] text-gray-600">Off duty — hanging out in the ops room.</p>
          ) : (
            <div className="space-y-2">
              {todos?.doing.map((t, i) => (
                <p key={`d${i}`} className="text-[11px] text-gray-300 leading-snug">
                  ▸ {t}
                </p>
              ))}
              {assigned.map((a) => (
                <button
                  key={a.id}
                  onClick={() => navigate(`/sessions/${a.session_id}`)}
                  className="block w-full text-left rounded-lg border border-border/60 px-2 py-1.5 hover:border-gray-500 transition-colors"
                >
                  <p className="text-[11px] text-gray-200 font-medium truncate">
                    {a.type === "subagent" ? a.subagent_type || a.name : a.name}
                    {a.status === "waiting" ? (
                      <span className="text-amber-400"> · waiting on you</span>
                    ) : null}
                  </p>
                  {a.task ? (
                    <p className="text-[11px] text-gray-400 leading-snug line-clamp-3">{a.task}</p>
                  ) : null}
                  {a.current_tool ? (
                    <p className="text-[10px] font-mono text-gray-500 mt-0.5">
                      using {a.current_tool}
                    </p>
                  ) : null}
                  <p className="text-[10px] text-gray-600 mt-0.5">open session →</p>
                </button>
              ))}
            </div>
          )}
        </SidebarSection>

        <SidebarSection title="Done" tone={role.tone}>
          {done.length === 0 ? (
            <p className="text-[11px] text-gray-600">Nothing logged yet.</p>
          ) : (
            <ul className="space-y-1">
              {done.slice(0, 8).map((t, i) => (
                <li key={i} className="text-[11px] text-gray-400 leading-snug">
                  <span className="text-emerald-500">✓</span> {t}
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>

        <SidebarSection title="Up next" tone={role.tone}>
          {!todos || todos.next.length === 0 ? (
            <p className="text-[11px] text-gray-600">Nothing queued.</p>
          ) : (
            <ul className="space-y-1">
              {todos.next.map((t, i) => (
                <li key={i} className="text-[11px] text-gray-400 leading-snug">
                  <span className="text-gray-600">○</span> {t}
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>
      </div>
    </div>
  );
}

// ── #ops-room chat ──────────────────────────────────────────────────────────

interface RoomMsg {
  key: string;
  role: RoleId | "user";
  text: string;
  at: string;
  count: number;
}

function roleForEvent(e: DashboardEvent, agentsById: Map<string, Agent>): RoleId {
  const a = e.agent_id ? agentsById.get(e.agent_id) : undefined;
  return (
    (a ? (roleForName(a.subagent_type || "") ?? roleForName(a.name || "")) : null) ??
    roleForTool(e.tool_name || "") ??
    (a && a.type !== "main" ? "scout" : "jarvis")
  );
}

/** Pull { subagent_type, description } out of a Task/Agent event payload. */
function delegationTarget(e: DashboardEvent): { who: string; desc: string } | null {
  if (!e.data) return null;
  try {
    const input = (JSON.parse(e.data) as { tool_input?: Record<string, unknown> }).tool_input;
    const subtype = typeof input?.subagent_type === "string" ? input.subagent_type : "";
    const desc = typeof input?.description === "string" ? input.description : "";
    const role = roleForName(subtype);
    const who = role ? ROLE_BY_ID.get(role)!.name : subtype;
    return who || desc ? { who: who || "the team", desc } : null;
  } catch {
    return null;
  }
}

/** Turn the raw event stream into team chatter. Oldest first, collapsed runs. */
function buildChat(events: DashboardEvent[], agentsById: Map<string, Agent>): RoomMsg[] {
  const out: RoomMsg[] = [];
  const push = (role: RoomMsg["role"], text: string, e: DashboardEvent) => {
    const last = out[out.length - 1];
    if (last && last.role === role && last.text === text) {
      last.count++;
      last.at = e.created_at;
      return;
    }
    out.push({ key: `${e.id}`, role, text, at: e.created_at, count: 1 });
  };

  for (const e of [...events].reverse()) {
    switch (e.event_type) {
      case "PostToolUse": {
        const headline = buildEventSummary(e)?.headline;
        push(roleForEvent(e, agentsById), headline || `${e.tool_name ?? "tool"} ✓`, e);
        break;
      }
      case "PreToolUse":
        // Delegations are the one Pre worth narrating: Jarvis handing work out,
        // called out to the teammate by name.
        if (/task|agent/i.test(e.tool_name || "")) {
          const d = delegationTarget(e);
          push(
            "jarvis",
            d
              ? `@${d.who} — ${d.desc || "take this one"} 📋`
              : buildEventSummary(e)?.headline || "delegating a task to the team",
            e
          );
        }
        break;
      case "UserPromptSubmit":
        push("user", e.summary || "sent new instructions", e);
        break;
      case "Notification":
        push("jarvis", `${e.summary || "waiting on your call"} 🙋`, e);
        break;
      case "Stop":
        push("jarvis", e.summary ? `${e.summary} ✅` : "turn wrapped ✅", e);
        break;
      case "SubagentStop":
        push(roleForEvent(e, agentsById), "done — handing back to Jarvis ✅", e);
        break;
      case "APIError":
        push("jarvis", "hit an API error, retrying 😵", e);
        break;
      case "Interrupted":
        push("user", "hold up — interrupted ✋", e);
        break;
      case "SessionStart":
        push("jarvis", "team's on shift 🟢", e);
        break;
      case "SessionEnd":
        push("jarvis", "clocking off 🌙", e);
        break;
      default:
        break;
    }
  }
  return out.slice(-50);
}

function Avatar({ role }: { role: RoomMsg["role"] }) {
  const def = role === "user" ? null : ROLE_BY_ID.get(role);
  const tone = def?.tone ?? "#e2e8f0";
  const letter = def ? def.name[0]! : "Y";
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold shrink-0"
      style={{ color: tone, backgroundColor: `${tone}22`, border: `1px solid ${tone}55` }}
    >
      {letter}
    </span>
  );
}

function OpsChat({ messages }: { messages: RoomMsg[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex flex-col min-h-0 h-full w-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="text-sm font-semibold text-gray-200">#ops-room</span>
        <span className="flex gap-1 ml-auto">
          {TEAM.map((r) => (
            <Avatar key={r.id} role={r.id} />
          ))}
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 ? (
          <p className="text-xs text-gray-600 py-4 text-center">Quiet in here right now.</p>
        ) : (
          messages.map((m) => {
            const def = m.role === "user" ? null : ROLE_BY_ID.get(m.role);
            return (
              <div key={m.key} className="flex items-start gap-2">
                <Avatar role={m.role} />
                <div className="min-w-0">
                  <span
                    className="text-[11px] font-semibold mr-2"
                    style={{ color: def?.tone ?? "#e2e8f0" }}
                  >
                    {def?.name ?? "You"}
                  </span>
                  <span className="text-[10px] text-gray-600">
                    {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <p className="text-[11px] text-gray-400 break-words leading-snug">
                    {m.text}
                    {m.count > 1 ? <span className="text-gray-600"> ×{m.count}</span> : null}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export function AgentRoom({
  agents,
  sessionsById,
  size = "panel",
  events,
}: {
  agents: Agent[];
  sessionsById?: Map<string, Session>;
  size?: "panel" | "wall";
  events?: DashboardEvent[];
}) {
  const wall = size === "wall";
  // Business mode (Phase BM): re-skin the crew before anything reads TEAM
  // this render. Mutates module state, but idempotently - the canvas loop
  // picks it up next frame, the JSX below this line reads it immediately.
  applyRoomSkin(useWorkMode());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const [selected, setSelected] = useState<RoleId | null>(null);
  const selectedRef = useRef<RoleId | null>(null);
  selectedRef.current = selected;

  const work = useMemo(() => assignWork(agents), [agents]);
  const workRef = useRef(work);
  workRef.current = work;

  // Ultron mode lives outside React (see hudMode); the rAF loop below reads
  // this ref each tick so a mode flip swaps Jarvis's sprite without tearing
  // down or restarting the canvas/animation effect.
  const ultronRef = useRef(hudMode.getMode() === "ultron");
  useEffect(() => {
    ultronRef.current = hudMode.getMode() === "ultron";
    return hudMode.subscribe((change) => {
      ultronRef.current = change.mode === "ultron";
    });
  }, []);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const messages = useMemo(
    () => (events ? buildChat(events, agentsById) : []),
    [events, agentsById]
  );

  // Character positions live outside React: mutated by the rAF loop only.
  const charsRef = useRef<Map<RoleId, CharState>>(
    new Map(
      TEAM.map((r, i) => {
        const seat = seatFor(r);
        const spots = idleSpotsFor(r.id);
        const spot = spots[i % spots.length]!;
        return [
          r.id,
          { x: seat.x, y: seat.y, tx: spot.x, ty: spot.y, act: spot.act, idleUntil: 0 },
        ];
      })
    )
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom / very old browsers: chips + chat still render

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w <= 0) return;
      // Wall mode has a fixed-height slot (no page scroll) - fit-contain on
      // both axes so the room never grows taller than what's left on screen.
      // The panel variant only ever constrains width, so it scales by width
      // alone and lets the page scroll to the natural (width-derived) height.
      const scale = wall && h > 0 ? Math.min(w / ART_W, h / ART_H) : w / ART_W;
      scaleRef.current = scale;
      canvas.width = Math.round(ART_W * scale * dpr);
      canvas.height = Math.round(ART_H * scale * dpr);
      canvas.style.width = `${Math.round(ART_W * scale)}px`;
      canvas.style.height = `${Math.round(ART_H * scale)}px`;
    };
    resize();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            resize();
            if (reducedMotion) frame(performance.now(), true);
          })
        : null;
    ro?.observe(wrap);

    let raf = 0;
    let last = performance.now();

    const frame = (now: number, once = false) => {
      const dt = Math.min(64, now - last);
      last = now;
      const chars = charsRef.current;
      const w = workRef.current;

      for (const role of TEAM) {
        const ch = chars.get(role.id)!;
        const active = (w.get(role.id)?.agents.length ?? 0) > 0;
        if (active) {
          const seat = seatFor(role);
          ch.tx = seat.x;
          ch.ty = seat.y;
        } else if (Math.abs(ch.x - ch.tx) + Math.abs(ch.y - ch.ty) <= 1 && now > ch.idleUntil) {
          // Wander: pick another hangout activity and linger there a while.
          const spots = idleSpotsFor(role.id);
          const spot = spots[Math.floor(Math.random() * spots.length)]!;
          ch.tx = spot.x + Math.floor(Math.random() * 10) - 5;
          ch.ty = spot.y;
          ch.act = spot.act;
          ch.idleUntil = now + 5000 + Math.random() * 9000;
        }
        // L-shaped move: x first, then y. ponytail: no BFS, layout keeps lanes clear.
        stepToward(ch, (dt / 1000) * 34);
      }

      ctx.setTransform(dpr * scaleRef.current, 0, 0, dpr * scaleRef.current, 0, 0);
      ctx.imageSmoothingEnabled = false;
      drawScene(ctx, now, chars, w, reducedMotion, selectedRef.current, ultronRef.current);
      if (!reducedMotion && !once) raf = requestAnimationFrame((t) => frame(t));
    };

    if (reducedMotion) {
      // Static portrait: everyone drawn where they belong, no animation loop.
      for (const role of TEAM) {
        const ch = charsRef.current.get(role.id)!;
        const active = (workRef.current.get(role.id)?.agents.length ?? 0) > 0;
        const pos = active ? seatFor(role) : { x: ch.tx, y: ch.ty };
        ch.x = pos.x;
        ch.y = pos.y;
      }
      frame(performance.now(), true);
    } else {
      raf = requestAnimationFrame((t) => frame(t));
    }

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
    // work/selected change flow in via refs; re-run only for reduced-motion redraws.
  }, [work, selected]);

  const toggleRole = useCallback(
    (role: RoleId) => {
      if (wall) return; // Wall is read-only by contract - no interaction there.
      setSelected((prev) => (prev === role ? null : role));
    },
    [wall]
  );

  const onCanvasClick = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / scaleRef.current;
      const y = (ev.clientY - rect.top) / scaleRef.current;
      for (const role of TEAM) {
        const d = role.desk;
        if (x >= d.x - 6 && x <= d.x + d.w + 6 && y >= d.y - 30 && y <= d.y + 18) {
          toggleRole(role.id);
          return;
        }
      }
    },
    [toggleRole]
  );

  const chipTitle = (role: RoleDef): string => {
    const assigned = work.get(role.id)?.agents ?? [];
    if (assigned.length === 0) return `${role.name} · ${role.title} · ${role.model} · off duty`;
    const names = assigned
      .map((a) => {
        const sname = sessionsById?.get(a.session_id)?.name?.trim() || "";
        const isAuto = /^Session [0-9a-f]{8}$/i.test(sname);
        if (a.type === "subagent") return a.subagent_type || a.name;
        return sname && !isAuto ? sname : a.name;
      })
      .join(", ");
    return `${role.name} · ${role.title} · ${role.model} · ${names}`;
  };

  const selectedRole = selected ? ROLE_BY_ID.get(selected) : undefined;

  const room = (
    <div className={`flex flex-col min-w-0 ${wall ? "flex-1 min-h-0" : "flex-1"}`}>
      <div
        ref={wrapRef}
        className={`relative min-w-0 ${wall ? "flex-1 min-h-0 flex items-center justify-center" : ""}`}
      >
        {/* The bordered/grid-pattern "floor" box lives on the canvas itself
            (not the measuring wrapper above) so it hugs the pixel art at its
            actual rendered size instead of stretching across any letterboxed
            space left over when the wrapper's aspect ratio doesn't match the
            room's (e.g. a wide wall display fit-contained to a fixed height). */}
        <canvas
          ref={canvasRef}
          onClick={wall ? undefined : onCanvasClick}
          className="room-floor rounded-2xl overflow-hidden"
          style={{
            display: "block",
            imageRendering: "pixelated",
            cursor: wall ? "default" : "pointer",
          }}
          role="img"
          aria-label="Pixel-art ops room showing the agent team at work"
        />
        {selectedRole && !wall ? (
          <AgentSidebar
            role={selectedRole}
            work={work}
            events={events}
            sessionsById={sessionsById}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
      <div
        className={`flex flex-wrap justify-center gap-2 ${wall ? "mt-4 flex-shrink-0" : "mt-3"}`}
      >
        {TEAM.map((role) => {
          const w = work.get(role.id);
          const n = w?.agents.length ?? 0;
          const status = w?.waiting ? "waiting on you" : n > 0 ? role.verb : "off duty";
          const tone = n > 0 ? role.tone : "#64748b";
          return (
            <button
              key={role.id}
              onClick={() => toggleRole(role.id)}
              title={chipTitle(role)}
              className={`${wall ? "text-sm" : "text-[10px]"} font-mono px-2 py-0.5 rounded-full border transition-transform hover:scale-105`}
              style={{
                color: tone,
                borderColor: selected === role.id ? tone : `${tone}44`,
                backgroundColor: `${tone}12`,
                cursor: wall ? "default" : "pointer",
              }}
            >
              {role.name} · {role.model} · {status}
              {n > 1 ? ` ×${n}` : ""}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (wall || !events) {
    return <div className={`h-full min-h-0 ${wall ? "p-2 flex flex-col" : ""}`}>{room}</div>;
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full min-h-0">
      {room}
      <div className="lg:w-72 shrink-0 lg:border-l border-t lg:border-t-0 border-border/60 min-h-[10rem] lg:min-h-0">
        <OpsChat messages={messages} />
      </div>
    </div>
  );
}
