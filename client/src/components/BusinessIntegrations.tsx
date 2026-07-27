/**
 * @file BusinessIntegrations.tsx
 * @description Settings section for the dormant business integrations (Phase
 * BM): eBay, Amazon SP-API, Keepa, SellerAmp. Everything is built and gated
 * server-side; this card is the "few clicks later" surface - paste keys,
 * toggle Enabled, hit Test, and the /api/business endpoints go live for the
 * ~/JarvisBusiness agents. Secrets are write-only: the server returns has*
 * booleans, never the values.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Briefcase, CheckCircle2, CircleOff, Loader2, PlugZap } from "lucide-react";
import { api } from "../lib/api";

type ProviderView = Record<string, unknown> & {
  enabled?: boolean;
  hasCreds?: boolean;
  connected?: boolean;
};

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean; // rendered as password, server reports has<Key> only
}

const PROVIDER_SPECS: Array<{ id: string; name: string; hint: string; fields: FieldSpec[] }> = [
  {
    id: "ebay",
    name: "eBay",
    hint: "Developer keypair for Browse comps; sell-side refresh token + policy IDs for draft listings.",
    fields: [
      { key: "clientId", label: "Client ID", secret: true },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "refreshToken", label: "Refresh token (sell-side)", secret: true },
      { key: "fulfillmentPolicyId", label: "Fulfilment policy ID" },
      { key: "paymentPolicyId", label: "Payment policy ID" },
      { key: "returnPolicyId", label: "Return policy ID" },
      { key: "merchantLocationKey", label: "Merchant location key" },
    ],
  },
  {
    id: "amazon",
    name: "Amazon SP-API",
    hint: "LWA app credentials + refresh token from Seller Central (amazon.co.uk).",
    fields: [
      { key: "lwaClientId", label: "LWA client ID", secret: true },
      { key: "lwaClientSecret", label: "LWA client secret", secret: true },
      { key: "refreshToken", label: "Refresh token", secret: true },
    ],
  },
  {
    id: "keepa",
    name: "Keepa",
    hint: "API key (paid subscription) for UK price history + sales-rank stats.",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
  },
  {
    id: "selleramp",
    name: "SellerAmp",
    hint: "No public API - the dashboard builds SAS lookup deep-links; nothing to configure.",
    fields: [],
  },
];

function hasFlagName(key: string) {
  return `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function StatusChip({ view }: { view: ProviderView | undefined }) {
  const { t } = useTranslation("settings");
  if (view?.connected) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
        <CheckCircle2 className="w-3 h-3" /> {t("business.connected", "Connected")}
      </span>
    );
  }
  if (view?.hasCreds) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
        <PlugZap className="w-3 h-3" /> {t("business.ready", "Keys saved · disabled")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 bg-gray-500/10 border border-gray-500/20 px-2 py-0.5 rounded-full">
      <CircleOff className="w-3 h-3" /> {t("business.dormant", "Dormant")}
    </span>
  );
}

export function BusinessIntegrations() {
  const { t } = useTranslation("settings");
  const [providers, setProviders] = useState<Record<string, ProviderView>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const load = () =>
    api.business
      .integrations()
      .then((r) => setProviders(r.providers as Record<string, ProviderView>))
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  async function save(id: string) {
    const draft = drafts[id] || {};
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) if (v !== "") patch[k] = v;
    if (Object.keys(patch).length === 0) return;
    setBusy(id);
    try {
      await api.business.update(id, patch);
      setDrafts((d) => ({ ...d, [id]: {} }));
      await load();
    } catch {
      /* leave the draft intact so nothing typed is lost */
    } finally {
      setBusy(null);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.business.update(id, { enabled });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function test(id: string) {
    setBusy(id);
    setTestResult((r) => ({ ...r, [id]: "…" }));
    try {
      const res = await api.business.test(id);
      setTestResult((r) => ({
        ...r,
        [id]:
          res.detail ||
          (res.tokensLeft !== undefined ? `OK - ${res.tokensLeft} Keepa tokens left` : "OK"),
      }));
    } catch (err) {
      setTestResult((r) => ({ ...r, [id]: `Failed: ${(err as Error).message}` }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {PROVIDER_SPECS.map((spec) => {
        const view = providers[spec.id];
        const draft = drafts[spec.id] || {};
        return (
          <div key={spec.id} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-200">{spec.name}</span>
                <StatusChip view={view} />
              </div>
              <div className="flex items-center gap-3">
                {testResult[spec.id] && (
                  <span className="text-[11px] text-gray-400">{testResult[spec.id]}</span>
                )}
                {view?.hasCreds && spec.fields.length > 0 && (
                  <button
                    onClick={() => test(spec.id)}
                    disabled={busy === spec.id}
                    className="btn-ghost text-xs"
                  >
                    {busy === spec.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      t("business.test", "Test")
                    )}
                  </button>
                )}
                <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(view?.enabled)}
                    disabled={busy === spec.id}
                    onChange={(e) => toggle(spec.id, e.target.checked)}
                  />
                  {t("business.enabled", "Enabled")}
                </label>
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-3">{spec.hint}</p>
            {spec.fields.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {spec.fields.map((f) => {
                  const saved = f.secret
                    ? Boolean(view?.[hasFlagName(f.key)])
                    : Boolean(view?.[f.key]);
                  return (
                    <input
                      key={f.key}
                      type={f.secret ? "password" : "text"}
                      className="input text-xs"
                      placeholder={`${f.label}${saved ? " · set" : ""}`}
                      value={draft[f.key] ?? ""}
                      autoComplete="off"
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [spec.id]: { ...d[spec.id], [f.key]: e.target.value },
                        }))
                      }
                    />
                  );
                })}
              </div>
            )}
            {spec.fields.length > 0 && Object.values(draft).some((v) => v !== "") && (
              <div className="mt-2">
                <button
                  onClick={() => save(spec.id)}
                  disabled={busy === spec.id}
                  className="btn-primary text-xs"
                >
                  {t("common:save")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-gray-600">
        {t(
          "business.footnote",
          "Built dormant on purpose: the v1 strategy stays manual until the subscriptions are earned. Once keys are saved and enabled, the agent endpoints under /api/business go live - nothing else changes."
        )}
      </p>
    </div>
  );
}
