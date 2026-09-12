import { fileURLToPath } from "node:url";
import { fetchSnapshot } from "./pulse.js";
import { createStore } from "./storage.js";
import { makeGeneration } from "./generation.js";
import { presentPulseGeneration } from "./historical-presenter.js";

export function positiveInteger(value, fallback, name) {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647) throw new Error(`Invalid ${name}`);
    return parsed;
}

export function createCollector({
    directory = process.env.PULSE_DATA_DIR || fileURLToPath(new URL("./data/", import.meta.url)),
    intervalMs = positiveInteger(process.env.PULSE_INTERVAL_MS, 300000, "PULSE_INTERVAL_MS"),
    timeoutMs = positiveInteger(process.env.PULSE_TIMEOUT_MS, 15000, "PULSE_TIMEOUT_MS"),
    fetchCurrentSnapshot = fetchSnapshot,
    store = createStore(directory), now = Date.now,
    schedule = setTimeout, unschedule = clearTimeout
} = {}) {
    let state = null, active = null, controller = null, timer = null;
    let stopped = false, started = false, failed = false, storageError = false;
    try { state = store.load(); } catch { storageError = true; }
    function metadata() {
        return { ready: Boolean(state), collecting: Boolean(active),
            lastSuccessfulCollection: state?.collectedAt ?? null,
            stale: !state || failed || storageError || now() - Date.parse(state.collectedAt) >= intervalMs,
            state: stopped ? "stopped" : storageError ? "storage-error" : active ? "collecting" : failed ? "upstream-error" : state ? "ready" : "starting" };
    }
    function collect() {
        if (stopped) return Promise.reject(new Error("Collector stopped"));
        if (!started) return Promise.reject(new Error("Collector not started"));
        if (active) return active;
        if (storageError) return Promise.reject(new Error("Storage recovery required"));
        controller = new AbortController();
        const signal = controller.signal;
        active = (async () => {
            try {
                const current = await fetchCurrentSnapshot({ signal, timeoutMs });
                signal.throwIfAborted();
                const previous = state?.current ?? null;
                const next = makeGeneration(previous, current, new Date(now()).toISOString(), state?.history ?? []);
                store.commit(next, state);
                state = next;
                failed = false;
                return next.result;
            } catch (error) { failed = true; throw error; }
            finally { controller = null; }
        })().finally(() => { active = null; });
        return active;
    }
    function tick() {
        if (stopped) return;
        collect().catch(() => {}).finally(() => {
            // Retry at the collection interval, including outages; no request queue.
            if (!stopped) timer = schedule(tick, intervalMs);
        });
    }
    function start({ scheduled = true } = {}) {
        if (stopped) throw new Error("Collector stopped");
        if (started) return;
        store.acquire();
        started = true;
        // Reload under the lock: a different writer may have committed since construction.
        try { state = store.load(); storageError = false; } catch { storageError = true; }
        if (scheduled) {
            const remaining = state ? intervalMs - (now() - Date.parse(state.collectedAt)) : 0;
            if (remaining > 0) timer = schedule(tick, remaining); else tick();
        }
    }
    async function stop() {
        stopped = true;
        if (timer !== null) unschedule(timer);
        controller?.abort(new Error("Collector shutting down"));
        await active?.catch(() => {});
        if (started) { store.release(); started = false; }
    }
    return { start, stop, collect, metadata,
        read: () => state ? { ...presentPulseGeneration(state), freshness: metadata() } : null };
}
