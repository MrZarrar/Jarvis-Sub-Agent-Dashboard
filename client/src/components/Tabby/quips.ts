/**
 * @file quips.ts
 * @description Tabby's personality: pools of short phrases keyed by pulse/mood,
 *   plus a deterministic-by-injection picker. Pure data + a pure function so it
 *   can be unit-tested without randomness leaking in.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import type { Mood, TabbyPulse } from "./brain";

export type QuipKey = NonNullable<TabbyPulse> | Mood;

const QUIPS: Record<QuipKey, string[]> = {
  // Pulses (event-driven, transient bubbles)
  session_done: [
    "a session just wrapped up ✅",
    "a session finished - nice work! ✨",
    "that session's all done ✅",
    "clean finish on that one 💜",
  ],
  session_start: [
    "a new session started! 👀",
    "a fresh session just landed ◉",
    "new session on the scope ✨",
    "something new is cooking 🍲",
  ],
  subagent_spawn: [
    "a subagent just came online ◉",
    "a little helper joined in 🤝",
    "a subagent's on the job 🚀",
    "reinforcements — new subagent online",
  ],
  waiting: [
    "a session needs your input 👀",
    "a session is waiting on you ⏳",
    "a session paused for your reply 💬",
    "your turn — a session's waiting ◉",
  ],
  error: [
    "uh oh, a session hit an error 😿",
    "something broke - wanna peek? 🙀",
    "a hook tripped on something ⚠️",
    "hiss… an error popped up 💢",
  ],
  run_done: [
    "your run just finished ✅",
    "the run's all wrapped up ✨",
    "run complete — that's a wrap ✅",
    "all done with that run 💜",
  ],
  // Moods (steady-state flavor, used by the panel / idle bubbles)
  disconnected: [
    "lost the connection… 😴",
    "can't reach the server 📡",
    "no signal - taking a nap 💤",
  ],
  worried: ["that didn't look right 😟", "keeping an eye out 👀", "hmm, something's off 🫣"],
  stuck: [
    "a session's been quiet a while… 🤔",
    "is something stuck? ⏳",
    "still chewing on it… 😾",
  ],
  happy: ["great run! ✨", "love a tidy finish ✨", "flawless execution 💠"],
  thinking: ["hmm, let me look… 🤔", "scanning the telemetry… 📡", "one sec, checking 🔍"],
  watching: ["scopes up 👀", "watching your sessions ◉", "sensors peeled ✨"],
  sleeping: ["zzz… 💤", "wake me if something happens 😴", "curled up, all calm 🐈"],
  idle: ["all systems quiet ◉", "ready when you are, sir", "just vibing ✨"],
};

/**
 * Pick a quip for a key. `rand` is injectable for deterministic tests; defaults
 * to Math.random. Returns "" only for an unknown key (never throws).
 */
export function pickQuip(key: QuipKey, rand: () => number = Math.random): string {
  const pool = QUIPS[key];
  if (!pool || pool.length === 0) return "";
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i] ?? "";
}

export const ALL_QUIP_KEYS = Object.keys(QUIPS) as QuipKey[];
