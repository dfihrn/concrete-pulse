import test from "node:test";
import assert from "node:assert/strict";

import {
  ONE_HOUR_MS,
  TWENTY_FOUR_HOURS_MS,
  analyzeHistory,
  analyzeHistoryWindow,
  rankLargestApyMovers,
  rankLargestDepositorMovers,
  rankLargestTvlMovers,
  rankMostActiveVaults,
} from "./history-analytics.js";

const ADDRESSES = {
  a: `0x${"a".repeat(40)}`,
  b: `0x${"b".repeat(40)}`,
  c: `0x${"c".repeat(40)}`,
  d: `0x${"d".repeat(40)}`,
};

function vault(name, tvl, apy, depositors) {
  return { name, tvl, apy, depositors };
}

function observation(collectedAt, vaults, chainId = 1) {
  return {
    collectedAt,
    vaults: {
      [chainId]: Object.fromEntries(
        Object.entries(vaults).map(([address, value]) => [address.toLowerCase(), value]),
      ),
    },
  };
}

function at(anchor, offsetMs) {
  return new Date(Date.parse(anchor) + offsetMs).toISOString();
}

function findVault(window, address) {
  return window.vaults.find((item) => item.address === address.toLowerCase());
}

test("analyzes an exact one-hour window and counts observed metric intervals", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Alpha", 100_000, 0.05, 10),
    }),
    observation(at(anchor, -30 * 60 * 1000), {
      [ADDRESSES.a]: vault("Alpha", 102_000, 0.05, 11),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Alpha Latest", 101_000, 0.0525, 11),
    }),
  ];

  const result = analyzeHistory(history, { anchorTime: anchor });
  const alpha = findVault(result.oneHour, ADDRESSES.a);

  assert.equal(result.oneHour.partial, false);
  assert.equal(result.oneHour.startTime, at(anchor, -ONE_HOUR_MS));
  assert.equal(result.oneHour.endTime, anchor);
  assert.equal(result.oneHour.observedSpanMs, ONE_HOUR_MS);
  assert.equal(alpha.name, "Alpha Latest");
  assert.deepEqual(alpha.tvl, {
    startValue: 100_000,
    endValue: 101_000,
    netChange: 1_000,
    percentageChange: 1,
    changeIntervals: 2,
    notableIntervals: 2,
    positiveIntervals: 1,
    negativeIntervals: 1,
  });
  assert.ok(Math.abs(alpha.apy.netChange - 0.0025) < Number.EPSILON);
  assert.ok(Math.abs(alpha.apy.percentagePointChange - 0.25) < Number.EPSILON * 100);
  assert.equal(alpha.apy.changeIntervals, 1);
  assert.equal(alpha.depositors.netChange, 1);
  assert.equal(alpha.depositors.changeIntervals, 1);
  assert.deepEqual(alpha.activity.categoriesChanged, ["TVL", "APY", "Depositors"]);
  assert.equal(alpha.activity.totalChangedIntervals, 2);
});

test("marks a short 24-hour history partial and reports its actual span", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -2.5 * ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Alpha", 100, 1, 1),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Alpha", 110, 1, 1),
    }),
  ];

  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: TWENTY_FOUR_HOURS_MS,
  });

  assert.equal(result.partial, true);
  assert.equal(result.observedSpanMs, 2.5 * ONE_HOUR_MS);
  assert.equal(result.coverage.startGapMs, 21.5 * ONE_HOUR_MS);
});

test("uses adjacent sparse and irregular observations without interpolation", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Alpha", 100, 1, 1),
    }),
    observation(at(anchor, -47 * 60 * 1000), {
      [ADDRESSES.a]: vault("Alpha", 150, 1, 1),
    }),
    observation(at(anchor, -8 * 60 * 1000), {
      [ADDRESSES.a]: vault("Alpha", 125, 1, 1),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Alpha", 130, 1, 1),
    }),
  ];

  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: ONE_HOUR_MS,
  });
  const alpha = findVault(result, ADDRESSES.a);

  assert.equal(result.partial, false);
  assert.equal(result.observationCount, 4);
  assert.equal(alpha.tvl.changeIntervals, 3);
  assert.equal(alpha.tvl.positiveIntervals, 2);
  assert.equal(alpha.tvl.negativeIntervals, 1);
});

test("preserves null metrics and does not calculate relative TVL from zero", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Null metrics", null, null, null),
      [ADDRESSES.b]: vault("Zero TVL", 0, -1, 2),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Null metrics", 100, 4, 3),
      [ADDRESSES.b]: vault("Zero TVL", 100, 3, 2),
    }),
  ];

  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: ONE_HOUR_MS,
  });
  const nullMetrics = findVault(result, ADDRESSES.a);
  const zeroTvl = findVault(result, ADDRESSES.b);

  assert.equal(nullMetrics.tvl.netChange, null);
  assert.equal(nullMetrics.tvl.changeIntervals, 0);
  assert.equal(nullMetrics.apy.netChange, null);
  assert.equal(nullMetrics.apy.changeIntervals, 0);
  assert.equal(nullMetrics.depositors.netChange, null);
  assert.equal(nullMetrics.depositors.changeIntervals, 0);
  assert.equal(zeroTvl.tvl.netChange, 100);
  assert.equal(zeroTvl.tvl.percentageChange, null);
  assert.equal(zeroTvl.tvl.notableIntervals, 0);
  assert.equal(zeroTvl.apy.startValue, null);
  assert.equal(zeroTvl.apy.netChange, null);
});

test("detects appearing and disappearing vaults only from observed transitions", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Leaves", 100, 1, 1),
    }),
    observation(at(anchor, -30 * 60 * 1000), {
      [ADDRESSES.a]: vault("Leaves", 100, 1, 1),
      [ADDRESSES.b]: vault("Arrives", 200, 2, 2),
    }),
    observation(anchor, {
      [ADDRESSES.b]: vault("Arrives", 200, 2, 2),
    }),
  ];

  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: ONE_HOUR_MS,
  });
  const leaves = findVault(result, ADDRESSES.a);
  const arrives = findVault(result, ADDRESSES.b);

  assert.deepEqual(leaves.presence, {
    firstObservedAt: at(anchor, -ONE_HOUR_MS),
    lastObservedAt: at(anchor, -30 * 60 * 1000),
    appeared: false,
    disappeared: true,
  });
  assert.deepEqual(arrives.presence, {
    firstObservedAt: at(anchor, -30 * 60 * 1000),
    lastObservedAt: anchor,
    appeared: true,
    disappeared: false,
  });
  assert.equal(leaves.activity.presenceChangeIntervals, 1);
  assert.equal(arrives.activity.presenceChangeIntervals, 1);
});

test("applies both existing notable TVL thresholds at their exact boundary", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Absolute", 500_000, 1, 1),
      [ADDRESSES.b]: vault("Relative", 500, 1, 1),
      [ADDRESSES.c]: vault("Below", 500, 1, 1),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Absolute", 501_000, 1, 1),
      [ADDRESSES.b]: vault("Relative", 505, 1, 1),
      [ADDRESSES.c]: vault("Below", 504.99, 1, 1),
    }),
  ];

  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: ONE_HOUR_MS,
  });

  assert.equal(findVault(result, ADDRESSES.a).tvl.notableIntervals, 1);
  assert.equal(findVault(result, ADDRESSES.b).tvl.notableIntervals, 1);
  assert.equal(findVault(result, ADDRESSES.c).tvl.notableIntervals, 0);
});

test("ranking helpers use documented deterministic tie-breakers", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const history = [
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Alpha", 1_000, 2, 10),
      [ADDRESSES.b]: vault("Beta", 1_000, 2, 10),
      [ADDRESSES.c]: vault("Gamma", 2_000, 3, 20),
      [ADDRESSES.d]: vault("Delta", 3_000, null, null),
    }),
    observation(anchor, {
      [ADDRESSES.a]: vault("Alpha", 2_000, 3, 11),
      [ADDRESSES.b]: vault("Beta", 2_000, 3, 11),
      [ADDRESSES.c]: vault("Gamma", 1_000, 2, 19),
      [ADDRESSES.d]: vault("Delta", 3_000, null, null),
    }),
  ];
  const result = analyzeHistoryWindow(history, {
    anchorTime: anchor,
    windowMs: ONE_HOUR_MS,
  });

  assert.deepEqual(
    rankMostActiveVaults(result).map((item) => item.address),
    [ADDRESSES.a, ADDRESSES.b, ADDRESSES.c],
  );
  assert.deepEqual(
    rankLargestTvlMovers(result).map((item) => item.address),
    [ADDRESSES.a, ADDRESSES.b, ADDRESSES.c],
  );
  assert.deepEqual(
    rankLargestApyMovers(result, 2).map((item) => item.address),
    [ADDRESSES.a, ADDRESSES.b],
  );
  assert.deepEqual(
    rankLargestDepositorMovers(result).map((item) => item.address),
    [ADDRESSES.a, ADDRESSES.b, ADDRESSES.c],
  );
});

test("does not mutate input history while sorting and normalizing it", () => {
  const anchor = "2026-09-12T12:00:00.000Z";
  const mixedCaseAddress = `0x${"Aa".repeat(20)}`;
  const history = [
    observation(anchor, {
      [mixedCaseAddress]: vault("Alpha", 200, 2, 2),
    }),
    observation(at(anchor, -ONE_HOUR_MS), {
      [ADDRESSES.a]: vault("Alpha", 100, 1, 1),
    }),
  ];
  const before = JSON.stringify(history);

  analyzeHistoryWindow(history, { anchorTime: anchor, windowMs: ONE_HOUR_MS });

  assert.equal(JSON.stringify(history), before);
});
