/**
 * @file Vault.tsx
 * @description Knowledge vault sphere-brain view (Phase Ω redesign). The graph
 * is a rotating 3D globe (see components/VaultSphere.tsx): nodes clustered by
 * type inside a wireframe sphere around a glowing core, curved live edges,
 * drag-orbit / zoom-to-core, click selects, double-click focuses the 2-hop
 * neighborhood (?focus=<id> deep link). This page owns the data + chrome:
 * load/WS refresh, brain-lock aware reloads, type filters, search dim, the node
 * detail panel, entity-engine controls and fx diffing, and the Recall panel -
 * old but connected notes resurfaced as active-recall questions (gold in the
 * globe) so knowledge stays alive instead of buried.
 *
 * @author Jarvis (Phase S3, sphere restored Phase Ω)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { VaultSphere } from "../components/VaultSphere";
import type { SphereFx } from "../components/VaultSphere";
import {
  BrainCircuit,
  Search,
  X,
  XCircle,
  Loader2,
  Crosshair,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { MarkdownContent } from "../components/conversation/MarkdownContent";
import { useBrainLockAccess } from "../components/BrainLockGate";
import type {
  VaultGraph,
  VaultNodeDetail,
  VaultEnginePayload,
  VaultEngineResult,
  VaultEngineStatus,
  VaultRecallItem,
  WSMessage,
} from "../lib/types";
import { timeAgo } from "../lib/format";

// Fixed type→slot assignment (entity-stable; never re-assigned by filters).
const TYPE_SLOTS: { type: string; label: string; slot: number }[] = [
  { type: "note", label: "Notes", slot: 1 },
  { type: "project", label: "Projects", slot: 2 },
  { type: "run", label: "Runs", slot: 3 },
  { type: "chat", label: "Chats", slot: 4 },
  { type: "person", label: "People", slot: 5 },
  { type: "capture", label: "Inbox", slot: 6 },
  { type: "reference", label: "Reference", slot: 7 },
  { type: "daily", label: "Daily", slot: 8 },
];

function slotFor(type: string): number {
  const hit = TYPE_SLOTS.find((s) => s.type === type);
  return hit ? hit.slot : 1; // unknown types fold into the note slot
}

// ── Engine-run neural effects (Phase T) ──────────────────────────────────────
// While the entity engine runs, the brain visibly thinks: scanned notes fire,
// synapses flicker, and when the graph refetch lands, brand-new nodes are
// "born" and brand-new edges grow in bright. The state lives in a ref that
// VaultSphere reads each frame; node/edge diffing (not the WS payload) decides
// what is new, so every change animates no matter which event produced it.
// The shape is VaultSphere's exported `SphereFx`.
const HOT_EDGE_MS = 4200;

export function Vault() {
  const { accessRevision } = useBrainLockAccess();
  const fxRef = useRef<SphereFx>({
    active: false,
    graceUntil: 0,
    firing: new Map(),
    hotEdges: new Map(),
  });
  const prevGraphRef = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null);
  const graphRequest = useRef(0);
  const recallRequest = useRef(0);
  const detailRequest = useRef(0);
  const previousAccessRevision = useRef(accessRevision);

  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engineRunning, setEngineRunning] = useState(false);
  const [engineCancelling, setEngineCancelling] = useState(false);
  const [engineStatus, setEngineStatus] = useState<VaultEngineStatus | null>(null);
  const [engineProgress, setEngineProgress] = useState<{
    done: number;
    total: number;
    title: string | null;
  } | null>(null);
  const [engineSummary, setEngineSummary] = useState<VaultEngineResult | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [recall, setRecall] = useState<VaultRecallItem[]>([]);
  const [query, setQuery] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultNodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    title: string;
    type: string;
  } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("focus");

  // ── Data ──────────────────────────────────────────────────────────────────
  const load = useCallback(() => {
    const request = ++graphRequest.current;
    api.vault
      .graph()
      .then((g) => {
        if (request !== graphRequest.current) return;
        setGraph(g);
        setError(null);
      })
      .catch((e) => {
        if (request === graphRequest.current) {
          setError(e instanceof Error ? e.message : "Failed to load vault");
        }
      });
  }, []);

  const loadRecall = useCallback(() => {
    const request = ++recallRequest.current;
    api.vault
      .recall(3)
      .then((response) => {
        if (request === recallRequest.current) setRecall(response.items);
      })
      .catch(() => {
        if (request === recallRequest.current) setRecall([]);
      });
  }, []);

  useEffect(() => {
    if (previousAccessRevision.current !== accessRevision) {
      previousAccessRevision.current = accessRevision;
      detailRequest.current += 1;
      setGraph(null);
      setRecall([]);
      setSelectedId(null);
      setDetail(null);
      setDetailLoading(false);
      prevGraphRef.current = null;
    }
    load();
    loadRecall();
  }, [accessRevision, load, loadRecall]);

  // Live refresh on any vault file change (debounced; positions preserved).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "note_changed") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 800);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // ── Entity engine (Phase T): status, live progress, neural fx triggers ────
  useEffect(() => {
    api.vault
      .engineStatus()
      .then((s) => {
        setEngineStatus(s);
        setEngineRunning(s.running);
        fxRef.current.active = s.running;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "vault_engine") return;
      const d = msg.data as VaultEnginePayload;
      const fx = fxRef.current;
      const now = performance.now();
      if (d.phase === "start") {
        fx.active = true;
        setEngineRunning(true);
        setEngineSummary(null);
        setEngineError(null);
        setEngineProgress({ done: 0, total: d.total ?? 0, title: null });
      } else if (d.phase === "scan" && d.noteId) {
        fx.firing.set(d.noteId, { t0: now, kind: "scan" });
        setEngineProgress((p) => ({
          done: (p?.done ?? 0) + 1,
          total: p?.total ?? 0,
          title: d.title ?? null,
        }));
      } else if ((d.phase === "entities" || d.phase === "linked") && d.noteId) {
        fx.firing.set(d.noteId, { t0: now, kind: "scan" });
      } else if (d.phase === "promoted" && d.noteId) {
        // The node lands in the graph on the next refetch; the diff below
        // re-fires it as a birth then. This entry covers the WS-first case.
        fx.firing.set(d.noteId, { t0: now, kind: "birth" });
      } else if (d.phase === "done") {
        fx.active = false;
        fx.graceUntil = now + 10_000; // late refetch diffs still animate
        setEngineRunning(false);
        setEngineProgress(null);
        setEngineSummary({
          notesScanned: d.notesScanned ?? 0,
          entitiesSeen: d.entitiesSeen ?? 0,
          entitiesCreated: d.entitiesCreated ?? 0,
          notesLinked: d.notesLinked ?? 0,
          errors: d.errors ?? 0,
        });
        api.vault
          .engineStatus()
          .then(setEngineStatus)
          .catch(() => {});
        load();
        loadRecall();
      }
    });
    return unsub;
  }, [load, loadRecall]);

  const runEngine = useCallback(async () => {
    setEngineRunning(true); // optimistic; the WS `start` event confirms
    setEngineSummary(null);
    setEngineError(null);
    try {
      const res = await api.vault.engineRun();
      setEngineSummary(res);
      api.vault
        .engineStatus()
        .then(setEngineStatus)
        .catch(() => {});
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : "Engine run failed");
    } finally {
      setEngineRunning(false);
      setEngineCancelling(false);
      fxRef.current.active = false;
      fxRef.current.graceUntil = performance.now() + 10_000;
    }
  }, []);

  // The pass stops after the note in flight, so this only marks intent - the
  // run's own promise still resolves normally and clears the flag.
  const cancelEngine = useCallback(async () => {
    setEngineCancelling(true);
    try {
      await api.vault.engineCancel();
    } catch {
      setEngineCancelling(false); // 409 = already finished; let the UI recover
    }
  }, []);

  const recallDone = useCallback((id: string) => {
    api.vault.recallSeen(id).catch(() => {});
    setRecall((items) => items.filter((item) => item.id !== id));
  }, []);

  // ── Visible subset (type filter + focus neighborhood + search dim) ────────
  const visible = useMemo(() => {
    if (!graph) return { nodes: [] as VaultGraph["nodes"], edges: [] as VaultGraph["edges"] };
    let nodes = graph.nodes.filter((n) => !hiddenTypes.has(normalizeType(n.type)));
    if (focusId) {
      // Local brain: the focused node + everything within 2 hops.
      const adj = new Map<string, Set<string>>();
      for (const e of graph.edges) {
        if (!adj.has(e.src)) adj.set(e.src, new Set());
        if (!adj.has(e.dst)) adj.set(e.dst, new Set());
        adj.get(e.src)!.add(e.dst);
        adj.get(e.dst)!.add(e.src);
      }
      const keep = new Set<string>([focusId]);
      let frontier = [focusId];
      for (let hop = 0; hop < 2; hop++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const nb of adj.get(id) || []) {
            if (!keep.has(nb)) {
              keep.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
      nodes = nodes.filter((n) => keep.has(n.id));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
    return { nodes, edges };
  }, [graph, hiddenTypes, focusId]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes || []) {
      const t = normalizeType(n.type);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  }, [graph]);

  const matchIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(visible.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, visible]);
  const matchRef = useRef<Set<string> | null>(null);
  matchRef.current = matchIds;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // ── Neural fx diffing (Phase T) ───────────────────────────────────────────
  // While the engine runs (or just ran), anything NEW in this refetch fires:
  // fresh nodes are born, fresh edges grow in hot. VaultSphere reads these off
  // the shared `fx` object each frame and animates them. Layout itself belongs
  // to the sphere, so no force simulation is needed here.
  useEffect(() => {
    const fx = fxRef.current;
    const now = performance.now();
    const nodeIds = new Set(visible.nodes.map((n) => n.id));
    const edgeKeys = new Set(visible.edges.map((e) => `${e.src}|${e.dst}`));
    const prev = prevGraphRef.current;
    if (prev && (fx.active || now < fx.graceUntil)) {
      for (const id of nodeIds) {
        if (!prev.nodes.has(id)) fx.firing.set(id, { t0: now, kind: "birth" });
      }
      for (const key of edgeKeys) {
        if (!prev.edges.has(key)) fx.hotEdges.set(key, now);
      }
    }
    prevGraphRef.current = { nodes: nodeIds, edges: edgeKeys };
    // Prune stale entries (e.g. promoted ids that never materialized).
    for (const [id, f] of fx.firing) if (now - f.t0 > 6000) fx.firing.delete(id);
    for (const [key, t0] of fx.hotEdges) if (now - t0 > HOT_EDGE_MS) fx.hotEdges.delete(key);
  }, [visible]);

  // Recall highlighting: the sphere pulses nodes queued for active recall.
  const recallIds = useMemo(() => new Set(recall.map((r) => r.id)), [recall]);

  // Double-click inside the sphere focuses the local neighborhood, matching the
  // `?focus=<id>` deep link mini-Jarvis emits. A null id clears the focus.
  const onFocus = useCallback(
    (id: string | null) => {
      if (id) setSearchParams({ focus: id });
      else if (focusId) setSearchParams({});
    },
    [focusId, setSearchParams]
  );

  const selectNode = useCallback((id: string) => {
    const request = ++detailRequest.current;
    setSelectedId(id);
    setDetailLoading(true);
    api.vault
      .node(id)
      .then((res) => {
        if (request === detailRequest.current) setDetail(res.node);
      })
      .catch(() => {
        if (request === detailRequest.current) setDetail(null);
      })
      .finally(() => {
        if (request === detailRequest.current) setDetailLoading(false);
      });
  }, []);

  // Deep link: ?focus=<id> also opens the panel for that node.
  useEffect(() => {
    if (focusId) selectNode(focusId);
  }, [focusId, selectNode]);

  const toggleType = (type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const empty = graph !== null && graph.nodes.length === 0;

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      {/* Header: title, search, legend-as-filter */}
      <div className="px-4 pt-4 pb-2 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-base font-medium text-gray-200 flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-accent" /> Vault
            {graph && (
              <span className="text-xs text-gray-500 font-normal">
                {visible.nodes.length} nodes · {visible.edges.length} links
              </span>
            )}
          </h2>
          {focusId && (
            <button
              type="button"
              onClick={() => setSearchParams({})}
              className="btn-secondary gap-1.5 text-xs"
              title="Show the whole vault again"
            >
              <Crosshair className="w-3.5 h-3.5" /> Focused · clear
            </button>
          )}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a node…"
              className="bg-surface-1 border border-border rounded-lg pl-8 pr-7 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/50 w-44 sm:w-56"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Hero CTA — the vault's headline action, framed and glowing. */}
          <div className="ml-auto flex items-center gap-2">
            {engineStatus && !engineRunning && (
              <span className="text-[11px] text-gray-500 text-right leading-tight">
                {engineStatus.promotedEntities}/{engineStatus.totalEntities} entities
                {engineStatus.lastRun ? (
                  <>
                    <br />
                    ran {timeAgo(engineStatus.lastRun)}
                  </>
                ) : (
                  " · never run"
                )}
              </span>
            )}
            <button
              type="button"
              onClick={() => void runEngine()}
              disabled={engineRunning}
              className="btn-primary hud-frame group relative px-5 py-2.5 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              title="Scan new notes, grow entities, and build connections"
            >
              {engineRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <BrainCircuit className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
              )}
              <span className="text-glow">{engineRunning ? "Thinking…" : "Run Neural Engine"}</span>
            </button>
            {engineRunning && (
              <button
                type="button"
                onClick={() => void cancelEngine()}
                disabled={engineCancelling}
                className="btn-ghost px-3 py-2.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-60 disabled:cursor-not-allowed"
                title="Stop after the note currently being processed"
              >
                <XCircle className="w-4 h-4" />
                <span>{engineCancelling ? "Stopping…" : "Cancel"}</span>
              </button>
            )}
          </div>
        </div>
        {/* Legend doubles as the type filter (identity never color-alone). */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {TYPE_SLOTS.filter((s) => (typeCounts.get(s.type) || 0) > 0).map((s) => {
            const off = hiddenTypes.has(s.type);
            return (
              <button
                key={s.type}
                type="button"
                onClick={() => toggleType(s.type)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] transition-colors ${
                  off
                    ? "border-surface-3 text-gray-600 bg-surface-2/40"
                    : "border-border text-gray-300 bg-surface-2"
                }`}
                title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: `var(--chart-${s.slot})`, opacity: off ? 0.3 : 1 }}
                />
                {s.label}
                <span className="text-gray-600">{typeCounts.get(s.type)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-2 text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* The sphere-brain */}
      <div className="relative flex-1 min-h-0 mx-4 mb-4 card overflow-hidden">
        <VaultSphere
          nodes={visible.nodes}
          edges={visible.edges}
          selectedId={selectedId}
          matchIds={matchIds}
          recallIds={recallIds}
          fx={fxRef.current}
          onSelect={(id) => (id ? selectNode(id) : setSelectedId(null))}
          onFocus={onFocus}
          onHover={setHoverInfo}
        />
        {hoverInfo && (
          <div
            className="pointer-events-none absolute z-10 px-2 py-1 rounded-md bg-surface-3/95 border border-border text-[11px] text-gray-200 max-w-56 truncate"
            style={{ left: hoverInfo.x + 12, top: hoverInfo.y + 12 }}
          >
            {hoverInfo.title}
            <span className="ml-1.5 text-gray-500">{hoverInfo.type}</span>
          </div>
        )}
        {/* Engine banner: thinking progress while it runs, result pill after. */}
        {engineRunning && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-1/90 border border-accent/40 text-xs text-gray-200 backdrop-blur-sm max-w-[90%]">
            <BrainCircuit className="w-3.5 h-3.5 text-accent animate-pulse shrink-0" />
            <span className="truncate">
              {engineProgress && engineProgress.total > 0
                ? `Thinking… ${Math.min(engineProgress.done, engineProgress.total)}/${engineProgress.total}${
                    engineProgress.title ? ` · ${engineProgress.title}` : ""
                  }`
                : "Thinking…"}
            </span>
          </div>
        )}
        {!engineRunning && engineSummary && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-1/90 border border-border text-xs text-gray-300 backdrop-blur-sm">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            {engineSummary.entitiesCreated > 0 && `+${engineSummary.entitiesCreated} entities · `}
            {engineSummary.notesLinked} linked · {engineSummary.notesScanned} scanned
            {engineSummary.errors > 0 && ` · ${engineSummary.errors} errors`}
            <button
              type="button"
              onClick={() => setEngineSummary(null)}
              className="text-gray-500 hover:text-gray-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        {!engineRunning && engineError && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30 text-xs text-red-300 backdrop-blur-sm">
            {engineError}
            <button
              type="button"
              onClick={() => setEngineError(null)}
              className="text-red-400 hover:text-red-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        {empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-gray-500 gap-2 px-6">
            <BrainCircuit className="w-8 h-8 text-gray-600" />
            <p className="text-sm">
              The vault is empty. Create notes (with [[wikilinks]]), save chat replies, or turn on
              run summaries in Settings → Knowledge Vault.
            </p>
          </div>
        )}
        {!graph && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {recall.length > 0 && (
          <aside className="absolute z-20 left-3 bottom-3 w-[min(24rem,calc(100%-1.5rem))] rounded-xl border border-amber-400/25 bg-surface-1/95 p-3 shadow-xl backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-200">
                <Sparkles className="h-3.5 w-3.5" /> Recall
              </p>
              <button
                type="button"
                onClick={() => setRecall([])}
                className="text-gray-500 hover:text-gray-200"
                aria-label="Dismiss recall questions"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-2">
              {recall.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-border bg-surface-2/70 p-2.5"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className="block text-left text-xs text-gray-200 hover:text-accent"
                  >
                    {item.question}
                  </button>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] text-gray-500">{item.title}</span>
                    <button
                      type="button"
                      onClick={() => recallDone(item.id)}
                      className="text-[11px] text-amber-200 hover:text-amber-100"
                    >
                      Reviewed
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}

        {/* Node panel: right rail on desktop, bottom sheet on mobile. */}
        {selectedId && (
          <div className="absolute z-20 bg-surface-1/95 border-border backdrop-blur-sm inset-x-0 bottom-0 max-h-[55%] border-t rounded-t-xl md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none md:w-96 md:border-t-0 md:border-l md:rounded-none flex flex-col">
            <div className="flex items-start justify-between gap-2 p-3 border-b border-border">
              <div className="min-w-0">
                <p className="text-sm text-gray-200 font-medium truncate">{detail?.title || "…"}</p>
                <p className="text-[11px] text-gray-500">
                  {detail && (
                    <>
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                        style={{ background: `var(--chart-${slotFor(detail.nodeType)})` }}
                      />
                      {detail.nodeType}
                      {detail.tags.length > 0 && ` · ${detail.tags.join(", ")}`}
                      {` · ${timeAgo(detail.updatedAt)}`}
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {detail?.path && (
                  <a
                    href={`obsidian://open?path=${encodeURIComponent(detail.path)}`}
                    title="Open in Obsidian"
                    className="p-1.5 text-gray-500 hover:text-gray-200"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setSearchParams({ focus: selectedId })}
                  title="Focus the graph on this node's neighborhood"
                  className="p-1.5 text-gray-500 hover:text-gray-200"
                >
                  <Crosshair className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(null);
                    setDetail(null);
                  }}
                  className="p-1.5 text-gray-500 hover:text-gray-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {detailLoading && (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              )}
              {detail && (
                <>
                  {detail.body.trim() ? (
                    <MarkdownContent text={detail.body} />
                  ) : (
                    <p className="text-xs text-gray-600 italic">No content.</p>
                  )}
                  {detail.outgoing.filter((l) => l.resolved).length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">
                        Links to
                      </p>
                      <ul className="space-y-1">
                        {detail.outgoing
                          .filter((l) => l.resolved && l.id)
                          .map((l) => (
                            <li key={`${l.id}-${l.type}`}>
                              <button
                                type="button"
                                onClick={() => selectNode(l.id!)}
                                className="text-xs text-accent hover:underline text-left"
                              >
                                {l.title || l.key}
                              </button>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                  {detail.backlinks.length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">
                        Linked from
                      </p>
                      <ul className="space-y-1">
                        {detail.backlinks.map((b) => (
                          <li key={`${b.id}-${b.type}`}>
                            <button
                              type="button"
                              onClick={() => selectNode(b.id)}
                              className="text-xs text-accent hover:underline text-left"
                            >
                              {b.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeType(t: string): string {
  return TYPE_SLOTS.some((s) => s.type === t) ? t : "note";
}
