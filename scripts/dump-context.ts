#!/usr/bin/env bun
/**
 * POC context dump.
 *
 * Connects to the Merge Agent Handler MCP server as one Registered User,
 * discovers every tool the Tool Pack exposes, calls every *read* tool it can
 * safely call, and writes everything to one .txt file.
 *
 *   bun run dump
 *   bun run dump --dry                       # show what would be called, call nothing
 *   bun run dump --connectors=gmail,spotify  # restrict to some connectors
 *   bun run dump --days=14 --out=./out.txt
 *
 * Design notes:
 * - One dead or unauthenticated connector must never sink the run: every call
 *   is isolated, timed out, and reported with its own status.
 * - We only call tools whose *required* inputs we can fill without guessing.
 *   Everything else is listed in the SKIPPED section so we can decide later
 *   whether it is worth wiring by hand.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------- config

const API_KEY = process.env.MERGE_AGENT_HANDLER_API_KEY;
const TOOL_PACK_ID = process.env.MERGE_TOOL_PACK_ID;
const REGISTERED_USER_ID = process.env.MERGE_REGISTERED_USER_ID;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
}

const DRY = arg("dry") !== undefined;
const WINDOW_DAYS = Number(arg("days") ?? process.env.CONTEXT_WINDOW_DAYS ?? 7);
const PAGE_SIZE = Number(process.env.CONTEXT_PAGE_SIZE ?? 25);
const MAX_CHARS = Number(process.env.CONTEXT_MAX_CHARS_PER_TOOL ?? 20_000);
const TIMEOUT_MS = Number(process.env.CONTEXT_TIMEOUT_MS ?? 45_000);
const CONCURRENCY = Number(process.env.CONTEXT_CONCURRENCY ?? 4);
const ONLY_CONNECTORS = (arg("connectors") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const NOW = new Date();
const SINCE = new Date(NOW.getTime() - WINDOW_DAYS * 86_400_000);
const STAMP = NOW.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = arg("out") || `./output/context-${STAMP}.txt`;

// ------------------------------------------------------- tool classification

/** A tool is a candidate only if it reads. */
const READ_VERB = /^(list|get|search|read|find|fetch|retrieve|describe|query)_/;

/** ...and never if any segment of its name is a mutation. */
const WRITE_VERB =
  /(^|_)(create|update|delete|remove|send|post|add|set|write|upload|move|copy|archive|unarchive|reply|forward|invite|share|revoke|cancel|complete|trash|untrash|modify|patch|put|play|pause|skip|transfer|follow|unfollow|star|unstar|accept|decline|assign|merge|close|reopen|publish|import|sync|refresh|generate|execute|run)(_|$)/;

/** Binary payloads: technically reads, but they turn the dump into base64 soup. */
const BINARY_TOOL = /(^|_)(get_attachment|download|thumbnail|binary|blob)(_|$)/;

type Skip = { tool: string; reason: string };

// -------------------------------------------------------------- arg filling

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const isoFull = (d: Date) => d.toISOString();

const START_KEYS = new Set([
  "start", "start_date", "start_time", "start_datetime", "start_at", "since",
  "after", "from_date", "from_datetime", "begin", "begin_date", "min_date",
  "date_from", "created_after", "updated_after", "modified_after", "published_after",
  "time_min", "start_time_min",
]);

const END_KEYS = new Set([
  "end", "end_date", "end_time", "end_datetime", "end_at", "until", "before",
  "to_date", "to_datetime", "max_date", "date_to", "created_before",
  "updated_before", "modified_before", "published_before", "time_max",
]);

const LIMIT_KEYS = new Set([
  "limit", "page_size", "per_page", "max_results", "maxresults", "count", "top", "size", "n",
]);

const DAYS_KEYS = new Set(["days", "num_days", "lookback_days", "period_days"]);

function dateValue(schema: any, d: Date): string | number {
  if (schema?.format === "date") return isoDate(d);
  if (schema?.type === "integer" || schema?.type === "number") return Math.floor(d.getTime() / 1000);
  return isoFull(d);
}

/** Returns a value for a known-safe parameter, or undefined if we refuse to guess. */
function hintFor(name: string, schema: any): unknown {
  const n = name.toLowerCase();

  if (LIMIT_KEYS.has(n)) {
    const max = typeof schema?.maximum === "number" ? schema.maximum : PAGE_SIZE;
    return Math.min(PAGE_SIZE, max);
  }
  if (DAYS_KEYS.has(n)) return WINDOW_DAYS;
  if (START_KEYS.has(n)) return dateValue(schema, SINCE);
  if (END_KEYS.has(n)) return dateValue(schema, NOW);

  // Spotify-style ranges: prefer the shortest window available.
  if (n === "time_range" && Array.isArray(schema?.enum)) {
    return schema.enum.includes("short_term") ? "short_term" : schema.enum[0];
  }
  return undefined;
}

type Plan =
  | { kind: "call"; name: string; connector: string; args: Record<string, unknown> }
  | { kind: "skip"; name: string; connector: string; reason: string };

function planFor(tool: { name: string; inputSchema?: any }): Plan {
  const [connector, ...rest] = tool.name.split("__");
  const bare = rest.join("__") || tool.name;
  const c = connector ?? "unknown";

  if (ONLY_CONNECTORS.length && !ONLY_CONNECTORS.includes(c))
    return { kind: "skip", name: tool.name, connector: c, reason: "connector filtered out" };
  if (WRITE_VERB.test(bare))
    return { kind: "skip", name: tool.name, connector: c, reason: "mutating tool" };
  if (!READ_VERB.test(bare))
    return { kind: "skip", name: tool.name, connector: c, reason: "not a read verb" };
  if (BINARY_TOOL.test(bare))
    return { kind: "skip", name: tool.name, connector: c, reason: "binary payload" };

  const schema = tool.inputSchema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required: string[] = schema.required ?? [];

  const args: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    const value = hintFor(key, def);
    if (value !== undefined) args[key] = value;
  }

  const missing = required.filter((r) => !(r in args));
  if (missing.length)
    return {
      kind: "skip",
      name: tool.name,
      connector: c,
      reason: `needs input we can't infer: ${missing.join(", ")}`,
    };

  return { kind: "call", name: tool.name, connector: c, args };
}

// ------------------------------------------------------------------ runtime

type Result = {
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
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((part: any) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") return `[image ${part.mimeType ?? "?"} omitted]`;
      if (part?.type === "resource") return JSON.stringify(part.resource ?? part, null, 2);
      return JSON.stringify(part, null, 2);
    })
    .join("\n")
    .trim();
}

async function callTool(client: Client, plan: Extract<Plan, { kind: "call" }>): Promise<Result> {
  const started = Date.now();
  const base = { name: plan.name, connector: plan.connector, args: plan.args };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), TIMEOUT_MS);
  });

  try {
    const race = await Promise.race([
      client.callTool({ name: plan.name, arguments: plan.args }),
      timeout,
    ]);

    if (race === "__timeout__")
      return { ...base, status: "timeout", ms: Date.now() - started, text: `timed out after ${TIMEOUT_MS}ms`, truncated: false };

    const res = race as any;
    const raw = renderContent(res.content);
    const truncated = raw.length > MAX_CHARS;
    const text = truncated ? `${raw.slice(0, MAX_CHARS)}\n…[truncated, ${raw.length} chars total]` : raw;

    if (res.isError) return { ...base, status: "error", ms: Date.now() - started, text, truncated };
    if (!raw.trim()) return { ...base, status: "empty", ms: Date.now() - started, text: "", truncated: false };
    return { ...base, status: "ok", ms: Date.now() - started, text, truncated };
  } catch (err) {
    return {
      ...base,
      status: "error",
      ms: Date.now() - started,
      text: (err as Error).message ?? String(err),
      truncated: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- report

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

function buildReport(results: Result[], skipped: Skip[], toolCount: number): string {
  const by = (s: Result["status"]) => results.filter((r) => r.status === s);
  const lines: string[] = [];

  lines.push(RULE);
  lines.push("CORGI — RAW PERSONAL CONTEXT DUMP");
  lines.push(RULE);
  lines.push(`generated_at      ${NOW.toISOString()}`);
  lines.push(`window            ${isoDate(SINCE)} → ${isoDate(NOW)}  (${WINDOW_DAYS} days)`);
  lines.push(`tool_pack         ${TOOL_PACK_ID}`);
  lines.push(`registered_user   ${REGISTERED_USER_ID}`);
  lines.push("");
  lines.push(`tools exposed     ${toolCount}`);
  lines.push(`tools called      ${results.length}`);
  lines.push(
    `  ok ${by("ok").length}   empty ${by("empty").length}   error ${by("error").length}   timeout ${by("timeout").length}`,
  );
  lines.push(`tools skipped     ${skipped.length}`);
  lines.push("");

  // Per-connector scoreboard — tells us at a glance which sources actually gave us something.
  const connectors = [...new Set(results.map((r) => r.connector))].sort();
  lines.push("PER CONNECTOR");
  lines.push(THIN);
  for (const c of connectors) {
    const rows = results.filter((r) => r.connector === c);
    const ok = rows.filter((r) => r.status === "ok");
    const chars = ok.reduce((n, r) => n + r.text.length, 0);
    lines.push(
      `${c.padEnd(22)} ok ${String(ok.length).padStart(3)}/${String(rows.length).padEnd(3)}` +
        `  errors ${String(rows.filter((r) => r.status === "error" || r.status === "timeout").length).padStart(3)}` +
        `  ${chars.toLocaleString()} chars`,
    );
  }
  lines.push("");

  // Content first: this is what the context agent will actually read.
  lines.push(RULE);
  lines.push("DATA");
  lines.push(RULE);
  for (const r of [...by("ok")].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push("");
    lines.push(`### ${r.name}`);
    lines.push(`args: ${JSON.stringify(r.args)}`);
    lines.push(`took: ${r.ms}ms   size: ${r.text.length} chars${r.truncated ? " (truncated)" : ""}`);
    lines.push(THIN);
    lines.push(r.text);
  }

  const problems = [...by("error"), ...by("timeout")];
  if (problems.length) {
    lines.push("");
    lines.push(RULE);
    lines.push("ERRORS  (usually: connector not authenticated for this Registered User)");
    lines.push(RULE);
    for (const r of problems) {
      lines.push(`- ${r.name} [${r.status}] ${r.text.split("\n")[0]?.slice(0, 300)}`);
    }
  }

  const empties = by("empty");
  if (empties.length) {
    lines.push("");
    lines.push(RULE);
    lines.push("EMPTY  (call succeeded, no data in the window)");
    lines.push(RULE);
    for (const r of empties) lines.push(`- ${r.name}`);
  }

  lines.push("");
  lines.push(RULE);
  lines.push("SKIPPED  (not called — review these to widen the dump)");
  lines.push(RULE);
  const grouped = new Map<string, Skip[]>();
  for (const s of skipped) {
    const key = s.reason.startsWith("needs input") ? "needs input we can't infer" : s.reason;
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }
  for (const [reason, items] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("");
    lines.push(`${reason}  (${items.length})`);
    for (const s of items.slice(0, 200)) {
      lines.push(`  - ${s.tool}${s.reason.startsWith("needs input") ? `  [${s.reason.replace("needs input we can't infer: ", "")}]` : ""}`);
    }
    if (items.length > 200) lines.push(`  … ${items.length - 200} more`);
  }

  lines.push("");
  return lines.join("\n");
}

// --------------------------------------------------------------------- main

const main = async () => {
  const missing = [
    !API_KEY && "MERGE_AGENT_HANDLER_API_KEY",
    !TOOL_PACK_ID && "MERGE_TOOL_PACK_ID",
    !REGISTERED_USER_ID && "MERGE_REGISTERED_USER_ID",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`\n✗ missing env: ${missing.join(", ")}\n  copy .env.example to .env and fill it in\n`);
    process.exit(1);
  }

  const base = process.env.MERGE_API_BASE ?? "https://ah-api.merge.dev";
  const url = new URL(`${base}/api/v1/tool-packs/${TOOL_PACK_ID}/registered-users/${REGISTERED_USER_ID}/mcp`);

  console.log(`→ connecting to Agent Handler MCP…`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const client = new Client({ name: "corgi-context-dump", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`✓ connected — ${tools.length} tools exposed by the Tool Pack`);

  const plans = tools.map((t) => planFor(t as any));
  const calls = plans.filter((p): p is Extract<Plan, { kind: "call" }> => p.kind === "call");
  const skipped: Skip[] = plans
    .filter((p): p is Extract<Plan, { kind: "skip" }> => p.kind === "skip")
    .map((p) => ({ tool: p.name, reason: p.reason }));

  console.log(`→ ${calls.length} read tools callable, ${skipped.length} skipped`);

  if (DRY) {
    for (const c of calls) console.log(`  would call  ${c.name}  ${JSON.stringify(c.args)}`);
    await client.close();
    return;
  }

  let done = 0;
  const results = await pool(calls, CONCURRENCY, async (plan) => {
    const r = await callTool(client, plan);
    done++;
    const mark = r.status === "ok" ? "✓" : r.status === "empty" ? "·" : "✗";
    console.log(`  ${mark} [${String(done).padStart(3)}/${calls.length}] ${r.name} (${r.ms}ms)`);
    return r;
  });

  await client.close();

  const report = buildReport(results, skipped, tools.length);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, report, "utf8");

  const ok = results.filter((r) => r.status === "ok").length;
  console.log(`\n✓ ${ok}/${calls.length} tools returned data`);
  console.log(`✓ written to ${OUT}  (${report.length.toLocaleString()} chars)\n`);
};

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
