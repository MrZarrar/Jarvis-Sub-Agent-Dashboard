import { useEffect, useState } from "react";
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
  secret?: boolean;
}

const PROVIDERS: Array<{ id: string; name: string; hint: string; fields: FieldSpec[] }> = [
  {
    id: "ebay",
    name: "eBay",
    hint: "Browse credentials for comparisons; sell-side credentials create unpublished drafts only.",
    fields: [
      { key: "clientId", label: "Client ID", secret: true },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "refreshToken", label: "Sell-side refresh token", secret: true },
      { key: "fulfillmentPolicyId", label: "Fulfilment policy ID" },
      { key: "paymentPolicyId", label: "Payment policy ID" },
      { key: "returnPolicyId", label: "Return policy ID" },
      { key: "merchantLocationKey", label: "Merchant location key" },
    ],
  },
  {
    id: "amazon",
    name: "Amazon SP-API",
    hint: "Optional UK catalogue and offer lookup. Keep disabled until the account is ready.",
    fields: [
      { key: "lwaClientId", label: "LWA client ID", secret: true },
      { key: "lwaClientSecret", label: "LWA client secret", secret: true },
      { key: "refreshToken", label: "Refresh token", secret: true },
    ],
  },
  {
    id: "keepa",
    name: "Keepa",
    hint: "Optional paid UK price-history and sales-rank data.",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
  },
  {
    id: "selleramp",
    name: "SellerAmp",
    hint: "Deep links only; SellerAmp does not offer a public API.",
    fields: [],
  },
];

function secretFlag(key: string) {
  return `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function Status({ view }: { view?: ProviderView }) {
  if (view?.connected) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </span>
    );
  }
  if (view?.hasCreds) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
        <PlugZap className="w-3 h-3" /> Ready, disabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
      <CircleOff className="w-3 h-3" /> Dormant
    </span>
  );
}

export function BusinessIntegrations() {
  const [providers, setProviders] = useState<Record<string, ProviderView>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = () =>
    api.business
      .integrations()
      .then((result) => setProviders(result.providers as Record<string, ProviderView>))
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  async function save(id: string) {
    const patch = Object.fromEntries(
      Object.entries(drafts[id] || {}).filter(([, value]) => value.trim() !== "")
    );
    if (!Object.keys(patch).length) return;
    setBusy(id);
    try {
      await api.business.update(id, patch);
      setDrafts((current) => ({ ...current, [id]: {} }));
      await load();
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
    try {
      const result = await api.business.test(id);
      setResults((current) => ({
        ...current,
        [id]:
          result.detail ||
          (result.tokensLeft === undefined ? "OK" : `${result.tokensLeft} tokens left`),
      }));
    } catch (error) {
      setResults((current) => ({ ...current, [id]: (error as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {PROVIDERS.map((provider) => {
        const view = providers[provider.id];
        const draft = drafts[provider.id] || {};
        const changed = Object.values(draft).some((value) => value.trim() !== "");
        return (
          <div key={provider.id} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-200">{provider.name}</span>
                <Status view={view} />
              </div>
              <div className="flex items-center gap-3">
                {results[provider.id] && (
                  <span className="text-[11px] text-gray-400">{results[provider.id]}</span>
                )}
                {view?.hasCreds && provider.fields.length > 0 && (
                  <button className="btn-ghost text-xs" onClick={() => test(provider.id)}>
                    {busy === provider.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "Test"
                    )}
                  </button>
                )}
                <label className="flex items-center gap-1.5 text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={Boolean(view?.enabled)}
                    disabled={busy === provider.id}
                    onChange={(event) => toggle(provider.id, event.target.checked)}
                  />
                  Enabled
                </label>
              </div>
            </div>
            <p className="mt-1 mb-3 text-xs text-gray-500">{provider.hint}</p>
            {provider.fields.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {provider.fields.map((field) => {
                  const saved = field.secret
                    ? Boolean(view?.[secretFlag(field.key)])
                    : Boolean(view?.[field.key]);
                  return (
                    <input
                      key={field.key}
                      type={field.secret ? "password" : "text"}
                      className="input text-xs"
                      autoComplete="off"
                      placeholder={`${field.label}${saved ? " · set" : ""}`}
                      value={draft[field.key] || ""}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [provider.id]: {
                            ...current[provider.id],
                            [field.key]: event.target.value,
                          },
                        }))
                      }
                    />
                  );
                })}
              </div>
            )}
            {changed && (
              <button className="btn-primary mt-2 text-xs" onClick={() => save(provider.id)}>
                Save
              </button>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-gray-600">
        These integrations are dormant by default. Enabling one may add separate third-party costs;
        Jarvis never enables or bills them automatically.
      </p>
    </div>
  );
}
