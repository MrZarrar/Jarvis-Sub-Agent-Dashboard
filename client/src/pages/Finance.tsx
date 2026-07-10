/**
 * @file Finance.tsx
 * @description Subscriptions / finance tracker page (Phase AE). Summary header
 * (per-currency monthly burn + yearly projection + next renewal), the list
 * with inline edit, an add form, and a paste-to-parse brain assist (paste a
 * bank-statement blob → candidate subscriptions → confirm-before-save, same
 * raw→formatted confirm UX as the notes dump flow). Manual entries only - no
 * bank integrations by design. Live-updates on `subscriptions_updated`.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Wallet,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  Sparkles,
  CalendarClock,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { EmptyState } from "../components/EmptyState";
import type {
  Subscription,
  SubscriptionCandidate,
  SubscriptionSummary,
  WSMessage,
} from "../lib/types";

const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", TRY: "₺" };
const fmtMoney = (amount: number, currency: string) =>
  `${SYMBOLS[currency] ?? `${currency} `}${amount.toFixed(2)}`;

const whenLabel = (days: number) =>
  days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;

interface FormState {
  name: string;
  amount: string;
  currency: string;
  cadence: "monthly" | "yearly" | "custom";
  cadence_days: string;
  next_renewal: string;
  category: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  amount: "",
  currency: "GBP",
  cadence: "monthly",
  cadence_days: "30",
  next_renewal: "",
  category: "",
  notes: "",
};

function toPayload(f: FormState): Partial<Subscription> {
  return {
    name: f.name.trim(),
    amount: Number(f.amount),
    currency: f.currency.trim().toUpperCase(),
    cadence: f.cadence,
    cadence_days: f.cadence === "custom" ? Number(f.cadence_days) : null,
    next_renewal: f.next_renewal || null,
    category: f.category.trim() || null,
    notes: f.notes.trim() || null,
  };
}

function fromRow(s: Subscription): FormState {
  return {
    name: s.name,
    amount: String(s.amount),
    currency: s.currency,
    cadence: s.cadence,
    cadence_days: String(s.cadence_days ?? 30),
    next_renewal: s.next_renewal ?? "",
    category: s.category ?? "",
    notes: s.notes ?? "",
  };
}

export function Finance() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Add / inline-edit forms.
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  // Paste-to-parse assist.
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [candidates, setCandidates] = useState<SubscriptionCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [parseNote, setParseNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, summaryRes] = await Promise.all([
        api.subscriptions.list(),
        api.subscriptions.summary(),
      ]);
      setSubs(listRes.subscriptions);
      setSummary(summaryRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscriptions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type === "subscriptions_updated") load();
    });
  }, [load]);

  const submitAdd = async () => {
    try {
      await api.subscriptions.create(toPayload(form));
      setForm(EMPTY_FORM);
      setAdding(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const submitEdit = async (id: string) => {
    try {
      await api.subscriptions.update(id, toPayload(editForm));
      setEditingId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const toggleActive = async (s: Subscription) => {
    try {
      await api.subscriptions.update(s.id, { active: s.active ? 0 : 1 });
      load();
    } catch {
      /* row keeps its previous state; next reload is honest */
    }
  };

  const removeSub = async (id: string) => {
    try {
      await api.subscriptions.remove(id);
      load();
    } catch {
      /* ignore */
    }
  };

  const runParse = async () => {
    if (!pasteText.trim() || parsing) return;
    setParsing(true);
    setParseNote(null);
    try {
      const out = await api.subscriptions.parse(pasteText);
      setCandidates(out.candidates);
      setPicked(new Set(out.candidates.map((_, i) => i)));
      setParseNote(
        out.candidates.length === 0
          ? "Nothing that looks like a subscription was found."
          : out.formatted
            ? null
            : "No brain provider configured - extracted with a simple heuristic; check the rows before saving."
      );
    } catch (err) {
      setParseNote(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setParsing(false);
    }
  };

  const saveCandidates = async () => {
    if (!candidates) return;
    const chosen = candidates.filter((_, i) => picked.has(i));
    for (const c of chosen) {
      try {
        await api.subscriptions.create(c);
      } catch {
        /* skip the bad row, keep saving the rest */
      }
    }
    setCandidates(null);
    setPasteText("");
    setPicked(new Set());
    load();
  };

  const formFields = (f: FormState, set: (next: FormState) => void) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <input
        className="input col-span-2"
        placeholder="Name (e.g. Netflix)"
        value={f.name}
        onChange={(e) => set({ ...f, name: e.target.value })}
      />
      <input
        className="input"
        placeholder="Amount"
        type="number"
        min="0"
        step="0.01"
        value={f.amount}
        onChange={(e) => set({ ...f, amount: e.target.value })}
      />
      <input
        className="input"
        placeholder="Currency"
        maxLength={3}
        value={f.currency}
        onChange={(e) => set({ ...f, currency: e.target.value.toUpperCase() })}
      />
      <select
        className="input"
        value={f.cadence}
        onChange={(e) => set({ ...f, cadence: e.target.value as FormState["cadence"] })}
      >
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
        <option value="custom">Custom (days)</option>
      </select>
      {f.cadence === "custom" ? (
        <input
          className="input"
          placeholder="Every N days"
          type="number"
          min="1"
          value={f.cadence_days}
          onChange={(e) => set({ ...f, cadence_days: e.target.value })}
        />
      ) : (
        <input
          className="input"
          type="date"
          title="Next renewal (optional - defaults to one cadence from today)"
          value={f.next_renewal}
          onChange={(e) => set({ ...f, next_renewal: e.target.value })}
        />
      )}
      <input
        className="input"
        placeholder="Category"
        value={f.category}
        onChange={(e) => set({ ...f, category: e.target.value })}
      />
      {f.cadence === "custom" && (
        <input
          className="input"
          type="date"
          title="Next renewal (optional - defaults to one cadence from today)"
          value={f.next_renewal}
          onChange={(e) => set({ ...f, next_renewal: e.target.value })}
        />
      )}
      <input
        className="input col-span-2"
        placeholder="Notes"
        value={f.notes}
        onChange={(e) => set({ ...f, notes: e.target.value })}
      />
    </div>
  );

  const currencies = summary ? Object.entries(summary.by_currency) : [];

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
            <Wallet className="w-4.5 h-4.5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">Finance</h1>
            <p className="text-xs text-gray-500">
              Subscriptions tracker - manual entries, no bank connections
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-ghost">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setAdding((v) => !v)} className="btn-primary">
            <Plus className="w-4 h-4" /> Add subscription
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Summary header */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Monthly burn
          </p>
          <p className="mt-1 text-xl font-semibold text-gray-100 font-mono">
            {currencies.length === 0
              ? "—"
              : currencies.map(([cur, v]) => fmtMoney(v.monthly_burn, cur)).join(" + ")}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Yearly projection
          </p>
          <p className="mt-1 text-xl font-semibold text-gray-100 font-mono">
            {currencies.length === 0
              ? "—"
              : currencies.map(([cur, v]) => fmtMoney(v.yearly_projection, cur)).join(" + ")}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Next renewal
          </p>
          {summary?.next_renewal ? (
            <p className="mt-1 text-sm text-gray-200 flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-accent flex-shrink-0" />
              <span className="truncate">
                {summary.next_renewal.name} ·{" "}
                {fmtMoney(summary.next_renewal.amount, summary.next_renewal.currency)}{" "}
                <span className="text-gray-500">{whenLabel(summary.next_renewal.days_until)}</span>
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-500">—</p>
          )}
        </div>
      </div>

      {/* Add form */}
      {adding && (
        <div className="card p-4 space-y-3">
          {formFields(form, setForm)}
          <div className="flex items-center gap-2">
            <button onClick={submitAdd} className="btn-primary">
              <Check className="w-4 h-4" /> Save
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setForm(EMPTY_FORM);
              }}
              className="btn-ghost"
            >
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {!loading && subs.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No subscriptions yet"
          description="Add one manually, or paste a statement below and let the brain extract them."
        />
      ) : (
        <div className="card overflow-hidden divide-y divide-border">
          {subs.map((s) =>
            editingId === s.id ? (
              <div key={s.id} className="p-4 space-y-3 bg-surface-2/30">
                {formFields(editForm, setEditForm)}
                <div className="flex items-center gap-2">
                  <button onClick={() => submitEdit(s.id)} className="btn-primary">
                    <Check className="w-4 h-4" /> Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="btn-ghost">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={s.id}
                className={`px-4 py-3 flex items-center gap-3 ${s.active ? "" : "opacity-50"}`}
              >
                <button
                  onClick={() => toggleActive(s)}
                  title={s.active ? "Active - click to pause" : "Paused - click to reactivate"}
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    s.active ? "bg-emerald-400" : "bg-gray-600"
                  }`}
                  aria-label={s.active ? "Deactivate" : "Activate"}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 truncate">
                    {s.name}
                    {s.category && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-gray-400">
                        {s.category}
                      </span>
                    )}
                  </p>
                  {s.notes && <p className="text-[11px] text-gray-500 truncate">{s.notes}</p>}
                </div>
                <span className="text-sm font-mono text-gray-200 flex-shrink-0">
                  {fmtMoney(s.amount, s.currency)}
                  <span className="text-gray-500 text-[11px]">
                    /
                    {s.cadence === "custom"
                      ? `${s.cadence_days}d`
                      : s.cadence.slice(0, 2) === "mo"
                        ? "mo"
                        : "yr"}
                  </span>
                </span>
                {s.next_renewal && (
                  <span className="hidden sm:inline text-[11px] text-gray-500 flex-shrink-0 w-24 text-right">
                    {s.next_renewal}
                  </span>
                )}
                <button
                  onClick={() => {
                    setEditingId(s.id);
                    setEditForm(fromRow(s));
                  }}
                  className="p-1.5 text-gray-500 hover:text-gray-200 transition-colors"
                  aria-label="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeSub(s.id)}
                  className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                  aria-label="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          )}
        </div>
      )}

      {/* Paste-to-parse assist */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-gray-200">Paste to extract</h3>
          <span className="text-[11px] text-gray-500">
            bank-statement lines, receipts, an app list - candidates are confirmed before saving
          </span>
        </div>
        <textarea
          className="input w-full h-24 font-mono text-xs"
          placeholder={"10/06 NETFLIX.COM £9.99\n11/06 SPOTIFY £11.99\n..."}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <button onClick={runParse} disabled={parsing || !pasteText.trim()} className="btn-primary">
          <Sparkles className="w-4 h-4" /> {parsing ? "Extracting…" : "Extract subscriptions"}
        </button>
        {parseNote && <p className="text-xs text-amber-400">{parseNote}</p>}
        {candidates && candidates.length > 0 && (
          <div className="space-y-2">
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {candidates.map((c, i) => (
                <label
                  key={i}
                  className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-surface-4"
                >
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                  />
                  <span className="text-sm text-gray-200 flex-1 truncate">{c.name}</span>
                  <span className="text-sm font-mono text-gray-300">
                    {fmtMoney(c.amount, c.currency)}
                    <span className="text-gray-500 text-[11px]">
                      /{c.cadence === "yearly" ? "yr" : "mo"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <button onClick={saveCandidates} disabled={picked.size === 0} className="btn-primary">
              <Check className="w-4 h-4" /> Add {picked.size} selected
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
