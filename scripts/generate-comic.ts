#!/usr/bin/env bun
/**
 * Comic generation spike — OpenRouter's dedicated image endpoint.
 *
 *   bun run comic
 *   bun run comic --model=google/gemini-3-pro-image
 *   bun run comic --prompt="..." --out=./output/foo.png
 *
 * POST https://openrouter.ai/api/v1/images returns base64 bytes in
 * data[].b64_json — it is NOT the chat/completions API.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const API_KEY = process.env.OPENROUTER_API_KEY;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
}

/**
 * The three things PROJECT_CONTEXT flags as the hard part — a story that makes
 * sense, one recognisable recurring character, and legible lettering — are all
 * asked for explicitly here rather than left to the model.
 */
const DEFAULT_PROMPT = `A four-panel comic strip page about one week in the life of a software developer, laid out in a 2x2 grid with clean white gutters between panels.

Style: bold hand-inked comic book art, thick black outlines, flat vibrant colours, halftone dot shading, warm cream paper background. Expressive, funny, warm — like a modern indie comic, not a corporate illustration.

The SAME character appears in all four panels and must be instantly recognisable: a young developer with messy dark hair, round glasses, a mustard-yellow hoodie.

Panel 1: sunrise, the developer confidently opens a laptop at a cluttered desk, coffee steaming. Speech bubble: "This week I'll finally ship it!"
Panel 2: midday, three overlapping video calls on screen, the character sandwiched between floating chat windows, overwhelmed. Speech bubble: "Just one more meeting..."
Panel 3: night, the room dark except for screen glow, empty coffee cups stacked into a tower, the character squinting at a wall of red error text. Speech bubble: "Who wrote this?!"
Panel 4: dawn again, the character slumped back in the chair, grinning exhausted and triumphant, a single green checkmark glowing on screen. Speech bubble: "Shipped."

All speech bubble text must be spelled correctly, in clean bold comic lettering, and easy to read.`;

const main = async () => {
  if (!API_KEY) {
    console.error("\n✗ missing env: OPENROUTER_API_KEY\n");
    process.exit(1);
  }

  const model = arg("model") || "openai/gpt-image-2";
  const prompt = arg("prompt") || DEFAULT_PROMPT;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = arg("out") || `./output/comic-${stamp}.png`;

  console.log(`→ ${model}`);
  console.log(`→ generating… (this takes a while)\n`);

  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1536" }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`\n✗ ${res.status} ${res.statusText}\n${text.slice(0, 600)}\n`);
    process.exit(1);
  }

  const json = JSON.parse(text) as {
    data?: { b64_json?: string; media_type?: string; url?: string }[];
    usage?: { cost?: number; completion_tokens?: number };
  };

  const image = json.data?.[0];
  if (!image?.b64_json) {
    console.error(`\n✗ no image in response:\n${text.slice(0, 600)}\n`);
    process.exit(1);
  }

  const bytes = Buffer.from(image.b64_json, "base64");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`✓ ${out}`);
  console.log(`  ${(bytes.length / 1024).toFixed(0)} KB · ${image.media_type ?? "image/png"} · ${secs}s`);
  if (json.usage?.cost !== undefined) console.log(`  cost: $${json.usage.cost}`);
};

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
