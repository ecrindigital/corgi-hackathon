"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/*
 * A stylised corgi, built from primitives rather than loaded from a file.
 *
 * Two reasons it is modelled in code. Every downloadable corgi sits behind an
 * account and an unverifiable licence, and more importantly their heads are
 * fused to their bodies, so "look at the cursor" would swivel the whole dog.
 * Building it here gives a real head group to rig, costs no asset download, and
 * takes its colours from the design system.
 *
 * Plain three, no React Three Fiber: the animation runs on refs inside one rAF
 * loop, so React never re-renders per frame.
 */

const FUR = 0xe0a06a;
const FUR_DARK = 0xc9884f;
const CREAM = 0xfff6ec;
const INK = 0x191919;
const ORANGE = 0xff5c00;

/** How far the head is allowed to turn, in radians. */
const MAX_YAW = 0.62;
const MAX_PITCH = 0.34;

/**
 * Frame-rate independent damping. A plain lerp with a fixed factor moves faster
 * on a 120Hz screen than on a 60Hz one; this converges at the same rate on both.
 */
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

function makeCorgi() {
  const root = new THREE.Group();

  const fur = new THREE.MeshStandardMaterial({ color: FUR, roughness: 0.72, metalness: 0 });
  const furDark = new THREE.MeshStandardMaterial({ color: FUR_DARK, roughness: 0.75, metalness: 0 });
  const cream = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.68, metalness: 0 });
  const ink = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.35, metalness: 0 });

  // ---- body: long and low, which is the entire joke of the breed -----------
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.52, 1.15, 12, 24), fur);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.62;
  root.add(body);

  const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.0, 10, 20), cream);
  belly.rotation.z = Math.PI / 2;
  belly.position.set(0, 0.44, 0.14);
  root.add(belly);

  // ---- legs: four stubs, deliberately too short ---------------------------
  for (const [x, z] of [
    [0.52, 0.3],
    [0.52, -0.3],
    [-0.52, 0.3],
    [-0.52, -0.3],
  ]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.2, 6, 12), furDark);
    leg.position.set(x, 0.19, z);
    root.add(leg);

    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), cream);
    paw.scale.y = 0.7;
    paw.position.set(x, 0.09, z + 0.03);
    root.add(paw);
  }

  // ---- tail ----------------------------------------------------------------
  const tail = new THREE.Group();
  const tailNub = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), fur);
  tailNub.scale.set(0.9, 1.1, 0.9);
  tailNub.position.set(-0.18, 0.1, 0);
  tail.add(tailNub);
  tail.position.set(-0.92, 0.78, 0);
  root.add(tail);

  // ---- head ----------------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0.95, 1.12, 0);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 20), fur);
  skull.scale.set(1, 0.95, 0.94);
  head.add(skull);

  const cheeks = new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 16), cream);
  cheeks.scale.set(0.78, 0.62, 0.9);
  cheeks.position.set(0.22, -0.16, 0);
  head.add(cheeks);

  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), cream);
  muzzle.scale.set(1.1, 0.78, 0.85);
  muzzle.position.set(0.42, -0.12, 0);
  head.add(muzzle);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 12), ink);
  nose.scale.set(0.8, 0.7, 1);
  nose.position.set(0.62, -0.05, 0);
  head.add(nose);

  // Eyes are their own group so they can blink independently of the skull.
  const eyes: THREE.Mesh[] = [];
  for (const z of [0.21, -0.21]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 12), ink);
    eye.position.set(0.38, 0.09, z);
    head.add(eye);
    eyes.push(eye);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), cream);
    glint.position.set(0.42, 0.12, z + (z > 0 ? 0.03 : -0.03));
    head.add(glint);
  }

  // ---- ears: oversized and upright, the other half of the joke -------------
  // Each ear is a group so the inner cone inherits the tilt instead of being
  // positioned by hand, which is what made it poke through the silhouette.
  for (const z of [0.3, -0.3]) {
    const ear = new THREE.Group();
    ear.position.set(-0.02, 0.44, z);
    ear.rotation.x = z > 0 ? 0.24 : -0.24;
    ear.rotation.z = -0.1;

    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.52, 16), fur);
    ear.add(outer);

    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.36, 14), cream);
    inner.position.set(0.08, -0.04, 0);
    ear.add(inner);

    head.add(ear);
  }

  root.add(head);

  // No collar, no bandana. Both tried, both vanished into a body that has no
  // neck to hang them on, and both read as a stray orange smudge. The brand
  // colour reaches the model through the rim light instead, which is enough
  // beside a headline that already says "drawn." in #ff5c00.

  return { root, head, tail, body, eyes };
}

export function Corgi3D({ className = "" }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hasPointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(3.3, 1.85, 4.1);
    camera.lookAt(0.12, 0.8, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearAlpha(0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    scene.add(new THREE.HemisphereLight(0xffffff, 0xf3e9df, 1.15));

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 6, 5);
    scene.add(key);

    // A dim rim in the brand colour, so the model belongs to the palette.
    const rim = new THREE.DirectionalLight(ORANGE, 0.75);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const { root, head, tail, body, eyes } = makeCorgi();
    root.rotation.y = -0.32;
    scene.add(root);

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    // Target angles live in refs, never in state: React must not run per frame.
    const target = { yaw: 0, pitch: 0 };
    const current = { yaw: 0, pitch: 0 };

    const onPointerMove = (event: PointerEvent) => {
      const nx = (event.clientX / window.innerWidth) * 2 - 1;
      const ny = (event.clientY / window.innerHeight) * 2 - 1;
      target.yaw = THREE.MathUtils.clamp(nx * 0.9, -1, 1) * MAX_YAW;
      target.pitch = THREE.MathUtils.clamp(ny * 0.9, -1, 1) * MAX_PITCH;
    };

    if (hasPointer && !reduced) window.addEventListener("pointermove", onPointerMove, { passive: true });

    let frame = 0;
    let last = performance.now();
    let visible = true;
    let nextBlink = 1.5;

    const render = () => renderer.render(scene, camera);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible) return;

      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const t = now / 1000;

      // Damped, so a flicked cursor produces a smooth turn rather than a snap.
      current.yaw = damp(current.yaw, target.yaw, 6, dt);
      current.pitch = damp(current.pitch, target.pitch, 6, dt);

      head.rotation.y = current.yaw;
      head.rotation.z = -current.pitch;
      // The body follows a fraction of the way, the way a real dog leans in.
      root.rotation.y = -0.32 + current.yaw * 0.22;

      body.scale.y = 1 + Math.sin(t * 1.7) * 0.016; // breathing
      tail.rotation.y = Math.sin(t * 5.2) * 0.5; // wag

      // Blink: a quick squash on the eyes every few seconds.
      if (t > nextBlink) {
        const phase = (t - nextBlink) / 0.12;
        if (phase >= 1) {
          nextBlink = t + 2.6 + Math.random() * 2.4;
          for (const eye of eyes) eye.scale.y = 1;
        } else {
          for (const eye of eyes) eye.scale.y = 1 - Math.sin(phase * Math.PI) * 0.9;
        }
      }

      render();
    };

    if (reduced) {
      // One static frame, no loop: the preference is not a suggestion.
      render();
    } else {
      frame = requestAnimationFrame(tick);
    }

    // Stop burning frames when the canvas is off-screen or the tab is hidden.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(mount);
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      last = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);

      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden />;
}
