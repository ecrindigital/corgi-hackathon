import { NextResponse } from "next/server";
import { createMagicLink } from "@/lib/merge";
import { getRegisteredUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { connector } = (await request.json()) as { connector?: string };
    // Slugs come from the Tool Pack, so we only sanity-check the shape here —
    // Merge answers "Connector not found" for anything it doesn't know.
    if (!connector || !/^[a-z0-9_]+$/.test(connector))
      return NextResponse.json({ error: `invalid connector: ${connector}` }, { status: 400 });

    const userId = await getRegisteredUserId();
    return NextResponse.json(await createMagicLink(userId, connector));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
