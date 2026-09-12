import { get, head, put, BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import { restoreGeneration } from "./generation.js";

import { GenerationConflict } from "./generation-store.js";

const STABLE_READ_ATTEMPTS = 3;

export function createBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN,
    pathname = process.env.PULSE_BLOB_PATH || "pulse/generation.json",
    sdk = { get, head, put }, timeoutMs = 10000 } = {}) {
    if (!token) throw new Error("Blob storage is not configured");

    async function readMetadata() {
        try {
            return await sdk.head(pathname, { token,
                abortSignal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            if (error instanceof BlobNotFoundError) return null;
            throw error;
        }
    }

    return {
        async load() {
            for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
                const before = await readMetadata();
                const response = await sdk.get(pathname, { access: "private", token,
                    useCache: false, abortSignal: AbortSignal.timeout(timeoutMs) });
                let serialized = null;
                if (response) {
                    if (response.statusCode !== 200 || !response.stream || !response.blob) {
                        throw new Error("Invalid Blob response");
                    }
                    serialized = await new Response(response.stream).text();
                }
                const after = await readMetadata();
                const beforeRevision = before?.etag ?? null;
                const afterRevision = after?.etag ?? null;

                if (beforeRevision !== afterRevision) continue;
                if (beforeRevision === null && response === null) {
                    return { generation: null, revision: null };
                }
                if (!beforeRevision || response === null) continue;

                const generation = restoreGeneration(JSON.parse(serialized));
                return { generation, revision: beforeRevision };
            }
            throw new Error(`Unable to obtain a stable Blob generation after ${STABLE_READ_ATTEMPTS} attempts`);
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
