/**
 * iMessage, read locally.
 *
 * Merge has no iMessage connector and Photon only carries messages sent *to*
 * your agent, so neither can reach your own conversation history. On macOS that
 * history is a SQLite file at ~/Library/Messages/chat.db, and reading it is the
 * only way to get the single richest personal source this product could have.
 *
 * Two hard limits, both deliberate:
 *
 * 1. macOS gates the file behind Full Disk Access. Nothing here can grant that;
 *    without it every call returns an empty list and the pipeline carries on.
 * 2. It only exists on the machine running the server. This source works under
 *    `bun run dev` on a Mac and silently disappears on Vercel.
 *
 * Auto-detected on macOS. Set IMESSAGE_ENABLED=false to opt out.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "./merge";

type Statement = { all: (...params: unknown[]) => unknown[] };
type SqliteDb = { prepare: (sql: string) => Statement; close: () => void };

/**
 * Bun ships `bun:sqlite`, Node ships `node:sqlite`, and neither has the other.
 * The specifier is held in a variable so the bundler cannot try to resolve
 * either one at build time, which is what broke the Next build.
 */
async function openDatabase(path: string): Promise<SqliteDb> {
  const attempts: [string, (mod: Record<string, unknown>) => SqliteDb][] = [
    ["bun:sqlite", (mod) => new (mod.Database as new (p: string, o: object) => SqliteDb)(path, { readonly: true })],
    [
      "node:sqlite",
      (mod) => new (mod.DatabaseSync as new (p: string, o: object) => SqliteDb)(path, { readOnly: true }),
    ],
  ];

  let last: unknown;
  for (const [specifier, construct] of attempts) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)) as Record<
        string,
        unknown
      >;
    } catch (err) {
      last = err;
      continue;
    }
    // The runtime exists. Surface database errors such as macOS permission
    // denial instead of masking them by trying another runtime.
    return construct(mod);
  }
  throw last instanceof Error ? last : new Error("no SQLite runtime available");
}

const DB_PATH = process.env.IMESSAGE_DB_PATH ?? join(homedir(), "Library", "Messages", "chat.db");

/**
 * Apple counts from 2001-01-01, in nanoseconds since macOS 10.13 and in plain
 * seconds before that. A nanosecond value like 806730795160150016 overflows
 * Number.MAX_SAFE_INTEGER, and the SQLite driver refuses to hand it over at
 * all, so the conversion happens in SQL and only unix seconds cross into JS.
 */
const APPLE_EPOCH_OFFSET = 978_307_200;

/** Both storage formats collapsed to unix seconds, inside SQLite. */
const UNIX_TS = `(CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000 ELSE m.date END + ${APPLE_EPOCH_OFFSET})`;

const toUnix = (d: Date) => Math.floor(d.getTime() / 1000);

/** Enough conversation to find a story in, not so much it drowns the model. */
const MAX_MESSAGES = 250;
const MAX_PER_CHAT = 40;

type Row = {
  chat_name: string | null;
  chat_identifier: string | null;
  handle: string | null;
  is_from_me: number;
  /** Unix seconds, already converted by the query. */
  ts: number;
  text: string | null;
  attributed_body: Uint8Array | null;
};

/**
 * Recent macOS leaves `text` NULL and puts the body in `attributedBody`. On
 * this database that is 2387 messages out of 2399, so this decoder is not a
 * fallback, it is the main path.
 *
 * The blob is a `streamtyped` NSArchiver stream, not NSKeyedArchiver, so there
 * is no plist to parse. The layout after the class name is:
 *
 *   "NSString"  01 94 84 01  2B  <len>  <utf8 bytes…>
 *                            ^^^ 0x2B marks the string payload
 *
 * A length byte of 0x81 means the real length is the next two bytes, little
 * endian; 0x82 means the next four.
 */
function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob?.length) return null;
  const buf = Buffer.from(blob);

  let marker = buf.indexOf("NSMutableString", 0, "latin1");
  if (marker === -1) marker = buf.indexOf("NSString", 0, "latin1");
  if (marker === -1) return null;

  const plus = buf.indexOf(0x2b, marker);
  if (plus === -1) return null;

  let i = plus + 1;
  let length = buf[i++]!;
  if (length === 0x81) {
    length = buf.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    length = buf.readUInt32LE(i);
    i += 4;
  } else if (length > 0x7f) {
    return null;
  }

  if (length <= 0 || i + length > buf.length) return null;
  return buf.subarray(i, i + length).toString("utf8").trim() || null;
}

const isEnabled = () => process.platform === "darwin" && process.env.IMESSAGE_ENABLED !== "false";

/** A short, human label for whoever sent it. Never a full phone number. */
function speaker(row: Row): string {
  if (row.is_from_me) return "me";
  const handle = row.handle ?? "";
  // Emails keep their local part; phone numbers keep the last four digits only.
  if (handle.includes("@")) return handle.split("@")[0]!;
  const digits = handle.replace(/\D/g, "");
  return digits ? `contact ${digits.slice(-4)}` : "someone";
}

export type IMessageOutcome = { available: boolean; results: ToolResult[]; note?: string };

/**
 * Returns conversation transcripts shaped like any other tool result, so the
 * rest of the pipeline treats iMessage as just another source.
 */
export async function readIMessages(since: Date | null, now: Date): Promise<IMessageOutcome> {
  if (!isEnabled()) return { available: false, results: [] };

  let db: SqliteDb;
  try {
    db = await openDatabase(DB_PATH);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return {
      available: false,
      results: [],
      note: /authorization denied|unable to open/i.test(message)
        ? "iMessage is enabled but macOS denied access. Grant Full Disk Access to your terminal in System Settings > Privacy & Security."
        : `iMessage unavailable: ${message}`,
    };
  }

  try {
    const started = Date.now();
    const rows = db
      .prepare(
        `SELECT c.display_name      AS chat_name,
                c.chat_identifier   AS chat_identifier,
                h.id                AS handle,
                m.is_from_me        AS is_from_me,
                ${UNIX_TS}          AS ts,
                m.text              AS text,
                m.attributedBody    AS attributed_body
           FROM message m
           LEFT JOIN handle h            ON h.ROWID = m.handle_id
           LEFT JOIN chat_message_join cm ON cm.message_id = m.ROWID
           LEFT JOIN chat c               ON c.ROWID = cm.chat_id
          WHERE ${UNIX_TS} >= ? AND ${UNIX_TS} <= ?
            AND m.associated_message_type = 0
          ORDER BY ts DESC
          LIMIT ${MAX_MESSAGES}`,
      )
      .all(since ? toUnix(since) : 0, toUnix(now)) as Row[];

    // Group into conversations: a comic needs threads, not a firehose.
    const threads = new Map<string, { when: string; who: string; said: string }[]>();

    for (const row of rows) {
      const body = row.text?.trim() || decodeAttributedBody(row.attributed_body);
      if (!body) continue;

      const key = row.chat_name || row.chat_identifier || row.handle || "unknown";
      const thread = threads.get(key) ?? [];
      if (thread.length >= MAX_PER_CHAT) continue;

      thread.push({
        when: new Date(row.ts * 1000).toISOString(),
        who: speaker(row),
        said: body.slice(0, 400),
      });
      threads.set(key, thread);
    }

    const ms = Date.now() - started;

    const results: ToolResult[] = [...threads.entries()].map(([name, messages]) => ({
      name: `imessage__conversation[${name}]`,
      connector: "imessage",
      args: {},
      status: "ok" as const,
      ms,
      // Oldest first reads like a conversation.
      text: JSON.stringify({ conversation: name, messages: messages.reverse() }, null, 1),
      truncated: false,
    }));

    return { available: true, results };
  } finally {
    db.close();
  }
}
