import { createHash } from "node:crypto";
import { createStore } from "./storage.js";
import { GenerationConflict } from "./generation-store.js";

// Same async load/commit contract as Blob; useful for local function testing.
export function createFileGenerationStore(directory) {
    const store = createStore(directory);
    const revisionOf = generation => generation
        ? createHash("sha256").update(JSON.stringify(generation)).digest("hex") : null;
    return {
        async load() {
            const generation = store.load();
            return { generation, revision: revisionOf(generation) };
        },
        async commit(generation, revision) {
            try { store.acquire(); } catch (error) {
                if (error.code === "EEXIST") throw new GenerationConflict("Writer active");
                throw error;
            }
            try {
                const before = store.load();
                if (revisionOf(before) !== revision) throw new GenerationConflict("Generation changed");
                store.commit(generation, before);
            } finally { store.release(); }
        }
    };
}
