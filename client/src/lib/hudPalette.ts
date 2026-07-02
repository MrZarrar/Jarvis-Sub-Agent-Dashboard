/**
 * @file hudPalette.ts
 * @description Jarvis HUD chart palette — single source of truth for series
 *   colors in data visualizations. Categorical hues are assigned in fixed
 *   order (index = entity identity) and were validated as a set against the
 *   dark surface for lightness band, chroma, CVD adjacent-pair separation,
 *   and contrast. Status colors (success/warn/error) are reserved and live
 *   with each component — never reuse them as series colors.
 */

/** Fixed-order categorical palette. Index by entity, never by rank. */
export const CHART_PALETTE = [
  "#0d9dc2", // cyan
  "#b3871d", // gold
  "#6b80e8", // periwinkle
  "#28a058", // green
  "#c05a86", // rose
  "#8a63d2", // violet
  "#bd6428", // orange
  "#2aa198", // teal
] as const;

/** Brighter companions for strokes/hover rings, same fixed order. */
export const CHART_PALETTE_BRIGHT = [
  "#3fd9ff",
  "#f0c040",
  "#93a5f5",
  "#4ade80",
  "#e585ad",
  "#b592ee",
  "#e8935a",
  "#4fd0c5",
] as const;

export function chartColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length] as string;
}

export function chartColorBright(index: number): string {
  return CHART_PALETTE_BRIGHT[index % CHART_PALETTE_BRIGHT.length] as string;
}
