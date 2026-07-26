import { NextResponse } from "next/server";
import { connectorStatus } from "@/lib/merge";
import { getFace } from "@/lib/faces";
import { getRoom, participants, registeredUserFor } from "@/lib/room";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const room = await getRoom();
    const userId = await registeredUserFor(room);

    // Connector list comes from the Tool Pack via MCP; the other participant's
    // state is a cheap REST read, so we don't open a second MCP session.
    const [connectors, people] = await Promise.all([connectorStatus(userId), participants(room)]);

    return NextResponse.json({
      room: room.code,
      slot: room.slot,
      connectors,
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
