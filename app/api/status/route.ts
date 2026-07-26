import { NextResponse } from "next/server";
import { connectorStatus } from "@/lib/merge";
import { getFace } from "@/lib/faces";
import { readIMessages } from "@/lib/imessage";
import { getRoom, participants, registeredUserFor } from "@/lib/room";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const room = await getRoom();
    const userId = await registeredUserFor(room);

    // Connector list comes from the Tool Pack via MCP; the other participant's
    // state is a cheap REST read, so we don't open a second MCP session.
    const [connectors, people] = await Promise.all([connectorStatus(userId), participants(room)]);

    // iMessage is not a Merge connector: it is read straight off this machine,
    // so it is injected here rather than discovered in the Tool Pack.
    const local = await readIMessages(new Date(Date.now() - 86_400_000), new Date());
    const imessage =
      process.env.IMESSAGE_ENABLED === "true"
        ? [
            {
              slug: "imessage",
              label: "iMessage",
              emoji: "💬",
              blurb: local.note
                ? "Needs Full Disk Access in System Settings"
                : "Your real conversations, read locally. Never leaves this machine except in the story.",
              connected: !local.note,
              toolCount: local.results.length,
              inPack: true,
            },
          ]
        : [];

    return NextResponse.json({
      room: room.code,
      slot: room.slot,
      connectors: [...imessage, ...connectors],
      participants: people.map((p) => ({
        slot: p.slot,
        isYou: p.isYou,
        connectors: p.connectors,
        hasFace: Boolean(getFace(room.code, p.slot)),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
