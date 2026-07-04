#!/usr/bin/env node

/**
 * Claude Code hook handler.
 * Receives hook event JSON on stdin and forwards it to every live Agent
 * Dashboard server. Designed to fail silently so it never blocks Claude
 * Code, and to fan out across multiple dashboards (e.g. the macOS desktop
 * app running alongside `npm run dev`) so each one keeps its real-time
 * stream.
 *
 * Delivery is fire-and-forget: we exit as soon as the request body is on the
 * wire, WITHOUT waiting for the dashboard's HTTP response. The hook only needs
 * to *deliver* the event - on loopback the local server reads the buffered
 * request and processes it even after this short-lived process exits. Waiting
 * for the response is what made Claude Code sit at "running hooks" for seconds
 * whenever a dashboard was busy, slow, or wedged.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const http = require("http");

// The dashboard's own usage-poller (server/lib/usage-poller.js) spawns a
// throwaway `claude -p` purely to read the real rate-limit header - it is
// not a real user session and must stay completely invisible: no entry in
// Sessions/Activity, no event rows. Skip forwarding entirely rather than
// filtering server-side, so it never touches the DB at all.
if (process.env.JARVIS_USAGE_PROBE === "1") {
  process.exit(0);
}

const hookType = process.argv[2] || "unknown";

/**
 * Resolve every live dashboard server's port via the discovery file. Falls
 * back to the `CLAUDE_DASHBOARD_PORT` override or the conventional 4820 if
 * the discovery module can't load for any reason. Never throws.
 */
function resolvePorts() {
  try {
    return require("../server/lib/server-info").resolveAllDashboardPorts();
  } catch {
    const envPort = parseInt(process.env.CLAUDE_DASHBOARD_PORT || "", 10);
    return [Number.isInteger(envPort) && envPort > 0 ? envPort : 4820];
  }
}

const ports = resolvePorts();

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let parsedData;
  try {
    parsedData = JSON.parse(input);
  } catch {
    parsedData = { raw: input };
  }

  const payload = JSON.stringify({
    hook_type: hookType,
    data: parsedData,
  });
  const contentLength = Buffer.byteLength(payload);

  // Fan out one POST per live server. Each per-target promise resolves the
  // moment the request body has been flushed - NOT when the dashboard replies
  // - so a busy, slow, or wedged dashboard can't stall the hook. Each promise
  // always resolves (never rejects), so one dead listener can't starve the
  // others and Promise.all can't be left hanging by a single failure.
  const sends = ports.map(
    (port) =>
      new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/hooks/event",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": contentLength,
            },
            timeout: 2000,
          },
          // Drain any response so the socket closes cleanly if the server does
          // reply before we exit. We never block on it.
          (res) => res.resume()
        );

        req.on("error", done); // dead listener (ECONNREFUSED) - nothing to deliver
        req.on("timeout", () => {
          req.destroy();
          done();
        });
        req.write(payload);
        // The 'end' callback fires once the body is on the wire: delivery is
        // done and the local server will process it on its own schedule.
        req.end(done);
      })
  );

  // Give the kernel one tick to hand the buffered request bytes to the local
  // server before our sockets close, then exit. The hook returns in ms.
  Promise.all(sends).finally(() => setImmediate(() => process.exit(0)));
});

// Safety net - guarantees the hook never blocks Claude Code even if a send
// somehow never settles. Shorter than the old 5s wait because we no longer
// block on the dashboard's response, only on the request flush.
setTimeout(() => process.exit(0), 2500);
