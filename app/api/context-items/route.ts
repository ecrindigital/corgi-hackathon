import { NextResponse } from "next/server";
import {
  capacityFor,
  contextSummaries,
  deleteContextItem,
  deleteTemporaryUpload,
  getContextItems,
  parseUploadedFile,
  readTemporaryUpload,
  saveContextDrafts,
  textDraft,
  urlDraft,
} from "@/lib/context-items";
import { getRoom } from "@/lib/room";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function looksLikeUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const room = await getRoom();
    const items = await getContextItems(room.code, room.slot);
    return NextResponse.json({ items: contextSummaries(items) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const room = await getRoom();
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("Choose a file to upload.");
      const parsed = await parseUploadedFile(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        await capacityFor(room.code, room.slot),
      );
      const items = await saveContextDrafts(room.code, room.slot, parsed.drafts);
      return NextResponse.json({ items: contextSummaries(items), skipped: parsed.skipped });
    }

    const body = (await request.json().catch(() => ({}))) as {
      value?: string;
      upload?: { pathname?: string; name?: string };
    };

    if (body.upload) {
      const pathname = body.upload.pathname ?? "";
      const name = body.upload.name ?? "";
      if (!pathname || !name) throw new Error("Upload metadata is incomplete.");
      try {
        const parsed = await parseUploadedFile(
          name,
          await readTemporaryUpload(pathname, room.code, room.slot),
          await capacityFor(room.code, room.slot),
        );
        const items = await saveContextDrafts(room.code, room.slot, parsed.drafts);
        return NextResponse.json({ items: contextSummaries(items), skipped: parsed.skipped });
      } finally {
        await deleteTemporaryUpload(pathname).catch(() => {});
      }
    }

    const value = body.value?.trim() ?? "";
    const draft = looksLikeUrl(value) ? await urlDraft(value) : textDraft(value);
    const items = await saveContextDrafts(room.code, room.slot, [draft]);
    return NextResponse.json({ items: contextSummaries(items), skipped: 0 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const room = await getRoom();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing item ID." }, { status: 400 });
    const removed = await deleteContextItem(room.code, room.slot, id);
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
