import { condenseContext, drawComic, IMAGE_MODEL, STORY_MODEL, writeComicBrief, type Cast } from "@/lib/comic";
import { dumpOptions, RANGE_DAYS, runDump, type TimeRange } from "@/lib/merge";
import { getFace } from "@/lib/faces";
import { readIMessages } from "@/lib/imessage";
import { getRoom, participants, registeredUserFor } from "@/lib/room";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RANGE_LABEL: Record<TimeRange, string> = {
  week: "the last 7 days",
  month: "the last 30 days",
  lifetime: "their whole history, with no date filter",
};

/**
 * The whole loop behind one button.
 *
 * Drawing still dominates the wall clock, so this streams NDJSON progress events
 * rather than leaving the browser on a blank spinner. Each line is one JSON
 * object; the last one carries the finished comic.
 */
export async function POST(request: Request) {
  const devMode = ["true", "1"].includes(new URL(request.url).searchParams.get("dev") ?? "");
  const body = (await request.json().catch(() => ({}))) as { range?: TimeRange };
  const range: TimeRange = body.range && body.range in RANGE_DAYS ? body.range : "week";

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      try {
        const room = await getRoom();
        const people = await participants(room);
        const active = people.filter((p) => p.connectors.length > 0);

        if (!active.length) {
          send({ error: "Nobody in this room has connected a source yet." });
          controller.close();
          return;
        }

        const duo = active.length > 1;
        send({
          step: "context",
          message: duo ? "Reading both your lives…" : "Reading your life…",
        });

        // Both participants are read in parallel — one slow mailbox shouldn't
        // double the wait.
        const opts = dumpOptions({ windowDays: RANGE_DAYS[range] });
        const reports = await Promise.all(
          active.map(async (p) => ({
            person: p,
            report: await runDump(await registeredUserFor({ code: room.code, slot: p.slot }), opts),
          })),
        );

        const cast: Cast[] = [];
        const faces: string[] = [];
        let totalTools = 0;
        const sources = new Set<string>();

        // iMessage lives on this machine, not behind Merge, so it only joins
        // the person actually sitting at the server.
        const local = await readIMessages(opts.since, opts.now);
        if (local.note) send({ step: "context", message: local.note });

        for (const { person, report } of reports) {
          const mine = person.isYou ? local.results : [];
          if (mine.length) report.results.push(...mine);

          const used = report.results.filter((r) => r.status === "ok");
          if (!used.length) continue;
          totalTools += used.length;
          for (const r of used) sources.add(r.connector);

          const face = getFace(room.code, person.slot);
          const label = person.slot.toUpperCase();
          cast.push({ label, context: condenseContext(report.results), hasFace: Boolean(face) });
          if (face) faces.push(face);
        }

        if (!cast.length) {
          send({ error: "Your sources came back empty. Try a longer time range." });
          controller.close();
          return;
        }

        send({
          step: "context",
          message: `Found ${totalTools} pockets of ${duo ? "your lives" : "your life"} across ${sources.size} source${sources.size > 1 ? "s" : ""}.`,
          sources: [...sources],
        });

        send({
          step: "story",
          message: duo
            ? "Finding where your two lives collide…"
            : "Deciding which moments deserve a panel…",
        });
        const brief = await writeComicBrief(cast, RANGE_LABEL[range]);

        send({
          step: "draw",
          message: faces.length
            ? "Inking the page, with your face in it. About half a minute."
            : "Inking the page. About half a minute.",
        });
        const drawn = await drawComic(brief, faces, { devMode });

        send({
          done: true,
          devMode,
          image: drawn.dataUrl,
          brief,
          sources: [...sources],
          toolsUsed: totalTools,
          people: cast.length,
          faces: faces.length,
          range,
          cost: drawn.cost,
          models: { story: STORY_MODEL, image: devMode ? "dev-placeholder" : IMAGE_MODEL },
        });
      } catch (err) {
        send({ error: (err as Error).message ?? String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
