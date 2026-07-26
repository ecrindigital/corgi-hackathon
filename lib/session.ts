import { cookies } from "next/headers";
import { createRegisteredUser } from "./merge";

const COOKIE = "corgi_registered_user";

/**
 * No application login (hackathon shortcut): one anonymous Merge Registered User
 * per browser, kept in an HTTP-only cookie. MERGE_REGISTERED_USER_ID seeds it so
 * a connector you already authenticated from the CLI is reused instead of
 * stranding you with a fresh, empty user.
 */
export async function getRegisteredUserId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing) return existing;

  const seeded = process.env.MERGE_REGISTERED_USER_ID;
  const id = seeded || (await createRegisteredUser(`corgi-${crypto.randomUUID()}`));

  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}
