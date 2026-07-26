"use client";

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

  return (
    <>
      <a href={dataUrl} download={filename} className="btn btn-primary px-6 py-3">
        Save the page
      </a>

      {support !== "none" && (
        <button onClick={send} disabled={state === "working"} className="btn btn-secondary px-6 py-3">
          {state === "copied" ? (
            <span className="pop inline-block">Copied to clipboard</span>
          ) : support === "share" ? (
            "Send it to someone"
          ) : (
            "Copy image"
          )}
        </button>
      )}
    </>
  );
}
