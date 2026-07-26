import { NextResponse } from "next/server";
import { CONNECTORS, createMagicLink } from "@/lib/merge";
import { getRegisteredUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { connector } = (await request.json()) as { connector?: string };
    if (!connector || !CONNECTORS.some((c) => c.slug === connector))
      return NextResponse.json({ error: `unknown connector: ${connector}` }, { status: 400 });

    const userId = await getRegisteredUserId();
    return NextResponse.json(await createMagicLink(userId, connector));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
