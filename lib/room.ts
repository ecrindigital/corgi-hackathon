import { cookies } from "next/headers";
import { getContextItems } from "./context-items";
import { ensureRegisteredUser, getRegisteredUser } from "./merge";

const COOKIE = "corgi_room";
const SLOTS = ["a", "b"] as const;

export type Slot = (typeof SLOTS)[number];
export type Room = { code: string; slot: Slot };

export type Participant = {
  slot: Slot;
  userId: string;
  connectors: string[];
  contextCount: number;
  isYou: boolean;
};

/** Unambiguous alphabet: no O/0, no I/1 — these codes get read aloud. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const isValidCode = (code: string) => /^[A-Z2-9]{6}$/.test(code);

/**
 * Everyone is in a room; solo is simply a room where slot B never joined.
 *
 * The room code plus the slot letter *is* the identity: `room:AB12CD:a` is fed
 * to Merge as an origin_user_id, which always resolves to the same Registered
 * User. Two browsers holding the same code therefore address the same pair of
 * Merge users with no shared storage between them.
 */
export async function getRoom(): Promise<Room> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;

  if (raw) {
    const [code, slot] = raw.split(":");
    if (code && isValidCode(code) && (slot === "a" || slot === "b")) return { code, slot };
  }

  const room: Room = { code: newCode(), slot: "a" };
  await writeRoom(room);
  return room;
}

export async function writeRoom(room: Room): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, `${room.code}:${room.slot}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

/** Join an existing room as the second person. */
export async function joinRoom(code: string): Promise<Room> {
  if (!isValidCode(code)) throw new Error(`invalid room code: ${code}`);
  const room: Room = { code: code.toUpperCase(), slot: "b" };
  await writeRoom(room);
  return room;
}

export const originUserId = (room: Room) => `room:${room.code}:${room.slot}`;

export async function registeredUserFor(room: Room): Promise<string> {
  // Demo shortcut: MERGE_REGISTERED_USER_ID pins slot A to the account you
  // already authenticated from the CLI, so connecting Gmail once keeps working
  // across rooms. Unset it for genuinely independent rooms.
  const seeded = process.env.MERGE_REGISTERED_USER_ID;
  if (seeded && room.slot === "a") return seeded;

  return ensureRegisteredUser(originUserId(room), `Corgi ${room.code} ${room.slot.toUpperCase()}`);
}

/** The current browser's Merge Registered User. */
export async function currentRegisteredUserId(): Promise<string> {
  return registeredUserFor(await getRoom());
}

/**
 * Everyone in the room who has actually connected something.
 *
 * Slot B's user is only created once someone joins, so an unresolvable or
 * empty slot B simply means "still solo".
 */
export async function participants(room: Room, currentUserId?: string): Promise<Participant[]> {
  const found = await Promise.all(
    SLOTS.map(async (slot) => {
      const userId =
        slot === room.slot && currentUserId
          ? currentUserId
          : await registeredUserFor({ code: room.code, slot }).catch(() => null);
      if (!userId) return null;
      const [info, context] = await Promise.all([
        getRegisteredUser(userId),
        getContextItems(room.code, slot),
      ]);
      return {
        slot,
        userId,
        connectors: info?.authenticated_connectors ?? [],
        contextCount: context.length,
        isYou: slot === room.slot,
      } satisfies Participant;
    }),
  );

  return found.filter((p): p is Participant => p !== null);
}
