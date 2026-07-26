import { NextResponse } from "next/server";
import { createMagicLink, disconnectConnector } from "@/lib/merge";
import { currentRegisteredUserId } from "@/lib/room";

export const dynamic = "force-dynamic";

async function connectorFrom(request: Request): Promise<string | null> {
  const { connector } = (await request.json()) as { connector?: unknown };
  return typeof connector === "string" && /^[a-z0-9_]+$/.test(connector) ? connector : null;
}

export async function POST(request: Request) {
  try {
    // Slugs come from the Tool Pack, so we only sanity-check the shape here —
    // Merge answers "Connector not found" for anything it doesn't know.
    const connector = await connectorFrom(request);
    if (!connector) return NextResponse.json({ error: "invalid connector" }, { status: 400 });
    const userId = await currentRegisteredUserId();
    return NextResponse.json(await createMagicLink(userId, connector));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const connector = await connectorFrom(request);
    if (!connector) return NextResponse.json({ error: "invalid connector" }, { status: 400 });
    await disconnectConnector(await currentRegisteredUserId(), connector);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
