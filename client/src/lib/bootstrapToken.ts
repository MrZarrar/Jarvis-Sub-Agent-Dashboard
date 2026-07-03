/**
 * @file bootstrapToken.ts
 * @description One-time capture of a `?token=` query param into the
 * `dashboard_token` localStorage key that `api.ts`'s `dashboardToken()` and
 * `useWebSocket.ts` already read. Lets a device be authorized by opening a
 * single link (e.g. `https://<tailscale-host>:4820/?token=...`) instead of
 * requiring the operator to set localStorage via devtools.
 */

export function bootstrapToken(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    localStorage.setItem("dashboard_token", token);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch {
    // localStorage/URL access can fail in locked-down embeds; token capture
    // is best-effort and shouldn't block app boot.
  }
}
