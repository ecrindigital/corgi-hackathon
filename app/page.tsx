"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Connector = {
  slug: string;
  label: string;
  emoji: string;
  blurb: string;
  connected: boolean;
  toolCount: number;
  inPack: boolean;
};

type Comic = {
  image: string;
  brief: string;
  sources: string[];
  toolsUsed: number;
  cost?: number;
  models: { story: string; image: string };
};

type Phase = "welcome" | "connect" | "create";

const ACCENTS = ["bg-sun", "bg-sky", "bg-mint", "bg-grape", "bg-pop"] as const;

export default function Home() {
  const [phase, setPhase] = useState<Phase>("welcome");

  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [comic, setComic] = useState<Comic | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setConnectors(json.connectors);
      return json.connectors as Connector[];
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    // /api/status also creates the Merge Registered User and sets its cookie, and
    // Next forbids setting cookies during a Server Component render — so the
    // session is bootstrapped from the client on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus]);

  /**
   * OAuth happens on Merge's domain in a popup, so nothing calls us back. We
   * poll our own status instead: a connector is live once its real tools
   * replace the `authenticate_*` placeholder.
   */
  const connect = useCallback(
    async (slug: string) => {
      setConnecting(slug);
      setError(null);
      try {
        const res = await fetch("/api/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: slug }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? res.statusText);

        const popup = window.open(json.url, "merge-link", "width=520,height=760");
        const started = Date.now();

        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          const fresh = await loadStatus();
          const done = fresh?.find((c) => c.slug === slug)?.connected;
          if (done || popup?.closed || Date.now() - started > 5 * 60_000) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(null);
          }
        }, 2500);
      } catch (err) {
        setError((err as Error).message);
        setConnecting(null);
      }
    },
    [loadStatus],
  );

  /** One button. Streams NDJSON progress because drawing takes minutes. */
  const createComic = useCallback(async () => {
    setBusy(true);
    setError(null);
    setComic(null);
    setProgress([]);

    try {
      const res = await fetch("/api/comic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays: 7 }),
      });
      if (!res.body) throw new Error("no response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          if (event.message) setProgress((p) => [...p, event.message]);
          if (event.done) setComic(event as Comic);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const connected = connectors?.filter((c) => c.connected) ?? [];

  // ------------------------------------------------------------------ output

  if (comic) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="mb-2 font-[family-name:var(--font-display)] text-4xl tracking-wide sm:text-5xl">
          Your week.
        </h1>
        <p className="mb-6 font-semibold">
          Drawn from {comic.toolsUsed} slices of {comic.sources.join(", ")}.
        </p>

        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, nothing for next/image to optimise */}
        <img src={comic.image} alt="Your week as a comic" className="w-full panel" />

        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href={comic.image}
            download="my-week.png"
            className="bg-mint px-6 py-3 font-[family-name:var(--font-display)] text-2xl tracking-wide transition-transform panel hover:-translate-y-1"
          >
            Download
          </a>
          <button
            onClick={createComic}
            disabled={busy}
            className="bg-paper px-6 py-3 font-[family-name:var(--font-display)] text-2xl tracking-wide transition-transform panel hover:-translate-y-1 disabled:opacity-50"
          >
            Draw it again
          </button>
        </div>

        <details className="mt-8 bg-paper p-4 panel-sm">
          <summary className="cursor-pointer font-black">What the model decided</summary>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{comic.brief}</p>
          <p className="mt-4 text-xs font-bold opacity-60">
            {comic.models.story} → {comic.models.image}
            {comic.cost !== undefined ? ` · $${comic.cost.toFixed(3)}` : ""}
          </p>
        </details>
      </main>
    );
  }

  // ----------------------------------------------------------------- welcome

  if (phase === "welcome") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-12">
        <h1 className="font-[family-name:var(--font-display)] text-6xl leading-none tracking-wide sm:text-8xl">
          <span className="inline-block -rotate-2 bg-pop px-5 py-2 text-paper panel">CORGI</span>
        </h1>

        <p className="mt-8 text-2xl font-bold leading-snug sm:text-3xl">
          Your life is scattered across a dozen apps. We read the last seven days of it and draw you a
          comic about it.
        </p>

        <ol className="mt-8 space-y-3 text-lg font-semibold">
          <li>
            <span className="mr-2 inline-block bg-sun px-2 panel-sm">1</span> Plug in your accounts
          </li>
          <li>
            <span className="mr-2 inline-block bg-sky px-2 panel-sm">2</span> Press one button
          </li>
          <li>
            <span className="mr-2 inline-block bg-mint px-2 panel-sm">3</span> Get your week, drawn
          </li>
        </ol>

        <button
          onClick={() => setPhase("connect")}
          className="mt-10 self-start bg-ink px-8 py-4 font-[family-name:var(--font-display)] text-3xl tracking-wide text-paper transition-transform panel hover:-translate-y-1"
        >
          Start
        </button>
      </main>
    );
  }

  // ----------------------------------------------------------------- connect

  if (phase === "connect") {
    return (
      <main className="mx-auto max-w-4xl px-5 py-12">
        <p className="mb-2 text-sm font-black uppercase tracking-widest opacity-60">Step 1 of 2</p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-wide sm:text-5xl">
          Plug in your life
        </h1>
        <p className="mt-3 max-w-xl font-semibold">
          Connect anything you like. One is enough to start — the more you add, the more the comic is
          actually yours.
        </p>

        {error && <p className="mt-5 bg-pop px-4 py-3 font-bold text-paper panel-sm">{error}</p>}

        {!connectors && !error && <ConnectorSkeleton />}

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {connectors?.map((c, i) => (
            <article
              key={c.slug}
              className={`flex flex-col justify-between gap-4 p-5 panel ${ACCENTS[i % ACCENTS.length]}`}
            >
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-2xl tracking-wide">
                  <span className="mr-2">{c.emoji}</span>
                  {c.label}
                </h2>
                <p className="mt-2 text-sm font-semibold leading-snug">{c.blurb}</p>
              </div>

              {!c.inPack ? (
                <p className="bg-paper/80 px-3 py-2 text-xs font-bold panel-sm">
                  Not in your Tool Pack yet
                </p>
              ) : c.connected ? (
                <p className="px-1 font-black">✓ connected</p>
              ) : (
                <button
                  onClick={() => connect(c.slug)}
                  disabled={connecting === c.slug}
                  className="bg-ink px-4 py-2 font-black text-paper transition-transform panel-sm hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {connecting === c.slug ? "waiting for OAuth…" : "Connect"}
                </button>
              )}
            </article>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button
            onClick={() => setPhase("create")}
            disabled={connected.length === 0}
            className="bg-mint px-8 py-4 font-[family-name:var(--font-display)] text-3xl tracking-wide transition-transform panel hover:-translate-y-1 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            Continue
          </button>
          <p className="font-bold opacity-70">
            {connected.length === 0
              ? "Connect at least one source."
              : `${connected.length} source${connected.length > 1 ? "s" : ""} plugged in.`}
          </p>
        </div>
      </main>
    );
  }

  // ------------------------------------------------------------------ create

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-5 py-12">
      <p className="mb-2 text-sm font-black uppercase tracking-widest opacity-60">Step 2 of 2</p>
      <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-wide sm:text-5xl">
        That&apos;s everything we need.
      </h1>
      <p className="mt-3 font-semibold">
        Reading {connected.map((c) => c.label).join(", ")} — the last 7 days.
      </p>

      <button
        onClick={createComic}
        disabled={busy}
        className="mt-10 self-start bg-pop px-10 py-5 font-[family-name:var(--font-display)] text-4xl tracking-wide text-paper transition-transform panel hover:-translate-y-1 disabled:opacity-60 disabled:hover:translate-y-0"
      >
        {busy ? "Drawing…" : "Create my comic"}
      </button>

      {busy && (
        <p className="mt-4 text-sm font-bold opacity-60">
          Takes two to three minutes. Leave this tab open.
        </p>
      )}

      {progress.length > 0 && (
        <ul className="mt-8 space-y-2">
          {progress.map((line, i) => (
            <li
              key={i}
              className={`bg-paper px-4 py-3 font-semibold panel-sm ${
                i === progress.length - 1 && busy ? "animate-pulse" : ""
              }`}
            >
              {i === progress.length - 1 && busy ? "▸ " : "✓ "}
              {line}
            </li>
          ))}
        </ul>
      )}

      {busy && <ComicSkeleton stage={progress.length} />}

      {error && <p className="mt-6 bg-pop px-4 py-3 font-bold text-paper panel-sm">{error}</p>}

      <button
        onClick={() => setPhase("connect")}
        className="mt-8 self-start text-sm font-bold underline decoration-2 underline-offset-4 hover:text-pop"
      >
        ← plug in more sources
      </button>
    </main>
  );
}

/** Placeholder cards while /api/status resolves — same shape as the real ones. */
function ConnectorSkeleton() {
  return (
    <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {ACCENTS.slice(0, 4).map((accent, i) => (
        <div key={i} className={`animate-pulse p-5 panel ${accent} opacity-60`}>
          <div className="h-7 w-2/3 rounded bg-ink/25" />
          <div className="mt-3 h-4 w-full rounded bg-ink/15" />
          <div className="mt-2 h-4 w-4/5 rounded bg-ink/15" />
          <div className="mt-6 h-10 w-28 rounded bg-ink/25" />
        </div>
      ))}
    </div>
  );
}

/**
 * Two and a half minutes is a long blank screen, so the wait shows the shape of
 * what is coming: an empty comic page whose panels light up as the pipeline
 * moves from reading, to writing, to drawing.
 */
function ComicSkeleton({ stage }: { stage: number }) {
  const panels = ["col-span-2 h-36", "h-28", "h-28", "col-span-2 h-36", "h-28", "h-28"];
  return (
    <div className="mt-8 grid grid-cols-2 gap-3 bg-paper p-3 panel" aria-hidden>
      {panels.map((shape, i) => (
        <div
          key={i}
          className={`${shape} rounded-md border-2 border-dashed border-ink/30 ${
            i < stage * 2 ? "animate-pulse bg-ink/20" : "bg-ink/5"
          }`}
        />
      ))}
    </div>
  );
}
