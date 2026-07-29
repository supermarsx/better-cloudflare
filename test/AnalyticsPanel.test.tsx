import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AnalyticsPanel } from "../src/components/analytics/AnalyticsPanel";

afterEach(() => {
  cleanup();
});

test("shows one failed Analytics fetch and retries only after an explicit click", async () => {
  const calls: Array<{
    zoneId: string;
    since: string | undefined;
    until: string | undefined;
    signal: AbortSignal | undefined;
  }> = [];
  const getZoneAnalytics = async (
    zoneId: string,
    since?: string,
    until?: string,
    signal?: AbortSignal,
  ) => {
    calls.push({ zoneId, since, until, signal });
    if (calls.length === 1) {
      throw new Error(
        "invalid args until for command get_zone_analytics: command get_zone_analytics missing required key until",
      );
    }
    return {
      totals: { requests: 1, bandwidth: 2, threats: 0, pageviews: 1 },
      timeseries: [],
    };
  };

  const view = render(
    <AnalyticsPanel zoneId="zone-id" getZoneAnalytics={getZoneAnalytics} />,
  );

  assert.ok(
    await screen.findByText(/missing required key until/),
    "the initial failure is visible",
  );
  assert.ok(screen.getByRole("button", { name: "Retry" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.zoneId, "zone-id");
  assert.match(calls[0]?.since ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls[0]?.until, undefined);
  assert.ok(calls[0]?.signal instanceof AbortSignal);
  assert.equal(calls[0]?.signal?.aborted, false);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  assert.equal(calls.length, 1, "the rejected request does not auto-repeat");

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.ok(await screen.findByText("Zone Analytics"));

  view.unmount();
  assert.equal(calls[0]?.signal?.aborted, true);
});
