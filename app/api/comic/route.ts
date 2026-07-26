import { condenseContext, drawComic, IMAGE_MODEL, STORY_MODEL, writeComicBrief } from "@/lib/comic";
import { dumpOptions, runDump } from "@/lib/merge";
import { getRegisteredUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The whole loop behind one button.
 *
 * Drawing alone takes over two minutes, so this streams NDJSON progress events
 * rather than leaving the browser on a blank spinner. Each line is one JSON
 * object; the last one carries the finished comic.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { windowDays?: number };
  const windowDays = body.windowDays ?? 7;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      try {
        send({ step: "context", message: "Reading your week…" });
        const userId = await getRegisteredUserId();
        const report = await runDump(userId, dumpOptions({ windowDays }));

        const used = report.results.filter((r) => r.status === "ok");
        const sources = [...new Set(used.map((r) => r.connector))];

        if (!used.length) {
          send({
            error:
              "Nothing came back from your connected sources. Connect a source, or try a longer window.",
          });
          controller.close();
          return;
        }

        send({
          step: "context",
          message: `Found ${used.length} pockets of your life across ${sources.length} source${sources.length > 1 ? "s" : ""}.`,
          sources,
        });

        send({ step: "story", message: "Deciding which moments deserve a panel…" });
        const brief = await writeComicBrief(condenseContext(report.results), windowDays);

        send({ step: "draw", message: "Inking the page — this is the slow bit, ~2 minutes." });
        const drawn = await drawComic(brief);

        send({
          done: true,
          image: drawn.dataUrl,
          brief,
          sources,
          toolsUsed: used.length,
          cost: drawn.cost,
          models: { story: STORY_MODEL, image: IMAGE_MODEL },
        });
      } catch (err) {
        send({ error: (err as Error).message ?? String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
