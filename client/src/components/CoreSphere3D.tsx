/**
 * @file CoreSphere3D.tsx
 * @description The 3D centerpiece of the JARVIS core — a geodesic icosphere
 *   wireframe wrapped in a particle halo, rendered with Three.js. It is alive:
 *   it rotates to follow the cursor (the "head" turns toward you), idles with a
 *   slow drift, and its surface continuously reforms via per-vertex noise whose
 *   amplitude and speed rise with the number of working agents. Colors track
 *   the HUD personality (cyan JARVIS ↔ crimson ULTRON) read straight from the
 *   --hud-accent CSS variable, and ULTRON deforms harder, spikier, faster.
 *
 *   Purely decorative and self-contained: it cleans up its renderer/geometry on
 *   unmount, honors prefers-reduced-motion (renders one static frame), and
 *   never blocks interaction (pointer-events pass through).
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { hudMode } from "../lib/hudMode";

interface CoreSphere3DProps {
  /** Working-agent count — drives deformation amplitude and spin. */
  working: number;
  connected: boolean;
}

/** Read the live --hud-accent CSS triplet ("0 194 232") into a THREE.Color. */
function readAccent(): THREE.Color {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--hud-accent").trim();
    const parts = raw.split(/\s+/).map(Number);
    const r = parts[0] ?? NaN;
    const g = parts[1] ?? NaN;
    const b = parts[2] ?? NaN;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return new THREE.Color(r / 255, g / 255, b / 255);
    }
  } catch {
    /* non-DOM / not ready */
  }
  return new THREE.Color(0, 0.76, 0.91);
}

/** Cheap, dependency-free pseudo-noise for organic vertex displacement. */
function noise(x: number, y: number, z: number, t: number): number {
  return (
    Math.sin(x * 3.1 + t) * 0.5 +
    Math.sin(y * 4.3 - t * 1.3) * 0.3 +
    Math.sin(z * 2.7 + t * 0.7) * 0.2 +
    Math.sin((x + y + z) * 5.0 + t * 1.9) * 0.15
  );
}

export function CoreSphere3D({ working, connected }: CoreSphere3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Live values the animation loop reads without re-initializing the scene.
  const stateRef = useRef({ working, connected, ultron: hudMode.getMode() === "ultron" });
  stateRef.current.working = working;
  stateRef.current.connected = connected;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const width = mount.clientWidth || 260;
    const height = mount.clientHeight || 260;

    // No WebGL (jsdom tests, remote desktops, ancient GPUs) → skip the 3D
    // layer entirely; the SVG rings + backing glow still carry the core.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 3.8;

    // Group everything so the whole core turns toward the cursor together.
    const group = new THREE.Group();
    scene.add(group);

    let accent = readAccent();

    // ── Geodesic icosphere wireframe ──
    const RADIUS = 1;
    const geometry = new THREE.IcosahedronGeometry(RADIUS, 4);
    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const basePositions = new Float32Array(posAttr.array); // cached rest state
    const vertexCount = posAttr.count;

    const wireMat = new THREE.MeshBasicMaterial({
      color: accent,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
    });
    const sphere = new THREE.Mesh(geometry, wireMat);
    group.add(sphere);

    // Glowing nodes at the vertices for the "flower of life" sparkle.
    const nodeMat = new THREE.PointsMaterial({
      color: accent,
      size: 0.03,
      transparent: true,
      opacity: 0.9,
      sizeAttenuation: true,
    });
    const nodes = new THREE.Points(geometry, nodeMat);
    group.add(nodes);

    // ── Particle halo / debris shell around the sphere ──
    const HALO_COUNT = 820;
    const haloGeo = new THREE.BufferGeometry();
    const haloPos = new Float32Array(HALO_COUNT * 3);
    for (let i = 0; i < HALO_COUNT; i++) {
      // Flattened spherical shell → reads as orbiting rings/debris.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      // Two shells: a tight band hugging the sphere + sparse outer drift.
      const r = Math.random() < 0.7 ? 1.18 + Math.random() * 0.35 : 1.5 + Math.random() * 0.45;
      const flatten = 0.4 + Math.random() * 0.55;
      haloPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      haloPos[i * 3 + 1] = r * Math.cos(phi) * flatten;
      haloPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    haloGeo.setAttribute("position", new THREE.BufferAttribute(haloPos, 3));
    const haloMat = new THREE.PointsMaterial({
      color: accent,
      size: 0.022,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Points(haloGeo, haloMat);
    group.add(halo);

    // ── Cursor tracking (the core turns toward the pointer) ──
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      target.x = ny * 0.6; // vertical cursor → pitch
      target.y = nx * 0.9; // horizontal cursor → yaw
    };
    window.addEventListener("pointermove", onPointer);

    // ── Personality color updates on mode flip ──
    const applyAccent = () => {
      accent = readAccent();
      wireMat.color.copy(accent);
      nodeMat.color.copy(accent);
      haloMat.color.copy(accent);
    };
    const unsubMode = hudMode.subscribe((change) => {
      stateRef.current.ultron = change.mode === "ultron";
      // CSS var flips on the same tick; read next frame to be safe.
      requestAnimationFrame(applyAccent);
    });

    // ── Resize ──
    const resize = () => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(mount);

    // ── Render loop ──
    let raf = 0;
    const clock = new THREE.Clock();

    const deform = (t: number) => {
      const { working: w, connected: c, ultron } = stateRef.current;
      const load = Math.min(w, 8) / 8; // 0..1
      const engaged = c && w > 0;
      // Idle: gentle shimmer. Engaged: bigger, faster. ULTRON: harder + spikier.
      const baseAmp = engaged ? 0.06 + load * 0.16 : 0.03;
      const amp = ultron ? baseAmp * 1.7 : baseAmp;
      const freq = ultron ? 1.9 : 1.0;
      for (let i = 0; i < vertexCount; i++) {
        const bx = basePositions[i * 3] ?? 0;
        const by = basePositions[i * 3 + 1] ?? 0;
        const bz = basePositions[i * 3 + 2] ?? 0;
        let d = noise(bx * freq, by * freq, bz * freq, t);
        if (ultron) d = Math.sign(d) * Math.pow(Math.abs(d), 0.7); // sharpen into spikes
        const scale = 1 + amp * d;
        posAttr.setXYZ(i, bx * scale, by * scale, bz * scale);
      }
      posAttr.needsUpdate = true;
    };

    const renderFrame = () => {
      const { working: w, connected: c, ultron } = stateRef.current;
      const t = clock.getElapsedTime();
      const engaged = c && w > 0;
      const spin = (engaged ? 0.12 + (Math.min(w, 8) / 8) * 0.5 : 0.06) * (ultron ? 1.7 : 1);

      deform(t);

      // Ease rotation toward the cursor target, plus a constant idle yaw.
      current.x += (target.x - current.x) * 0.05;
      current.y += (target.y - current.y) * 0.05;
      group.rotation.x = current.x;
      group.rotation.y = current.y + t * spin * 0.35;
      // Halo counter-rotates for parallax depth.
      halo.rotation.y = -t * spin * 0.5;
      halo.rotation.x = t * spin * 0.12;

      renderer.render(scene, camera);
      raf = requestAnimationFrame(renderFrame);
    };

    if (reduceMotion) {
      deform(0);
      renderer.render(scene, camera);
    } else {
      renderFrame();
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      unsubMode();
      ro?.disconnect();
      geometry.dispose();
      haloGeo.dispose();
      wireMat.dispose();
      nodeMat.dispose();
      haloMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden />;
}
