import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import {
  hasContextBlobStorage,
  MAX_ZIP_BYTES,
  temporaryPrefix,
  UPLOAD_CONTENT_TYPES,
} from "@/lib/context-items";
import { getRoom } from "@/lib/room";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasContextBlobStorage())
    return NextResponse.json({ error: "Private Blob storage is not configured." }, { status: 503 });

  try {
    const room = await getRoom();
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const prefix = temporaryPrefix(room.code, room.slot);
        if (!pathname.startsWith(prefix) || pathname.includes(".."))
          throw new Error("Invalid upload path.");
        return {
          allowedContentTypes: [...UPLOAD_CONTENT_TYPES],
          maximumSizeInBytes: MAX_ZIP_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 60,
          validUntil: Date.now() + 10 * 60_000,
          tokenPayload: JSON.stringify({ room: room.code, slot: room.slot }),
        };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
