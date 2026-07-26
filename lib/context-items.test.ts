import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import {
  getContextBundle,
  getContextItems,
  isPublicIp,
  MAX_TEXT_CHARS,
  parseUploadedFile,
  parseZipUpload,
  saveContextDrafts,
  textDraft,
  urlDraft,
} from "./context-items";

const savedBlobEnv = {
  token: process.env.BLOB_READ_WRITE_TOKEN,
  oidc: process.env.VERCEL_OIDC_TOKEN,
  store: process.env.BLOB_STORE_ID,
};

beforeAll(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.BLOB_STORE_ID;
});

afterAll(() => {
  if (savedBlobEnv.token) process.env.BLOB_READ_WRITE_TOKEN = savedBlobEnv.token;
  if (savedBlobEnv.oidc) process.env.VERCEL_OIDC_TOKEN = savedBlobEnv.oidc;
  if (savedBlobEnv.store) process.env.BLOB_STORE_ID = savedBlobEnv.store;
});

function centralOffset(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let index = 0; index <= zip.length - 4; index++)
    if (view.getUint32(index, true) === 0x02014b50) return index;
  throw new Error("central directory not found");
}

function onePagePdf(text: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(pdf);
}

describe("context validation", () => {
  test("pasted text is trimmed and bounded", () => {
    expect(textDraft("  a small memory  ").text).toBe("a small memory");
    expect(() => textDraft("x".repeat(MAX_TEXT_CHARS + 1))).toThrow("characters or fewer");
  });

  test("private and documentation IP ranges are blocked", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
  });

  test("plain files become bounded context drafts", async () => {
    const parsed = await parseUploadedFile(
      "week.md",
      strToU8("# Monday\nBuilt a comic."),
      { items: 10, images: 6 },
    );
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.drafts[0]).toMatchObject({ kind: "file", label: "week.md" });
  });

  test("extracts readable HTML snapshots and PDF text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        "<html><head><title>Weekend</title></head><body><nav>Ignore me</nav><main><p>Made a comic with friends.</p></main></body></html>",
        { headers: { "Content-Type": "text/html" } },
      )) as unknown as typeof fetch;
    try {
      expect(await urlDraft("https://93.184.216.34/story")).toMatchObject({
        kind: "url",
        label: "Weekend",
        text: "Made a comic with friends.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const pdf = await parseUploadedFile("memory.pdf", onePagePdf("Hello from a PDF"), {
      items: 10,
      images: 6,
    });
    expect(pdf.drafts[0]).toMatchObject({ kind: "pdf", label: "memory.pdf" });
    expect(pdf.drafts[0]!.text).toContain("Hello from a PDF");
  });
});

describe("ZIP import", () => {
  test("prioritizes documents, imports images, and reports skipped entries", async () => {
    const zip = zipSync({
      "photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "_chat.txt": strToU8("A week of messages"),
      "ignored.json": strToU8("{}"),
      "__MACOSX/.DS_Store": strToU8("noise"),
    });

    const parsed = await parseZipUpload(zip, { items: 2, images: 1 });

    expect(parsed.drafts.map((draft) => draft.kind)).toEqual(["file", "image"]);
    expect(parsed.drafts.map((draft) => draft.label)).toEqual(["_chat.txt", "photo.png"]);
    expect(parsed.skipped).toBe(2);
  });

  test("rejects traversal and nested archives", async () => {
    await expect(
      parseZipUpload(zipSync({ "../secret.txt": strToU8("no") }), { items: 10, images: 6 }),
    ).rejects.toThrow("unsafe path");
    await expect(
      parseZipUpload(zipSync({ "nested.zip": zipSync({ "a.txt": strToU8("no") }) }), {
        items: 10,
        images: 6,
      }),
    ).rejects.toThrow("Nested ZIP");
  });

  test("rejects encrypted flags, symlinks, too many entries, and expansion bombs", async () => {
    const encrypted = zipSync({ "a.txt": strToU8("hello") });
    const encryptedView = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
    encryptedView.setUint16(centralOffset(encrypted) + 8, 1, true);
    await expect(parseZipUpload(encrypted, { items: 10, images: 6 })).rejects.toThrow("Encrypted ZIP");

    const symlink = zipSync({ "link.txt": strToU8("target") });
    const symlinkView = new DataView(symlink.buffer, symlink.byteOffset, symlink.byteLength);
    symlinkView.setUint32(centralOffset(symlink) + 38, 0xa0000000, true);
    await expect(parseZipUpload(symlink, { items: 10, images: 6 })).rejects.toThrow("symlinks");

    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`${index}.txt`, strToU8("x")]),
    );
    await expect(parseZipUpload(zipSync(many), { items: 10, images: 6 })).rejects.toThrow(
      "at most 100",
    );

    const bomb = zipSync({ "large.txt": strToU8("hello") });
    const bombView = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    bombView.setUint32(centralOffset(bomb) + 24, 40_000_001, true);
    await expect(parseZipUpload(bomb, { items: 10, images: 6 })).rejects.toThrow(
      "40 MB limit",
    );

    const lyingHeader = zipSync({ "oversized.txt": strToU8("x".repeat(200_001)) });
    const lyingView = new DataView(
      lyingHeader.buffer,
      lyingHeader.byteOffset,
      lyingHeader.byteLength,
    );
    lyingView.setUint32(centralOffset(lyingHeader) + 24, 1, true);
    await expect(parseZipUpload(lyingHeader, { items: 10, images: 6 })).rejects.toThrow(
      "file-size limit",
    );
  });

  test("rejects malformed archives atomically", async () => {
    await expect(
      parseZipUpload(new Uint8Array([0x50, 0x4b, 1, 2, 3]), { items: 10, images: 6 }),
    ).rejects.toThrow("malformed");

    const invalidUnselectedImage = zipSync({
      "chat.txt": strToU8("This entry would fill the only available slot."),
      "broken.png": strToU8("not really an image"),
    });
    await expect(
      parseZipUpload(invalidUnselectedImage, { items: 1, images: 0 }),
    ).rejects.toThrow("not a supported image");
  });
});

describe("context lifecycle", () => {
  test("scopes items by participant and expires them after one hour", async () => {
    const room = crypto.randomUUID();
    const start = new Date("2026-07-26T12:00:00.000Z");
    await saveContextDrafts(room, "a", [textDraft("Person A memory")], start);
    await saveContextDrafts(room, "b", [textDraft("Person B memory")], start);

    expect(await getContextItems(room, "a", new Date("2026-07-26T12:30:00.000Z"))).toHaveLength(1);
    const bundle = await getContextBundle(room, "a", new Date("2026-07-26T12:30:00.000Z"));
    expect(bundle.results[0]).toMatchObject({ connector: "context", status: "ok" });
    expect(bundle.results[0]!.text).toContain("Person A memory");
    expect(bundle.results[0]!.text).not.toContain("Person B memory");

    expect(await getContextItems(room, "a", new Date("2026-07-26T13:00:01.000Z"))).toEqual([]);
  });
});
