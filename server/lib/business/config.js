/**
 * @file business/config.js
 * @description Server-side config store for the business integrations (Phase
 * BM — eBay / Amazon SP-API / Keepa / SellerAmp). Mirrors github/config.js: a
 * single gitignored JSON file (`server/config/business.json`) plus env
 * fallbacks, edited through the Settings UI (`PUT /api/business/config/:provider`).
 * Secrets live ONLY here — the client only ever sees `has*` booleans.
 *
 * These integrations are DORMANT BY DESIGN: they ship fully built but disabled,
 * so the accounts/API subscriptions can be linked later with a few clicks
 * (paste keys in Settings → enable → the /api/business endpoints go live).
 * Until then every operational endpoint answers 503 NOT_CONNECTED and the v1
 * manual strategy (GUIDE.md) is unaffected.
 *
 * Env fallbacks (a UI-saved value in the file always wins):
 *   EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN
 *   AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_REFRESH_TOKEN
 *   KEEPA_API_KEY
 *
 * `BUSINESS_CONFIG_PATH` overrides the file location (tests point it at a temp
 * file). Reads never throw — a missing/corrupt file yields defaults.
 *
 * @author Jarvis (Phase BM)
 */

const fs = require("node:fs");
const path = require("node:path");

// UK-first defaults (eBay GB marketplace, amazon.co.uk SP-API + Keepa domain).
const DEFAULTS = Object.freeze({
  ebay: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    environment: "PRODUCTION", // or SANDBOX
    marketplaceId: "EBAY_GB",
    // Sell-side policy ids - required by eBay before an offer can be created;
    // filled in once the business account exists (guide Part 1).
    fulfillmentPolicyId: "",
    paymentPolicyId: "",
    returnPolicyId: "",
    merchantLocationKey: "",
  },
  amazon: {
    enabled: false,
    lwaClientId: "",
    lwaClientSecret: "",
    refreshToken: "",
    endpoint: "https://sellingpartnerapi-eu.amazon.com",
    marketplaceId: "A1F83G8C2ARO7P", // amazon.co.uk
  },
  keepa: {
    enabled: false,
    apiKey: "",
    domain: 2, // keepa domain id for amazon.co.uk
  },
  // SellerAmp has no public API - the integration is a deep-link builder that
  // needs no credentials, just an on/off switch for the UI.
  selleramp: {
    enabled: false,
  },
});

const PROVIDERS = Object.freeze(Object.keys(DEFAULTS));

// Fields a client may write, and which of them are secrets (redacted to has*).
const SECRET_FIELDS = Object.freeze({
  ebay: ["clientId", "clientSecret", "refreshToken"],
  amazon: ["lwaClientId", "lwaClientSecret", "refreshToken"],
  keepa: ["apiKey"],
  selleramp: [],
});

function configPath() {
  return (
    process.env.BUSINESS_CONFIG_PATH || path.join(__dirname, "..", "..", "config", "business.json")
  );
}

function readFileConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const ENV_FALLBACKS = {
  ebay: {
    clientId: "EBAY_CLIENT_ID",
    clientSecret: "EBAY_CLIENT_SECRET",
    refreshToken: "EBAY_REFRESH_TOKEN",
  },
  amazon: {
    lwaClientId: "AMAZON_LWA_CLIENT_ID",
    lwaClientSecret: "AMAZON_LWA_CLIENT_SECRET",
    refreshToken: "AMAZON_REFRESH_TOKEN",
  },
  keepa: { apiKey: "KEEPA_API_KEY" },
  selleramp: {},
};

/** Full resolved config (file + env + defaults). Secrets included - server-only. */
function getConfig() {
  const file = readFileConfig();
  const out = {};
  for (const provider of PROVIDERS) {
    const defaults = DEFAULTS[provider];
    const stored = file[provider] && typeof file[provider] === "object" ? file[provider] : {};
    const merged = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (stored[key] !== undefined && typeof stored[key] === typeof defaults[key]) {
        merged[key] = stored[key];
      }
    }
    // Env only fills a slot the file left empty - a UI-saved value always wins.
    for (const [key, envName] of Object.entries(ENV_FALLBACKS[provider])) {
      if (!merged[key] && process.env[envName]) merged[key] = process.env[envName].trim();
    }
    out[provider] = merged;
  }
  return out;
}

/**
 * Persist a partial patch for one provider (merged over the on-disk file, NOT
 * over env - so clearing a key in the UI actually clears it). Only known
 * fields land. Writes atomically, 0600. Returns the new redacted view.
 */
function updateProvider(provider, patch) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider: ${provider}`);
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  const file = readFileConfig();
  const current = file[provider] && typeof file[provider] === "object" ? file[provider] : {};
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS[provider])) {
    if (patch[key] === undefined) continue;
    if (typeof DEFAULTS[provider][key] === "boolean") next[key] = Boolean(patch[key]);
    else if (typeof DEFAULTS[provider][key] === "number") {
      const n = Number(patch[key]);
      if (Number.isFinite(n)) next[key] = n;
    } else next[key] = typeof patch[key] === "string" ? patch[key].trim() : "";
  }
  file[provider] = next;
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
  return redactedConfig()[provider];
}

/** True when the provider has every credential its operations need. */
function hasCreds(provider, cfg) {
  const c = cfg || getConfig();
  switch (provider) {
    case "ebay":
      // App token (search/comps) only needs the keypair; the refresh token is
      // required for the sell-side (listing) calls and reported separately.
      return Boolean(c.ebay.clientId && c.ebay.clientSecret);
    case "amazon":
      return Boolean(c.amazon.lwaClientId && c.amazon.lwaClientSecret && c.amazon.refreshToken);
    case "keepa":
      return Boolean(c.keepa.apiKey);
    case "selleramp":
      return true; // deep-links need no credentials
    default:
      return false;
  }
}

/** enabled AND credentialed - the gate every operational endpoint checks. */
function isConnected(provider, cfg) {
  const c = cfg || getConfig();
  return Boolean(c[provider] && c[provider].enabled && hasCreds(provider, c));
}

/** Client-safe view: secrets replaced by has* booleans, plus readiness flags. */
function redactedConfig() {
  const cfg = getConfig();
  const out = {};
  for (const provider of PROVIDERS) {
    const c = cfg[provider];
    const view = {};
    for (const [key, value] of Object.entries(c)) {
      if (SECRET_FIELDS[provider].includes(key)) {
        view[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = Boolean(value);
      } else {
        view[key] = value;
      }
    }
    view.hasCreds = hasCreds(provider, cfg);
    view.connected = isConnected(provider, cfg);
    out[provider] = view;
  }
  return out;
}

module.exports = {
  DEFAULTS,
  PROVIDERS,
  getConfig,
  updateProvider,
  redactedConfig,
  hasCreds,
  isConnected,
  configPath,
};
