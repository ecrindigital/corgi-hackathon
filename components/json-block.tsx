"use client";

import { useState } from "react";

const PREVIEW_LINES = 14;

/** Tool output is usually JSON but not guaranteed — pretty-print when we can, show raw when we can't. */
export function JsonBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON; render as-is
  }

  const lines = body.split("\n");
  const clipped = lines.length > PREVIEW_LINES;
  const shown = open || !clipped ? body : lines.slice(0, PREVIEW_LINES).join("\n");

  return (
    <div>
      <pre className="max-h-[28rem] overflow-auto rounded-lg bg-ink/95 p-3 text-xs leading-relaxed text-paper">
        {shown}
        {clipped && !open ? "\n…" : ""}
      </pre>
      {clipped && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 text-xs font-bold underline decoration-2 underline-offset-2 hover:text-pop"
        >
          {open ? "show less" : `show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
