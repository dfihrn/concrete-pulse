import { compareSnapshots } from "./pulse.js";

// Both persistence adapters store the same complete comparison generation.
export function makeGeneration(previous, current, collectedAt = new Date().toISOString()) {
    return { version: 1, previous, current, collectedAt,
        result: compareSnapshots(previous, current) };
}

export function restoreGeneration(state) {
    if (!state || state.version !== 1 || !Object.hasOwn(state, "previous") ||
        typeof state.collectedAt !== "string" || !Number.isFinite(Date.parse(state.collectedAt))) {
        throw new Error("Invalid saved generation");
    }
    // Recompute instead of trusting potentially inconsistent persisted summary counts.
    return makeGeneration(state.previous, state.current, state.collectedAt);
}

export function generationFreshness(state, { now = Date.now(), intervalMs = 300000 } = {}) {
    const stale = !state || now - Date.parse(state.collectedAt) >= intervalMs;
    return { ready: Boolean(state), lastSuccessfulCollection: state?.collectedAt ?? null,
        stale, state: !state ? "starting" : stale ? "stale" : "ready" };
}
