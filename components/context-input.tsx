"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextItemSummary } from "@/lib/context-items";

const MAX_UPLOAD_BYTES = 20_000_000;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_IMAGE_EDGE = 1600;
const ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.markdown,.zip";

function safeName(name: string) {
  return name.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(-120) || "upload";
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (blob && blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error("That image could not be reduced below 1.5 MB.");
}

async function normalizeImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not prepare that image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvasBlob(canvas);
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "image"}.webp`, {
    type: "image/webp",
  });
}

async function errorFrom(response: Response) {
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(json.error ?? response.statusText);
}

export function ContextInput({
  room,
  slot,
  onChange,
}: {
  room: string;
  slot: string;
  onChange?: () => void;
}) {
  const [items, setItems] = useState<ContextItemSummary[]>([]);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"text" | "files" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadItems = useCallback(async () => {
    const response = await fetch("/api/context-items", { cache: "no-store" });
    if (!response.ok) throw await errorFrom(response);
    const json = (await response.json()) as { items: ContextItemSummary[] };
    setItems(json.items);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial server-backed list
    loadItems().catch((err) => {
      setLoading(false);
      setError((err as Error).message);
    });
  }, [loadItems]);

  const finish = useCallback(
    async (response: Response, fallback: string) => {
      if (!response.ok) throw await errorFrom(response);
      const json = (await response.json()) as {
        items: ContextItemSummary[];
        skipped?: number;
      };
      await loadItems();
      onChange?.();
      setMessage(
        json.skipped
          ? `Added ${json.items.length}; skipped ${json.skipped} unsupported or excess archive entries.`
          : fallback,
      );
    },
    [loadItems, onChange],
  );

  const addValue = useCallback(async () => {
    if (!value.trim()) return;
    setBusy("text");
    setError(null);
    setMessage("Reading context…");
    try {
      const response = await fetch("/api/context-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      await finish(response, "Context added.");
      setValue("");
    } catch (err) {
      setMessage(null);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [finish, value]);

  const uploadOne = useCallback(
    async (original: File) => {
      if (!/\.(png|jpe?g|webp|pdf|txt|md|markdown|zip)$/i.test(original.name))
        throw new Error("Supported files are PNG, JPEG, WebP, PDF, TXT, Markdown, and ZIP.");
      const file = await normalizeImage(original);
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 20 MB.`);
      setMessage(file.name.endsWith(".zip") ? `Uploading and unpacking ${file.name}…` : `Uploading ${file.name}…`);

      let response: Response;
      try {
        const pathname = `context-temp/${room}/${slot}/${crypto.randomUUID()}-${safeName(file.name)}`;
        const blob = await upload(pathname, file, {
          access: "private",
          handleUploadUrl: "/api/context-items/upload",
          multipart: file.size > 4_000_000,
          contentType: file.type || "application/octet-stream",
          onUploadProgress: ({ percentage }) =>
            setMessage(`Uploading ${file.name}… ${Math.round(percentage)}%`),
        });
        if (file.name.endsWith(".zip")) setMessage(`Safely unpacking ${file.name}…`);
        response = await fetch("/api/context-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload: { pathname: blob.pathname, name: file.name },
          }),
        });
      } catch (directError) {
        // Local development may intentionally run without Vercel Blob.
        const form = new FormData();
        form.set("file", file);
        response = await fetch("/api/context-items", { method: "POST", body: form });
        if (!response.ok && file.size > 4_000_000) throw directError;
      }
      await finish(response, `${file.name} added.`);
    },
    [finish, room, slot],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy("files");
      setError(null);
      try {
        for (const file of files) await uploadOne(file);
      } catch (err) {
        setMessage(null);
        setError((err as Error).message);
      } finally {
        setBusy(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [uploadOne],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      const response = await fetch(`/api/context-items?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError((await errorFrom(response)).message);
        return;
      }
      await loadItems();
      onChange?.();
      setMessage("Context removed.");
    },
    [loadItems, onChange],
  );

  return (
    <section className="card rise mt-6 p-5">
      <h2 className="text-base">Add anything from your life</h2>
      <p className="mt-1 max-w-2xl text-sm">
        Paste a story or public link, or add screenshots, PDFs, text, Markdown, or ZIP exports.
        <br/>
        Context disappears after one hour.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a memorable exchange, describe what happened, or add a public URL…"
          rows={3}
          maxLength={20_000}
          className="min-h-24 flex-1 resize-y rounded border-2 border-fg bg-card px-3 py-2 text-sm outline-none placeholder:text-muted/70 focus:border-orange"
        />
        <button
          onClick={addValue}
          disabled={Boolean(busy) || !value.trim()}
          className="btn btn-primary self-stretch px-5 py-2.5 text-sm disabled:opacity-40 sm:self-end"
        >
          {busy === "text" ? (
            <span className="flex items-center gap-2">
              <span className="spinner" /> Adding…
            </span>
          ) : (
            "Add context"
          )}
        </button>
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles([...event.dataTransfer.files]);
        }}
        disabled={Boolean(busy)}
        className={`mt-3 w-full rounded border-2 border-dashed px-4 py-4 text-center text-sm font-black transition-colors ${
          dragging ? "border-orange bg-yellow/30" : "border-fg bg-page hover:bg-yellow/15"
        } disabled:opacity-50`}
      >
        {busy === "files" ? (
          <span className="flex items-center justify-center gap-2">
            <span className="spinner" />
            {message ?? "Preparing files…"}
          </span>
        ) : (
          "Drop files here or choose files"
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => addFiles([...(event.target.files ?? [])])}
      />

      {loading ? (
        <div className="mt-4 space-y-3 border-y border-edge py-3" role="status" aria-label="Loading added context">
          <div className="skeleton h-9 rounded" />
          <div className="skeleton h-9 rounded" />
        </div>
      ) : items.length > 0 && (
        <ul className="mt-4 divide-y divide-edge border-y border-edge">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="rounded bg-yellow px-2 py-0.5 font-black uppercase text-fg">
                {item.kind}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-black text-fg">{item.label}</p>
                <p className="truncate text-xs text-muted">
                  {item.preview} · expires at{" "}
                  {new Date(item.expiresAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <button
                onClick={() => remove(item.id)}
                className="shrink-0 text-muted underline decoration-edge underline-offset-4 hover:text-fg"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {message && !busy && (
        <p className="mt-3 text-sm text-muted" aria-live="polite">
          {message}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-orange">{error}</p>}
    </section>
  );
}
