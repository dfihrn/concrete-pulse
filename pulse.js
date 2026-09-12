import { getConcreteApi } from "@concrete-xyz/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";


// Missing values are not zero. Reject booleans, arrays and objects too.
export function parseMetric(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseApy(value) {
    const apy = parseMetric(value);
    // Concrete's -1 sentinel is unavailable, not a real -100% yield.
    return apy === -1 ? null : apy;
}

function parseDepositors(value) {
    const count = parseMetric(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function validateSnapshot(snapshot) {
    if (!isObject(snapshot) || typeof snapshot.timestamp !== "string" ||
        !Number.isFinite(Date.parse(snapshot.timestamp))) {
        throw new Error("Snapshot must have a valid timestamp.");
    }
}

// The SDK returns { chainId: { vaultAddress: vault } }.
// Chain + address prevents contracts on different chains from colliding.
export function flattenVaults(groupedVaults) {
    if (!isObject(groupedVaults)) throw new Error("Expected vault data grouped by chain.");
    const vaultMap = new Map();
    for (const [chain, chainVaults] of Object.entries(groupedVaults)) {
        const chainId = Number(chain);
        if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isObject(chainVaults)) {
            throw new Error(`Invalid vault group for chain ${chain}.`);
        }
        for (const [address, vault] of Object.entries(chainVaults)) {
            if (!isObject(vault) || !/^0x[0-9a-f]{40}$/i.test(address)) {
                throw new Error(`Invalid vault record on chain ${chain}.`);
            }
            if ((vault.chainId != null && Number(vault.chainId) !== chainId) ||
                (vault.address != null && String(vault.address).toLowerCase() !== address.toLowerCase())) {
                throw new Error(`Vault identity disagrees with its group: ${chain}:${address}.`);
            }
            const key = `${chainId}:${address.toLowerCase()}`;
            if (vaultMap.has(key)) throw new Error(`Duplicate vault: ${key}.`);
            vaultMap.set(key, {
                name: typeof vault.name === "string" && vault.name.trim() ? vault.name : address,
                address: vault.address ?? address,
                chainId,
                tvl: parseMetric(vault.tvl),
                apy: parseApy(vault.apy),
                depositors: parseDepositors(vault.totalDepositors)
            });
        }
    }
    return vaultMap;
}

function vaultIdentity(vault) {
    return { name: vault.name, address: vault.address, chainId: vault.chainId };
}

function compareMetric(previousVaults, currentVaults, metric) {
    const changes = [];
    for (const [key, currentVault] of currentVaults) {
        const previousVault = previousVaults.get(key);
        if (!previousVault) continue;
        const previousValue = previousVault[metric];
        const currentValue = currentVault[metric];
        // Availability transitions are not numeric changes; see unavailableMetrics.
        if (previousValue === null || currentValue === null || previousValue === currentValue) continue;
        const change = currentValue - previousValue;
        if (!Number.isFinite(change)) continue;
        const percentage = previousValue === 0 ? null : change / Math.abs(previousValue) * 100;
        changes.push({
            ...vaultIdentity(currentVault),
            previousValue,
            currentValue,
            // Signed absolute difference, in the metric's original units.
            change,
            percentageChange: Number.isFinite(percentage) ? percentage : null,
            // APY is a decimal rate: 0.01 = 1%. Points differ from relative %.
            ...(metric === "apy" ? { percentagePointChange: parseMetric(change * 100) } : {})
        });
    }
    return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

function findUnavailableMetrics(vaults, snapshot) {
    const issues = [];
    for (const vault of vaults.values()) {
        for (const metric of ["tvl", "apy", "depositors"]) {
            if (vault[metric] === null) issues.push({ ...vaultIdentity(vault), snapshot, metric });
        }
    }
    return issues;
}

export function isNotableTvlChange(change) {
    // Inclusive OR: at least $1,000 in either direction OR at least 1%.
    // Never use relative movement from a zero baseline. Raw changes stay intact.
    return Math.abs(change.change) >= 1000 ||
        (change.previousValue !== 0 && Number.isFinite(change.percentageChange) &&
            Math.abs(change.percentageChange) >= 1);
}

export function findMostActiveVaults(results) {
    const vaults = new Map();
    for (const [category, changes] of [
        ["TVL", results.tvlChanges], ["APY", results.apyChanges],
        ["Depositors", results.depositorChanges], ["New", results.newVaults],
        ["Removed", results.removedVaults]
    ]) {
        for (const change of changes) {
            const key = `${change.chainId}:${change.address.toLowerCase()}`;
            if (!vaults.has(key)) vaults.set(key, { ...vaultIdentity(change), categories: [] });
            const vault = vaults.get(key);
            if (!vault.categories.includes(category)) vault.categories.push(category);
        }
    }
    // Include raw TVL activity. Count distinct categories, not financial merit.
    return [...vaults.values()].filter(vault => vault.categories.length > 1)
        .map(vault => ({ ...vault, categoryCount: vault.categories.length }))
        .sort((a, b) => b.categoryCount - a.categoryCount ||
            a.name.localeCompare(b.name) || a.chainId - b.chainId || a.address.localeCompare(b.address));
}

// Pure comparison: this function never fetches or writes files.
// A first snapshot establishes a baseline instead of marking every vault as new.
export function compareSnapshots(previousSnapshot, currentSnapshot) {
    validateSnapshot(currentSnapshot);
    if (previousSnapshot != null) validateSnapshot(previousSnapshot);
    const currentVaults = flattenVaults(currentSnapshot.vaults);
    const previousVaults = previousSnapshot ? flattenVaults(previousSnapshot.vaults) : new Map();
    const hasPreviousSnapshot = previousSnapshot != null;
    const results = {
        timestamp: currentSnapshot.timestamp,
        previousTimestamp: previousSnapshot?.timestamp ?? null,
        hasPreviousSnapshot,
        tvlChanges: compareMetric(previousVaults, currentVaults, "tvl"),
        apyChanges: compareMetric(previousVaults, currentVaults, "apy"),
        depositorChanges: compareMetric(previousVaults, currentVaults, "depositors"),
        newVaults: hasPreviousSnapshot
            ? [...currentVaults].filter(([key]) => !previousVaults.has(key)).map(([, vault]) => vault) : [],
        removedVaults: [...previousVaults].filter(([key]) => !currentVaults.has(key)).map(([, vault]) => vault),
        unavailableMetrics: [
            ...findUnavailableMetrics(previousVaults, "previous"),
            ...findUnavailableMetrics(currentVaults, "current")
        ]
    };
    results.notableTvlChanges = results.tvlChanges.filter(isNotableTvlChange);
    results.mostActiveVaults = findMostActiveVaults(results);
    results.summary = {
        totalVaults: currentVaults.size,
        tvlChanges: results.tvlChanges.length,
        apyChanges: results.apyChanges.length,
        depositorChanges: results.depositorChanges.length,
        newVaults: results.newVaults.length,
        removedVaults: results.removedVaults.length,
        notableTvlChanges: results.notableTvlChanges.length,
        totalActivity: results.tvlChanges.length + results.apyChanges.length +
            results.depositorChanges.length + results.newVaults.length + results.removedVaults.length
    };
    return results;
}

export async function fetchSnapshot({ signal, timeoutMs = 15000,
    requestFactory = () => getConcreteApi().apy.getAllVaultsApy() } = {}) {
    signal?.throwIfAborted();
    const request = requestFactory();
    let cancelled = false;
    const cancel = () => { cancelled = true; request.abort(); };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    try {
        const vaults = await request.toPromise();
        if (cancelled || signal?.aborted) throw new Error("Collection cancelled");
        return { timestamp: new Date().toISOString(), vaults };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
    }
}

function signed(value, digits = 2) {
    if (value === null) return "N/A";
    return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", {
        minimumFractionDigits: digits, maximumFractionDigits: digits
    })}`;
}

function formatTvlChange(change) {
    const amount = Math.abs(change.change).toLocaleString("en-US", {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
    const percent = change.percentageChange === null ? "N/A" : `${signed(change.percentageChange)}%`;
    return `${change.change < 0 ? "-" : "+"}$${amount} | ${percent} relative change`;
}

export function printResults(results) {
    if (!results.hasPreviousSnapshot) {
        console.log("Snapshot saved. Run Pulse again later to detect changes.");
    }
    const sections = [
        ["TVL", results.tvlChanges, formatTvlChange],
        ["APY", results.apyChanges, c => `${signed(c.percentagePointChange)} percentage points`],
        ["depositor", results.depositorChanges, c => `${signed(c.change, 0)} depositors`]
    ];
    for (const [label, changes, format] of sections) {
        console.log(`\nPulse detected ${changes.length} ${label} changes.\n`);
        for (const change of changes.slice(0, 10)) {
            console.log(`${change.change > 0 ? "UP" : "DOWN"} | ${change.name} | chain ${change.chainId} | ${change.address} | ${format(change)}`);
        }
    }
    for (const [label, vaults] of [["new", results.newVaults], ["removed", results.removedVaults]]) {
        console.log(`\nPulse detected ${vaults.length} ${label} vaults.\n`);
        for (const vault of vaults.slice(0, 10)) {
            console.log(`${vault.name} | chain ${vault.chainId} | ${vault.address}`);
        }
    }
    if (results.unavailableMetrics.length) {
        console.log(`\n${results.unavailableMetrics.length} unavailable metric values (excluded from numeric comparisons):`);
        for (const issue of results.unavailableMetrics) {
            console.log(`${issue.snapshot} | ${issue.name} | chain ${issue.chainId} | ${issue.metric} unavailable`);
        }
    }
}

// Optional inputs let tests use temporary snapshots without touching real data.
export async function runPulse({ print = true, snapshotDirectory,
    fetchCurrentSnapshot = fetchSnapshot } = {}) {
    const { createCollector } = await import("./collector.js");
    const collector = createCollector({ directory: snapshotDirectory, fetchCurrentSnapshot });
    try {
        collector.start({ scheduled: false });
        const result = await collector.collect();
        if (print) printResults(result);
        return result;
    } finally { await collector.stop(); }
}

// Direct execution runs Pulse; importing it leaves snapshots untouched.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runPulse().catch(error => {
        console.error("Pulse failed:", error.message);
        process.exitCode = 1;
    });
}
