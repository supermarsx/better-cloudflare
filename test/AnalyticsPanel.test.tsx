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

import {
  ANALYTICS_NORMALIZATION_SCAN_LIMIT,
  ANALYTICS_POINT_LIMIT,
  ANALYTICS_TABLE_ROW_LIMIT,
  AnalyticsPanel,
  type AnalyticsTimeseries,
} from "../src/components/analytics/AnalyticsPanel";

const { downsampleAnalyticsTimeseries, normalizeAnalyticsPayload } =
  AnalyticsPanel;

afterEach(() => {
  cleanup();
});

function analyticsPoint(index: number): AnalyticsTimeseries {
  return {
    since: new Date(index * 60_000).toISOString(),
    until: new Date((index + 1) * 60_000).toISOString(),
    requests: index,
    bandwidth: index * 2,
    threats: index % 17,
    pageviews: index * 3,
    uniques: index % 23,
  };
}

function analyticsResult(points: AnalyticsTimeseries[]) {
  return {
    totals: {
      requests: points.length,
      bandwidth: points.length * 2,
      threats: 0,
      pageviews: points.length,
    },
    timeseries: points,
  };
}

test("downsamples deterministically at boundaries while retaining endpoints and extrema", () => {
  const points = Array.from({ length: ANALYTICS_POINT_LIMIT + 1 }, (_, index) =>
    analyticsPoint(index),
  );
  points[123] = { ...points[123], threats: -100 };
  points[4321] = { ...points[4321], bandwidth: 1_000_000 };

  assert.equal(downsampleAnalyticsTimeseries(points, 0).length, 0);
  assert.deepEqual(downsampleAnalyticsTimeseries(points, 1), [points[0]]);

  const sampled = downsampleAnalyticsTimeseries(points, 32);
  assert.equal(sampled.length, 32);
  assert.equal(sampled[0], points[0]);
  assert.equal(sampled.at(-1), points.at(-1));
  assert.ok(sampled.includes(points[123]));
  assert.ok(sampled.includes(points[4321]));
  assert.deepEqual(downsampleAnalyticsTimeseries(points, 32), sampled);
  assert.equal(points.length, ANALYTICS_POINT_LIMIT + 1);
});

test("reports original and rendered analytics counts and bounds table DOM rows", async () => {
  const points = Array.from({ length: ANALYTICS_POINT_LIMIT + 1 }, (_, index) =>
    analyticsPoint(index),
  );

  render(
    <AnalyticsPanel
      zoneId="large-zone"
      getZoneAnalytics={async () => analyticsResult(points)}
    />,
  );

  const notice = await screen.findByTestId("analytics-sampling-notice");
  assert.match(
    notice.textContent ?? "",
    new RegExp(`${ANALYTICS_POINT_LIMIT} of ${ANALYTICS_POINT_LIMIT + 1}`),
  );
  assert.equal(
    screen.getAllByTestId("analytics-timeseries-row").length,
    ANALYTICS_TABLE_ROW_LIMIT,
  );
});

test("normalizes malformed and oversized analytics payloads before rendering", async () => {
  const rawTimeseries = Array.from(
    { length: ANALYTICS_NORMALIZATION_SCAN_LIMIT + 101 },
    (_, index): unknown =>
      index % 11 === 0
        ? {
            since: "not-a-date",
            until: undefined,
            requests: Number.NaN,
          }
        : {
            since: new Date(index * 60_000).toISOString(),
            until: new Date((index + 1) * 60_000).toISOString(),
            requests: String(index),
            bandwidth: index === 3 ? Number.POSITIVE_INFINITY : "2048",
            threats: undefined,
            pageviews: "7",
            uniques: "-10",
          },
  );
  const payload = {
    totals: {
      requests: "12",
      bandwidth: Number.NaN,
      threats: Number.POSITIVE_INFINITY,
      pageviews: undefined,
    },
    timeseries: rawTimeseries,
  };
  const normalized = normalizeAnalyticsPayload(payload);

  assert.deepEqual(normalized.data.totals, {
    requests: 12,
    bandwidth: 0,
    threats: 0,
    pageviews: 0,
    uniques: 0,
  });
  assert.equal(normalized.sourcePointCount, rawTimeseries.length);
  assert.ok(normalized.data.timeseries.length <= ANALYTICS_POINT_LIMIT);
  for (const point of normalized.data.timeseries) {
    assert.ok(Number.isFinite(Date.parse(point.since)));
    assert.ok(Number.isFinite(Date.parse(point.until)));
    assert.ok(
      [point.requests, point.bandwidth, point.threats, point.pageviews].every(
        Number.isFinite,
      ),
    );
    assert.ok((point.uniques ?? 0) >= 0);
  }

  render(
    <AnalyticsPanel
      zoneId="malformed-zone"
      getZoneAnalytics={async () => payload}
    />,
  );
  assert.ok(await screen.findByText("Zone Analytics"));
  await screen.findByTestId("analytics-sampling-notice");
  assert.ok(
    screen.getAllByTestId("analytics-timeseries-row").length <=
      ANALYTICS_TABLE_ROW_LIMIT,
  );
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /NaN|Infinity|Invalid Date/,
  );
});

test("aborts superseded analytics requests and rejects their stale results", async () => {
  const calls: Array<{
    signal: AbortSignal | undefined;
    resolve: (value: ReturnType<typeof analyticsResult>) => void;
  }> = [];
  const getZoneAnalytics = (
    _zoneId: string,
    _since?: string,
    _until?: string,
    signal?: AbortSignal,
  ) =>
    new Promise<ReturnType<typeof analyticsResult>>((resolve) => {
      calls.push({ signal, resolve });
    });

  const view = render(
    <AnalyticsPanel zoneId="first-zone" getZoneAnalytics={getZoneAnalytics} />,
  );
  await waitFor(() => assert.equal(calls.length, 1));

  view.rerender(
    <AnalyticsPanel zoneId="second-zone" getZoneAnalytics={getZoneAnalytics} />,
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[0]?.signal?.aborted, true);

  await act(async () => {
    calls[1]?.resolve(analyticsResult([analyticsPoint(1)]));
  });
  assert.equal(screen.queryByTestId("analytics-sampling-notice"), null);

  await act(async () => {
    calls[0]?.resolve(
      analyticsResult(
        Array.from({ length: ANALYTICS_POINT_LIMIT + 1 }, (_, index) =>
          analyticsPoint(index),
        ),
      ),
    );
  });
  assert.equal(
    screen.queryByTestId("analytics-sampling-notice"),
    null,
    "the stale large result cannot replace the current zone data",
  );
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
