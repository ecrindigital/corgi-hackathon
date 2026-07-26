#!/usr/bin/env bun
/**
 * Image model bench.
 *
 * Drawing is ~85% of the wall clock of a generation, so the model choice is the
 * only lever that matters. Runs the same real brief through several models in
 * parallel and reports latency, cost and output, so the decision is made on
 * measurements instead of vibes.
 *
 *   bun run bench --brief=./path/to/brief.txt
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.OPENROUTER_API_KEY;

const MODELS = [
  "openai/gpt-image-2",
  "openai/gpt-image-1-mini",
  "google/gemini-3.1-flash-image",
  "google/gemini-3-pro-image",
  "black-forest-labs/flux.2-klein-4b",
];

const STYLE_SUFFIX = `

Art direction: bold hand-inked comic book art, thick confident black outlines, flat vibrant colours, halftone dot shading, warm cream paper background, clean white gutters between panels.

All lettering must be spelled correctly and easy to read.`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

type Row = { model: string; ms: number; cost?: number; kb?: number; error?: string };

async function run(model: string, prompt: string): Promise<Row> {
  const started = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, size: "1024x1536" }),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return { model, ms, error: `${res.status} ${text.slice(0, 120)}` };

    const json = JSON.parse(text) as {
      data?: { b64_json?: string }[];
      usage?: { cost?: number };
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) return { model, ms, error: "no image in response" };

    const bytes = Buffer.from(b64, "base64");
    const file = `./output/bench-${model.replace(/[/.]/g, "-")}.png`;
    await writeFile(file, bytes);
    return { model, ms, cost: json.usage?.cost, kb: Math.round(bytes.length / 1024) };
  } catch (err) {
    return { model, ms: Date.now() - started, error: (err as Error).message };
  }
}

const main = async () => {
  if (!API_KEY) {
    console.error("\n✗ missing env: OPENROUTER_API_KEY\n");
    process.exit(1);
  }

  const briefPath = arg("brief");
  if (!briefPath) {
    console.error("\n✗ pass --brief=<file> with a real comic brief\n");
    process.exit(1);
  }

  const prompt = `${(await readFile(briefPath, "utf8")).trim()}${STYLE_SUFFIX}`;
  await mkdir("./output", { recursive: true });

  console.log(`→ ${MODELS.length} models, same brief, in parallel\n`);

  // In parallel: sequential runs would take as long as the sum, and we only
  // care about each model's own latency.
  const rows = await Promise.all(MODELS.map((m) => run(m, prompt)));

  rows.sort((a, b) => a.ms - b.ms);
  console.log("model                               time     cost      size");
  console.log("-".repeat(68));
  for (const r of rows) {
    const time = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    if (r.error) {
      console.log(`${r.model.padEnd(35)} ${time}   ✗ ${r.error.slice(0, 60)}`);
      continue;
    }
    const cost = r.cost !== undefined ? `$${r.cost.toFixed(4)}` : "?";
    console.log(`${r.model.padEnd(35)} ${time}   ${cost.padEnd(9)} ${r.kb} KB`);
  }
  console.log("\nimages written to ./output/bench-*.png");
};

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exit(1);
});
