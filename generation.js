import { compareSnapshots, flattenVaults } from "./pulse.js";

export const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTimestamp(value, label) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new Error(`Invalid ${label}`);
    }
}

function historyVault(vault) {
    if (!isObject(vault) || typeof vault.name !== "string" || !vault.name.trim()) {
        throw new Error("Invalid history vault");
    }
    for (const metric of ["tvl", "apy"]) {
        if (vault[metric] !== null && !Number.isFinite(vault[metric])) {
            throw new Error(`Invalid history ${metric}`);
        }
    }
    if (vault.depositors !== null && (!Number.isSafeInteger(vault.depositors) || vault.depositors < 0)) {
        throw new Error("Invalid history depositors");
    }
    return { name: vault.name, tvl: vault.tvl, apy: vault.apy, depositors: vault.depositors };
}

// Chain IDs and addresses are object keys so identity and presence remain available
// without repeating them inside every compact vault record.
export function makeHistoryObservation(current, collectedAt) {
    validateTimestamp(collectedAt, "history timestamp");
    const vaults = {};
    for (const [key, vault] of flattenVaults(current.vaults)) {
        const separator = key.indexOf(":");
        const chainId = key.slice(0, separator);
        const address = key.slice(separator + 1);
        vaults[chainId] ??= {};
        vaults[chainId][address] = historyVault(vault);
    }
    return { collectedAt, vaults };
}

function restoreObservation(observation) {
    if (!isObject(observation) || !isObject(observation.vaults)) {
        throw new Error("Invalid history observation");
    }
    validateTimestamp(observation.collectedAt, "history timestamp");
    const vaults = {};
    for (const [chain, chainVaults] of Object.entries(observation.vaults)) {
        const chainId = Number(chain);
        if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isObject(chainVaults)) {
            throw new Error("Invalid history chain");
        }
        const normalizedChain = String(chainId);
        if (Object.hasOwn(vaults, normalizedChain)) throw new Error("Duplicate history chain");
        vaults[normalizedChain] = {};
        for (const [address, vault] of Object.entries(chainVaults)) {
            if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("Invalid history address");
            const normalizedAddress = address.toLowerCase();
            if (Object.hasOwn(vaults[normalizedChain], normalizedAddress)) {
                throw new Error("Duplicate history vault");
            }
            vaults[normalizedChain][normalizedAddress] = historyVault(vault);
        }
    }
    return { collectedAt: observation.collectedAt, vaults };
}

function restoreHistory(history) {
    if (!Array.isArray(history)) throw new Error("Invalid saved history");
    return history.map(restoreObservation);
}

export function appendHistory(history, current, collectedAt) {
    const next = makeHistoryObservation(current, collectedAt);
    const cutoff = Date.parse(collectedAt) - HISTORY_RETENTION_MS;
    const observations = new Map();
    for (const observation of restoreHistory(history)) {
        const timestamp = Date.parse(observation.collectedAt);
        // The cutoff is exclusive, yielding 288 observations at a five-minute cadence.
        if (timestamp > cutoff) observations.set(timestamp, observation);
    }
    // The new observation wins if the same collectedAt is already present.
    observations.set(Date.parse(collectedAt), next);
    return [...observations.entries()].sort(([left], [right]) => left - right)
        .map(([, observation]) => observation);
}

// Both persistence adapters store the same complete comparison generation.
export function makeGeneration(previous, current, collectedAt = new Date().toISOString(), history = []) {
    return { version: 1, previous, current, collectedAt,
        history: appendHistory(history, current, collectedAt),
        result: compareSnapshots(previous, current) };
}

export function restoreGeneration(state) {
    if (!state || state.version !== 1 || !Object.hasOwn(state, "previous") ||
        typeof state.collectedAt !== "string" || !Number.isFinite(Date.parse(state.collectedAt))) {
        throw new Error("Invalid saved generation");
    }
    // Recompute instead of trusting potentially inconsistent persisted summary counts.
    return { version: 1, previous: state.previous, current: state.current,
        collectedAt: state.collectedAt,
        history: Object.hasOwn(state, "history") ? restoreHistory(state.history) : [],
        result: compareSnapshots(state.previous, state.current) };
}

export function generationFreshness(state, { now = Date.now(), intervalMs = 300000 } = {}) {
    const stale = !state || now - Date.parse(state.collectedAt) >= intervalMs;
    return { ready: Boolean(state), lastSuccessfulCollection: state?.collectedAt ?? null,
        stale, state: !state ? "starting" : stale ? "stale" : "ready" };
}
