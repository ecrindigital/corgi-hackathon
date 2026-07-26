#!/usr/bin/env bun
/**
 * CLI over lib/merge.ts — same discovery, classification and calling as the app,
 * rendered to one .txt file instead of the UI.
 *
 *   bun run dump
 *   bun run dump --dry                       # show what would be called, call nothing
 *   bun run dump --connectors=gmail,spotify  # restrict to some connectors
 *   bun run dump --days=14 --out=./out.txt
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  dumpOptions,
  planFor,
  runDump,
  withMcp,
  type DumpReport,
  type ToolDescriptor,
  type ToolResult,
} from "../lib/merge";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
}

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);
const isoDate = (s: string) => s.slice(0, 10);

function buildReport(report: DumpReport): string {
  const by = (s: ToolResult["status"]) => report.results.filter((r) => r.status === s);
  const lines: string[] = [];

  lines.push(RULE, "CORGI — RAW PERSONAL CONTEXT DUMP", RULE);
  lines.push(`generated_at      ${report.options.now}`);
  lines.push(
    `window            ${isoDate(report.options.since)} → ${isoDate(report.options.now)}  (${report.options.windowDays} days)`,
  );
  lines.push(`tool_pack         ${process.env.MERGE_TOOL_PACK_ID}`);
  lines.push(`registered_user   ${process.env.MERGE_REGISTERED_USER_ID}`);
  lines.push("");
  lines.push(`tools exposed     ${report.toolCount}`);
  lines.push(`tools called      ${report.results.length}`);
  lines.push(
    `  ok ${by("ok").length}   empty ${by("empty").length}   error ${by("error").length}   timeout ${by("timeout").length}`,
  );
  lines.push(`tools skipped     ${report.skipped.length}`, "");

  const connectors = [...new Set(report.results.map((r) => r.connector))].sort();
  lines.push("PER CONNECTOR", THIN);
  for (const c of connectors) {
    const rows = report.results.filter((r) => r.connector === c);
    const ok = rows.filter((r) => r.status === "ok");
    const chars = ok.reduce((n, r) => n + r.text.length, 0);
    lines.push(
      `${c.padEnd(22)} ok ${String(ok.length).padStart(3)}/${String(rows.length).padEnd(3)}` +
        `  errors ${String(rows.filter((r) => r.status === "error" || r.status === "timeout").length).padStart(3)}` +
        `  ${chars.toLocaleString()} chars`,
    );
  }
  lines.push("");

  lines.push(RULE, "DATA", RULE);
  for (const r of [...by("ok")].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push("", `### ${r.name}`);
    lines.push(`args: ${JSON.stringify(r.args)}`);
    lines.push(`took: ${r.ms}ms   size: ${r.text.length} chars${r.truncated ? " (truncated)" : ""}`);
    lines.push(THIN, r.text);
  }

  const problems = [...by("error"), ...by("timeout")];
  if (problems.length) {
    lines.push("", RULE, "ERRORS", RULE);
    for (const r of problems) lines.push(`- ${r.name} [${r.status}] ${r.text.split("\n")[0]?.slice(0, 300)}`);
  }

  const empties = by("empty");
  if (empties.length) {
    lines.push("", RULE, "EMPTY  (call succeeded, no data in the window)", RULE);
    for (const r of empties) lines.push(`- ${r.name}`);
  }

  if (report.unauthenticated.length) {
    lines.push("", RULE, "NOT AUTHENTICATED  (in the Tool Pack, but no credential for this user)", RULE);
    for (const slug of report.unauthenticated) lines.push(`- ${slug}`);
    lines.push("", `  bun run setup --links=${report.unauthenticated.join(",")}`);
  }

  lines.push("", RULE, "SKIPPED  (not called — review these to widen the dump)", RULE);
  const grouped = new Map<string, typeof report.skipped>();
  for (const s of report.skipped) {
    if (s.reason === "connector not authenticated") continue; // already reported above
    const key = s.reason.startsWith("needs input") ? "needs input we can't infer" : s.reason;
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }
  for (const [reason, items] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("", `${reason}  (${items.length})`);
    for (const s of items.slice(0, 200)) {
      const detail = s.reason.startsWith("needs input")
        ? `  [${s.reason.replace("needs input we can't infer: ", "")}]`
        : "";
      lines.push(`  - ${s.tool}${detail}`);
    }
    if (items.length > 200) lines.push(`  … ${items.length - 200} more`);
  }

  lines.push("");
  return lines.join("\n");
}

const main = async () => {
  const userId = process.env.MERGE_REGISTERED_USER_ID;
  if (!userId) {
    console.error(`\n✗ missing env: MERGE_REGISTERED_USER_ID\n  run: bun run setup\n`);
    process.exit(1);
  }

  const opts = dumpOptions({
    windowDays: arg("days") ? Number(arg("days")) : undefined,
    connectors: (arg("connectors") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });

  console.log("→ connecting to Agent Handler MCP…");

  if (arg("dry") !== undefined) {
    await withMcp(userId, async (client) => {
      const { tools } = await client.listTools();
      const plans = tools.map((t) => planFor(t as ToolDescriptor, opts));
      const calls = plans.filter((p) => p.kind === "call");
      console.log(`✓ connected — ${tools.length} tools exposed by the Tool Pack`);
      console.log(`→ ${calls.length} read tools callable, ${plans.length - calls.length} skipped`);
      for (const c of calls) console.log(`  would call  ${c.name}  ${JSON.stringify(c.args)}`);

      const unauth = plans.flatMap((p) => (p.kind === "skip" && p.needsAuth ? [p.needsAuth] : []));
      if (unauth.length) {
        console.log(`\n! not authenticated: ${unauth.join(", ")}`);
        console.log(`  bun run setup --links=${unauth.join(",")}\n`);
      }
    });
    return;
  }

  const report = await runDump(userId, opts, (done, total, r) => {
    const mark = r.status === "ok" ? "✓" : r.status === "empty" ? "·" : "✗";
    console.log(`  ${mark} [${String(done).padStart(3)}/${total}] ${r.name} (${r.ms}ms)`);
  });

  if (report.unauthenticated.length) {
    console.log(`\n! not authenticated: ${report.unauthenticated.join(", ")}`);
    console.log(`  bun run setup --links=${report.unauthenticated.join(",")}\n`);
  }

  const stamp = report.options.now.replace(/[:.]/g, "-").slice(0, 19);
  const out = arg("out") || `./output/context-${stamp}.txt`;
  const text = buildReport(report);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text, "utf8");

  const ok = report.results.filter((r) => r.status === "ok").length;
  console.log(`\n✓ ${ok}/${report.results.length} tools returned data`);
  console.log(`✓ written to ${out}  (${text.length.toLocaleString()} chars)\n`);
};

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
