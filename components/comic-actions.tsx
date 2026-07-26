"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useState, useSyncExternalStore } from "react";

async function toFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

type Support = "share" | "copy" | "none";

let cached: Support | undefined;

/** Probed once per page load; the answer cannot change while the tab is open. */
function detectSupport(): Support {
  if (cached) return cached;

  const canShareFiles =
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([], "probe.png", { type: "image/png" })] });

  cached = canShareFiles ? "share" : "clipboard" in navigator && "ClipboardItem" in window ? "copy" : "none";
  return cached;
}

const subscribe = () => () => {};

/**
 * Save and send.
 *
 * The Web Share sheet is the whole point on a phone: it drops the page straight
 * into iMessage or WhatsApp, which is where a comic about your life actually
 * wants to end up. Desktop browsers rarely support sharing files, so they get
 * copy-to-clipboard instead, and anything older falls back to the download link
 * that is always there.
 */
export function ComicActions({ dataUrl, filename }: { dataUrl: string; filename: string }) {
  const [state, setState] = useState<"idle" | "working" | "copied">("idle");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareState, setShareState] = useState<"idle" | "working" | "copied">("idle");
  const [error, setError] = useState<string | null>(null);

  // Client-only capability, read without an effect: the server snapshot is
  // "none", so nothing renders until hydration knows the real answer.
  const support = useSyncExternalStore<Support>(subscribe, detectSupport, () => "none");

  const send = useCallback(async () => {
    setState("working");
    try {
      if (support === "share") {
        const file = await toFile(dataUrl, filename);
        await navigator.share({
          files: [file],
          title: "My life, drawn",
          text: "My life, drawn by Toonback.",
        });
        setState("idle");
        return;
      }

      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      // A cancelled share sheet throws too; nothing went wrong worth saying.
      setState("idle");
    }
  }, [dataUrl, filename, support]);

  const createShareLink = useCallback(async () => {
    setShareState("working");
    setError(null);
    try {
      const file = await toFile(dataUrl, filename);
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw new Error("Only finished PNG, JPEG, or WebP comics can be shared.");
      const extension =
        file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
      const blob = await upload(`shared/${crypto.randomUUID()}.${extension}`, file, {
        access: "private",
        handleUploadUrl: "/api/share",
        contentType: file.type,
      });
      setShareUrl(
        `${window.location.origin}/api/share?pathname=${encodeURIComponent(blob.pathname)}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setShareState("idle");
    }
  }, [dataUrl, filename]);

  const copyShareLink = useCallback(async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setShareState("copied");
    setTimeout(() => setShareState("idle"), 2000);
  }, [shareUrl]);

  return (
    <div className="contents">
      <a href={dataUrl} download={filename} className="btn btn-primary px-6 py-3">
        Save the page
      </a>

      {support !== "none" && (
        <button onClick={send} disabled={state === "working"} className="btn btn-secondary px-6 py-3">
          {state === "working" ? (
            <span className="flex items-center gap-2">
              <span className="spinner" /> Preparing…
            </span>
          ) : state === "copied" ? (
            <span className="pop inline-block">Copied to clipboard</span>
          ) : support === "share" ? (
            "Send it to someone"
          ) : (
            "Copy image"
          )}
        </button>
      )}

      {shareUrl ? (
        <>
          <button onClick={copyShareLink} className="btn btn-secondary px-6 py-3">
            {shareState === "copied" ? "Link copied" : "Copy share link"}
          </button>
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary px-6 py-3"
          >
            Open share link
          </a>
        </>
      ) : (
        <button
          onClick={createShareLink}
          disabled={shareState === "working"}
          className="btn btn-secondary px-6 py-3 disabled:opacity-50"
        >
          {shareState === "working" ? (
            <span className="flex items-center gap-2">
              <span className="spinner" /> Creating link…
            </span>
          ) : (
            "Create share link"
          )}
        </button>
      )}

      <p className="basis-full text-xs text-muted">
        Share links are public. Anyone with the link can view the finished comic.
      </p>
      {error && <p className="basis-full text-sm text-orange">{error}</p>}
    </div>
  );
}
