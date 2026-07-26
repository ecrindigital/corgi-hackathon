import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { get } from "@vercel/blob";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SHARE_PATH = /^shared\/[0-9a-f-]{36}\.(png|jpe?g|webp)$/;

export async function GET(request: Request) {
  const pathname = new URL(request.url).searchParams.get("pathname") ?? "";
  if (!SHARE_PATH.test(pathname))
    return NextResponse.json({ error: "Invalid share link." }, { status: 400 });

  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200)
    return NextResponse.json({ error: "Comic not found." }, { status: 404 });

  return new Response(result.stream, {
    headers: {
      "Content-Type": result.blob.contentType,
      "Content-Length": String(result.blob.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: result.blob.etag,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!SHARE_PATH.test(pathname)) throw new Error("Invalid share path.");
        return {
          allowedContentTypes: ["image/png", "image/jpeg", "image/webp"],
          maximumSizeInBytes: 15_000_000,
          addRandomSuffix: false,
          tokenPayload: "toonback-comic",
        };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
