/**
 * @file Vault.tsx
 * @description Knowledge vault graph-brain view (Phase S3). An interactive
 * force-directed graph over the whole vault (notes, run/chat memories, project
 * hubs) rendered to CANVAS - DOM/SVG won't hold thousands of nodes. Colored
 * clusters by node type (validated --chart-1..8 palette), node radius by
 * degree, hover highlights the neighborhood, click opens a side panel with the
 * markdown body + backlinks, double-click focuses the local neighborhood
 * (?focus=<id> is the deep link mini-Jarvis emits), wheel/pinch zoom, drag pan,
 * node drag, labels fade in as you zoom (LOD, Obsidian-style). Live: refetches
 * on `note_changed` while preserving layout positions. Ambient "alive" motion:
 * edge pulses, per-node breathing, and a never-fully-settling simulation. All
 * motion is disabled under prefers-reduced-motion.
 *
 * @author Jarvis (Phase S3)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3";
import type { Simulation } from "d3";
import { BrainCircuit, Search, X, Loader2, Crosshair, Sparkles, ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { MarkdownContent } from "../components/conversation/MarkdownContent";
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

interface SimNode {
  id: string;
  title: string;
  type: string;
  degree: number;
  phase: number; // stable per-node offset for breathing
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: string | SimNode;
  target: string | SimNode;
  type: string;
}

// Ambient motion (rotation, edge pulses, breathing) honors reduced-motion.
const REDUCE_MOTION =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// Simulation never fully settles: tiny alpha floor keeps nodes drifting.
// ponytail: constant simmer ticks the sim forever; gate on visibility if CPU matters.
const SIMMER = REDUCE_MOTION ? 0 : 0.02;

function slotFor(type: string): number {
  const hit = TYPE_SLOTS.find((s) => s.type === type);
  return hit ? hit.slot : 1; // unknown types fold into the note slot
}

// ── Engine-run neural effects (Phase T) ──────────────────────────────────────
// While the entity engine runs, the brain visibly thinks: scanned notes fire
// (expanding rings), random synapses flicker, edge pulses race, and when the
// graph refetch lands, brand-new nodes are "born" and brand-new edges grow in
// bright from source to target. All state lives in a ref the draw loop reads;
// node/edge diffing (not the WS payload) decides what is new, so every change
// animates no matter which event produced it.
interface EngineFx {
  active: boolean;
  graceUntil: number; // post-run window in which reload diffs still animate
  firing: Map<string, { t0: number; kind: "scan" | "spark" | "birth" }>;
  hotEdges: Map<string, number>; // "src|dst" → t0
}
const FIRE_LIFE = { scan: 1200, spark: 500, birth: 2200 };
const HOT_EDGE_MS = 4200;
const EDGE_GROW_MS = 600;

function radiusFor(degree: number): number {
  return Math.min(3 + Math.sqrt(degree) * 2.2, 14);
}

export function Vault() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const hoverRef = useRef<SimNode | null>(null);
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
  const colorsRef = useRef<string[]>([]);
  const rafRef = useRef<number>(0);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDistRef = useRef<number | null>(null);
  const dragRef = useRef<{ node: SimNode | null; panning: boolean; moved: boolean }>({
    node: null,
    panning: false,
    moved: false,
  });

  const fxRef = useRef<EngineFx>({
    active: false,
    graceUntil: 0,
    firing: new Map(),
    hotEdges: new Map(),
  });
  const prevGraphRef = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null);

  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engineRunning, setEngineRunning] = useState(false);
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
    api.vault
      .graph()
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load vault"));
  }, []);

  const loadRecall = useCallback(() => {
    api.vault
      .recall(3)
      .then((response) => setRecall(response.items))
      .catch(() => setRecall([]));
  }, []);

  useEffect(() => {
    load();
    loadRecall();
  }, [load, loadRecall]);

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
      fxRef.current.active = false;
      fxRef.current.graceUntil = performance.now() + 10_000;
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

  // ── Simulation lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    // Neural fx (Phase T): while the engine runs (or just ran), anything NEW
    // in this refetch fires - fresh nodes are born, fresh edges grow in hot.
    {
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
    }

    const degree = new Map<string, number>();
    for (const e of visible.edges) {
      degree.set(e.src, (degree.get(e.src) || 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) || 0) + 1);
    }
    // Preserve positions of nodes that survive a refresh/filter change.
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const nodes: SimNode[] = visible.nodes.map((n) => {
      const old = prev.get(n.id);
      return {
        id: n.id,
        title: n.title,
        type: normalizeType(n.type),
        degree: degree.get(n.id) || 0,
        phase: old?.phase ?? Math.random() * Math.PI * 2,
        x: old?.x,
        y: old?.y,
        vx: old?.vx,
        vy: old?.vy,
      };
    });
    const edges: SimEdge[] = visible.edges.map((e) => ({
      source: e.src,
      target: e.dst,
      type: e.type,
    }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    const nb = new Map<string, Set<string>>();
    for (const e of visible.edges) {
      if (!nb.has(e.src)) nb.set(e.src, new Set());
      if (!nb.has(e.dst)) nb.set(e.dst, new Set());
      nb.get(e.src)!.add(e.dst);
      nb.get(e.dst)!.add(e.src);
    }
    neighborsRef.current = nb;

    simRef.current?.stop();
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(70)
          .strength(0.5)
      )
      .force("charge", forceManyBody().strength(-140))
      .force("center", forceCenter(0, 0))
      .force(
        "collide",
        forceCollide<SimNode>().radius((d) => radiusFor(d.degree) + 3)
      )
      .alpha(prev.size ? 0.35 : 1)
      .alphaDecay(0.03)
      .alphaTarget(SIMMER);
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [visible]);

  // ── Canvas rendering (rAF loop; sim ticks internally) ────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(document.documentElement);
    colorsRef.current = Array.from(
      { length: 8 },
      (_, i) => styles.getPropertyValue(`--chart-${i + 1}`).trim() || "#0d9dc2"
    );

    const dpr = window.devicePixelRatio || 1;
    // The canvas is absolutely positioned so its bitmap size NEVER feeds back
    // into layout (a sized block canvas toggles the page scrollbar, which
    // resizes the wrap, which re-clears the canvas - an infinite jitter loop).
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      if (transformRef.current.x === 0 && transformRef.current.y === 0) {
        transformRef.current = { x: rect.width / 2, y: rect.height / 2, k: 1 };
      }
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    const draw = () => {
      const now = performance.now();
      const { x: tx, y: ty, k } = transformRef.current;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(tx, ty);
      ctx.scale(k, k);

      const hover = hoverRef.current;
      const selected = selectedRef.current;
      const matches = matchRef.current;
      const hoverSet = hover ? neighborsRef.current.get(hover.id) : null;
      const dimming = !!hover || !!matches;

      // Neural fx (Phase T): while the engine thinks, random synapses flicker
      // across the brain - a spark ring on a random node every few frames.
      const fx = fxRef.current;
      if (fx.active && !REDUCE_MOTION && nodesRef.current.length > 0 && Math.random() < 0.1) {
        const pick = nodesRef.current[(Math.random() * nodesRef.current.length) | 0];
        if (pick && !fx.firing.has(pick.id)) fx.firing.set(pick.id, { t0: now, kind: "spark" });
      }

      // Edges first (recessive).
      ctx.lineWidth = 1 / k;
      for (const e of edgesRef.current) {
        const s = e.source as SimNode;
        const t = e.target as SimNode;
        if (s.x == null || t.x == null) continue;
        const lit = hover && (s.id === hover.id || t.id === hover.id);
        ctx.strokeStyle = lit
          ? "rgba(150, 200, 235, 0.55)"
          : `rgba(90, 130, 170, ${dimming ? 0.08 : 0.18})`;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(t.x, t.y!);
        ctx.stroke();

        // Hot edges (Phase T): a just-created connection grows in bright from
        // source to target - a synapse forming - then cools back to normal.
        if (!REDUCE_MOTION) {
          const hotT0 = fx.hotEdges.get(`${s.id}|${t.id}`) ?? fx.hotEdges.get(`${t.id}|${s.id}`);
          if (hotT0 != null) {
            const age = now - hotT0;
            if (age > HOT_EDGE_MS) {
              fx.hotEdges.delete(`${s.id}|${t.id}`);
              fx.hotEdges.delete(`${t.id}|${s.id}`);
            } else {
              const grow = Math.min(1, age / EDGE_GROW_MS);
              const cool = 1 - Math.max(0, (age - EDGE_GROW_MS) / (HOT_EDGE_MS - EDGE_GROW_MS));
              const hx = s.x + (t.x - s.x) * grow;
              const hy = s.y! + (t.y! - s.y!) * grow;
              ctx.strokeStyle = `rgba(140, 220, 255, ${0.2 + 0.65 * cool})`;
              ctx.lineWidth = (1 + 1.6 * cool) / k;
              ctx.beginPath();
              ctx.moveTo(s.x, s.y!);
              ctx.lineTo(hx, hy);
              ctx.stroke();
              ctx.lineWidth = 1 / k;
              if (grow < 1) {
                // growth cone at the advancing tip
                ctx.fillStyle = "rgba(200, 240, 255, 0.95)";
                ctx.beginPath();
                ctx.arc(hx, hy, 2.6 / k, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
      }

      // Pulses traveling along edges: the vault visibly "building connections".
      if (!REDUCE_MOTION) {
        for (let i = 0; i < edgesRef.current.length; i++) {
          const e = edgesRef.current[i];
          if (!e) continue;
          const s = e.source as SimNode;
          const t = e.target as SimNode;
          if (s.x == null || t.x == null) continue;
          // Golden-ratio offset desynchronizes pulses across edges. While the
          // engine thinks, pulses race ~3x faster and glow brighter.
          const phase = (now / (fx.active ? 1400 : 4000) + i * 0.618) % 1;
          const fade = Math.sin(phase * Math.PI); // bright mid-edge, soft at ends
          ctx.globalAlpha = fade * (dimming ? 0.15 : fx.active ? 0.95 : 0.7);
          ctx.fillStyle = "rgb(150, 205, 240)";
          ctx.beginPath();
          ctx.arc(s.x + (t.x - s.x) * phase, s.y! + (t.y! - s.y!) * phase, 1.6 / k, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Nodes.
      for (const n of nodesRef.current) {
        if (n.x == null || n.y == null) continue;
        const breathe = REDUCE_MOTION ? 1 : 1 + 0.07 * Math.sin(now / 1100 + n.phase);
        const r = radiusFor(n.degree) * breathe;
        const color = colorsRef.current[slotFor(n.type) - 1] || "#0d9dc2";
        const isHover = hover?.id === n.id;
        const isSelected = selected === n.id;
        const isNeighbor = hoverSet?.has(n.id) || false;
        const isMatch = matches ? matches.has(n.id) : true;
        const dim = dimming && !isHover && !isNeighbor && !(matches && isMatch);

        ctx.globalAlpha = dim ? 0.15 : 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isHover || isSelected) {
          ctx.strokeStyle = "rgba(220, 240, 255, 0.9)";
          ctx.lineWidth = 1.5 / k;
          ctx.stroke();
        }

        // Firing neurons (Phase T): scanned notes pulse an expanding ring,
        // random synapses spark, newborn entity nodes flash a double halo.
        const fire = REDUCE_MOTION ? undefined : fx.firing.get(n.id);
        if (fire) {
          const life = FIRE_LIFE[fire.kind];
          const age = now - fire.t0;
          if (age > life) {
            fx.firing.delete(n.id);
          } else {
            const p = age / life;
            const glow = 1 - p;
            const reach = fire.kind === "birth" ? 30 : fire.kind === "scan" ? 16 : 9;
            ctx.strokeStyle = `rgba(160, 225, 255, ${0.85 * glow})`;
            ctx.lineWidth = (fire.kind === "birth" ? 2 : 1.2) / k;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + reach * p, 0, Math.PI * 2);
            ctx.stroke();
            if (fire.kind === "birth") {
              // second trailing halo + a bright core flash while it settles
              ctx.strokeStyle = `rgba(200, 245, 255, ${0.5 * glow})`;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r + reach * p * 0.55, 0, Math.PI * 2);
              ctx.stroke();
              ctx.fillStyle = `rgba(235, 250, 255, ${0.55 * glow})`;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r * (1 + 0.9 * glow), 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.lineWidth = 1 / k;
          }
        }
        ctx.globalAlpha = 1;
      }

      // Labels: LOD - fade in past 1.1x zoom; hovered/selected always labeled.
      const showAll = k > 1.1;
      ctx.font = `${11 / k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      for (const n of nodesRef.current) {
        if (n.x == null || n.y == null) continue;
        const isHover = hover?.id === n.id;
        const isSelected = selected === n.id;
        const isNeighbor = hoverSet?.has(n.id) || false;
        if (!showAll && !isHover && !isSelected && !isNeighbor) continue;
        const dim = dimming && !isHover && !isNeighbor;
        ctx.fillStyle =
          isHover || isSelected
            ? "rgba(226, 238, 248, 0.95)"
            : `rgba(148, 170, 192, ${dim ? 0.25 : 0.8})`;
        ctx.fillText(n.title.slice(0, 32), n.x, n.y + radiusFor(n.degree) + 12 / k);
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
    };
  }, []);

  // ── Hit-testing + interaction ────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y, k } = transformRef.current;
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k };
  };

  const nodeAt = (clientX: number, clientY: number): SimNode | null => {
    const p = toWorld(clientX, clientY);
    const k = transformRef.current.k;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      // Hit target bigger than the mark (min ~10px screen-space).
      const hit = Math.max(radiusFor(n.degree), 10 / k);
      if (d < hit && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  };

  const dragTo = (n: SimNode, clientX: number, clientY: number) => {
    const w = toWorld(clientX, clientY);
    n.fx = w.x;
    n.fy = w.y;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size > 1) return; // pinch handled in move
    const n = nodeAt(e.clientX, e.clientY);
    dragRef.current = { node: n, panning: !n, moved: false };
    if (n) {
      simRef.current?.alphaTarget(0.25).restart();
      dragTo(n, e.clientX, e.clientY);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointersRef.current.get(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Pinch zoom (two pointers): scale by the change in pointer distance.
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const prevDist = pinchDistRef.current;
      pinchDistRef.current = dist;
      if (prevDist && prevDist > 0) {
        const rect = canvasRef.current!.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, dist / prevDist);
      }
      return;
    }
    pinchDistRef.current = null;

    if (dragRef.current.node) {
      dragTo(dragRef.current.node, e.clientX, e.clientY);
      dragRef.current.moved = true;
      return;
    }
    if (dragRef.current.panning && prev && e.buttons > 0) {
      transformRef.current.x += e.clientX - prev.x;
      transformRef.current.y += e.clientY - prev.y;
      dragRef.current.moved = true;
      return;
    }

    // Hover (no buttons held).
    const n = nodeAt(e.clientX, e.clientY);
    hoverRef.current = n;
    if (n) {
      const rect = canvasRef.current!.getBoundingClientRect();
      setHoverInfo({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        title: n.title,
        type: n.type,
      });
    } else {
      setHoverInfo(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchDistRef.current = null;
    const { node, moved } = dragRef.current;
    if (node) {
      node.fx = null;
      node.fy = null;
      simRef.current?.alphaTarget(SIMMER);
      if (!moved) selectNode(node.id);
    } else if (!moved) {
      // Tap on empty space clears the selection.
      setSelectedId(null);
      setDetail(null);
    }
    dragRef.current = { node: null, panning: false, moved: false };
  };

  /** Zoom keeping the canvas-relative point (px,py) stationary. */
  const zoomAt = (px: number, py: number, factor: number) => {
    const t = transformRef.current;
    const k = Math.min(4, Math.max(0.12, t.k * factor));
    const wx = (px - t.x) / t.k;
    const wy = (py - t.y) / t.k;
    t.k = k;
    t.x = px - wx * k;
    t.y = py - wy * k;
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0015, -e.deltaY));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const n = nodeAt(e.clientX, e.clientY);
    if (n) {
      setSearchParams({ focus: n.id });
    } else if (focusId) {
      setSearchParams({});
    }
  };

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    api.vault
      .node(id)
      .then((res) => setDetail(res.node))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
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

      {/* The brain */}
      <div ref={wrapRef} className="relative flex-1 min-h-0 mx-4 mb-4 card overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
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
