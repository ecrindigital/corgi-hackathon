import { describe, expect, test } from "bun:test";
import { dumpOptions, planFor, type ToolDescriptor } from "./merge";

const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });

function plan(connector: string, properties: Record<string, object>, windowDays: number | null = 7) {
  const tool: ToolDescriptor = {
    name: `${connector}__${connector === "spotify" ? "get_recently_played" : "list_events"}`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { input: { type: "object", properties, required: Object.keys(properties) } },
      required: ["input"],
    },
  };
  return planFor(
    tool,
    dumpOptions({ now: new Date("2026-07-26T12:00:00.000Z"), windowDays }),
  );
}

describe("connector planning", () => {
  test("Calendar uses the primary calendar, expands recurrences, and applies bounds", () => {
    const result = plan("google_calendar", {
      calendar_id: { type: "string" },
      single_events: { type: "boolean" },
      time_min: nullable("string"),
      time_max: nullable("string"),
      max_results: nullable("integer"),
    });

    expect(result).toEqual({
      kind: "call",
      name: "google_calendar__list_events",
      connector: "google_calendar",
      args: {
        input: {
          calendar_id: "primary",
          single_events: true,
          time_min: "2026-07-19T12:00:00.000Z",
          time_max: "2026-07-26T12:00:00.000Z",
          max_results: 25,
        },
      },
    });
  });

  test("Spotify sends after in Unix milliseconds and no upper bound", () => {
    const result = plan("spotify", {
      after: nullable("integer"),
      before: nullable("integer"),
      limit: nullable("integer"),
    });

    expect(result.kind).toBe("call");
    if (result.kind === "call")
      expect(result.args).toEqual({
        input: { after: 1784462400000, before: null, limit: 25 },
      });
  });

  test("Spotify lifetime mode omits its lower bound", () => {
    const result = plan("spotify", {
      after: nullable("integer"),
      before: nullable("integer"),
      limit: nullable("integer"),
    }, null);

    expect(result.kind).toBe("call");
    if (result.kind === "call")
      expect(result.args).toEqual({
        input: { before: null, limit: 25 },
      });
  });
});
