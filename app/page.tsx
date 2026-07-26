"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JsonBlock } from "@/components/json-block";

type Connector = {
  slug: string;
  label: string;
  emoji: string;
  blurb: string;
  connected: boolean;
  toolCount: number;
  inPack: boolean;
};

type ToolResult = {
  name: string;
  connector: string;
  args: Record<string, unknown>;
  status: "ok" | "empty" | "error" | "timeout";
  ms: number;
  text: string;
  truncated: boolean;
};

type Report = {
  toolCount: number;
  results: ToolResult[];
  skipped: { tool: string; reason: string }[];
  unauthenticated: string[];
  options: { windowDays: number; since: string; now: string };
};

const ACCENTS = ["bg-sun", "bg-sky", "bg-mint", "bg-grape", "bg-pop"] as const;

export default function Home() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const [windowDays, setWindowDays] = useState(7);
  const [report, setReport] = useState<Report | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setConnectors(json.connectors);
      setStatusError(null);
      return json.connectors as Connector[];
    } catch (err) {
      setStatusError((err as Error).message);
      return null;
    }
  }, []);

  // Loading this on the server instead would be nicer, but /api/status also
  // *creates* the Merge Registered User and sets its cookie, and Next forbids
  // setting cookies during a Server Component render. So the session is
  // bootstrapped from the client on mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus]);

  /**
   * Magic Link opens in a popup; the OAuth round-trip happens on Merge's domain
   * so we can't listen for it. We poll our own status endpoint instead — a
   * connector counts as connected once its real tools replace `authenticate_*`.
   */
  const connect = useCallback(
    async (slug: string) => {
      const popup = window.open("", "merge-link", "width=520,height=760");
      if (!popup) {
        setStatusError("Popup blocked. Allow popups for this site and try again.");
        return;
      }

      setConnecting(slug);
      try {
        const res = await fetch("/api/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: slug }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? res.statusText);

        popup.location.href = json.url;

        if (pollRef.current) clearInterval(pollRef.current);
        const started = Date.now();
        pollRef.current = setInterval(async () => {
          const fresh = await loadStatus();
          const done = fresh?.find((c) => c.slug === slug)?.connected;
          const expired = Date.now() - started > 5 * 60_000;
          if (done || expired || popup?.closed) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(null);
            if (popup?.closed) loadStatus();
          }
        }, 2500);
      } catch (err) {
        popup.close();
        setStatusError((err as Error).message);
        setConnecting(null);
      }
    },
    [loadStatus],
  );

  const fetchContext = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    setReport(null);
    try {
      const res = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setReport(json);
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setFetching(false);
    }
  }, [windowDays]);

  const anyConnected = connectors?.some((c) => c.connected) ?? false;

  const grouped = useMemo(() => {
    if (!report) return [];
    const map = new Map<string, ToolResult[]>();
    for (const r of report.results) map.set(r.connector, [...(map.get(r.connector) ?? []), r]);
    return [...map.entries()]
      .map(([connector, results]) => ({
        connector,
        results: results.sort((a, b) => a.name.localeCompare(b.name)),
        ok: results.filter((r) => r.status === "ok").length,
        chars: results.reduce((n, r) => n + r.text.length, 0),
      }))
      .sort((a, b) => b.chars - a.chars);
  }, [report]);

  return (
    <main className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
      <header className="mb-12">
        <h1 className="font-[family-name:var(--font-display)] text-5xl leading-none tracking-wide sm:text-7xl">
          <span className="inline-block -rotate-2 bg-pop px-4 py-2 text-paper panel">CORGI</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg font-semibold sm:text-xl">
          Connect the fragmented pieces of your digital life. We turn them into one story
          <span className="whitespace-nowrap">—your week as a comic.</span>
        </p>
      </header>

      {/* ---------------------------------------------------------- connectors */}
      <section className="mb-12">
        <h2 className="mb-4 font-[family-name:var(--font-display)] text-3xl tracking-wide">
          1. Plug in your life
        </h2>

        {statusError && (
          <p className="mb-4 bg-pop px-4 py-3 font-bold text-paper panel-sm">{statusError}</p>
        )}

        {!connectors && !statusError && <p className="font-semibold opacity-70">Looking for your sources…</p>}

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {connectors?.map((c, i) => (
            <article
              key={c.slug}
              className={`flex flex-col justify-between gap-4 p-5 panel ${ACCENTS[i % ACCENTS.length]}`}
            >
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-[family-name:var(--font-display)] text-2xl tracking-wide">
                    <span className="mr-2">{c.emoji}</span>
                    {c.label}
                  </h3>
                  {c.connected && (
                    <span className="shrink-0 bg-ink px-2 py-1 text-xs font-black text-paper">
                      {c.toolCount} tools
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm font-semibold leading-snug">{c.blurb}</p>
              </div>

              {!c.inPack ? (
                <p className="bg-paper/80 px-3 py-2 text-xs font-bold panel-sm">
                  Not in your Tool Pack — add it at ah-eu.merge.dev
                </p>
              ) : c.connected ? (
                <p className="px-1 text-sm font-black">✓ connected</p>
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
      </section>

      {/* -------------------------------------------------------------- fetch */}
      <section className="mb-12">
        <h2 className="mb-4 font-[family-name:var(--font-display)] text-3xl tracking-wide">
          2. Pull your week
        </h2>

        <div className="flex flex-wrap items-center gap-4 bg-paper p-5 panel">
          <div className="flex items-center gap-2">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={`px-3 py-2 text-sm font-black panel-sm ${
                  windowDays === d ? "bg-ink text-paper" : "bg-paper hover:bg-sun"
                }`}
              >
                {d} days
              </button>
            ))}
          </div>

          <button
            onClick={fetchContext}
            disabled={fetching || !anyConnected}
            className="bg-mint px-6 py-3 font-[family-name:var(--font-display)] text-2xl tracking-wide transition-transform panel hover:-translate-y-1 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {fetching ? "Digging through your week…" : "Fetch my context"}
          </button>

          {!anyConnected && connectors && (
            <p className="text-sm font-bold opacity-70">Connect at least one source first.</p>
          )}
        </div>

        {fetchError && <p className="mt-4 bg-pop px-4 py-3 font-bold text-paper panel-sm">{fetchError}</p>}
      </section>

      {/* ------------------------------------------------------------ results */}
      {report && (
        <section>
          <h2 className="mb-4 font-[family-name:var(--font-display)] text-3xl tracking-wide">
            3. What we found
          </h2>

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="tools exposed" value={report.toolCount} />
            <Stat label="tools called" value={report.results.length} />
            <Stat label="returned data" value={report.results.filter((r) => r.status === "ok").length} />
            <Stat
              label="characters"
              value={report.results.reduce((n, r) => n + r.text.length, 0).toLocaleString()}
            />
          </div>

          {report.unauthenticated.length > 0 && (
            <p className="mb-6 bg-sun px-4 py-3 font-bold panel-sm">
              Not authenticated yet: {report.unauthenticated.join(", ")}
            </p>
          )}

          {grouped.length === 0 && (
            <p className="bg-paper px-4 py-3 font-bold panel-sm">
              No tool returned anything. Connect a source, or widen the window.
            </p>
          )}

          <div className="space-y-8">
            {grouped.map((group) => (
              <div key={group.connector}>
                <h3 className="mb-3 inline-block -rotate-1 bg-ink px-3 py-1 font-[family-name:var(--font-display)] text-2xl tracking-wide text-paper">
                  {group.connector} · {group.ok}/{group.results.length} ok
                </h3>

                <div className="space-y-4">
                  {group.results.map((r) => (
                    <article key={r.name} className="bg-paper p-4 panel-sm">
                      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <code className="font-mono text-sm font-black">{r.name}</code>
                        <Badge status={r.status} />
                        <span className="text-xs font-bold opacity-60">
                          {r.ms}ms · {r.text.length.toLocaleString()} chars
                          {r.truncated ? " · truncated" : ""}
                        </span>
                      </header>

                      {Object.keys(r.args).length > 0 && (
                        <p className="mb-2 font-mono text-xs opacity-70">args: {JSON.stringify(r.args)}</p>
                      )}

                      {r.status === "empty" ? (
                        <p className="text-sm font-semibold opacity-60">
                          Call succeeded, nothing in this window.
                        </p>
                      ) : (
                        <JsonBlock text={r.text} />
                      )}
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <details className="mt-8 bg-paper p-4 panel-sm">
            <summary className="cursor-pointer font-black">
              {report.skipped.length} tools skipped — why
            </summary>
            <ul className="mt-3 space-y-1 font-mono text-xs">
              {report.skipped.map((s) => (
                <li key={s.tool}>
                  <span className="font-bold">{s.tool}</span> — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-paper p-3 text-center panel-sm">
      <div className="font-[family-name:var(--font-display)] text-3xl leading-none">{value}</div>
      <div className="mt-1 text-xs font-bold uppercase tracking-wide opacity-60">{label}</div>
    </div>
  );
}

function Badge({ status }: { status: ToolResult["status"] }) {
  const tone =
    status === "ok" ? "bg-mint" : status === "empty" ? "bg-sky" : status === "timeout" ? "bg-sun" : "bg-pop";
  return <span className={`px-2 py-0.5 text-xs font-black ${tone} panel-sm`}>{status}</span>;
}
