import { NextResponse } from "next/server";
import { dumpOptions, runDump } from "@/lib/merge";
import { currentRegisteredUserId } from "@/lib/room";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { windowDays?: number };
    const userId = await currentRegisteredUserId();
    const report = await runDump(userId, dumpOptions({ windowDays: body.windowDays }));
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
