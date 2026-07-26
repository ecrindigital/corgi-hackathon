import { NextResponse } from "next/server";
import { clearFace, putFace } from "@/lib/faces";
import { getRoom } from "@/lib/room";

export const dynamic = "force-dynamic";

/** Generous ceiling — the browser downscales to ~512px before uploading. */
const MAX_BYTES = 4_000_000;

export async function POST(request: Request) {
  try {
    const { dataUrl } = (await request.json()) as { dataUrl?: string };
    if (!dataUrl || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl))
      return NextResponse.json({ error: "expected a png/jpeg/webp data URL" }, { status: 400 });
    if (dataUrl.length > MAX_BYTES)
      return NextResponse.json({ error: "image too large" }, { status: 413 });

    const room = await getRoom();
    putFace(room.code, room.slot, dataUrl);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE() {
  const room = await getRoom();
  clearFace(room.code, room.slot);
  return NextResponse.json({ ok: true });
}
