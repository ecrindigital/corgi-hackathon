#!/usr/bin/env bun
/**
 * One-time setup for the POC.
 *
 *   bun run setup                          -> create a Registered User, print its ID
 *   bun run setup --links gmail,spotify    -> print a Magic Link per connector
 *   bun run setup --links personal         -> Magic Links for the whole personal set
 *
 * Each Magic Link is opened by the user in a browser; it completes that
 * provider's OAuth and stores the credential against the Registered User.
 * Links are short-lived (~30 min) and single-use.
 */

// US is ah-api.merge.dev; the EU dashboard (ah-eu.merge.dev) is served by ah-api-eu.merge.dev.
// Only the US host is documented — set MERGE_API_BASE to match the dashboard you got the key from.
const API = process.env.MERGE_API_BASE ?? "https://ah-api.merge.dev";
const API_KEY = process.env.MERGE_AGENT_HANDLER_API_KEY;

/**
 * Personal connectors worth having for a "your week as a comic" context dump.
 *
 * Slugs use underscores, matching the `authenticate_<slug>` tool names — NOT the
 * hyphens used in the docs URLs. `google-drive` is rejected with "Connector not
 * found"; `google_drive` works. All of these are verified against the live API.
 */
const PERSONAL_CONNECTORS = [
  "gmail",
  "google_calendar",
  "google_drive",
  "google_tasks",
  "google_meet",
  "outlook",
  "spotify",
  "oura",
  "whoop",
  "notion",
  "calendly",
  "zoom",
  "fireflies",
  "plaud",
  "dropbox",
  "github",
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
}

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
  return json;
}

async function createRegisteredUser() {
  const body = {
    origin_user_id: process.env.MERGE_ORIGIN_USER_ID ?? `corgi-poc-${Date.now()}`,
    origin_user_name: process.env.MERGE_ORIGIN_USER_NAME ?? "Corgi POC User",
    ...(process.env.MERGE_ORIGIN_USER_EMAIL
      ? { origin_user_email: process.env.MERGE_ORIGIN_USER_EMAIL }
      : {}),
  };
  const json = await post("/api/v1/registered-users", body);
  const id = json.registered_user_id ?? json.id;
  if (!id) throw new Error(`no registered_user_id in response: ${JSON.stringify(json)}`);
  return id as string;
}

/**
 * Verified against the live API: the path carries the /v1 prefix (the docs omit
 * it) and the body field is `connector` (the docs say `connector_slug`, which
 * the API rejects with "Connector slug is required").
 */
async function createMagicLink(userId: string, connector: string) {
  const json = await post(`/api/v1/registered-users/${userId}/link-token`, { connector });
  const url = json.magic_link_url ?? json.link_url;
  if (!url) throw new Error(`no link in response: ${JSON.stringify(json)}`);
  return { url: url as string, expiresAt: json.expires_at as string | undefined };
}

const main = async () => {
  if (!API_KEY) die("MERGE_AGENT_HANDLER_API_KEY is not set (copy .env.example to .env)");

  let userId = process.env.MERGE_REGISTERED_USER_ID;
  if (!userId) {
    console.log("→ creating a Registered User…");
    userId = await createRegisteredUser();
    console.log(`\n✓ Registered User created\n\n  MERGE_REGISTERED_USER_ID=${userId}\n`);
    console.log("  Add that line to your .env, then re-run with --links.\n");
  } else {
    console.log(`→ using existing Registered User ${userId}`);
  }

  const links = arg("links");
  if (links === undefined) return;

  const connectors =
    links === "" || links === "personal" ? PERSONAL_CONNECTORS : links.split(",").map((s) => s.trim());

  console.log(`\n→ generating Magic Links for ${connectors.length} connector(s)…\n`);

  const failed: string[] = [];
  for (const connector of connectors) {
    try {
      const { url, expiresAt } = await createMagicLink(userId, connector);
      console.log(`  ${connector.padEnd(18)} ${url}${expiresAt ? `   (expires ${expiresAt})` : ""}`);
    } catch (err) {
      failed.push(connector);
      console.log(`  ${connector.padEnd(18)} ✗ ${(err as Error).message.split("\n")[0]}`);
    }
  }

  if (failed.length) {
    console.log(
      `\n! ${failed.length} connector(s) failed: ${failed.join(", ")}` +
        `\n  Usually means the Connector is not enabled on your Tool Pack, or the slug differs.` +
        `\n  Check https://ah.merge.dev/tool-packs and https://docs.merge.dev/merge-agent-handler/connectors/overview`,
    );
  }

  console.log(
    `\nOpen each link in a browser to authenticate. Links are single-use and expire in ~30 min.` +
      `\nThen run: bun run dump\n`,
  );
};

main().catch((err) => die((err as Error).message));
