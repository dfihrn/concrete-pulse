import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { restoreGeneration } from "./generation.js";

import { GenerationConflict } from "./generation-store.js";

export function createBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN,
    pathname = process.env.PULSE_BLOB_PATH || "pulse/generation.json",
    sdk = { get, put }, timeoutMs = 10000 } = {}) {
    if (!token) throw new Error("Blob storage is not configured");
    return {
        async load() {
            // Read content AND its ETag together, bypassing the Blob cache. Using
            // head() separately could pair old content with a newer ETag.
            const response = await sdk.get(pathname, { access: "private", token,
                useCache: false, abortSignal: AbortSignal.timeout(timeoutMs) });
            if (!response) return { generation: null, revision: null };
            if (response.statusCode !== 200 || !response.stream || !response.blob.etag) {
                throw new Error("Invalid Blob response");
            }
            const generation = restoreGeneration(await new Response(response.stream).json());
            return { generation, revision: response.blob.etag };
        },
        async commit(generation, revision) {
            restoreGeneration(generation);
            try {
                return await sdk.put(pathname, JSON.stringify(generation), {
                    access: "private", token, addRandomSuffix: false,
                    contentType: "application/json", cacheControlMaxAge: 60,
                    // First creation is also exclusive. Never overwrite without a revision.
                    allowOverwrite: revision !== null,
                    ...(revision !== null ? { ifMatch: revision } : {}),
                    abortSignal: AbortSignal.timeout(timeoutMs)
                });
            } catch (error) {
                if (error instanceof BlobPreconditionFailedError) throw new GenerationConflict("Generation changed");
                if (revision === null) {
                    // Exclusive creation may report a generic already-exists error.
                    let existing;
                    try { existing = await sdk.get(pathname, { access: "private", token,
                        useCache: false, abortSignal: AbortSignal.timeout(timeoutMs) }); } catch { /* Keep original failure. */ }
                    if (existing?.statusCode === 200) throw new GenerationConflict("Generation created concurrently");
                }
                throw error;
            }
        }
    };
}
