import { afterEach, describe, expect, test } from "bun:test";
import { drawComic } from "./comic";

const originalKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("drawComic", () => {
  test("dev mode returns a zero-cost SVG without an OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const comic = await drawComic("ignored", [], { devMode: true });

    expect(comic.dataUrl).toStartWith("data:image/svg+xml;charset=utf-8,");
    expect(decodeURIComponent(comic.dataUrl.split(",")[1]!)).toContain("OPENROUTER OFF");
    expect(comic.bytes).toBeGreaterThan(0);
    expect(comic.cost).toBe(0);
  });

  test("normal mode still requires an OpenRouter key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(drawComic("ignored")).rejects.toThrow("missing env: OPENROUTER_API_KEY");
  });
});
