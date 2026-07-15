/**
 * @file VaultSphere.tsx
 * @description The vault as a rotating 3D sphere-brain (Phase Ω redesign,
 * "omega prism" style). Three.js scene: a faint lat/long wireframe shell, a
 * glowing crystal core at the center with light rays out to every node, nodes
 * clustered by type inside the sphere via a custom 3D force layout that never
 * fully settles, curved edges that bend and reshape live, pulses racing along
 * them, a starfield for depth. The whole globe slowly rotates; drag to orbit,
 * wheel/pinch to zoom all the way into the core, click a node to select (the
 * camera flies to it), double-click to focus its neighborhood. Labels LOD in
 * as nodes grow on screen. Engine fx (scan/spark/birth flashes, hot edges) and
 * gold recall pulses ride the same maps the 2D view used. Reduced motion:
 * static globe, no pulses/breathing.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VaultEdge, VaultNode } from "../lib/types";

export interface SphereFx {
  active: boolean;
  graceUntil: number;
  firing: Map<string, { t0: number; kind: "scan" | "spark" | "birth" }>;
  hotEdges: Map<string, number>; // "src|dst" → t0
}

interface VaultSphereProps {
  nodes: VaultNode[];
  edges: VaultEdge[];
  selectedId: string | null;
  matchIds: Set<string> | null;
  recallIds: Set<string>;
  /** Stable object identity; mutated externally by the engine-event handlers. */
  fx: SphereFx;
  onSelect: (id: string | null) => void;
  onFocus: (id: string | null) => void;
  onHover: (info: { x: number; y: number; title: string; type: string } | null) => void;
}

const REDUCE_MOTION =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const R = 100; // shell radius (world units)
const EDGE_SEGS = 10; // bezier samples per edge
const FIRE_LIFE = { scan: 1200, spark: 500, birth: 2200 };
const HOT_EDGE_MS = 4200;

const TYPE_SLOT: Record<string, number> = {
  note: 1,
  project: 2,
  run: 3,
  chat: 4,
  person: 5,
  capture: 6,
  reference: 7,
  daily: 8,
};

function slotFor(type: string): number {
  return TYPE_SLOT[type] ?? 1;
}

/** Fibonacci-sphere direction for a type slot - fixed cluster anchors. */
function anchorFor(slot: number): THREE.Vector3 {
  const i = slot - 1;
  const y = 1 - (2 * (i + 0.5)) / 8;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = i * 2.399963;
  return new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)).multiplyScalar(68);
}

function radiusFor(degree: number): number {
  return Math.min(1.1 + Math.sqrt(degree) * 0.4, 4.5);
}

interface N3 {
  id: string;
  title: string;
  type: string;
  degree: number;
  phase: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  anchor: THREE.Vector3;
  glow: number; // smoothed highlight intensity 0..1 (dimmed ↔ lit)
}

interface E3 {
  a: N3;
  b: N3;
  key: string; // "srcId|dstId"
}

/** Faint lat/long wireframe globe. */
function buildShell(): THREE.LineSegments {
  const pts: number[] = [];
  const seg = 64;
  for (let lat = 1; lat < 8; lat++) {
    const phi = (lat / 8) * Math.PI;
    const y = R * Math.cos(phi);
    const r = R * Math.sin(phi);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const b = ((i + 1) / seg) * Math.PI * 2;
      pts.push(r * Math.cos(a), y, r * Math.sin(a), r * Math.cos(b), y, r * Math.sin(b));
    }
  }
  for (let m = 0; m < 12; m++) {
    const th = (m / 12) * Math.PI * 2;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI;
      const b = ((i + 1) / seg) * Math.PI;
      pts.push(
        R * Math.sin(a) * Math.cos(th),
        R * Math.cos(a),
        R * Math.sin(a) * Math.sin(th),
        R * Math.sin(b) * Math.cos(th),
        R * Math.cos(b),
        R * Math.sin(b) * Math.sin(th)
      );
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x8ea6c8,
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
  });
  return new THREE.LineSegments(geo, mat);
}

function buildStars(): THREE.Points {
  const n = 420;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(R * (0.3 + Math.random() * 1.8));
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: 0xaabbdd,
      size: 0.9,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      sizeAttenuation: true,
    })
  );
}

/** White radial falloff texture for node glow sprites. */
function orbTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.6)");
  g.addColorStop(0.5, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radial-gradient sprite texture for the core glow. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255, 235, 240, 1)");
  g.addColorStop(0.25, "rgba(255, 190, 205, 0.55)");
  g.addColorStop(0.6, "rgba(200, 120, 160, 0.14)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One 3D force tick. O(n²) repulsion - fine at personal-vault scale.
 *  ponytail: swap in a grid/octree if the vault ever hits many thousands. */
function tickSim(nodes: N3[], edges: E3[], alpha: number, wander: boolean, t: number) {
  const f = new THREE.Vector3();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    // repulsion
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      f.subVectors(a.p, b.p);
      const d2 = Math.max(4, f.lengthSq());
      if (d2 > 8100) continue;
      const s = (1100 / d2) * alpha;
      f.normalize().multiplyScalar(Math.min(2, s));
      a.v.add(f);
      b.v.sub(f);
    }
    // weak center gravity + type-cluster pull + containment
    a.v.addScaledVector(a.p, -0.0015 * alpha);
    f.subVectors(a.anchor, a.p);
    a.v.addScaledVector(f, 0.016 * alpha); // strong pull to cluster anchor - keeps type-lobes distinct as the vault grows
    const len = a.p.length();
    if (len > R * 0.9) a.v.addScaledVector(a.p, (-0.05 * (len - R * 0.9)) / len);
    if (len < 34) a.v.addScaledVector(a.p, (0.4 * (34 - len)) / Math.max(1, len)); // keep off the core
  }
  // link springs
  for (const e of edges) {
    f.subVectors(e.b.p, e.a.p);
    const d = Math.max(0.1, f.length());
    const s = ((d - 40) / d) * 0.03 * alpha;
    e.a.v.addScaledVector(f, s);
    e.b.v.addScaledVector(f, -s);
  }
  for (const n of nodes) {
    if (wander) {
      n.v.x += Math.sin(t * 0.0007 + n.phase) * 0.006;
      n.v.y += Math.cos(t * 0.0005 + n.phase * 1.7) * 0.006;
      n.v.z += Math.sin(t * 0.0006 + n.phase * 2.3) * 0.006;
    }
    n.v.multiplyScalar(0.86);
    n.v.clampLength(0, 3);
    n.p.add(n.v);
  }
}

export function VaultSphere(props: VaultSphereProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rebuildRef = useRef<((nodes: VaultNode[], edges: VaultEdge[]) => void) | null>(null);

  // ── Scene (once) ──────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    const labelCanvas = labelRef.current;
    if (!mount || !labelCanvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // no WebGL (tests / headless) - the page still works, just no globe
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    mount.appendChild(renderer.domElement);
    renderer.domElement.className = "absolute inset-0 w-full h-full touch-none";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    camera.position.set(0, 55, 255);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.55;
    controls.minDistance = 7; // all the way into the core
    controls.maxDistance = 460;
    controls.enablePan = false;

    const world = new THREE.Group(); // rotates - everything but stars lives here
    scene.add(world);
    world.add(buildShell());
    scene.add(buildStars());

    // Core: glow sprite + crystal + counter-rotating wireframe cage.
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(38);
    world.add(glow);
    const crystal = new THREE.Mesh(
      new THREE.IcosahedronGeometry(5.2, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd9e2, transparent: true, opacity: 0.92 })
    );
    world.add(crystal);
    const cage = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(7.4, 0)),
      new THREE.LineBasicMaterial({
        color: 0xffc7d8,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      })
    );
    world.add(cage);

    // ── Mutable graph state + rebuildable buffers ───────────────────────────
    let nodes3: N3[] = [];
    let edges3: E3[] = [];
    let byId = new Map<string, N3>();
    let neighbors = new Map<string, Set<string>>();
    let alpha = 1;

    const palette: THREE.Color[] = [];
    {
      const styles = getComputedStyle(document.documentElement);
      for (let i = 1; i <= 8; i++) {
        const raw = styles.getPropertyValue(`--chart-${i}`).trim() || "#0d9dc2";
        try {
          palette.push(new THREE.Color(raw));
        } catch {
          palette.push(new THREE.Color(0x0d9dc2));
        }
      }
    }

    let nodeMesh: THREE.InstancedMesh | null = null;
    let haloPoints: THREE.Points | null = null;
    const haloUniforms = {
      uScale: { value: 600 },
      map: { value: orbTexture() },
    };
    let edgeLines: THREE.LineSegments | null = null;
    let rays: THREE.LineSegments | null = null;
    let pulses: THREE.Points | null = null;
    const nodeGeo = new THREE.SphereGeometry(1, 10, 8);
    const dummy = new THREE.Object3D();
    const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

    const disposeGraph = () => {
      for (const obj of [nodeMesh, haloPoints, edgeLines, rays, pulses]) if (obj) world.remove(obj);
      for (const d of disposables.splice(0)) d.dispose();
      nodeMesh = haloPoints = edgeLines = rays = pulses = null;
    };

    const rebuild = (vnodes: VaultNode[], vedges: VaultEdge[]) => {
      const degree = new Map<string, number>();
      for (const e of vedges) {
        degree.set(e.src, (degree.get(e.src) || 0) + 1);
        degree.set(e.dst, (degree.get(e.dst) || 0) + 1);
      }
      const prev = byId;
      byId = new Map();
      nodes3 = vnodes.map((n) => {
        const old = prev.get(n.id);
        const anchor = anchorFor(slotFor(n.type));
        let node: N3;
        if (old) {
          node = old;
          node.title = n.title;
          node.type = n.type;
          node.degree = degree.get(n.id) || 0;
          node.anchor = anchor;
        } else {
          // Births spawn at a linked neighbor when one exists - the edge grows out.
          const linked = vedges.find((e) => e.src === n.id || e.dst === n.id);
          const parent = linked ? prev.get(linked.src === n.id ? linked.dst : linked.src) : null;
          const p = parent
            ? parent.p.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(6))
            : anchor.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(20));
          node = {
            id: n.id,
            title: n.title,
            type: n.type,
            degree: degree.get(n.id) || 0,
            phase: Math.random() * Math.PI * 2,
            p,
            v: new THREE.Vector3(),
            anchor,
            glow: 1,
          };
        }
        byId.set(n.id, node);
        return node;
      });
      edges3 = vedges
        .filter((e) => byId.has(e.src) && byId.has(e.dst))
        .map((e) => ({ a: byId.get(e.src)!, b: byId.get(e.dst)!, key: `${e.src}|${e.dst}` }));
      neighbors = new Map();
      for (const e of edges3) {
        if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, new Set());
        if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, new Set());
        neighbors.get(e.a.id)!.add(e.b.id);
        neighbors.get(e.b.id)!.add(e.a.id);
      }
      alpha = prev.size ? 0.5 : 1;

      disposeGraph();
      if (nodes3.length === 0) return;

      const nMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
      nodeMesh = new THREE.InstancedMesh(nodeGeo, nMat, nodes3.length);
      nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      disposables.push(nMat);
      world.add(nodeMesh);

      // glow sprites behind each node - radial falloff makes them read as orbs
      const hGeo = new THREE.BufferGeometry();
      hGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(nodes3.length * 3), 3)
      );
      hGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nodes3.length * 3), 3));
      hGeo.setAttribute("size", new THREE.BufferAttribute(new Float32Array(nodes3.length), 1));
      const hMat = new THREE.ShaderMaterial({
        uniforms: haloUniforms,
        vertexShader: `
          attribute float size;
          varying vec3 vColor;
          uniform float uScale;
          void main() {
            vColor = color;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * uScale / -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform sampler2D map;
          varying vec3 vColor;
          void main() {
            gl_FragColor = vec4(vColor, 1.0) * texture2D(map, gl_PointCoord);
          }`,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      haloPoints = new THREE.Points(hGeo, hMat);
      disposables.push(hGeo, hMat);
      world.add(haloPoints);

      const eGeo = new THREE.BufferGeometry();
      eGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(edges3.length * EDGE_SEGS * 2 * 3), 3)
      );
      eGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(edges3.length * EDGE_SEGS * 2 * 3), 3)
      );
      const eMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      });
      edgeLines = new THREE.LineSegments(eGeo, eMat);
      disposables.push(eGeo, eMat);
      world.add(edgeLines);

      const rGeo = new THREE.BufferGeometry();
      rGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(nodes3.length * 2 * 3), 3)
      );
      const rMat = new THREE.LineBasicMaterial({
        color: 0xffe0ea,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      rays = new THREE.LineSegments(rGeo, rMat);
      disposables.push(rGeo, rMat);
      world.add(rays);

      if (!REDUCE_MOTION && edges3.length > 0) {
        const pGeo = new THREE.BufferGeometry();
        pGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(edges3.length * 3), 3)
        );
        pGeo.setAttribute(
          "color",
          new THREE.BufferAttribute(new Float32Array(edges3.length * 3), 3)
        );
        const pMat = new THREE.PointsMaterial({
          size: 2.1,
          vertexColors: true,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          sizeAttenuation: true,
        });
        pulses = new THREE.Points(pGeo, pMat);
        disposables.push(pGeo, pMat);
        world.add(pulses);
      }
    };
    rebuildRef.current = rebuild;

    // ── Sizing ────────────────────────────────────────────────────────────────
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      haloUniforms.uScale.value = (h * dpr) / Math.tan((camera.fov * Math.PI) / 360);
      labelCanvas.width = Math.floor(w * dpr);
      labelCanvas.height = Math.floor(h * dpr);
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(mount);

    // ── Picking (screen-space; generous hit radius, no raycaster fiddling) ──
    const wv = new THREE.Vector3();
    const project = (n: N3) => {
      wv.copy(n.p).applyMatrix4(world.matrixWorld).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: ((wv.x + 1) / 2) * rect.width,
        y: ((1 - wv.y) / 2) * rect.height,
        behind: wv.z > 1,
        depth: wv.z,
      };
    };
    const nodeAt = (clientX: number, clientY: number): N3 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best: N3 | null = null;
      let bestD = Infinity;
      for (const n of nodes3) {
        const s = project(n);
        if (s.behind) continue;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < 14 && (d < bestD || (best && s.depth < project(best).depth && d < 10))) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    let hover: N3 | null = null;
    let downAt: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons > 0) return; // orbiting
      const n = nodeAt(e.clientX, e.clientY);
      hover = n;
      renderer.domElement.style.cursor = n ? "pointer" : "grab";
      const rect = renderer.domElement.getBoundingClientRect();
      propsRef.current.onHover(
        n
          ? { x: e.clientX - rect.left, y: e.clientY - rect.top, title: n.title, type: n.type }
          : null
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) {
        downAt = null;
        return;
      }
      downAt = null;
      const n = nodeAt(e.clientX, e.clientY);
      propsRef.current.onSelect(n ? n.id : null);
    };
    const onDblClick = (e: MouseEvent) => {
      const n = nodeAt(e.clientX, e.clientY);
      propsRef.current.onFocus(n ? n.id : null);
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("dblclick", onDblClick);

    // Auto-rotation pauses while the user drags and resumes shortly after.
    let userBusyUntil = 0;
    controls.addEventListener("start", () => {
      userBusyUntil = Infinity;
    });
    controls.addEventListener("end", () => {
      userBusyUntil = performance.now() + 2500;
    });

    // Camera fly-to on selection change (watched in the loop, not React).
    let flownTo: string | null = null;
    const flyTarget = new THREE.Vector3();
    let flying = false;

    // ── Animation loop ────────────────────────────────────────────────────────
    const ctx2d = labelCanvas.getContext("2d");
    const colA = new THREE.Color();
    const colB = new THREE.Color();
    const gold = new THREE.Color(1, 0.78, 0.32);
    const white = new THREE.Color(1, 1, 1);
    const grey = new THREE.Color(0.32, 0.35, 0.4);
    const baseEdge = new THREE.Color(0.22, 0.32, 0.45);
    const litEdge = new THREE.Color(0.55, 0.78, 0.95);
    const hotEdge = new THREE.Color(0.62, 0.92, 1);
    const bez = new THREE.Vector3();
    const ctrl = new THREE.Vector3();
    const mid = new THREE.Vector3();
    let raf = 0;
    let last = performance.now();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(50, now - last);
      last = now;
      const P = propsRef.current;
      const fx = P.fx;

      // sim
      alpha = Math.max(REDUCE_MOTION ? 0 : 0.06, alpha * 0.995);
      if (nodes3.length) tickSim(nodes3, edges3, Math.max(alpha, 0.06), !REDUCE_MOTION, now);

      // globe rotation (paused while interacting or when a node is selected)
      if (!REDUCE_MOTION && now > userBusyUntil && !P.selectedId) {
        world.rotation.y += dt * 0.00005;
      }

      // core life
      const corePulse = REDUCE_MOTION ? 1 : 1 + 0.08 * Math.sin(now / 900);
      glow.scale.setScalar(38 * corePulse * (fx.active ? 1.18 : 1));
      crystal.rotation.y += dt * 0.0004;
      crystal.rotation.x += dt * 0.00013;
      cage.rotation.y -= dt * 0.00025;
      crystal.scale.setScalar(corePulse);

      // engine "thinking": random synapse sparks
      if (fx.active && !REDUCE_MOTION && nodes3.length > 0 && Math.random() < 0.1) {
        const pick = nodes3[(Math.random() * nodes3.length) | 0];
        if (pick && !fx.firing.has(pick.id)) fx.firing.set(pick.id, { t0: now, kind: "spark" });
      }

      const hoverSet = hover ? neighbors.get(hover.id) : null;
      const dimming = !!hover || !!P.matchIds;

      // nodes
      if (nodeMesh) {
        for (let i = 0; i < nodes3.length; i++) {
          const n = nodes3[i]!;
          const isHover = hover?.id === n.id;
          const isSel = P.selectedId === n.id;
          const isNb = hoverSet?.has(n.id) || false;
          const isMatch = P.matchIds ? P.matchIds.has(n.id) : true;
          const lit = isHover || isSel || isNb || (P.matchIds ? isMatch : false);
          const targetGlow = dimming && !lit ? 0.18 : 1;
          n.glow += (targetGlow - n.glow) * 0.15;

          let scale = radiusFor(n.degree);
          if (!REDUCE_MOTION) scale *= 1 + 0.07 * Math.sin(now / 1100 + n.phase);
          // dimmed nodes desaturate to grey (not just darken) so the lit set pops
          const litAmt = THREE.MathUtils.clamp((n.glow - 0.18) / 0.82, 0, 1);
          colA.copy(palette[slotFor(n.type) - 1] || palette[0]!).lerp(grey, 1 - litAmt);
          colA.multiplyScalar(0.3 + 0.7 * n.glow);

          const fire = REDUCE_MOTION ? undefined : fx.firing.get(n.id);
          if (fire) {
            const life = FIRE_LIFE[fire.kind];
            const age = now - fire.t0;
            if (age > life) {
              fx.firing.delete(n.id);
            } else {
              const g = 1 - age / life;
              scale *= 1 + (fire.kind === "birth" ? 1.6 : 0.6) * g;
              colA.lerp(white, 0.75 * g);
            }
          }
          if (P.recallIds.has(n.id) && !REDUCE_MOTION) {
            colA.lerp(gold, 0.45 + 0.35 * Math.sin(now / 500 + n.phase));
          }
          if (isHover || isSel) colA.lerp(white, 0.35);

          if (haloPoints) {
            const hp = haloPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
            const hc = haloPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
            const hs = haloPoints.geometry.getAttribute("size") as THREE.BufferAttribute;
            hp.setXYZ(i, n.p.x, n.p.y, n.p.z);
            hc.setXYZ(i, colA.r * 1.35, colA.g * 1.35, colA.b * 1.35); // brighter than the core - reads as a light source
            hs.setX(i, scale * 3.5);
          }
          // hot core, but keep more hue than before so it reads as a colored light, not a white bead
          colA.lerp(white, 0.22);
          dummy.position.copy(n.p);
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          nodeMesh.setMatrixAt(i, dummy.matrix);
          nodeMesh.setColorAt(i, colA);
        }
        nodeMesh.instanceMatrix.needsUpdate = true;
        if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
        if (haloPoints) {
          for (const attr of ["position", "color", "size"] as const) {
            (haloPoints.geometry.getAttribute(attr) as THREE.BufferAttribute).needsUpdate = true;
          }
        }
      }

      // curved edges (rebuilt every frame - they bend as the sim breathes)
      if (edgeLines) {
        const pos = edgeLines.geometry.getAttribute("position") as THREE.BufferAttribute;
        const col = edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
        let vi = 0;
        for (const e of edges3) {
          mid.addVectors(e.a.p, e.b.p).multiplyScalar(0.5);
          const bow = 0.12 + Math.min(0.22, e.a.p.distanceTo(e.b.p) / 260);
          ctrl.copy(mid).multiplyScalar(1 + bow);
          if (ctrl.lengthSq() < 25) ctrl.set(mid.x, mid.y + 10, mid.z);

          const touching =
            (hover && (e.a.id === hover.id || e.b.id === hover.id)) ||
            (P.selectedId && (e.a.id === P.selectedId || e.b.id === P.selectedId));
          const hotT0 = fx.hotEdges.get(e.key) ?? fx.hotEdges.get(`${e.b.id}|${e.a.id}`);
          let hot = 0;
          if (hotT0 != null) {
            const age = now - hotT0;
            if (age > HOT_EDGE_MS) fx.hotEdges.delete(e.key);
            else hot = 1 - age / HOT_EDGE_MS;
          }
          colB.copy(touching ? litEdge : baseEdge);
          if (!touching && dimming) colB.multiplyScalar(0.35);
          if (hot > 0) colB.lerp(hotEdge, hot).multiplyScalar(1 + hot);

          for (let s = 0; s < EDGE_SEGS; s++) {
            for (const t of [s / EDGE_SEGS, (s + 1) / EDGE_SEGS]) {
              const u = 1 - t;
              bez.set(
                u * u * e.a.p.x + 2 * u * t * ctrl.x + t * t * e.b.p.x,
                u * u * e.a.p.y + 2 * u * t * ctrl.y + t * t * e.b.p.y,
                u * u * e.a.p.z + 2 * u * t * ctrl.z + t * t * e.b.p.z
              );
              pos.setXYZ(vi, bez.x, bez.y, bez.z);
              col.setXYZ(vi, colB.r, colB.g, colB.b);
              vi++;
            }
          }
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
      }

      // core rays - short filaments of light spilling from the crystal, not full lines
      // to every node (at vault scale that reads as a cluttered sunburst, not a glow)
      if (rays) {
        const pos = rays.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < nodes3.length; i++) {
          const n = nodes3[i]!;
          pos.setXYZ(i * 2, 0, 0, 0);
          pos.setXYZ(i * 2 + 1, n.p.x * 0.22, n.p.y * 0.22, n.p.z * 0.22);
        }
        pos.needsUpdate = true;
      }

      // pulses racing along edges
      if (pulses) {
        const pos = pulses.geometry.getAttribute("position") as THREE.BufferAttribute;
        const col = pulses.geometry.getAttribute("color") as THREE.BufferAttribute;
        for (let i = 0; i < edges3.length; i++) {
          const e = edges3[i]!;
          const t = (now / (fx.active ? 1400 : 4200) + i * 0.618) % 1;
          const u = 1 - t;
          mid.addVectors(e.a.p, e.b.p).multiplyScalar(0.5);
          ctrl.copy(mid).multiplyScalar(1.25);
          pos.setXYZ(
            i,
            u * u * e.a.p.x + 2 * u * t * ctrl.x + t * t * e.b.p.x,
            u * u * e.a.p.y + 2 * u * t * ctrl.y + t * t * e.b.p.y,
            u * u * e.a.p.z + 2 * u * t * ctrl.z + t * t * e.b.p.z
          );
          const fade = Math.sin(t * Math.PI) * (dimming ? 0.25 : fx.active ? 1 : 0.7);
          col.setXYZ(i, 0.55 * fade, 0.8 * fade, 1 * fade);
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
      }

      // fly-to on selection change
      if (P.selectedId !== flownTo) {
        flownTo = P.selectedId;
        const n = P.selectedId ? byId.get(P.selectedId) : null;
        flyTarget.copy(n ? n.p.clone().applyMatrix4(world.matrixWorld) : new THREE.Vector3());
        flying = true;
      }
      if (flying) {
        const sel = flownTo ? byId.get(flownTo) : null;
        if (sel) flyTarget.copy(sel.p).applyMatrix4(world.matrixWorld);
        controls.target.lerp(flyTarget, 0.08);
        if (sel) {
          const want = Math.max(controls.minDistance, 62);
          const d = camera.position.distanceTo(controls.target);
          camera.position
            .sub(controls.target)
            .multiplyScalar(1 + ((want - d) / d) * 0.08)
            .add(controls.target);
        }
        if (controls.target.distanceTo(flyTarget) < 0.5) flying = false;
      }

      controls.update();
      renderer.render(scene, camera);

      // labels overlay (LOD by on-screen size; hover/selected/recall always)
      if (ctx2d) {
        const rect = renderer.domElement.getBoundingClientRect();
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx2d.clearRect(0, 0, rect.width, rect.height);
        ctx2d.textAlign = "center";
        const halfH = rect.height / 2;
        const tanFov = Math.tan((camera.fov * Math.PI) / 360);
        const camPos = camera.position;
        ctx2d.font = "11px ui-sans-serif, system-ui, sans-serif";
        for (const n of nodes3) {
          const isKey = hover?.id === n.id || P.selectedId === n.id || P.recallIds.has(n.id);
          const s = project(n);
          if (s.behind) continue;
          const dist = wv.copy(n.p).applyMatrix4(world.matrixWorld).distanceTo(camPos);
          const pxR = (radiusFor(n.degree) * halfH) / (dist * tanFov);
          // Keep the overview quiet; labels emerge only when zoomed in or explicitly targeted.
          if (!isKey && pxR < 12) continue;
          const a = isKey ? 0.95 : Math.min(0.85, (pxR - 12) / 5);
          if (a <= 0.02) continue;
          ctx2d.fillStyle = `rgba(200, 218, 236, ${a * n.glow})`;
          ctx2d.fillText(n.title.slice(0, 30), s.x, s.y + pxR + 11);
        }
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      controls.dispose();
      disposeGraph();
      nodeGeo.dispose();
      glowMat.map?.dispose();
      haloUniforms.map.value.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      rebuildRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data changes → rebuild buffers (positions survive) ────────────────────
  useEffect(() => {
    rebuildRef.current?.(props.nodes, props.edges);
  }, [props.nodes, props.edges]);

  return (
    <div ref={mountRef} className="absolute inset-0 cursor-grab active:cursor-grabbing">
      <canvas ref={labelRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
}
