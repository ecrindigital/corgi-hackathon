import { NextResponse } from "next/server";
import { cleanupAllContext } from "@/lib/context-items";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const removed = await cleanupAllContext();
  return NextResponse.json({ ok: true, removed });
}
