import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORICAL_RANKING_LIMIT,
  presentHistoricalAnalytics,
  presentPulseGeneration,
} from "./historical-presenter.js";

const anchor = "2026-09-12T12:00:00.000Z";
const start = "2026-09-12T11:00:00.000Z";

function address(index) {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

function observation(collectedAt, current = false) {
  const vaults = {};
  for (let index = 1; index <= 7; index += 1) {
    vaults[address(index)] = {
      name: `Vault ${index}`,
      tvl: index * 10_000 + (current ? index * 1_000 : 0),
      apy: 0.05 + (current ? index * 0.0001 : 0),
      depositors: 10 + (current ? index : 0),
    };
  }
  return { collectedAt, vaults: { 1: vaults } };
}

test("presents bounded 1H and 24H rankings without raw history or full vault analytics", () => {
  const historical = presentHistoricalAnalytics([
    observation(start),
    observation(anchor, true),
  ], anchor);

  assert.equal(historical.anchorTime, anchor);
  assert.deepEqual(Object.keys(historical.windows), ["1h", "24h"]);
  assert.equal(historical.windows["1h"].startTime, start);
  assert.equal(historical.windows["1h"].endTime, anchor);
  assert.equal(historical.windows["1h"].observedSpanMs, 60 * 60 * 1000);
  assert.equal(historical.windows["1h"].observationCount, 2);
  assert.equal(historical.windows["1h"].partial, false);
  assert.equal(historical.windows["24h"].partial, true);

  for (const window of Object.values(historical.windows)) {
    assert.equal(Object.hasOwn(window, "vaults"), false);
    for (const ranking of ["mostActive", "tvlMovers", "apyMovers", "depositorMovers"]) {
      assert.ok(window[ranking].length <= HISTORICAL_RANKING_LIMIT);
    }
  }
  assert.equal(historical.windows["1h"].mostActive.length, 5);
  assert.equal(historical.windows["1h"].counts.activeVaults, 7);
  assert.equal(historical.windows["1h"].counts.apyChangeIntervals, 7);
  assert.equal(historical.windows["1h"].counts.depositorChangeIntervals, 7);
});

test("adds historical projection while preserving every existing Pulse result field", () => {
  const result = {
    timestamp: anchor,
    previousTimestamp: start,
    summary: { totalVaults: 7 },
    tvlChanges: [{ change: 1 }],
  };
  const generation = {
    collectedAt: anchor,
    history: [observation(start), observation(anchor, true)],
    result,
  };

  const response = presentPulseGeneration(generation);

  for (const [key, value] of Object.entries(result)) assert.deepEqual(response[key], value);
  assert.ok(response.historical);
  assert.equal(Object.hasOwn(response, "history"), false);
  assert.equal(JSON.stringify(response).includes('"vaults"'), false);
});

test("an empty legacy history produces explicit partial windows with empty rankings", () => {
  const historical = presentHistoricalAnalytics([], anchor);

  for (const window of Object.values(historical.windows)) {
    assert.equal(window.partial, true);
    assert.equal(window.observationCount, 0);
    assert.equal(window.startTime, null);
    assert.equal(window.endTime, null);
    assert.deepEqual(window.mostActive, []);
    assert.deepEqual(window.tvlMovers, []);
  }
});
