import { NextResponse } from "next/server";
import { connectorStatus } from "@/lib/merge";
import { getRegisteredUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await getRegisteredUserId();
    return NextResponse.json({ userId, connectors: await connectorStatus(userId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
