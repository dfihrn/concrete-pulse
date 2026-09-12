import fs from "node:fs";
import path from "node:path";
import { compareSnapshots } from "./pulse.js";
import { restoreGeneration } from "./generation.js";

// One atomic file contains the entire comparison, never two independently rotated files.
export function createStore(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const statePath = path.join(directory, "pulse-state.json");
    const backupPath = path.join(directory, "pulse-backup.json");
    const lockPath = path.join(directory, "collector.lock");
    let ownsLock = false;
    function acquire() {
        // Fail closed after an unclean exit. Do not guess whether another host's
        // writer is alive or steal a lock based on PID reuse or elapsed time.
        const fd = fs.openSync(lockPath, "wx");
        ownsLock = true;
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
        finally { fs.closeSync(fd); }
    }
    function release() {
        if (ownsLock) {
            try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
            ownsLock = false;
        }
    }
    function read(file) {
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        return restoreGeneration(state);
    }
    function load() {
        let found = false;
        for (const file of [statePath, backupPath]) {
            if (!fs.existsSync(file)) continue;
            found = true;
            try { return read(file); } catch { /* Try the last-good generation. */ }
        }
        if (found) throw new Error("No valid saved generation; restore storage before collecting.");
        // Import the existing raw snapshots once. Never rewrite or remove them.
        const latest = path.join(directory, "latest.json");
        const previous = path.join(directory, "previous.json");
        if (!fs.existsSync(latest)) return null;
        const current = JSON.parse(fs.readFileSync(latest, "utf8"));
        const before = fs.existsSync(previous) ? JSON.parse(fs.readFileSync(previous, "utf8")) : null;
        return { version: 1, current, previous: before, collectedAt: current.timestamp,
            result: compareSnapshots(before, current) };
    }
    function atomicWrite(file, value) {
        const temporary = `${file}.tmp`;
        try {
            const fd = fs.openSync(temporary, "w");
            try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temporary, file);
            // Directory fsync makes rename durable on filesystems supporting it.
            if (process.platform !== "win32") {
                const dir = fs.openSync(directory, "r");
                try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
            }
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    function commit(state, lastGood) {
        if (!ownsLock) throw new Error("Collector does not own storage");
        if (lastGood) atomicWrite(backupPath, lastGood);
        atomicWrite(statePath, state);
    }
    return { acquire, release, load, commit };
}
