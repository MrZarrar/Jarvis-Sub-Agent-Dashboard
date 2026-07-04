/**
 * @file github.test.js
 * @description Unit + integration tests for the GitHub dev-workflow panel
 * (Phase I): config read/redact/update (repo parsing, PAT redaction, pollMinutes
 * clamp), the client's CI-rollup collapse and overview shaping via an injected
 * `gh` runner (no real gh/network), the service cache round-trip + fingerprint +
 * broadcast-on-change, and route CRUD. Node's built-in test runner + a temp DB,
 * mirroring projects.test.js / skills.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "github-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.GITHUB_CONFIG_PATH = path.join(TMP, "github.json");
// Keep env fallbacks from leaking real values into these tests.
delete process.env.GITHUB_PAT;
delete process.env.GITHUB_REPOS;

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const config = require("../lib/github/config");
const client = require("../lib/github/client");
const service = require("../lib/github/service");

let server;
let BASE;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(b || "{}");
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("github config", () => {
  it("defaults to empty/unconfigured with the PAT redacted", () => {
    try {
      fs.unlinkSync(config.configPath());
    } catch {
      /* fresh */
    }
    const red = config.redactedConfig();
    assert.equal(red.hasPat, false);
    assert.deepEqual(red.repos, []);
    assert.equal(red.pollMinutes, 5);
    assert.equal(red.enabled, true);
  });

  it("parses a mixed repo list and drops malformed entries", () => {
    // "bad" (no slash) and "nope/x/y" (two slashes) are both dropped.
    assert.deepEqual(config.parseRepoList("a/b, c/d\ne/f  bad nope/x/y"), ["a/b", "c/d", "e/f"]);
    assert.deepEqual(config.parseRepoList(["ok/one", "  ok/two ", "junk", 5]), [
      "ok/one",
      "ok/two",
    ]);
  });

  it("accepts a pasted github.com URL in any common shape (regression: was silently dropped)", () => {
    assert.deepEqual(
      config.parseRepoList("https://github.com/MrZarrar/Jarvis-Sub-Agent-Dashboard"),
      ["MrZarrar/Jarvis-Sub-Agent-Dashboard"]
    );
    assert.deepEqual(config.parseRepoList("http://github.com/owner/repo"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList("github.com/owner/repo"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList("www.github.com/owner/repo"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList("https://github.com/owner/repo.git"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList("https://github.com/owner/repo/"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList("https://github.com/owner/repo/pulls"), ["owner/repo"]);
    assert.deepEqual(config.parseRepoList(["https://github.com/owner/repo"]), ["owner/repo"]);
  });

  it("deduplicates while preserving first-seen order", () => {
    assert.deepEqual(config.parseRepoList("a/b\na/b\nhttps://github.com/a/b"), ["a/b"]);
  });

  it("persists a patch, redacts the PAT, and clamps pollMinutes", () => {
    config.updateConfig({
      repos: ["owner/name", "org/repo2"],
      pat: "ghp_secret",
      pollMinutes: 9999,
    });
    const red = config.redactedConfig();
    assert.equal(red.hasPat, true);
    assert.deepEqual(red.repos, ["owner/name", "org/repo2"]);
    assert.equal(red.pollMinutes, config.MAX_POLL_MINUTES);
    // The raw PAT is on disk (server-side) but never in the redacted view.
    assert.equal(config.getConfig().pat, "ghp_secret");
    assert.equal(JSON.stringify(red).includes("ghp_secret"), false);
  });

  it("clearing the PAT actually clears it", () => {
    config.updateConfig({ pat: "" });
    assert.equal(config.getConfig().pat, "");
    assert.equal(config.redactedConfig().hasPat, false);
  });
});

describe("github client shaping", () => {
  it("collapses statusCheckRollup worst-wins", () => {
    assert.equal(client.ciFromRollup([]), "none");
    assert.equal(client.ciFromRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "success");
    assert.equal(
      client.ciFromRollup([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
      "failure"
    );
    assert.equal(client.ciFromRollup([{ status: "IN_PROGRESS" }]), "pending");
    assert.equal(client.ciFromRollup([{ state: "FAILURE" }]), "failure");
    assert.equal(client.ciFromRollup([{ state: "SUCCESS" }]), "success");
  });

  it("returns an empty overview for mode 'none'", async () => {
    const ov = await client.fetchOverview({
      config: { enabled: true, repos: ["a/b"], pat: "" },
      mode: "none",
    });
    assert.equal(ov.configured, false);
    assert.equal(ov.mode, "none");
    assert.equal(ov.counts.reviewRequested, 0);
  });

  it("shapes a gh overview from an injected runner", async () => {
    const fakeGh = (args) => {
      const a = args.join(" ");
      if (a.includes("api user")) return "octocat";
      if (a.includes("pr list") && a.includes("review-requested:@me")) {
        return [
          {
            number: 1,
            title: "Fix bug",
            url: "https://gh/1",
            author: { login: "bob" },
            updatedAt: "2026-07-01T00:00:00Z",
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
          },
        ];
      }
      if (a.includes("pr list") && a.includes("author:@me")) {
        return [
          {
            number: 2,
            title: "My PR",
            url: "https://gh/2",
            author: { login: "octocat" },
            updatedAt: "2026-07-02T00:00:00Z",
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          },
        ];
      }
      if (a.includes("issue list")) {
        return [
          {
            number: 3,
            title: "Bug report",
            url: "https://gh/3",
            author: { login: "carol" },
            updatedAt: "2026-07-03T00:00:00Z",
          },
        ];
      }
      return [];
    };

    const ov = await client.fetchOverview({
      config: { enabled: true, repos: ["owner/name"], pat: "" },
      mode: "gh",
      gh: fakeGh,
    });

    assert.equal(ov.configured, true);
    assert.equal(ov.mode, "gh");
    assert.equal(ov.me, "octocat");
    assert.equal(ov.counts.reviewRequested, 1);
    assert.equal(ov.counts.mine, 1);
    assert.equal(ov.counts.openIssues, 1);
    assert.equal(ov.counts.failingChecks, 1); // the review PR is red
    assert.equal(ov.reviewRequested[0].ci, "failure");
    assert.equal(ov.mine[0].ci, "success");
    assert.equal(ov.reviewRequested[0].repo, "owner/name");
  });

  it("shapes the latest commit as a plain (non-merge) push", () => {
    const shaped = client.shapeLatestCommit("owner/name", "develop", {
      html_url: "https://gh/commit/def456",
      parents: [{ sha: "p1" }],
      commit: {
        message: "Fix typo in README",
        author: { name: "bob", date: "2026-07-04T09:00:00Z" },
      },
    });
    assert.equal(shaped.repo, "owner/name");
    assert.equal(shaped.branch, "develop");
    assert.equal(shaped.message, "Fix typo in README");
    assert.equal(shaped.isMerge, false);
    assert.equal(shaped.mergedPr, null);
    assert.equal(shaped.author, "bob");
    assert.equal(shaped.url, "https://gh/commit/def456");
  });

  it("detects a merge commit and extracts the merged PR number/branch/title", () => {
    const shaped = client.shapeLatestCommit("owner/name", "main", {
      html_url: "https://gh/commit/abc123",
      parents: [{ sha: "p1" }, { sha: "p2" }],
      commit: {
        message: "Merge pull request #7 from owner/feature-x\n\nAdd feature X",
        author: { name: "carol", date: "2026-07-04T10:00:00Z" },
      },
    });
    assert.equal(shaped.isMerge, true);
    assert.deepEqual(shaped.mergedPr, {
      number: 7,
      fromRef: "owner/feature-x",
      title: "Add feature X",
    });
    assert.equal(shaped.message, "Merge pull request #7 from owner/feature-x");
  });

  it("returns null for a malformed commit response instead of throwing", () => {
    assert.equal(client.shapeLatestCommit("owner/name", "main", null), null);
    assert.equal(client.shapeLatestCommit("owner/name", "main", {}), null);
  });

  it("fetches one latest-commit entry per repo via the injected gh runner, sorted newest-first", async () => {
    const fakeGh = (args) => {
      const a = args.join(" ");
      if (a.includes("api user")) return "octocat";
      if (a.includes("/commits/")) {
        if (a.includes("repos/owner/one/")) {
          return {
            html_url: "https://gh/commit/1",
            parents: [{ sha: "p1" }],
            commit: {
              message: "Older commit",
              author: { name: "bob", date: "2026-07-01T00:00:00Z" },
            },
          };
        }
        return {
          html_url: "https://gh/commit/2",
          parents: [{ sha: "p1" }, { sha: "p2" }],
          commit: {
            message: "Merge pull request #9 from owner/hotfix\n\nHotfix",
            author: { name: "carol", date: "2026-07-04T00:00:00Z" },
          },
        };
      }
      if (a.startsWith("api repos/")) return { default_branch: "main" };
      return [];
    };

    const ov = await client.fetchOverview({
      config: { enabled: true, repos: ["owner/one", "owner/two"], pat: "" },
      mode: "gh",
      gh: fakeGh,
    });

    assert.equal(ov.latest.length, 2);
    // Newest first: owner/two's merge (2026-07-04) before owner/one's commit (2026-07-01).
    assert.equal(ov.latest[0].repo, "owner/two");
    assert.equal(ov.latest[0].isMerge, true);
    assert.equal(ov.latest[1].repo, "owner/one");
    assert.equal(ov.latest[1].isMerge, false);
  });

  it("skips a repo's latest commit on error without failing the whole overview", async () => {
    const fakeGh = (args) => {
      const a = args.join(" ");
      if (a.includes("api user")) return "octocat";
      if (a.startsWith("api repos/")) throw new Error("gh: repo not found");
      return [];
    };
    const ov = await client.fetchOverview({
      config: { enabled: true, repos: ["owner/gone"], pat: "" },
      mode: "gh",
      gh: fakeGh,
    });
    assert.equal(ov.configured, true);
    assert.deepEqual(ov.latest, []);
  });
});

describe("github service cache + fingerprint", () => {
  it("round-trips a snapshot through SQLite", () => {
    const snap = client.emptyOverview({
      configured: true,
      mode: "gh",
      counts: { reviewRequested: 2, mine: 0, failingChecks: 1, openIssues: 3 },
    });
    stmts.upsertGithubCache.run({
      data: JSON.stringify(snap),
      fingerprint: service.fingerprint(snap),
      fetched_at: new Date().toISOString(),
      error: null,
    });
    const cached = service.getCached();
    assert.equal(cached.overview.counts.reviewRequested, 2);
    assert.equal(cached.overview.mode, "gh");
  });

  it("broadcasts github_updated only on a fingerprint change", async () => {
    // Seed a distinctive snapshot so the next (empty, no-network) poll differs.
    const seeded = client.emptyOverview({
      configured: true,
      mode: "gh",
      counts: { reviewRequested: 5, mine: 5, failingChecks: 5, openIssues: 5 },
    });
    stmts.upsertGithubCache.run({
      data: JSON.stringify(seeded),
      fingerprint: service.fingerprint(seeded),
      fetched_at: new Date().toISOString(),
      error: null,
    });
    // repos empty → fetchOverview returns an empty overview without touching gh.
    config.updateConfig({ repos: [], pat: "" });

    const events = [];
    const broadcast = (type, data) => events.push({ type, data });
    await service.pollOnce({ db, broadcast });
    assert.equal(events.filter((e) => e.type === "github_updated").length, 1);

    // Second poll: nothing changed → no broadcast.
    events.length = 0;
    await service.pollOnce({ db, broadcast });
    assert.equal(events.filter((e) => e.type === "github_updated").length, 0);
  });
});

describe("github routes", () => {
  it("GET /api/github returns the cached overview + mode", async () => {
    const res = await req("GET", "/api/github");
    assert.equal(res.status, 200);
    assert.ok(res.body.overview);
    assert.ok(["gh", "pat", "none"].includes(res.body.mode));
    assert.equal(typeof res.body.configured, "boolean");
  });

  it("GET/PUT /api/github/config updates repos and redacts the PAT", async () => {
    const put = await req("PUT", "/api/github/config", { repos: ["owner/name"], pat: "ghp_route" });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.hasPat, true);
    assert.deepEqual(put.body.config.repos, ["owner/name"]);
    assert.equal(JSON.stringify(put.body).includes("ghp_route"), false);

    const get = await req("GET", "/api/github/config");
    assert.equal(get.body.config.hasPat, true);
    // cleanup so a real PAT env/file doesn't linger
    await req("PUT", "/api/github/config", { pat: "", repos: [] });
  });

  it("POST /api/github/refresh returns an overview without throwing", async () => {
    const res = await req("POST", "/api/github/refresh");
    assert.equal(res.status, 200);
    assert.ok(res.body.overview);
    assert.equal(res.body.overview.configured, false); // repos cleared above
  });
});
