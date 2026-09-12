import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSnapshots, parseMetric, isNotableTvlChange, findMostActiveVaults } from "./pulse.js";
import { HISTORY_RETENTION_MS, makeGeneration, restoreGeneration } from "./generation.js";

const address = "0x" + "a".repeat(40);
const otherAddress = "0x" + "b".repeat(40);

test("TVL significance uses inclusive USD OR percent thresholds and protects zero baselines", () => {
    for (const change of [1000, -1000]) assert.equal(isNotableTvlChange({change, previousValue: 1000000, percentageChange: 0.1}), true);
    for (const percentageChange of [1, -1]) assert.equal(isNotableTvlChange({change: 10, previousValue: 1000, percentageChange}), true);
    assert.equal(isNotableTvlChange({change: 999, previousValue: 1000000, percentageChange: 0.999}), false);
    assert.equal(isNotableTvlChange({change: 999, previousValue: 0, percentageChange: null}), false);
    assert.equal(isNotableTvlChange({change: 1000, previousValue: 0, percentageChange: null}), true);
    assert.equal(isNotableTvlChange({change: 1, previousValue: 0, percentageChange: 100}), false);
});

test("raw activity survives filtering; category counts use chain and address identity", () => {
    const before = snapshot([[1, address], [2, address]]);
    const after = snapshot([[1, address, {tvl: "100.01", apy: "0.02", totalDepositors: 11}], [2, address, {tvl: "100.01"}]]);
    const result = compareSnapshots(before, after);
    assert.equal(result.tvlChanges.length, 2);
    assert.equal(result.notableTvlChanges.length, 0);
    assert.equal(result.summary.totalActivity, 4);
    assert.equal(result.mostActiveVaults.length, 1);
    assert.deepEqual(result.mostActiveVaults[0].categories, ["TVL", "APY", "Depositors"]);
    assert.equal(result.mostActiveVaults[0].chainId, 1);
    result.tvlChanges.push(result.tvlChanges[0]);
    assert.equal(findMostActiveVaults(result)[0].categoryCount, 3);
    assert.deepEqual(compareSnapshots(null, after).mostActiveVaults, []);
    assert.equal(compareSnapshots(after, after).summary.totalActivity, 0);
});
function snapshot(rows) {
    const vaults = {};
    for (const [chainId, vaultAddress, metrics = {}] of rows) {
        vaults[chainId] ??= {};
        vaults[chainId][vaultAddress] = {
            name: "Test vault", address: vaultAddress, chainId,
            tvl: "100", apy: "0.01", totalDepositors: 10, ...metrics
        };
    }
    return { timestamp: "2026-09-10T00:00:00Z", vaults };
}

test("numeric changes keep identity, signed differences and APY units", () => {
    const previous = snapshot([[1, address]]);
    const current = snapshot([[1, address, { tvl: "150", apy: "0.02", totalDepositors: 8 }]]);
    const result = compareSnapshots(previous, current);
    assert.deepEqual(result.tvlChanges[0], {
        name: "Test vault", address, chainId: 1,
        previousValue: 100, currentValue: 150, change: 50, percentageChange: 50
    });
    assert.equal(result.apyChanges[0].percentagePointChange, 1);
    assert.equal(result.apyChanges[0].percentageChange, 100);
    assert.equal(result.depositorChanges[0].change, -2);
    assert.equal(result.depositorChanges[0].percentageChange, -20);
});

test("unavailable APY is never converted to zero or a numeric change", () => {
    for (const value of [null, undefined, "", "  ", "NaN", "Infinity", false, [], {}, Infinity]) {
        assert.equal(parseMetric(value), null);
        for (const [before, after] of [[value, "0.02"], ["0.02", value]]) {
            const result = compareSnapshots(
                snapshot([[1, address, { apy: before }]]),
                snapshot([[1, address, { apy: after }]])
            );
            assert.equal(result.apyChanges.length, 0);
            assert.equal(result.unavailableMetrics.length, 1);
        }
    }
    const result = compareSnapshots(snapshot([[1, address, { apy: "0" }]]), snapshot([[1, address]]));
    assert.equal(result.apyChanges[0].percentageChange, null);
    assert.equal(result.apyChanges[0].percentagePointChange, 1);
});

test("chain and case aware matching detects additions and removals separately", () => {
    const result = compareSnapshots(
        snapshot([[1, address], [2, address], [1, otherAddress]]),
        snapshot([[1, address.toUpperCase().replace("0X", "0x")], [3, address]])
    );
    assert.equal(result.tvlChanges.length, 0);
    assert.equal(result.newVaults.length, 1);
    assert.equal(result.newVaults[0].chainId, 3);
    assert.equal(result.removedVaults.length, 2);
});

test("first run, unchanged snapshots, empty current snapshot and invalid shape", () => {
    const current = snapshot([[1, address]]);
    assert.equal(compareSnapshots(null, current).newVaults.length, 0);
    assert.equal(compareSnapshots(null, current).hasPreviousSnapshot, false);
    assert.equal(compareSnapshots(current, current).apyChanges.length, 0);
    assert.equal(compareSnapshots(current, snapshot([])).removedVaults.length, 1);
    assert.throws(() => compareSnapshots(current, { timestamp: current.timestamp, vaults: null }), /grouped by chain/);
});

test("invalid depositor counts are unavailable instead of rounded, with raw values preserved", () => {
    for (const count of [1.5, -1, "2.5", Number.MAX_SAFE_INTEGER + 1, null]) {
        const current = snapshot([[1, address, { totalDepositors: count }]]);
        const result = compareSnapshots(snapshot([[1, address]]), current);
        assert.equal(result.depositorChanges.length, 0);
        assert.ok(result.unavailableMetrics.some(issue => issue.metric === "depositors"));
        assert.equal(current.vaults[1][address].totalDepositors, count);
    }
});

test("invalid timestamps fail before persistence and non-text vault names fall back to address", () => {
    const current = snapshot([[1, address, { name: {} }]]);
    assert.equal(compareSnapshots(snapshot([]), current).newVaults[0].name, address);
    for (const timestamp of [undefined, null, "invalid"]) {
        assert.throws(() => compareSnapshots(null, { ...current, timestamp }), /timestamp/);
        assert.throws(() => compareSnapshots({ ...current, timestamp }, current), /timestamp/);
    }
});

test("APY -1 is unavailable while raw snapshots and other negative rates survive", () => {
    for (const sentinel of [-1, "-1", "-1.000"]) {
        const previous = snapshot([[1, address, { apy: sentinel }]]);
        const current = snapshot([[2, address, { apy: sentinel }]]);
        const result = compareSnapshots(previous, current);
        assert.equal(result.newVaults[0].apy, null);
        assert.equal(result.removedVaults[0].apy, null);
        assert.equal(previous.vaults[1][address].apy, sentinel);
        assert.equal(current.vaults[2][address].apy, sentinel);
        assert.equal(compareSnapshots(previous, snapshot([[1, address]])).apyChanges.length, 0);
        assert.equal(compareSnapshots(snapshot([[1, address]]), previous).apyChanges.length, 0);
    }
    const result = compareSnapshots(snapshot([]), snapshot([[1, address, { apy: "-0.01" }]]));
    assert.equal(result.newVaults[0].apy, -0.01);
});

test("old generations restore with empty history and new generations store compact observations", () => {
    const collectedAt = "2026-09-11T00:00:00.000Z";
    const generation = makeGeneration(null, snapshot([[1, address]]), collectedAt);
    assert.deepEqual(generation.history, [{
        collectedAt,
        vaults: { "1": { [address]: {
            name: "Test vault", tvl: 100, apy: 0.01, depositors: 10
        } } }
    }]);
    const oldGeneration = { ...generation };
    delete oldGeneration.history;
    assert.deepEqual(restoreGeneration(oldGeneration).history, []);
});

test("history appends uniquely and retains only the latest 24 hours", () => {
    const end = Date.parse("2026-09-12T00:00:00.000Z");
    const olderAt = new Date(end - HISTORY_RETENTION_MS - 1).toISOString();
    const insideAt = new Date(end - HISTORY_RETENTION_MS + 1).toISOString();
    const endAt = new Date(end).toISOString();
    const first = makeGeneration(null, snapshot([[1, address]]), olderAt);
    const second = makeGeneration(first.current, snapshot([[1, address, { tvl: 150 }]]), insideAt, first.history);
    const third = makeGeneration(second.current, snapshot([[1, address, { tvl: 200 }]]), endAt, second.history);
    assert.deepEqual(third.history.map(observation => observation.collectedAt), [insideAt, endAt]);
    const duplicate = makeGeneration(third.current, snapshot([[1, address, { tvl: 250 }]]), endAt, third.history);
    assert.equal(duplicate.history.length, 2);
    assert.equal(duplicate.history.at(-1).vaults[1][address].tvl, 250);
});

test("history restore rejects addresses that collide after case normalization", () => {
    const generation = makeGeneration(null, snapshot([[1, address]]), "2026-09-11T00:00:00.000Z");
    generation.history[0].vaults[1][otherAddress] = generation.history[0].vaults[1][address];
    generation.history[0].vaults[1][otherAddress.toUpperCase().replace("0X", "0x")] =
        generation.history[0].vaults[1][address];
    assert.throws(() => restoreGeneration(generation), /Duplicate history vault/);
});
