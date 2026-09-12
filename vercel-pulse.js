import { timingSafeEqual } from "node:crypto";
import { createBlobStore } from "./blob-storage.js";
import { GenerationConflict } from "./generation-store.js";
import { fetchSnapshot } from "./pulse.js";
import { makeGeneration, generationFreshness } from "./generation.js";
import { positiveInteger } from "./collector.js";
import { presentPulseGeneration } from "./historical-presenter.js";

// Distributed optimistic concurrency: competing invocations may fetch, but only
// one can replace the generation they both read. Losers do not retry or rebase.
export function createVercelHandlers({ storeFactory = () => createBlobStore(),
    fetchCurrentSnapshot = fetchSnapshot, secret = process.env.CRON_SECRET,
    now = Date.now,
    intervalMs = positiveInteger(process.env.PULSE_INTERVAL_MS, 300000, "PULSE_INTERVAL_MS"),
    timeoutMs = positiveInteger(process.env.PULSE_TIMEOUT_MS, 15000, "PULSE_TIMEOUT_MS") } = {}) {
    function authenticated(req) {
        if (!secret || secret.length < 16) return false;
        const supplied = Buffer.from(req.headers.authorization || "");
        const expected = Buffer.from(`Bearer ${secret}`);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    }
    function prepare(req, res) {
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ error: "Method not allowed" }); return false; }
        return true;
    }
    async function read(req, res, health = false) {
        if (!prepare(req, res)) return;
        try {
            const { generation } = await storeFactory().load();
            const freshness = generationFreshness(generation, { now: now(), intervalMs });
            // Scheduled invocations run on separate instances; do not invent a
            // global collecting flag.
            if (health) return res.json({ status: "ok", ...freshness, collectionMode: "external" });
            if (generation) return res.json({ ...presentPulseGeneration(generation), freshness });
            res.setHeader("Retry-After", "60");
            return res.status(503).json({ error: "Pulse data is not available yet. Please try again shortly.", freshness });
        } catch {
            return res.status(503).json({ error: "Pulse storage is temporarily unavailable." });
        }
    }
    return {
        pulse: (req, res) => read(req, res),
        health: (req, res) => read(req, res, true),
        async collect(req, res) {
            if (!prepare(req, res)) return;
            if (!authenticated(req)) return res.status(401).json({ error: "Unauthorized" });
            let store;
            let generationBeforeWrite;
            try {
                store = storeFactory();
                const { generation, revision } = await store.load();
                generationBeforeWrite = generation;
                // Absorb duplicate scheduler deliveries without advancing the baseline again.
                if (generation && now() - Date.parse(generation.collectedAt) < 60000) {
                    return res.json({ status: "skipped", reason: "recent-collection" });
                }
                const current = await fetchCurrentSnapshot({ timeoutMs });
                const next = makeGeneration(generation?.current ?? null, current,
                    new Date(now()).toISOString(), generation?.history ?? []);
                await store.commit(next, revision);
                return res.json({ status: "collected", timestamp: next.current.timestamp });
            } catch (error) {
                if (error instanceof GenerationConflict && store) {
                    try {
                        const { generation: persistedGeneration } = await store.load();
                        const previousCollectedAt = generationBeforeWrite
                            ? Date.parse(generationBeforeWrite.collectedAt)
                            : Number.NEGATIVE_INFINITY;
                        const persistedCollectedAt = persistedGeneration
                            ? Date.parse(persistedGeneration.collectedAt)
                            : Number.NEGATIVE_INFINITY;

                        // A conflict is a successful concurrent collection only when
                        // another invocation demonstrably advanced the persisted generation.
                        if (persistedCollectedAt > previousCollectedAt) {
                            return res.json({ status: "skipped", reason: "concurrent-collection" });
                        }
                        return res.status(409).json({ error: "Pulse data was not persisted. Please retry." });
                    } catch {
                        return res.status(503).json({ error: "Unable to verify Pulse persistence. Please retry." });
                    }
                }
                // No failed attempt overwrites the last successful generation. Age
                // marks it stale across all instances, including cold starts.
                return res.status(503).json({ error: "Unable to collect Pulse data. The last successful result is preserved." });
            }
        }
    };
}
