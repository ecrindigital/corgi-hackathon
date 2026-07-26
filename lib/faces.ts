/**
 * Reference photos, held in memory.
 *
 * In duo mode each person uploads from their own browser, so the two photos
 * have to meet somewhere server-side before the drawing call. A real product
 * would put them in Blob storage; for a hackathon a process-local map is
 * enough and keeps the "no database, no object storage" shortcut intact.
 *
 * Consequences, accepted deliberately: photos die on restart, and on a
 * multi-instance deploy the two uploads can land on different instances. Fine
 * for a demo on one machine; the first thing to replace if this ships.
 */

type Entry = { dataUrl: string; at: number };

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 50;

const faces = new Map<string, Entry>();

const key = (roomCode: string, slot: string) => `${roomCode}:${slot}`;

function evictStale() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of faces) if (v.at < cutoff) faces.delete(k);

  // Hard cap as a memory backstop: drop the oldest first.
  if (faces.size > MAX_ENTRIES) {
    const oldest = [...faces.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of oldest.slice(0, faces.size - MAX_ENTRIES)) faces.delete(k);
  }
}

export function putFace(roomCode: string, slot: string, dataUrl: string) {
  evictStale();
  faces.set(key(roomCode, slot), { dataUrl, at: Date.now() });
}

export function getFace(roomCode: string, slot: string): string | null {
  evictStale();
  return faces.get(key(roomCode, slot))?.dataUrl ?? null;
}

export function clearFace(roomCode: string, slot: string) {
  faces.delete(key(roomCode, slot));
}
