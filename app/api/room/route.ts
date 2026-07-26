import { NextResponse } from "next/server";
import { isValidCode, joinRoom } from "@/lib/room";

export const dynamic = "force-dynamic";

/** Join an existing room as the second person. */
export async function POST(request: Request) {
  try {
    const { code } = (await request.json()) as { code?: string };
    const normalised = code?.trim().toUpperCase();
    if (!normalised || !isValidCode(normalised))
      return NextResponse.json({ error: "invalid room code" }, { status: 400 });

    const room = await joinRoom(normalised);
    return NextResponse.json({ room: room.code, slot: room.slot });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
