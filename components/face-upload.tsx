"use client";

import { useCallback, useRef, useState } from "react";

/** Downscale in the browser: the model needs a face, not a 12 MP photo. */
const MAX_EDGE = 512;
const JPEG_QUALITY = 0.85;

async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser blocked image resizing. Try another browser.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export function FaceUpload({ onChange }: { onChange?: (hasFace: boolean) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        const dataUrl = await shrink(file);
        const res = await fetch("/api/face", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        setPreview(dataUrl);
        onChange?.(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  const remove = useCallback(async () => {
    await fetch("/api/face", { method: "DELETE" });
    setPreview(null);
    onChange?.(false);
  }, [onChange]);

  return (
    <div>
      <div className="flex items-center gap-4">
        <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full border border-edge bg-page">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data: URL
            <img src={preview} alt="Your reference photo" className="pop size-full object-cover" />
          ) : (
            <span className="text-lg text-muted">☺</span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-black text-fg">Your face</p>
          <p className="text-sm text-muted">
            {preview
              ? "The character will be drawn from this photo."
              : "Optional. Without it, the model invents someone."}
          </p>
        </div>

        {preview ? (
          <button onClick={remove} className="btn btn-secondary shrink-0 px-4 py-2 text-sm">
            Replace
          </button>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="btn btn-secondary shrink-0 px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy ? <span className="breathe">Resizing</span> : "Add a photo"}
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {error && <p className="mt-3 text-sm text-orange">{error}</p>}
    </div>
  );
}
