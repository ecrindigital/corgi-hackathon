/**
 * Server-side Merge Agent Handler client.
 *
 * Shared by the Next.js route handlers and the `bun run dump` CLI so both
 * classify and call tools identically.
 *
 * Everything here is verified against the live API — the public docs are wrong
 * on three points, each marked below.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ------------------------------------------------------------------ config

/** Docs only document the US host; the EU dashboard is served by ah-api-eu. */
export const API_BASE = process.env.MERGE_API_BASE ?? "https://ah-api.merge.dev";

const API_KEY = () => requireEnv("MERGE_AGENT_HANDLER_API_KEY");
const TOOL_PACK_ID = () => requireEnv("MERGE_TOOL_PACK_ID");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

/** The connectors this POC surfaces, in display order. */
export const CONNECTORS = [
  {
    slug: "gmail",
    label: "Gmail",
    emoji: "✉️",
    blurb: "Conversations, invitations, travel confirmations, unexpected life events",
  },
  {
    slug: "google_drive",
    label: "Google Drive",
    emoji: "📁",
    blurb: "Files you touched, and anything you kept",
  },
  {
    slug: "google_maps",
    label: "Google Maps",
    emoji: "🗺️",
    blurb: "Places and directions (no personal location history)",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    emoji: "💼",
    // Merge's LinkedIn connector only exposes create_*_share and
    // validate_credentials — there is no read tool for your posts, profile or
    // feed, so it contributes nothing to the story. Kept for the share-out path.
    blurb: "Posting only — LinkedIn exposes no readable history",
  },
] as const;

export type ConnectorSlug = (typeof CONNECTORS)[number]["slug"];

// --------------------------------------------------------------- REST calls

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function createRegisteredUser(originUserId: string): Promise<string> {
  const json = await post("/api/v1/registered-users", {
    origin_user_id: originUserId,
    origin_user_name: "Corgi POC User",
  });
  const id = json.registered_user_id ?? json.id;
  if (!id) throw new Error(`no registered_user_id in response: ${JSON.stringify(json)}`);
  return id as string;
}

/**
 * Docs say `POST /api/registered-users/{id}/link-token` with `{connector_slug}`.
 * The live API needs the `/v1` prefix and the field `connector`, and slugs use
 * underscores (`google_drive`, not `google-drive`).
 */
export async function createMagicLink(registeredUserId: string, connector: string) {
  const json = await post(`/api/v1/registered-users/${registeredUserId}/link-token`, { connector });
  const url = json.magic_link_url ?? json.link_url;
  if (!url) throw new Error(`no link in response: ${JSON.stringify(json)}`);
  return { url: url as string, expiresAt: (json.expires_at as string | undefined) ?? null };
}

// ---------------------------------------------------------------- MCP client

export async function withMcp<T>(registeredUserId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(
    `${API_BASE}/api/v1/tool-packs/${TOOL_PACK_ID()}/registered-users/${registeredUserId}/mcp`,
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY()}` } },
  });
  const client = new Client({ name: "corgi", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ------------------------------------------------------- tool classification

const READ_VERB = /^(list|get|search|read|find|fetch|retrieve|describe|query)_/;

const WRITE_VERB =
  /(^|_)(create|update|delete|remove|send|post|add|set|write|upload|move|copy|archive|unarchive|reply|forward|invite|share|revoke|cancel|complete|trash|untrash|modify|patch|put|play|pause|skip|transfer|follow|unfollow|star|unstar|accept|decline|assign|merge|close|reopen|publish|import|sync|refresh|generate|execute|run)(_|$)/;

const BINARY_TOOL = /(^|_)(get_attachment|download|thumbnail|binary|blob)(_|$)/;

/** Merge exposes `authenticate_<slug>` in place of a connector's real tools until it is connected. */
const NEEDS_AUTH = /^authenticate_(.+)$/;

/** The slice of JSON Schema we actually read off a tool's inputSchema. */
type JsonSchema = {
  type?: string;
  format?: string;
  enum?: unknown[];
  maximum?: number;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

/** Merge marks every field of an input object `required`, but most accept null. */
function isNullable(schema: JsonSchema | undefined): boolean {
  return schema?.anyOf?.some((s) => s.type === "null") ?? false;
}

function effectiveType(schema: JsonSchema | undefined): string | undefined {
  if (schema?.type) return schema.type;
  return schema?.anyOf?.find((s) => s.type && s.type !== "null")?.type;
}

export type ToolDescriptor = { name: string; inputSchema?: JsonSchema };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const START_KEYS = new Set([
  "start", "start_date", "start_time", "start_datetime", "start_at", "since", "after",
  "from_date", "from_datetime", "begin", "begin_date", "min_date", "date_from",
  "created_after", "updated_after", "modified_after", "published_after", "time_min",
]);

const END_KEYS = new Set([
  "end", "end_date", "end_time", "end_datetime", "end_at", "until", "before",
  "to_date", "to_datetime", "max_date", "date_to", "created_before", "updated_before",
  "modified_before", "published_before", "time_max",
]);

const LIMIT_KEYS = new Set([
  "limit", "page_size", "per_page", "max_results", "maxresults", "count", "top", "size", "n",
]);

const DAYS_KEYS = new Set(["days", "num_days", "lookback_days", "period_days"]);

function dateValue(schema: JsonSchema | undefined, d: Date): string | number {
  if (schema?.format === "date") return isoDate(d);
  if (schema?.type === "integer" || schema?.type === "number") return Math.floor(d.getTime() / 1000);
  return d.toISOString();
}

/** Gmail search syntax wants slashes: after:2026/07/19 */
const slashDate = (d: Date) => isoDate(d).replace(/-/g, "/");

/**
 * A few fields are only meaningful per connector. Kept deliberately tiny — the
 * generic rules below handle everything else.
 */
const CONNECTOR_HINTS: Record<string, (field: string, opts: DumpOptions) => unknown> = {
  // `q` takes Gmail search syntax; without it we'd pull the whole mailbox
  // newest-first instead of the requested window.
  gmail: (field, opts) => (field === "q" ? `after:${slashDate(opts.since)}` : undefined),
};

/** A value for a known-safe parameter, or undefined when we refuse to guess. */
function hintFor(
  name: string,
  schema: JsonSchema | undefined,
  opts: DumpOptions,
  connector?: string,
): unknown {
  const perConnector = connector ? CONNECTOR_HINTS[connector]?.(name, opts) : undefined;
  if (perConnector !== undefined) return perConnector;

  const n = name.toLowerCase();
  if (LIMIT_KEYS.has(n)) {
    const max = typeof schema?.maximum === "number" ? schema.maximum : opts.pageSize;
    return Math.min(opts.pageSize, max);
  }
  if (DAYS_KEYS.has(n)) return opts.windowDays;
  if (START_KEYS.has(n)) return dateValue(schema, opts.since);
  if (END_KEYS.has(n)) return dateValue(schema, opts.now);
  if (n === "time_range" && Array.isArray(schema?.enum))
    return schema.enum.includes("short_term") ? "short_term" : schema.enum[0];
  return undefined;
}

/**
 * Fill one object schema.
 *
 * Merge nests every real parameter inside a single `input` object and lists all
 * of its fields as required, so a naive reading skips almost every tool. We
 * recurse into that wrapper, fill what we know, and fall back to null/false for
 * required fields the schema says are optional in practice.
 */
function buildArgs(
  schema: JsonSchema,
  opts: DumpOptions,
  connector: string,
): { args: Record<string, unknown>; missing: string[] } {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const args: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [key, def] of Object.entries(props)) {
    // The `input` wrapper: recurse and keep the nesting.
    if (key === "input" && effectiveType(def) === "object" && def.properties) {
      const inner = buildArgs(def, opts, connector);
      args.input = inner.args;
      missing.push(...inner.missing.map((m) => `input.${m}`));
      continue;
    }

    const hinted = hintFor(key, def, opts, connector);
    if (hinted !== undefined) {
      args[key] = hinted;
      continue;
    }

    if (!required.includes(key)) continue;

    // Required but unknown: null and false are safe no-ops the API accepts.
    if (isNullable(def)) args[key] = null;
    else if (effectiveType(def) === "boolean") args[key] = false;
    else missing.push(key);
  }

  return { args, missing };
}

export type Plan =
  | { kind: "call"; name: string; connector: string; args: Record<string, unknown> }
  | { kind: "skip"; name: string; connector: string; reason: string; needsAuth?: string };

export function planFor(tool: ToolDescriptor, opts: DumpOptions): Plan {
  const auth = NEEDS_AUTH.exec(tool.name);
  if (auth)
    return {
      kind: "skip",
      name: tool.name,
      connector: auth[1]!,
      reason: "connector not authenticated",
      needsAuth: auth[1]!,
    };

  const [connector, ...rest] = tool.name.split("__");
  const bare = rest.join("__") || tool.name;
  const c = connector ?? "unknown";

  if (opts.connectors?.length && !opts.connectors.includes(c))
    return { kind: "skip", name: tool.name, connector: c, reason: "connector filtered out" };
  if (WRITE_VERB.test(bare)) return { kind: "skip", name: tool.name, connector: c, reason: "mutating tool" };
  if (!READ_VERB.test(bare)) return { kind: "skip", name: tool.name, connector: c, reason: "not a read verb" };
  if (BINARY_TOOL.test(bare)) return { kind: "skip", name: tool.name, connector: c, reason: "binary payload" };

  const { args, missing } = buildArgs(tool.inputSchema ?? {}, opts, c);
  if (missing.length)
    return {
      kind: "skip",
      name: tool.name,
      connector: c,
      reason: `needs input we can't infer: ${missing.join(", ")}`,
    };

  return { kind: "call", name: tool.name, connector: c, args };
}

// ------------------------------------------------------------------- runner

export type DumpOptions = {
  now: Date;
  since: Date;
  windowDays: number;
  pageSize: number;
  maxChars: number;
  timeoutMs: number;
  concurrency: number;
  connectors?: string[];
};

export function dumpOptions(overrides: Partial<DumpOptions> = {}): DumpOptions {
  const windowDays = overrides.windowDays ?? Number(process.env.CONTEXT_WINDOW_DAYS ?? 7);
  const now = overrides.now ?? new Date();
  return {
    now,
    since: overrides.since ?? new Date(now.getTime() - windowDays * 86_400_000),
    windowDays,
    pageSize: overrides.pageSize ?? Number(process.env.CONTEXT_PAGE_SIZE ?? 25),
    maxChars: overrides.maxChars ?? Number(process.env.CONTEXT_MAX_CHARS_PER_TOOL ?? 20_000),
    timeoutMs: overrides.timeoutMs ?? Number(process.env.CONTEXT_TIMEOUT_MS ?? 45_000),
    concurrency: overrides.concurrency ?? Number(process.env.CONTEXT_CONCURRENCY ?? 4),
    connectors: overrides.connectors,
  };
}

export type ToolResult = {
  name: string;
  connector: string;
  args: Record<string, unknown>;
  status: "ok" | "empty" | "error" | "timeout";
  ms: number;
  text: string;
  truncated: boolean;
};

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

type ContentPart = { type?: string; text?: string; mimeType?: string; resource?: unknown };

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return (content as ContentPart[])
    .map((part) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") return `[image ${part.mimeType ?? "?"} omitted]`;
      if (part?.type === "resource") return JSON.stringify(part.resource ?? part, null, 2);
      return JSON.stringify(part, null, 2);
    })
    .join("\n")
    .trim();
}

async function callTool(
  client: Client,
  plan: Extract<Plan, { kind: "call" }>,
  opts: DumpOptions,
): Promise<ToolResult> {
  const started = Date.now();
  const base = { name: plan.name, connector: plan.connector, args: plan.args };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), opts.timeoutMs);
  });

  try {
    const race = await Promise.race([
      client.callTool({ name: plan.name, arguments: plan.args }),
      timeout,
    ]);

    if (race === "__timeout__")
      return { ...base, status: "timeout", ms: Date.now() - started, text: `timed out after ${opts.timeoutMs}ms`, truncated: false };

    const res = race as { content?: unknown; isError?: boolean };
    const raw = renderContent(res.content);
    const truncated = raw.length > opts.maxChars;
    const text = truncated ? `${raw.slice(0, opts.maxChars)}\n…[truncated, ${raw.length} chars total]` : raw;

    if (res.isError) return { ...base, status: "error", ms: Date.now() - started, text, truncated };
    if (!raw.trim()) return { ...base, status: "empty", ms: Date.now() - started, text: "", truncated: false };
    return { ...base, status: "ok", ms: Date.now() - started, text, truncated };
  } catch (err) {
    return { ...base, status: "error", ms: Date.now() - started, text: (err as Error).message ?? String(err), truncated: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- hydration

/**
 * List endpoints return identifiers, not content: `gmail__list_messages` gives
 * back nine bare IDs. Without a second pass the story model receives no actual
 * emails, so we expand each ID through its detail tool.
 *
 * The detail tools are exactly the ones the planner skips as "needs input we
 * can't infer" — the input is inferable only once the list call has run.
 */
const MAX_HYDRATE = 30;

type Expansion = {
  list: string;
  detail: string;
  ids: (json: Record<string, unknown>) => string[];
  args: (id: string) => Record<string, unknown>;
  /** Collapse a verbose provider payload into just the storytelling signal. */
  transform?: (text: string) => string;
};

// ---- Gmail message extraction ------------------------------------------------

type GmailPart = {
  mime_type?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

const decodeB64Url = (data: string) => {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
};

/** Depth-first search for the first part of a given MIME type that carries data. */
function findPart(part: GmailPart | undefined, mime: string): string | undefined {
  if (!part) return undefined;
  if (part.mime_type === mime && part.body?.data) return decodeB64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** How much body text per email is worth keeping. Enough for a joke, not a newsletter. */
const BODY_CHARS = 1200;

/**
 * One raw Gmail message is ~33k characters, nearly all of it MIME scaffolding,
 * a base64 HTML part and a duplicate `raw` field. The story model needs six
 * fields. This keeps those and drops the rest, which is what makes it possible
 * to hydrate dozens of emails instead of a handful.
 */
function summariseGmailMessage(text: string): string {
  let json: {
    snippet?: string;
    internal_date?: string;
    label_ids?: string[];
    payload?: GmailPart & { headers?: { name: string; value: string }[] };
  };
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }

  const headers = json.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const plain = findPart(json.payload, "text/plain");
  const html = plain ? undefined : findPart(json.payload, "text/html");
  const body = (plain ?? (html ? stripHtml(html) : "") ?? "").trim();

  const date = json.internal_date
    ? new Date(Number(json.internal_date)).toISOString()
    : header("Date");

  return JSON.stringify(
    {
      from: header("From"),
      to: header("To"),
      subject: header("Subject"),
      date,
      labels: (json.label_ids ?? []).filter((l) => !l.startsWith("Label_")),
      snippet: json.snippet,
      body: body.slice(0, BODY_CHARS) + (body.length > BODY_CHARS ? " […]" : ""),
    },
    null,
    1,
  );
}

const idsFrom = (json: Record<string, unknown>, key: string): string[] => {
  const rows = json[key];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (r as { id?: string })?.id).filter((id): id is string => Boolean(id));
};

const EXPANSIONS: Expansion[] = [
  {
    list: "gmail__list_messages",
    detail: "gmail__get_message",
    ids: (j) => idsFrom(j, "messages"),
    // 'full' is the only format carrying the body; summariseGmailMessage then
    // throws away the 95% of it that is MIME scaffolding.
    args: (id) => ({ input: { message_id: id, format: "full" } }),
    transform: summariseGmailMessage,
  },
];

async function hydrate(
  client: Client,
  results: ToolResult[],
  available: Set<string>,
  opts: DumpOptions,
  onProgress?: (done: number, total: number, result: ToolResult) => void,
): Promise<ToolResult[]> {
  const jobs: {
    name: string;
    connector: string;
    args: Record<string, unknown>;
    transform?: (text: string) => string;
  }[] = [];

  for (const exp of EXPANSIONS) {
    if (!available.has(exp.detail)) continue;
    const source = results.find((r) => r.name === exp.list && r.status === "ok");
    if (!source) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(source.text);
    } catch {
      continue;
    }

    const connector = exp.detail.split("__")[0] ?? "unknown";
    for (const id of exp.ids(parsed).slice(0, MAX_HYDRATE)) {
      jobs.push({
        name: `${exp.detail}[${id}]`,
        connector,
        args: exp.args(id),
        transform: exp.transform,
      });
    }
  }

  if (!jobs.length) return [];

  // Truncation happens inside callTool, before our transform runs — a clipped
  // payload would fail to parse. Take these whole; the transform shrinks them.
  const rawOpts: DumpOptions = { ...opts, maxChars: 1_000_000 };

  let done = 0;
  return pool(jobs, opts.concurrency, async (job) => {
    const r = await callTool(
      client,
      { kind: "call", name: job.name.replace(/\[.*\]$/, ""), connector: job.connector, args: job.args },
      rawOpts,
    );
    const text = job.transform && r.status === "ok" ? job.transform(r.text) : r.text;
    const labelled = { ...r, name: job.name, text, truncated: false };
    onProgress?.(++done, jobs.length, labelled);
    return labelled;
  });
}

export type DumpReport = {
  toolCount: number;
  results: ToolResult[];
  skipped: { tool: string; reason: string }[];
  unauthenticated: string[];
  options: { windowDays: number; since: string; now: string };
};

/** Discover every tool, call the ones we safely can, and return the lot. */
export async function runDump(
  registeredUserId: string,
  opts: DumpOptions,
  onProgress?: (done: number, total: number, result: ToolResult) => void,
): Promise<DumpReport> {
  return withMcp(registeredUserId, async (client) => {
    const { tools } = await client.listTools();
    const plans = tools.map((t) => planFor(t as ToolDescriptor, opts));

    const calls = plans.filter((p): p is Extract<Plan, { kind: "call" }> => p.kind === "call");
    const skips = plans.filter((p): p is Extract<Plan, { kind: "skip" }> => p.kind === "skip");

    let done = 0;
    const results = await pool(calls, opts.concurrency, async (plan) => {
      const r = await callTool(client, plan, opts);
      onProgress?.(++done, calls.length, r);
      return r;
    });

    const available = new Set(tools.map((t) => t.name));
    const hydrated = await hydrate(client, results, available, opts, onProgress);

    return {
      toolCount: tools.length,
      results: [...results, ...hydrated],
      skipped: skips.map((s) => ({ tool: s.name, reason: s.reason })),
      unauthenticated: skips.filter((s) => s.needsAuth).map((s) => s.needsAuth!),
      options: { windowDays: opts.windowDays, since: opts.since.toISOString(), now: opts.now.toISOString() },
    };
  });
}

/** Which connectors are connected, judged by whether their real tools are exposed. */
export async function connectorStatus(registeredUserId: string) {
  return withMcp(registeredUserId, async (client) => {
    const { tools } = await client.listTools();
    const pending = new Set<string>();
    const ready = new Map<string, number>();

    for (const tool of tools) {
      const auth = NEEDS_AUTH.exec(tool.name);
      if (auth) {
        pending.add(auth[1]!);
        continue;
      }
      const prefix = tool.name.split("__")[0];
      if (prefix && tool.name.includes("__")) ready.set(prefix, (ready.get(prefix) ?? 0) + 1);
    }

    return CONNECTORS.map((c) => ({
      ...c,
      connected: ready.has(c.slug),
      toolCount: ready.get(c.slug) ?? 0,
      inPack: ready.has(c.slug) || pending.has(c.slug),
    }));
  });
}
