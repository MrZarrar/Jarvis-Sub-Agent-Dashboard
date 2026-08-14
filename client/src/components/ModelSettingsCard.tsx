/**
 * @file ModelSettingsCard.tsx
 * @description Pins which model backs each surface: the chat tiers, the vault
 * entity engine, and each agent-team role. Saves are per-field so one bad entry
 * cannot strand the rest, and an empty value is a real choice meaning "inherit
 * the provider's default" rather than a missing one.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../lib/api";
import type { ModelSettings, ModelSettingsResponse } from "../lib/types";

const ROLE_HINTS: Record<string, string> = {
  scout: "Recon and investigation",
  forge: "Implementation",
  sentinel: "Review",
  ops: "Validation",
};

/** Datalist-backed text input: suggests known ids without rejecting new ones. */
function ModelField({
  id,
  label,
  hint,
  value,
  options,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: string[];
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-300">
        {label}
      </label>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
      <input
        id={id}
        list={`${id}-options`}
        className="input mt-1 w-full"
        placeholder="Provider default"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <datalist id={`${id}-options`}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
    </div>
  );
}

export function ModelSettingsCard() {
  const [data, setData] = useState<ModelSettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    api.settings.models
      .get()
      .then((next) => active && setData(next))
      .catch(() => active && setError("Could not load model settings."));
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (patch: Partial<ModelSettings>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.settings.models.set(patch);
      setData((current) => (current ? { ...current, settings: res.settings } : current));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save model settings.");
    } finally {
      setSaving(false);
    }
  }, []);

  if (error && !data) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <Loader2 className="w-4 h-4 animate-spin text-gray-500" />;

  const { settings, known, engineProviders, agentRoles } = data;
  const engineOptions = known[settings.engine.provider] ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Chat tiers</h4>
        <p className="text-[11px] text-gray-500 mb-3">
          Used for brain chat and note reasoning. Leave blank to follow each provider&apos;s own
          default.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ModelField
            id="model-chat-claude"
            label="Claude"
            value={settings.chat.claude}
            options={known.claude ?? []}
            disabled={saving}
            onCommit={(model) => void save({ chat: { ...settings.chat, claude: model } })}
          />
          <ModelField
            id="model-chat-codex"
            label="Codex"
            value={settings.chat.codex}
            options={known.codex ?? []}
            disabled={saving}
            onCommit={(model) => void save({ chat: { ...settings.chat, codex: model } })}
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Neural engine</h4>
        <p className="text-[11px] text-gray-500 mb-3">
          Entity extraction across the vault. The chosen provider is tried first; the other stays as
          a fallback so a signed-out CLI degrades instead of failing the pass.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="model-engine-provider"
              className="block text-xs font-medium text-gray-300"
            >
              Provider
            </label>
            <select
              id="model-engine-provider"
              className="input mt-1 w-full appearance-none"
              value={settings.engine.provider}
              disabled={saving}
              onChange={(e) =>
                void save({ engine: { ...settings.engine, provider: e.target.value } })
              }
            >
              {engineProviders.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
          <ModelField
            id="model-engine"
            label="Model"
            value={settings.engine.model}
            options={engineOptions}
            disabled={saving}
            onCommit={(model) => void save({ engine: { ...settings.engine, model } })}
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 mb-2">Agent team</h4>
        <p className="text-[11px] text-gray-500 mb-3">
          Per-role model for spawned mission agents. An explicit model chosen at spawn time still
          wins over these.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {agentRoles.map((role) => (
            <ModelField
              key={role}
              id={`model-agent-${role}`}
              label={role.charAt(0).toUpperCase() + role.slice(1)}
              hint={ROLE_HINTS[role]}
              value={settings.agents[role] ?? ""}
              options={[...(known.claude ?? []), ...(known.codex ?? [])]}
              disabled={saving}
              onCommit={(model) => void save({ agents: { ...settings.agents, [role]: model } })}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px]" aria-live="polite">
        {saving && <span className="text-gray-500">Saving…</span>}
        {!saving && error && <span className="text-red-400">{error}</span>}
        {!saving && !error && savedAt && <span className="text-green-400">Saved</span>}
      </div>
    </div>
  );
}
