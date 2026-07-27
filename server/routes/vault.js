/**
 * @file vault.js
 * @description Knowledge-vault API (Phase S). The graph over the notes tree plus
 * the v1 writers. Read-only queries + guardrailed writes (vault lib enforces the
 * inbox/agent-only write boundary); no process-spawning, so it sits behind only
 * the global host/CORS/token guards - same posture as routes/notes.js.
 *
 * Surface (all additive):
 *   GET  /api/vault/graph             - { nodes, edges } for the graph-brain view
 *   GET  /api/vault/node/:id          - one node: body + outgoing links + backlinks
 *   GET  /api/vault/path?from=&to=    - shortest link path between two nodes
 *   GET  /api/vault/summary-projects  - run-summary opt-in project ids
 *   PUT  /api/vault/summary-projects  - set the opt-in list (materializes stubs)
 *   POST /api/vault/save-chat         - file a chat message / conversation summary
 *   POST /api/vault/write             - guardrailed write (inbox/ or agent/ only)
 *   POST /api/vault/engine/run        - entity-engine pass (manual trigger; 409 if running)
 *   GET  /api/vault/engine/status     - last run + entity counts
 *   GET  /api/vault/recall            - notes due for a revisit, as recall questions
 *   POST /api/vault/recall/seen       - mark a resurfaced note as reviewed
 *   GET  /api/vault/graphify-projects - graphify opt-in project ids
 *   PUT  /api/vault/graphify-projects - set the opt-in list
 *   POST /api/vault/graphify/run      - start a codegraph run for one project (202)
 *   GET  /api/vault/graphify/status   - per-project last run + in-flight set
 *   POST /api/vault/graphify/query     - run graphify query/explain/path/affected
 *   GET  /api/vault/project-files      - list a project's repo files (git ls-files, or walk)
 *   GET  /api/vault/project-file       - read one file from a project's repo
 */

const { Router } = require("express");
const vault = require("../lib/vault");
const vaultEngine = require("../lib/vault-engine");
const vaultGraphify = require("../lib/vault-graphify");
const projectFiles = require("../lib/project-files");

const router = Router();

function badRequest(res, code, message) {
  return res.status(400).json({ error: { code, message } });
}

router.get("/graph", (_req, res) => {
  res.json(vault.graph());
});

router.get("/path", (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!from || !to) return badRequest(res, "EBADINPUT", "from and to are required");
  const ids = vault.pathBetween(from, to);
  if (!ids) return res.json({ path: null });
  res.json({
    path: ids
      .map((id) => vault.node(id))
      .filter(Boolean)
      .map(({ id, title, nodeType }) => ({ id, title, type: nodeType })),
  });
});

router.get("/summary-projects", (_req, res) => {
  res.json({ projectIds: vault.getSummaryProjects() });
});

router.put("/summary-projects", (req, res) => {
  const ids = req.body?.projectIds;
  if (!Array.isArray(ids)) return badRequest(res, "EBADINPUT", "projectIds array is required");
  res.json({ projectIds: vault.setSummaryProjects(ids) });
});

router.post("/save-chat", async (req, res) => {
  const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";
  const mode = req.body?.mode === "summary" ? "summary" : "message";
  const messageId = typeof req.body?.messageId === "string" ? req.body.messageId : null;
  if (!chatId) return badRequest(res, "EBADINPUT", "chatId is required");
  if (mode === "message" && !messageId)
    return badRequest(res, "EBADINPUT", "messageId is required for mode=message");
  try {
    const note = await vault.saveChat({ chatId, mode, messageId });
    res.status(201).json({ note });
  } catch (err) {
    if (err.code === "ENOTFOUND")
      return res.status(404).json({ error: { code: err.code, message: err.message } });
    res.status(500).json({ error: { code: err.code || "ESAVE", message: err.message } });
  }
});

router.post("/write", (req, res) => {
  const b = req.body || {};
  try {
    const note = vault.writeVaultFile({
      folder: typeof b.folder === "string" ? b.folder : "inbox",
      title: typeof b.title === "string" ? b.title : "",
      body: typeof b.body === "string" ? b.body : "",
      tags: Array.isArray(b.tags) ? b.tags : [],
      projectId: typeof b.projectId === "string" ? b.projectId : null,
      source: "agent",
    });
    res.status(201).json({ note });
  } catch (err) {
    if (err.code === "EACCES")
      return res.status(403).json({ error: { code: err.code, message: err.message } });
    return badRequest(res, "EWRITE", err.message);
  }
});

router.post("/engine/run", async (_req, res) => {
  try {
    res.json(await vaultEngine.runEngine({}));
  } catch (err) {
    if (err.code === "EBUSY")
      return res.status(409).json({ error: { code: err.code, message: err.message } });
    res.status(500).json({ error: { code: err.code || "EENGINE", message: err.message } });
  }
});

router.get("/engine/status", (_req, res) => {
  res.json(vaultEngine.getStatus());
});

router.get("/recall", async (req, res) => {
  const n = Number.parseInt(String(req.query.n || ""), 10) || 3;
  try {
    res.json({ items: await vault.recallQueue({ n }) });
  } catch (err) {
    res.status(500).json({ error: { code: "ERECALL", message: err.message } });
  }
});

router.post("/recall/seen", (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) return badRequest(res, "EBADINPUT", "id is required");
  vault.recallSeen(id);
  res.json({ ok: true });
});

router.get("/graphify-projects", (_req, res) => {
  res.json({ projectIds: vaultGraphify.getGraphifyProjects() });
});

router.put("/graphify-projects", (req, res) => {
  const ids = req.body?.projectIds;
  if (!Array.isArray(ids)) return badRequest(res, "EBADINPUT", "projectIds array is required");
  res.json({ projectIds: vaultGraphify.setGraphifyProjects(ids) });
});

// Long-running (extraction can take minutes on a big repo): kick off and
// return 202; progress streams as `vault_graphify` WS events.
router.post("/graphify/run", (req, res) => {
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
  if (!projectId) return badRequest(res, "EBADINPUT", "projectId is required");
  if (!vaultGraphify.getGraphifyProjects().includes(projectId))
    return badRequest(res, "EBADINPUT", "project is not opted into graphify");
  if (vaultGraphify.getStatus().running.includes(projectId))
    return res.status(409).json({ error: { code: "EBUSY", message: "already running" } });
  if (!vaultGraphify.repoPathFor(projectId))
    return res
      .status(404)
      .json({ error: { code: "ENOTFOUND", message: "project has no repo path on disk" } });
  vaultGraphify.runGraphify(projectId, {}).catch((err) => {
    console.warn("[vault] graphify run failed:", err?.message || err);
  });
  res.status(202).json({ started: true, projectId });
});

router.get("/graphify/status", (_req, res) => {
  res.json(vaultGraphify.getStatus());
});

router.post("/graphify/query", async (req, res) => {
  const b = req.body || {};
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  const subcommand = typeof b.subcommand === "string" ? b.subcommand : "";
  if (!projectId || !subcommand)
    return badRequest(res, "EBADINPUT", "projectId and subcommand are required");
  try {
    const output = await vaultGraphify.queryGraphify(projectId, subcommand, b.args);
    res.json({ output });
  } catch (err) {
    if (err.code === "ENOTFOUND")
      return res.status(404).json({ error: { code: err.code, message: err.message } });
    if (err.code === "EBADINPUT") return badRequest(res, err.code, err.message);
    res.status(500).json({ error: { code: "EQUERY", message: err.message } });
  }
});

router.get("/project-files", async (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
  const subpath = typeof req.query.subpath === "string" ? req.query.subpath : "";
  if (!projectId) return badRequest(res, "EBADINPUT", "projectId is required");
  try {
    res.json({ files: await projectFiles.listProjectFiles(projectId, subpath) });
  } catch (err) {
    if (err.code === "ENOTFOUND" || err.code === "EACCES")
      return res.status(err.code === "EACCES" ? 403 : 404).json({
        error: { code: err.code, message: err.message },
      });
    res.status(500).json({ error: { code: "ELIST", message: err.message } });
  }
});

router.get("/project-file", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
  const filePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!projectId || !filePath)
    return badRequest(res, "EBADINPUT", "projectId and path are required");
  try {
    res.json({ path: filePath, content: projectFiles.readProjectFile(projectId, filePath) });
  } catch (err) {
    if (err.code === "EACCES")
      return res.status(403).json({ error: { code: err.code, message: err.message } });
    if (err.code === "ENOTFOUND" || err.code === "ENOENT")
      return res.status(404).json({ error: { code: err.code, message: err.message } });
    if (err.code === "ETOOBIG")
      return res.status(413).json({ error: { code: err.code, message: err.message } });
    res.status(500).json({ error: { code: "EREAD", message: err.message } });
  }
});

router.get("/node/:id", (req, res) => {
  const n = vault.node(req.params.id);
  if (!n) return res.status(404).json({ error: { code: "ENOTFOUND", message: "node not found" } });
  res.json({ node: n });
});

module.exports = router;
