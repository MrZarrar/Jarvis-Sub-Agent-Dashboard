const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
process.env.DASHBOARD_DB_PATH = path.join(tmp, "dashboard.db");

const { __dashboardOnly: dashboardOnly } = require("../routes/assistant");

describe("computer-use snapshot access", () => {
  it("allows the dashboard UI but rejects a scoped assistant token", () => {
    let nextCalls = 0;
    dashboardOnly({}, {}, () => nextCalls++);
    assert.equal(nextCalls, 1);

    let status;
    let body;
    dashboardOnly(
      { assistantTokenId: "siri-token" },
      {
        status(value) {
          status = value;
          return this;
        },
        json(value) {
          body = value;
        },
      },
      () => nextCalls++
    );
    assert.equal(status, 403);
    assert.equal(body.error.code, "EFORBIDDEN");
    assert.equal(nextCalls, 1);
  });
});
