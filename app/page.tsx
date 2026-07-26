"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ComicActions } from "@/components/comic-actions";
import { ContextInput } from "@/components/context-input";
import { Dither } from "@/components/dither";
import { FaceUpload } from "@/components/face-upload";

// WebGL has no business running during SSR, and three should not sit in the
// bundle for anyone who never reaches the welcome screen.
const Corgi3D = dynamic(() => import("@/components/corgi-3d").then((m) => m.Corgi3D), { ssr: false });

type Connector = {
  slug: string;
  label: string;
  blurb: string;
  connected: boolean;
  toolCount: number;
  inPack: boolean;
};

type Participant = {
  slot: string;
  isYou: boolean;
  connectors: string[];
  contextCount: number;
  hasFace: boolean;
};

type Status = { room: string; slot: string; connectors: Connector[]; participants: Participant[] };

type TimeRange = "week" | "month" | "lifetime";

type Comic = {
  devMode: boolean;
  image: string;
  brief: string;
  sources: string[];
  toolsUsed: number;
  people: number;
  faces: number;
  range: TimeRange;
  cost?: number;
  models: { story: string; image: string };
};

type Phase = "welcome" | "connect" | "create" | "result";

const RANGES: { id: TimeRange; label: string; hint: string }[] = [
  { id: "week", label: "Last week", hint: "7 days" },
  { id: "month", label: "Last month", hint: "30 days" },
  { id: "lifetime", label: "Lifetime", hint: "Your entire life" },
];

/** Entrance stagger. Small enough to read as one gesture, not a queue. */
const STEP = 50;
const delay = (i: number) => ({ animationDelay: `${i * STEP}ms` });

export default function Home() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [status, setStatus] = useState<Status | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [range, setRange] = useState<TimeRange>("week");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [devMode, setDevMode] = useState(false);

  /**
   * Every take this session, newest first. Regenerating used to throw the
   * previous page away, which is the wrong instinct: two takes of the same story
   * are worth comparing, and one of them is usually the keeper.
   */
  const [takes, setTakes] = useState<Comic[]>([]);
  const [active, setActive] = useState(0);
  const comic = takes[active] ?? null;

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setStatus(json);
      return json as Status;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  /** A ?join=CODE link puts this browser in someone else's room as person B. */
  const bootstrap = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("join");
    setDevMode(["true", "1"].includes(params.get("dev") ?? ""));
    if (code) {
      await fetch("/api/room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }).catch(() => {});
      params.delete("join");
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${params.size ? `?${params}` : ""}`,
      );
      setPhase("connect");
    }
    await loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    // /api/status also creates the Merge Registered User and sets the room
    // cookie, and Next forbids setting cookies during a Server Component
    // render, so the session is bootstrapped from the client on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    bootstrap();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [bootstrap]);

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
          const done = fresh?.connectors.find((c) => c.slug === slug)?.connected;
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

  /** One button. Streams NDJSON progress so the wait shows its work. */
  const createComic = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress([]);

    try {
      const res = await fetch(`/api/comic${devMode ? "?dev=true" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ range }),
      });
      if (!res.body) throw new Error("The server closed the connection. Try again.");

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
          if (event.done) {
            setTakes((t) => [event as Comic, ...t]);
            setActive(0);
            setPhase("result");
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [devMode, range]);

  const copyInvite = useCallback(async () => {
    if (!status) return;
    const params = new URLSearchParams({ join: status.room });
    if (devMode) params.set("dev", "true");
    await navigator.clipboard.writeText(`${window.location.origin}/?${params}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [devMode, status]);

  const connected = status?.connectors.filter((c) => c.connected) ?? [];
  const mine = status?.participants.find((p) => p.isYou);
  const contextCount = mine?.contextCount ?? 0;
  const ready =
    status?.participants.filter((p) => p.connectors.length > 0 || p.contextCount > 0) ?? [];
  const partner = status?.participants.find(
    (p) => !p.isYou && (p.connectors.length > 0 || p.contextCount > 0),
  );

  // ------------------------------------------------------------------ output

  if (phase === "result" && comic) {
    return (
      <Shell devMode={devMode} onHome={() => setPhase("welcome")}>
        <div className="mx-auto max-w-3xl px-6 py-14">
          <div className="rise" style={delay(0)}>
            <Eyebrow>
              {comic.devMode
                ? "DEV PLACEHOLDER"
                : RANGES.find((r) => r.id === comic.range)?.label ?? comic.range}
            </Eyebrow>
            <h1 className="mt-3 text-4xl sm:text-5xl">
              {comic.people > 1 ? "Your lives. Drawn together." : "Your life, drawn."}
            </h1>
            <p className="mt-3 max-w-xl">
              Drawn from {comic.toolsUsed} pieces of {comic.sources.join(", ")}
              {comic.faces > 0 && `, with ${comic.faces > 1 ? "your faces" : "your face"}`}.
            </p>
          </div>

          {/* The one loud thing on the page, and the only long curve in it. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, nothing for next/image to optimise */}
          <img
            src={comic.image}
            alt="Your life as a comic"
            className="reveal mt-8 w-full rounded-xl border border-edge"
            style={delay(2)}
          />

          {/* Keep it, send it, or go again. */}
          <div className="rise mt-6 flex flex-wrap gap-3" style={delay(5)}>
            <ComicActions
              dataUrl={comic.image}
              filename={comic.devMode ? "dev-placeholder.svg" : "my-life-drawn.png"}
            />
          </div>

          <div className="rise mt-8 border-t border-edge pt-6" style={delay(6)}>
            <Eyebrow>Go again</Eyebrow>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                onClick={createComic}
                disabled={busy}
                className="btn btn-secondary px-5 py-2.5 text-sm disabled:opacity-50"
              >
                {busy ? <span className="breathe">Drawing</span> : "Same story, new take"}
              </button>
              <button
                onClick={() => setPhase("create")}
                className="btn btn-secondary px-5 py-2.5 text-sm"
              >
                Change the period or my face
              </button>
              <button
                onClick={() => setPhase("connect")}
                className="btn btn-secondary px-5 py-2.5 text-sm"
              >
                Add another source
              </button>
            </div>

            {busy && (
              <ol className="mt-5 divide-y divide-edge border-y border-edge">
                {progress.map((line, i) => {
                  const current = i === progress.length - 1;
                  return (
                    <li key={i} className="rise flex items-center gap-3 py-2.5 text-sm">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${current ? "breathe bg-orange" : "bg-line"}`}
                        aria-hidden
                      />
                      <span className={current ? "text-fg" : ""}>{line}</span>
                    </li>
                  );
                })}
              </ol>
            )}

            {error && <Notice>{error}</Notice>}
          </div>

          {/* Earlier takes stay reachable: one of them is usually the keeper. */}
          {takes.length > 1 && (
            <div className="rise mt-8" style={delay(7)}>
              <Eyebrow>
                {takes.length} takes of this story
              </Eyebrow>
              <div className="mt-3 flex flex-wrap gap-3">
                {takes.map((t, i) => (
                  <button
                    key={i}
                    onClick={() => setActive(i)}
                    aria-pressed={i === active}
                    aria-label={`Take ${takes.length - i}`}
                    className={`overflow-hidden rounded-xl border transition-colors duration-150 ${
                      i === active ? "border-orange" : "border-edge hover:border-ink"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- data: URL */}
                    <img src={t.image} alt="" className="h-24 w-16 object-cover object-top" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <details className="card rise mt-8 p-5" style={delay(8)}>
            <summary className="font-black text-fg">
              What the model decided
            </summary>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">{comic.brief}</p>
            <p className="mt-5 text-xs text-muted">
              {comic.models.story} → {comic.models.image}
              {comic.cost !== undefined ? ` · $${comic.cost.toFixed(3)}` : ""}
            </p>
          </details>
        </div>
      </Shell>
    );
  }

  // ----------------------------------------------------------------- welcome

  if (phase === "welcome") {
    return (
      <Shell devMode={devMode} onHome={() => setPhase("welcome")}>
        <div className="mx-auto flex min-h-[calc(100dvh-57px)] max-w-3xl flex-col justify-center px-6 py-6 sm:py-8">
          <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:items-center sm:gap-6">
            <h1 className="rise text-5xl leading-[1.05] sm:text-7xl" style={delay(0)}>
              Your life,
              <br />
              <span className="text-orange">drawn.</span>
            </h1>

            <Corgi3D className="pop size-36 shrink-0 sm:size-48" />
          </div>

          <p className="rise mt-4 max-w-lg text-lg" style={delay(1)}>
            Your life is scattered across a dozen apps. Toonback reads it and turns it into a comic. One
            page, your story, nobody else&apos;s.
          </p>

          <ol className="mt-6 max-w-lg divide-y divide-edge border-y border-edge">
            {[
              ["Connect", "Plug in the accounts you want it to read."],
              ["Add your face", "Optional, alone or with someone else."],
              ["Press one button", "About a minute later, your page is drawn."],
            ].map(([title, detail], i) => (
              <li key={title} className="rise flex gap-4 py-2.5" style={delay(2 + i)}>
                <span className="w-5 shrink-0 font-black text-sm text-orange">
                  {i + 1}
                </span>
                <div>
                  <p className="font-black text-fg">{title}</p>
                  <p className="text-sm">{detail}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="rise" style={delay(5)}>
            <button
              onClick={() => setPhase("connect")}
              className="btn btn-primary mt-6 px-8 py-3.5 text-lg"
            >
              Get started
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // ----------------------------------------------------------------- connect

  if (phase === "connect") {
    return (
      <Shell devMode={devMode} step="1 of 2" room={status?.room} onHome={() => setPhase("welcome")}>
        <div className="mx-auto max-w-4xl px-6 py-14">
          <div className="rise" style={delay(0)}>
            <Eyebrow>Sources</Eyebrow>
            <h1 className="mt-3 text-3xl sm:text-4xl">Plug in your life</h1>
            <p className="mt-3 max-w-xl">
              One source is enough to start. Every one you add makes the story more yours.
            </p>
          </div>

          {error && <Notice>{error}</Notice>}

          {status && (
            <ContextInput room={status.room} slot={status.slot} onChange={() => loadStatus()} />
          )}

          {!status && !error ? (
            <ConnectorSkeleton />
          ) : (
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {status?.connectors.map((c, i) => (
                <article
                  key={c.slug}
                  className={`rise flex items-start gap-4 rounded-xl border p-5 transition-colors duration-200 ${
                    c.connected
                      ? "border-orange bg-orange text-card"
                      : "card card-interactive"
                  }`}
                  style={delay(1 + i)}
                >
                  <ConnectorLogo connector={c} />

                  <div className="min-w-0 flex-1">
                    <h2 className={`text-base ${c.connected ? "text-card" : ""}`}>{c.label}</h2>
                    {c.blurb && (
                      <p className={`mt-1 text-sm ${c.connected ? "text-card/85" : ""}`}>{c.blurb}</p>
                    )}
                  </div>

                  {c.connected ? (
                    // Mounts the moment polling sees the credential land. The
                    // pop is the only confirmation the popup ever gives you.
                    <span className="pop flex shrink-0 items-center gap-2 text-sm text-card">
                      <span className="size-2 rounded-full bg-card" aria-hidden />
                      {c.toolCount} tools
                    </span>
                  ) : (
                    <button
                      onClick={() => connect(c.slug)}
                      disabled={connecting === c.slug}
                      className="btn btn-secondary shrink-0 px-4 py-2 text-sm disabled:opacity-50"
                    >
                      {connecting === c.slug ? (
                        <span className="breathe">Waiting</span>
                      ) : (
                        "Connect"
                      )}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}

          {/* ---------------------------------------------------------- duo */}
          <section className="card rise mt-6 p-5" style={delay(4)}>
            <h2 className="text-base">Make it a duo</h2>
            <p className="mt-1 max-w-xl text-sm">
              Send this link to someone. They connect their own accounts, and the story goes looking for
              where your two lives collide.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="rounded-xl border border-edge bg-page px-4 py-2.5 font-mono text-sm tracking-widest text-fg">
                {status?.room ?? "······"}
              </code>
              <button
                onClick={copyInvite}
                disabled={!status}
                className="btn btn-secondary px-4 py-2.5 text-sm disabled:opacity-50"
              >
                {copied ? <span className="pop inline-block">Copied</span> : "Copy invite link"}
              </button>
              <p className="text-sm">
                {partner ? (
                  <span className="pop inline-block">
                    Someone joined with{" "}
                    {partner.connectors.length + (partner.contextCount > 0 ? 1 : 0)} source
                    {partner.connectors.length + (partner.contextCount > 0 ? 1 : 0) > 1 ? "s" : ""}.
                  </span>
                ) : (
                  "Nobody yet. Solo works fine."
                )}
              </p>
            </div>
          </section>

          <div className="rise mt-10 flex flex-wrap items-center gap-4 border-t border-edge pt-8" style={delay(5)}>
            <button
              onClick={() => setPhase("create")}
              disabled={connected.length === 0 && contextCount === 0}
              className="btn btn-primary px-7 py-3 disabled:opacity-40"
            >
              Continue
            </button>
            <p className="text-sm">
              {connected.length === 0 && contextCount === 0
                ? "Add context or connect at least one source to continue."
                : `${connected.length + (contextCount > 0 ? 1 : 0)} source${
                    connected.length + (contextCount > 0 ? 1 : 0) > 1 ? "s" : ""
                  } ready.`}
            </p>
            {takes.length > 0 && (
              <button
                onClick={() => setPhase("result")}
                className="text-sm text-muted underline decoration-edge underline-offset-4 transition-colors duration-150 hover:text-fg"
              >
                Back to your comic
              </button>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  // ------------------------------------------------------------------ create

  return (
    <Shell devMode={devMode} step="2 of 2" room={status?.room} onHome={() => setPhase("welcome")}>
      <div className="mx-auto max-w-2xl px-6 py-14">
        <div className="rise" style={delay(0)}>
          <Eyebrow>Ready</Eyebrow>
          <h1 className="mt-3 text-3xl sm:text-4xl">
            {ready.length > 1 ? "Two of you. One comic." : "Let’s turn this into a comic."}
          </h1>
          <p className="mt-3">
            Currently reading{" "}
            {[...connected.map((c) => c.label), ...(contextCount ? ["your added context"] : [])].join(
              ", ",
            )}
            .
          </p>
        </div>

        <div className="card rise mt-8 p-5" style={delay(1)}>
          <FaceUpload onChange={() => loadStatus()} />
        </div>

        <div className="rise mt-6" style={delay(2)}>
          <Eyebrow>How far back</Eyebrow>

          <div className="relative mt-3 grid grid-cols-3 gap-1 rounded-xl border border-edge p-2 sm:inline-grid sm:w-auto">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                aria-pressed={range === r.id}
                className={`btn px-3 py-2 text-center text-sm transition-colors duration-200 ${
                  range === r.id ? "bg-orange text-card" : "text-muted hover:text-fg"
                }`}
              >
                {r.label}
                <span className="block text-[11px] opacity-60">{r.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rise" style={delay(3)}>
          <button
            onClick={createComic}
            disabled={busy}
            className="btn btn-primary mt-8 w-full px-8 py-4 text-lg disabled:opacity-60 sm:w-auto"
          >
            {busy ? <span className="breathe">Drawing</span> : "Create my comic"}
          </button>
        </div>

        {busy && <p className="rise mt-3 text-sm text-muted">About a minute. Keep this tab open.</p>}

        {progress.length > 0 && (
          <ol className="mt-8 divide-y divide-edge border-y border-edge">
            {progress.map((line, i) => {
              const current = i === progress.length - 1 && busy;
              return (
                <li key={i} className="rise flex items-center gap-3 py-3 text-sm">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      current ? "breathe bg-orange" : "bg-line"
                    }`}
                    aria-hidden
                  />
                  <span className={current ? "text-fg" : ""}>{line}</span>
                </li>
              );
            })}
          </ol>
        )}

        {busy && <DrawingProgress stage={progress.length} />}

        {error && <Notice>{error}</Notice>}

        <div className="mt-8 flex flex-wrap gap-5 text-sm">
          <button
            onClick={() => setPhase("connect")}
            className="text-muted underline decoration-edge underline-offset-4 transition-colors duration-150 hover:text-fg"
          >
            Back to sources
          </button>
          {takes.length > 0 && (
            <button
              onClick={() => setPhase("result")}
              className="text-muted underline decoration-edge underline-offset-4 transition-colors duration-150 hover:text-fg"
            >
              Back to your comic
            </button>
          )}
        </div>
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */

function Shell({
  children,
  step,
  room,
  devMode,
  onHome,
}: {
  children: React.ReactNode;
  step?: string;
  room?: string;
  devMode?: boolean;
  onHome: () => void;
}) {
  return (
    <>
      <div className="pointer-events-none fixed inset-0 -z-10 opacity-[0.16] [mask-image:radial-gradient(100%_80%_at_100%_0%,black_0%,transparent_62%)]">
        <Dither pixelSize={2} intensity={0.35} />
      </div>
      <div className="pointer-events-none fixed inset-0 -z-10 rotate-180 opacity-[0.16] [mask-image:radial-gradient(100%_80%_at_100%_0%,black_0%,transparent_62%)]">
        <Dither pixelSize={2} intensity={0.35} />
      </div>

      <header className="sticky top-0 z-10 border-b border-edge bg-card/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <button onClick={onHome} className="font-black text-fg">
            Toonback<span className="text-orange">.</span>
          </button>
          <div className="flex items-center gap-3">
            {devMode && (
              <span className="border-2 border-fg bg-yellow px-2 py-1 text-[10px] font-black uppercase tracking-wide">
                DEV MODE · OpenRouter off
              </span>
            )}
            <span className="text-xs text-muted">
              {room && <span className="mr-3 font-mono tracking-widest">{room}</span>}
              {step}
            </span>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-black text-xs uppercase tracking-[0.14em] text-orange">
      {children}
    </p>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="pop mt-6 rounded-xl border border-orange/50 bg-orange/10 px-4 py-3 text-sm text-fg">
      {children}
    </p>
  );
}

const CONNECTOR_LOGOS: Record<string, string> = {
  gmail: "https://cdn.simpleicons.org/gmail",
  google_calendar: "https://cdn.simpleicons.org/googlecalendar",
  google_drive: "https://cdn.simpleicons.org/googledrive",
  x: "https://cdn.simpleicons.org/x",
  spotify: "https://cdn.simpleicons.org/spotify",
  oura: "https://api.iconify.design/arcticons:oura.svg",
  whoop: "https://api.iconify.design/arcticons:whoop.svg",
  notion: "https://cdn.simpleicons.org/notion",
  github: "https://cdn.simpleicons.org/github",
  imessage: "https://cdn.simpleicons.org/imessage",
};

function ConnectorLogo({ connector }: { connector: Connector }) {
  const logo = CONNECTOR_LOGOS[connector.slug];

  return (
    <span
      className="grid size-9 shrink-0 place-items-center rounded-lg border border-edge bg-card p-2 font-black text-fg"
      aria-hidden
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- small third-party brand marks
        <img src={logo} alt="" className="size-full object-contain" />
      ) : (
        connector.label.charAt(0)
      )}
    </span>
  );
}

function ConnectorSkeleton() {
  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card breathe flex items-start gap-4 p-5" style={delay(i)}>
          <div className="size-5 rounded bg-line" />
          <div className="flex-1">
            <div className="h-4 w-24 rounded bg-line" />
            <div className="mt-2 h-3 w-full rounded bg-line/70" />
          </div>
          <div className="h-8 w-20 rounded-xl bg-line" />
        </div>
      ))}
    </div>
  );
}

/**
 * The signature moment. A blank screen would be the weakest
 * part of the product, so the wait becomes the one place the brand colour takes
 * over: an empty page whose panels fill as the pipeline advances, with a light
 * sweeping across whichever panel is being worked on.
 */
function DrawingProgress({ stage }: { stage: number }) {
  const panels = ["col-span-2 h-28", "h-20", "h-20", "col-span-2 h-28", "h-20", "h-20"];
  const filledUpTo = stage * 2;

  return (
    <div className="mt-6 grid grid-cols-2 gap-2 rounded-xl border border-edge p-2" aria-hidden>
      {panels.map((shape, i) => {
        const filled = i < filledUpTo;
        const working = i >= filledUpTo && i < filledUpTo + 2;
        return (
          <div key={i} className={`${shape} relative overflow-hidden rounded-lg bg-page`}>
            {/*
             * Panels ink themselves in: a dither sweep on the panel being
             * worked, a settled dither on the ones already done. The page is
             * being printed, so it fills the way print fills.
             */}
            {(filled || working) && (
              <div className={`absolute inset-0 ${filled ? "opacity-40" : "opacity-70"}`}>
                <Dither
                  pixelSize={2}
                  shape={working ? "sweep" : "corner"}
                  progress={working ? 0.55 : 1}
                  intensity={filled ? 0.8 : 0.6}
                  animated={working}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
