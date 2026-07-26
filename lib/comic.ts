/**
 * context → story → drawing.
 *
 * Two models, two providers, on purpose:
 *   - the story step runs on Merge Gateway (sponsor credit, text only)
 *   - the drawing step runs on OpenRouter (Merge Gateway has no image endpoint)
 */

import type { ToolResult } from "./merge";

const GATEWAY_URL = "https://api-gateway.merge.dev/v1/openai/chat/completions";
const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

export const STORY_MODEL = process.env.STORY_MODEL ?? "anthropic/claude-sonnet-5";
export const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "openai/gpt-image-2";

/** Total context handed to the story model. Generous, but bounded. */
const CONTEXT_BUDGET = 60_000;
const PER_TOOL_BUDGET = 6_000;

/** Flatten the raw dump into something a language model can actually read. */
export function condenseContext(results: ToolResult[]): string {
  const useful = results.filter((r) => r.status === "ok" && r.text.trim());
  const byConnector = new Map<string, ToolResult[]>();
  for (const r of useful) byConnector.set(r.connector, [...(byConnector.get(r.connector) ?? []), r]);

  const chunks: string[] = [];
  let spent = 0;

  for (const [connector, rows] of byConnector) {
    chunks.push(`\n===== SOURCE: ${connector} =====`);
    for (const r of rows) {
      if (spent >= CONTEXT_BUDGET) break;
      const slice = r.text.slice(0, Math.min(PER_TOOL_BUDGET, CONTEXT_BUDGET - spent));
      spent += slice.length;
      chunks.push(`\n--- ${r.name} ---\n${slice}`);
    }
  }

  return chunks.join("\n");
}

const STORY_SYSTEM = `You turn a person's real digital exhaust into a short comic.

You will receive raw data pulled from their connected accounts over a time window. Your job is to find the few genuinely memorable, funny, or quietly human moments in it, and write ONE prompt for an image-generation model that draws the whole comic as a single page.

Rules for the comic you design:
- 3 to 6 panels on one page. You choose the count and the layout.
- ONE recurring main character, described identically every time they appear (hair, glasses, clothing, build). This is the single most important requirement: the reader must recognise the same person in every panel.
- Ground it in the ACTUAL data. Use real event names, real places, real people's first names, real songs, real times of day. A generic "developer has a busy week" comic is a failure.
- Give every speech bubble its exact words. Keep them short. Demand correct spelling and clean, readable comic lettering.
- Warm and funny, never mean. Affectionate teasing is good; humiliation is not.

PRIVACY — this is a hard constraint, not a preference. The comic is a shareable image; treat every panel as a poster on a wall.

NEVER render, and never reference in dialogue:
- verification codes, one-time passcodes, 2FA codes, PINs, or any digit sequence from a security email
- passwords, API keys, tokens, recovery phrases
- account numbers, card numbers, invoice or payment amounts
- postal addresses, phone numbers, full email addresses
- health, medical, legal or financial specifics
- surnames or identifying details of other people — first names only

A security or verification email may inspire a panel's SITUATION ("another sign-in alert"), but the code itself must never appear on any screen, note, or bubble you describe. If you cannot describe a moment without one of the above, choose a different moment.

Output ONLY the image prompt as plain prose. No preamble, no markdown, no explanation, no quotes around it. Begin directly with the description of the comic page.`;

/** Ask the story model for one image prompt built from the real data. */
export async function writeComicBrief(context: string, windowDays: number): Promise<string> {
  const key = process.env.MERGE_GATEWAY_API_KEY;
  if (!key) throw new Error("missing env: MERGE_GATEWAY_API_KEY");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: STORY_MODEL,
      max_tokens: 2000,
      messages: [
        { role: "system", content: STORY_SYSTEM },
        {
          role: "user",
          content: `Here is my real data from the last ${windowDays} days. Design my comic.\n\n${context}`,
        },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`story model ${res.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const brief = json.choices?.[0]?.message?.content?.trim();
  if (!brief) throw new Error(`story model returned nothing: ${text.slice(0, 300)}`);
  return brief;
}

const STYLE_SUFFIX = `

Art direction: bold hand-inked comic book art, thick confident black outlines, flat vibrant colours, halftone dot shading, warm cream paper background, clean white gutters between panels. Expressive and warm, like a modern indie comic — not corporate illustration, not 3D, not photorealistic.

All lettering must be spelled correctly and easy to read.`;

export type DrawnComic = { dataUrl: string; bytes: number; cost?: number };

/** Draw the page. OpenRouter's image endpoint returns base64, not a URL. */
export async function drawComic(prompt: string): Promise<DrawnComic> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("missing env: OPENROUTER_API_KEY");

  const res = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: `${prompt}${STYLE_SUFFIX}`,
      n: 1,
      size: "1024x1536",
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`image model ${res.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text) as {
    data?: { b64_json?: string; media_type?: string }[];
    usage?: { cost?: number };
  };
  const image = json.data?.[0];
  if (!image?.b64_json) throw new Error(`image model returned no image: ${text.slice(0, 300)}`);

  return {
    dataUrl: `data:${image.media_type ?? "image/png"};base64,${image.b64_json}`,
    bytes: Math.floor((image.b64_json.length * 3) / 4),
    cost: json.usage?.cost,
  };
}
