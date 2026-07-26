"use client";

import { useEffect, useRef } from "react";

/**
 * Dithered gradient, rendered as fine noise.
 *
 * A pure Bayer matrix reads as a crosshatch pattern, which is too graphic to
 * sit behind body copy. Mixing the ordered threshold with a per-pixel hash
 * keeps the density ramp of a dither while breaking the visible grid, so it
 * lands as grain instead of wallpaper.
 *
 * The canvas renders one cell per `pixelSize` CSS pixels and is scaled up with
 * image-rendering: pixelated, which is both the look and the reason it is
 * cheap: a couple of hundred thousand threshold comparisons at 12fps.
 */

// prettier-ignore
const BAYER_8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/** Grain is a texture, not a motion: 12fps reads the same as 60 and costs a fifth. */
const FPS = 12;

/** How much of the threshold comes from the hash rather than the ordered matrix. */
const NOISE_MIX = 0.7;

/** Deterministic per-pixel hash. Random() would shimmer and cost more. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export type DitherProps = {
  className?: string;
  /** CSS pixels per dither cell. 2 is fine grain, 6 is chunky. */
  pixelSize?: number;
  /** 0 to 1, how far the dense end reaches. */
  intensity?: number;
  /**
   * "corner" fades from the top right, "sweep" fills left to right, "grain"
   * lays an even film across the whole surface.
   */
  shape?: "corner" | "sweep" | "grain";
  /** Fill fraction for a static sweep, 0 to 1. */
  progress?: number;
  animated?: boolean;
  color?: [number, number, number];
};

const ORANGE: [number, number, number] = [255, 92, 0];

export function Dither({
  className = "",
  pixelSize = 2,
  intensity = 0.6,
  shape = "corner",
  progress = 1,
  animated = true,
  color = ORANGE,
}: DitherProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The loop reads live values through a ref, so changing intensity or progress
  // never tears down and restarts the animation mid-sweep.
  const props = useRef({ intensity, shape, progress, color });
  useEffect(() => {
    props.current = { intensity, shape, progress, color };
  }, [intensity, shape, progress, color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 1;
    let height = 1;

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      width = Math.max(1, Math.round(rect.width / pixelSize));
      height = Math.max(1, Math.round(rect.height / pixelSize));
      canvas.width = width;
      canvas.height = height;
      return true;
    };

    const draw = (time: number) => {
      const { intensity: amount, shape: form, progress: fill, color: rgb } = props.current;
      const image = ctx.createImageData(width, height);
      const data = image.data;
      const [r, g, b] = rgb;

      // Grain that crawls slowly rather than boiling: one new seed per frame.
      const seed = Math.floor(time * FPS);

      for (let y = 0; y < height; y++) {
        const v = y / height;
        for (let x = 0; x < width; x++) {
          const u = x / width;

          // The value being dithered: 1 is solid, 0 is empty.
          let value: number;
          if (form === "sweep") {
            if (animated) {
              // A print head crossing the panel: dense at the leading edge,
              // fading behind it, then round again.
              const head = ((time * 0.45) % 1.5) - 0.25;
              const behind = head - u;
              value = behind >= 0 ? Math.max(0, 1 - behind * 2.4) * 1.25 : behind > -0.06 ? 1 : 0;
            } else {
              value = (fill - u) * 3;
            }
          } else if (form === "grain") {
            value = amount;
          } else {
            const d = Math.hypot(u - 1.05, v + 0.15);
            value = (1 - d / 1.15) * amount * 2;
          }

          if (value <= 0) continue;

          const ordered = (BAYER_8[(y & 7) * 8 + (x & 7)]! + 0.5) / 64;
          const threshold = ordered * (1 - NOISE_MIX) + hash(x, y, seed) * NOISE_MIX;

          if (value > threshold) {
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
          }
        }
      }

      ctx.putImageData(image, 0, 0);
    };

    if (!measure()) return;

    if (reduced || !animated) {
      draw(0);
      return;
    }

    let frame = 0;
    let last = 0;
    let visible = true;
    const interval = 1000 / FPS;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || now - last < interval) return;
      last = now;
      draw(now / 1000);
    };
    frame = requestAnimationFrame(tick);

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(canvas);

    const resizeObserver = new ResizeObserver(() => {
      if (measure()) draw(performance.now() / 1000);
    });
    resizeObserver.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      resizeObserver.disconnect();
    };
  }, [pixelSize, animated]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ imageRendering: "pixelated", width: "100%", height: "100%", display: "block" }}
      aria-hidden
    />
  );
}
