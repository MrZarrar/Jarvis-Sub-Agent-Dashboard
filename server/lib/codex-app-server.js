/** Managed, shared Codex app-server JSON-RPC connection. */

const { EventEmitter } = require("node:events");
const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const { resolveCodexCommand } = require("./providers/codex-command");

const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_CACHE_MS = 60_000;
const STDERR_LIMIT = 8_000;
const SCHEMA_VERSION = "codex-0.144.2";
const SUPPORTED_METHODS = Object.freeze([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/archive",
  "thread/list",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
  "account/read",
  "account/rateLimits/read",
]);

function collectMethods(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectMethods(item, found);
    return found;
  }
  const values = value.properties?.method?.enum;
  if (Array.isArray(values)) for (const method of values) found.add(method);
  for (const item of Object.values(value)) collectMethods(item, found);
  return found;
}

const CLIENT_METHODS = collectMethods(require(`../schemas/${SCHEMA_VERSION}/ClientRequest.json`));
const SERVER_REQUEST_METHODS = collectMethods(
  require(`../schemas/${SCHEMA_VERSION}/ServerRequest.json`)
);
const SERVER_NOTIFICATION_METHODS = collectMethods(
  require(`../schemas/${SCHEMA_VERSION}/ServerNotification.json`)
);

function validEnvelope(message) {
  return Boolean(message && typeof message === "object" && !Array.isArray(message));
}

function subscriptionEnv() {
  const env = { ...process.env };
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

class CodexAppServer extends EventEmitter {
  constructor({ spawnImpl = spawn, commandResolver = resolveCodexCommand } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.commandResolver = commandResolver;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.starting = null;
    this.ready = false;
    this.startedAt = null;
    this.lastError = null;
    this.stderrTail = "";
    this.rateLimits = null;
    this.rateLimitsFetchedAt = null;
    this.rateLimitsPending = null;
  }

  async start() {
    if (this.ready && this.child) return this;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    const command = this.commandResolver();
    const child = this.spawnImpl(command, ["app-server", "--stdio"], {
      env: subscriptionEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.ready = false;
    this.startedAt = Date.now();
    this.lastError = null;
    this.stderrTail = "";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this._onLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => this._onExit(error));
    child.once("exit", (code, signal) =>
      this._onExit(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`))
    );

    await this._requestWithoutStart("initialize", {
      clientInfo: { name: "jarvis_dashboard", title: "Jarvis Dashboard", version: "1.3.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.emit("ready");
    return this;
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("protocolError", { error, line });
      return;
    }
    if (!validEnvelope(message)) {
      this.emit("protocolError", { error: new Error("Invalid Codex protocol envelope"), line });
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error"))
    ) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      if (!SERVER_REQUEST_METHODS.has(message.method) || !validEnvelope(message.params)) {
        this.emit("protocolError", {
          error: new Error(`Unsupported Codex server request: ${message.method}`),
          line,
        });
        this.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
        return;
      }
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) {
      if (!SERVER_NOTIFICATION_METHODS.has(message.method) || !validEnvelope(message.params)) {
        this.emit("protocolError", {
          error: new Error(`Unsupported Codex notification: ${message.method}`),
          line,
        });
        return;
      }
      this.emit("notification", message);
    }
  }

  _onExit(error) {
    if (!this.child && !this.ready) return;
    this.lastError = error?.message || String(error);
    this.ready = false;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }

  _write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _requestWithoutStart(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!CLIENT_METHODS.has(method) || (params !== null && !validEnvelope(params))) {
      return Promise.reject(
        new Error(`Request does not match pinned Codex ${SCHEMA_VERSION} protocol: ${method}`)
      );
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this._write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs) {
    await this.start();
    return this._requestWithoutStart(method, params, timeoutMs);
  }

  async getRateLimits() {
    const now = Date.now();
    if (
      this.rateLimits &&
      this.rateLimitsFetchedAt &&
      now - this.rateLimitsFetchedAt < RATE_LIMIT_CACHE_MS
    ) {
      return this.rateLimits;
    }
    if (!this.rateLimitsPending) {
      this.rateLimitsPending = this.request("account/rateLimits/read", null)
        .then((result) => {
          this.rateLimits = result;
          this.rateLimitsFetchedAt = Date.now();
          return result;
        })
        .finally(() => {
          this.rateLimitsPending = null;
        });
    }
    return this.rateLimitsPending;
  }

  notify(method, params = {}) {
    this._write({ method, params });
  }

  respond(id, result) {
    this._write({ id, result });
  }

  respondError(id, code, message) {
    this._write({ id, error: { code, message } });
  }

  async diagnostics() {
    try {
      await this.start();
      const [accountResult, modelResult] = await Promise.all([
        this.request("account/read", { refreshToken: false }),
        this.request("model/list", { includeHidden: false, limit: 100 }),
      ]);
      const account = accountResult?.account || null;
      return {
        cliFound: true,
        version: this.version(),
        ready: this.ready,
        authenticated: Boolean(account),
        authType: account?.type || null,
        planType: account?.planType || null,
        accessType: account?.type === "chatgpt" ? "subscription_cli" : "unavailable",
        supportedMethods: SUPPORTED_METHODS,
        models: modelResult?.data || [],
        startedAt: this.startedAt,
        lastError: this.lastError,
        stderrTail: this.stderrTail,
      };
    } catch (error) {
      return {
        cliFound: Boolean(this.commandResolver()),
        version: this.version(),
        ready: false,
        authenticated: false,
        authType: null,
        planType: null,
        accessType: "unavailable",
        supportedMethods: SUPPORTED_METHODS,
        models: [],
        startedAt: this.startedAt,
        lastError: error?.message || String(error),
        stderrTail: this.stderrTail,
      };
    }
  }

  version() {
    try {
      return execFileSync(this.commandResolver(), ["--version"], {
        encoding: "utf8",
        env: subscriptionEnv(),
      }).trim();
    } catch {
      return null;
    }
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

const codexAppServer = new CodexAppServer();

module.exports = {
  CodexAppServer,
  codexAppServer,
  SUPPORTED_METHODS,
  SCHEMA_VERSION,
  CLIENT_METHODS,
  SERVER_REQUEST_METHODS,
  SERVER_NOTIFICATION_METHODS,
  subscriptionEnv,
};
