#!/usr/bin/env bun
/**
 * Story model bench.
 *
 * The story step decides which moments become panels and enforces the privacy
 * rules, so speed is not the only axis. This runs the same real context through
 * several models and reports latency next to automated quality checks, then
 * writes each brief out so they can be read side by side.
 *
 *   bun run bench:story
 */

import { mkdir, writeFile } from "node:fs/promises";
import { condenseContext, writeComicBrief, type Cast } from "../lib/comic";
import { readIMessages } from "../lib/imessage";
import { dumpOptions, runDump } from "../lib/merge";

const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5-20251001",
  "google/gemini-3.5-flash",
];

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const MODELS = arg("models")?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_MODELS;

type Row = {
  model: string;
  ms: number;
  chars: number;
  panels: number;
  digitRuns: number;
  emDashes: number;
  error?: string;
};

/** Cheap signals, not a verdict: they flag briefs worth reading closely. */
function inspect(brief: string) {
  return {
    chars: brief.length,
    panels: (brief.match(/panel\s*\d/gi) ?? []).length,
    // 4-8 digit runs are how a verification code sneaks into a panel.
    digitRuns: (brief.match(/\b\d{4,8}\b/g) ?? []).length,
    emDashes: (brief.match(/[—–]/g) ?? []).length,
  };
}

const main = async () => {
  const userId = process.env.MERGE_REGISTERED_USER_ID;
  if (!userId) {
    console.error("\n✗ missing env: MERGE_REGISTERED_USER_ID\n");
    process.exit(1);
  }

  const opts = dumpOptions({ windowDays: 7 });

  console.log("→ building the real context once, so every model sees the same input");
  const report = await runDump(userId, opts);
  const local = await readIMessages(opts.since, opts.now);
  const results = [...report.results, ...local.results];
  const context = condenseContext(results);
  console.log(`  ${results.filter((r) => r.status === "ok").length} tools, ${context.length} chars\n`);

  await mkdir("./output", { recursive: true });
  const rows: Row[] = [];

  // Sequential: these share a rate limit, and we are timing them.
  for (const model of MODELS) {
    process.env.STORY_MODEL = model;
    const cast: Cast[] = [{ label: "A", context, hasFace: false }];
    const started = Date.now();
    try {
      // writeComicBrief reads STORY_MODEL at call time via the module default,
      // so pass the override explicitly instead of relying on import order.
      const brief = await writeComicBrief(cast, "the last 7 days", model);
      const ms = Date.now() - started;
      await writeFile(`./output/brief-${model.replace(/[/.]/g, "-")}.txt`, brief);
      rows.push({ model, ms, ...inspect(brief) });
    } catch (err) {
      rows.push({ model, ms: Date.now() - started, chars: 0, panels: 0, digitRuns: 0, emDashes: 0, error: (err as Error).message });
    }
  }

  console.log("model                                    time    chars  panels  digits  dashes");
  console.log("-".repeat(82));
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.model.padEnd(40)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ✗ ${r.error.slice(0, 50)}`);
      continue;
    }
    console.log(
      `${r.model.padEnd(40)} ${(r.ms / 1000).toFixed(1).padStart(6)}s ${String(r.chars).padStart(7)} ${String(r.panels).padStart(7)} ${String(r.digitRuns).padStart(7)} ${String(r.emDashes).padStart(7)}`,
    );
  }
  console.log("\nbriefs written to ./output/brief-*.txt");
  console.log("digits and dashes should both be 0: they are privacy and typography violations.");
};

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exit(1);
});
