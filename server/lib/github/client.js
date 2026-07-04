/**
 * @file github/client.js
 * @description GitHub data access for the dev-workflow panel (Phase I). Two
 * backends, selected automatically:
 *   - "gh"  - shell out to the locally-authenticated `gh` CLI (no secret stored;
 *             the recommended path). Provides CI/check status via
 *             `statusCheckRollup`.
 *   - "pat" - call the REST API with a configured Personal Access Token. Used
 *             when a PAT is set (portable to hosts without `gh`). PRs/issues are
 *             listed via the search API; per-PR CI rollup is NOT fetched in this
 *             mode (that would fan out one request per PR), so `ci` is reported
 *             as "unknown" - documented, and why `gh` is the recommended path.
 *   - "none" - neither available → an empty, `configured:false` overview.
 *
 * `fetchOverview` never throws: any backend error resolves to an overview with
 * an `error` string so the poller/route can surface it without crashing. The
 * network/spawn seams (`gh`, `rest`) are injectable so the shaping logic can be
 * unit-tested without a real GitHub or `gh` on the box.
 *
 * @author Jarvis (Phase I)
 */

const { spawnSync } = require("node:child_process");
const { getConfig } = require("./config");

const GH_TIMEOUT_MS = 15_000;
const PER_REPO_LIMIT = 30;
const MAX_ITEMS = 40; // cap each list so a huge org can't bloat the snapshot

let ghAvailableCache; // undefined = not probed yet

/** Whether the `gh` CLI is on PATH (probed once, cached). */
function ghAvailable() {
  if (ghAvailableCache !== undefined) return ghAvailableCache;
  try {
    const r = spawnSync("gh", ["--version"], { timeout: 5000, encoding: "utf8" });
    ghAvailableCache = r.status === 0;
  } catch {
    ghAvailableCache = false;
  }
  return ghAvailableCache;
}

/** Reset the cached gh-availability probe (tests). */
function _resetGhProbe() {
  ghAvailableCache = undefined;
}

/** Pick the backend for a resolved config. PAT wins (portable); else gh. */
function authMode(cfg = getConfig()) {
  if (cfg.pat) return "pat";
  if (ghAvailable()) return "gh";
  return "none";
}

/** Run a `gh` subcommand and JSON-parse its stdout. Throws on failure. */
function runGh(args) {
  const r = spawnSync("gh", args, {
    timeout: GH_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw new Error(`gh: ${r.error.message}`);
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || `gh exited ${r.status}`;
    throw new Error(msg.split("\n")[0]);
  }
  const out = (r.stdout || "").trim();
  if (!out) return [];
  return JSON.parse(out);
}

/** GET the GitHub REST API with a PAT. Throws on non-2xx. */
async function runRest(path, pat) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-dashboard",
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) detail = body.message;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * Collapse a `gh` statusCheckRollup array into one CI state.
 * Rollup entries are either CheckRun ({status, conclusion}) or StatusContext
 * ({state}). Worst-wins: failure > pending > success > none.
 */
function ciFromRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let sawPending = false;
  let sawSuccess = false;
  for (const c of rollup) {
    // CheckRun
    if (c.status || c.conclusion) {
      const status = (c.status || "").toUpperCase();
      const conclusion = (c.conclusion || "").toUpperCase();
      if (status && status !== "COMPLETED") {
        sawPending = true;
        continue;
      }
      if (
        ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
          conclusion
        )
      )
        return "failure";
      if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) sawSuccess = true;
      continue;
    }
    // StatusContext (legacy commit status)
    const state = (c.state || "").toUpperCase();
    if (state === "FAILURE" || state === "ERROR") return "failure";
    if (state === "PENDING") sawPending = true;
    if (state === "SUCCESS") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  return "none";
}

function repoParts(repo) {
  const [owner, name] = String(repo).split("/");
  return { owner, name };
}

/** Shape a raw `gh pr list --json` row into our compact PR item. */
function shapeGhPr(repo, row) {
  return {
    repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author && row.author.login ? row.author.login : null,
    updatedAt: row.updatedAt || null,
    isDraft: Boolean(row.isDraft),
    reviewDecision: row.reviewDecision || null,
    ci: ciFromRollup(row.statusCheckRollup),
  };
}

/**
 * Shape the latest commit on a repo's default branch into a compact "what
 * changed last" summary: branch + human message (never the raw SHA - a link
 * to view the commit is included instead). Detects a GitHub merge commit
 * ("Merge pull request #N from owner/branch") and, when the PR title is on
 * the following body line (GitHub's default format), surfaces it separately
 * so the UI can render "Merged PR #N: <title>" instead of the raw boilerplate.
 * Returns null for a malformed/empty commit response rather than throwing.
 */
function shapeLatestCommit(repo, branch, commit) {
  if (!commit || !commit.commit) return null;
  const rawMessage = typeof commit.commit.message === "string" ? commit.commit.message : "";
  const lines = rawMessage.split("\n").map((l) => l.trim());
  const subject = lines[0] || "(no commit message)";
  const parentCount = Array.isArray(commit.parents) ? commit.parents.length : 1;
  const isMerge = parentCount > 1 || /^merge\s/i.test(subject);

  let mergedPr = null;
  if (isMerge) {
    const m = subject.match(/^Merge pull request #(\d+) from (\S+)/i);
    if (m) {
      const title = lines.slice(1).find((l) => l.length > 0) || null;
      mergedPr = { number: Number(m[1]), fromRef: m[2], title };
    }
  }

  const author = commit.commit.author || null;
  return {
    repo,
    branch,
    message: subject,
    isMerge,
    mergedPr,
    author: author && author.name ? author.name : null,
    date: author && author.date ? author.date : null,
    url: commit.html_url || null,
  };
}

function shapeGhIssue(repo, row) {
  return {
    repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author && row.author.login ? row.author.login : null,
    updatedAt: row.updatedAt || null,
  };
}

const emptyOverview = (extra = {}) => ({
  configured: false,
  mode: "none",
  me: null,
  repos: [],
  reviewRequested: [],
  mine: [],
  issues: [],
  latest: [],
  counts: { reviewRequested: 0, mine: 0, failingChecks: 0, openIssues: 0 },
  error: null,
  ...extra,
});

/**
 * Build the full overview across the configured repos. Injection points:
 *   opts.config - resolved config (defaults to getConfig()).
 *   opts.mode   - force a backend (defaults to authMode()).
 *   opts.gh     - (args:string[]) => any   replaces runGh (tests).
 *   opts.rest   - (path:string) => Promise<any> replaces a PAT-bound runRest.
 * Never throws.
 */
async function fetchOverview(opts = {}) {
  const cfg = opts.config || getConfig();
  const mode = opts.mode || authMode(cfg);
  const repos = Array.isArray(cfg.repos) ? cfg.repos.filter(Boolean) : [];

  if (mode === "none") return emptyOverview({ configured: false, mode: "none" });
  if (repos.length === 0) return emptyOverview({ configured: false, mode });

  const gh = opts.gh || runGh;
  const rest = opts.rest || ((p) => runRest(p, cfg.pat));

  try {
    if (mode === "gh") return await fetchViaGh(repos, gh);
    return await fetchViaRest(repos, rest);
  } catch (err) {
    return emptyOverview({ configured: true, mode, repos, error: err.message || String(err) });
  }
}

async function fetchViaGh(repos, gh) {
  let me = null;
  try {
    const user = gh(["api", "user", "--jq", ".login"]);
    me = typeof user === "string" ? user : user && user.login ? user.login : null;
  } catch {
    me = null;
  }

  const reviewRequested = [];
  const mine = [];
  const issues = [];

  for (const repo of repos) {
    const reviews = gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      "review-requested:@me",
      "--json",
      "number,title,url,author,updatedAt,isDraft,reviewDecision,statusCheckRollup",
      "--limit",
      String(PER_REPO_LIMIT),
    ]);
    for (const row of reviews || []) reviewRequested.push(shapeGhPr(repo, row));

    const authored = gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      "author:@me",
      "--json",
      "number,title,url,author,updatedAt,isDraft,reviewDecision,statusCheckRollup",
      "--limit",
      String(PER_REPO_LIMIT),
    ]);
    for (const row of authored || []) mine.push(shapeGhPr(repo, row));

    const iss = gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,url,author,updatedAt",
      "--limit",
      String(PER_REPO_LIMIT),
    ]);
    for (const row of iss || []) issues.push(shapeGhIssue(repo, row));
  }

  const latest = [];
  for (const repo of repos) {
    try {
      const repoInfo = gh(["api", `repos/${repo}`]);
      const branch = repoInfo && repoInfo.default_branch;
      if (!branch) continue;
      const commit = gh(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`]);
      const shaped = shapeLatestCommit(repo, branch, commit);
      if (shaped) latest.push(shaped);
    } catch {
      // best-effort - an empty repo or a branch-protection quirk shouldn't fail the whole overview
    }
  }

  return finalize({ mode: "gh", me, repos, reviewRequested, mine, issues, latest });
}

async function fetchViaRest(repos, rest) {
  let me = null;
  try {
    const user = await rest("/user");
    me = user && user.login ? user.login : null;
  } catch {
    me = null;
  }

  const reviewRequested = [];
  const mine = [];
  const issues = [];

  const shapeSearchPr = (repo, item) => ({
    repo,
    number: item.number,
    title: item.title,
    url: item.html_url,
    author: item.user && item.user.login ? item.user.login : null,
    updatedAt: item.updated_at || null,
    isDraft: Boolean(item.draft),
    reviewDecision: null,
    ci: "unknown", // per-PR CI rollup isn't fetched in PAT mode (see file header)
  });

  for (const repo of repos) {
    const q = (extra) => encodeURIComponent(`repo:${repo} is:open is:pr ${extra}`);
    const reviews = await rest(
      `/search/issues?q=${q("review-requested:@me")}&per_page=${PER_REPO_LIMIT}`
    );
    for (const item of (reviews && reviews.items) || [])
      reviewRequested.push(shapeSearchPr(repo, item));

    const authored = await rest(`/search/issues?q=${q("author:@me")}&per_page=${PER_REPO_LIMIT}`);
    for (const item of (authored && authored.items) || []) mine.push(shapeSearchPr(repo, item));

    const { owner, name } = repoParts(repo);
    const iss = await rest(`/repos/${owner}/${name}/issues?state=open&per_page=${PER_REPO_LIMIT}`);
    for (const item of iss || []) {
      if (item.pull_request) continue; // the issues endpoint includes PRs
      issues.push({
        repo,
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user && item.user.login ? item.user.login : null,
        updatedAt: item.updated_at || null,
      });
    }
  }

  const latest = [];
  for (const repo of repos) {
    try {
      const { owner, name } = repoParts(repo);
      const repoInfo = await rest(`/repos/${owner}/${name}`);
      const branch = repoInfo && repoInfo.default_branch;
      if (!branch) continue;
      const commit = await rest(`/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`);
      const shaped = shapeLatestCommit(repo, branch, commit);
      if (shaped) latest.push(shaped);
    } catch {
      /* best-effort */
    }
  }

  return finalize({ mode: "pat", me, repos, reviewRequested, mine, issues, latest });
}

/** Sort newest-first, cap list lengths, and compute the summary counts. */
function finalize({ mode, me, repos, reviewRequested, mine, issues, latest = [] }) {
  const byUpdated = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  reviewRequested.sort(byUpdated);
  mine.sort(byUpdated);
  issues.sort(byUpdated);
  const sortedLatest = [...latest].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || ""))
  );

  const rr = reviewRequested.slice(0, MAX_ITEMS);
  const mn = mine.slice(0, MAX_ITEMS);
  const is = issues.slice(0, MAX_ITEMS);

  const failingChecks =
    rr.filter((p) => p.ci === "failure").length + mn.filter((p) => p.ci === "failure").length;

  return {
    configured: true,
    mode,
    me,
    repos,
    reviewRequested: rr,
    mine: mn,
    issues: is,
    latest: sortedLatest,
    counts: {
      reviewRequested: rr.length,
      mine: mn.length,
      failingChecks,
      openIssues: is.length,
    },
    error: null,
  };
}

module.exports = {
  fetchOverview,
  authMode,
  ghAvailable,
  ciFromRollup,
  shapeLatestCommit,
  emptyOverview,
  _resetGhProbe,
};
