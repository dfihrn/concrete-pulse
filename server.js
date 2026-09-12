import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCollector, positiveInteger } from "./collector.js";

export function createApp({ collector } = {}) {
    if (!collector) throw new Error("A collector is required");
    const app = express();
    app.disable("x-powered-by");
    app.use("/api", (_request, response, next) => {
        response.set("Cache-Control", "no-store");
        next();
    });
    app.get("/api/health", (_request, response) => response.json({ status: "ok", ...collector.metadata() }));
    app.get("/api/pulse", (_request, response) => {
        const result = collector.read();
        if (result) return response.json(result);
        response.set("Retry-After", "30").status(503).json({
            error: "Pulse data is not available yet. Please try again shortly.",
            freshness: collector.metadata()
        });
    });
    app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url))));
    return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let collector;
    try {
        const port = positiveInteger(process.env.PORT, 3000, "PORT");
        if (port > 65535) throw new Error("Invalid PORT");
        collector = createCollector();
        collector.start();
        const server = createApp({ collector }).listen(port, "0.0.0.0", () => {
            console.log(`Concrete Pulse running at http://127.0.0.1:${port}`);
        });
        let exiting = false;
        async function shutdown() {
            if (exiting) return;
            exiting = true;
            server.close();
            await collector.stop();
        }
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        server.on("error", async error => {
            console.error("Unable to start Pulse:", error.message);
            process.exitCode = 1;
            await shutdown();
        });
    } catch (error) {
        console.error("Unable to start Pulse:", error.message);
        process.exitCode = 1;
        await collector?.stop();
    }
}
