/**
 * @file legacy.ts
 * @description Phase AF: gate for the parked Phase-Z surfaces (/browse,
 * /computer-use). Injected at build time from the LEGACY_SURFACES env var
 * (see vite.config.ts `define`); guarded so contexts without the define
 * (e.g. tooling that bypasses the vite config) resolve to "retired".
 */

declare const __LEGACY_SURFACES__: boolean;

export const LEGACY_SURFACES: boolean =
  typeof __LEGACY_SURFACES__ !== "undefined" && __LEGACY_SURFACES__;
