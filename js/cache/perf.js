// Timings of each step of getting a tile on screen. Every thread - the main thread and each
// worker - keeps its own; client.js merges them. From the console, `await mapPerf()` prints them
// and `mapPerf.reset()` starts over.
//
// Steps that await (downloads, storage, gzip, tile encoding) are wall time, so they include time
// spent on other tiles the same thread interleaved with them. Synchronous steps are pure CPU time.

const timings = new Map();

export function record(name, ms) {
    let timing = timings.get(name);
    if (!timing) {
        timing = { count: 0, total: 0, max: 0 };
        timings.set(name, timing);
    }
    timing.count++;
    timing.total += ms;
    if (ms > timing.max) timing.max = ms;
}

// Runs fn and records how long it took, whether it returns a value or a promise.
export function time(name, fn) {
    const start = performance.now();
    const result = fn();
    if (result instanceof Promise) {
        return result.finally(() => record(name, performance.now() - start));
    }
    record(name, performance.now() - start);
    return result;
}

export function snapshot() {
    return Array.from(timings, ([name, timing]) => [name, { ...timing }]);
}

export function reset() {
    timings.clear();
}

// Adds up snapshots from several threads into rows for console.table, sorted by name.
export function mergeSnapshots(snapshots) {
    const merged = new Map();
    for (const snap of snapshots) {
        for (const [name, timing] of snap) {
            const into = merged.get(name);
            if (!into) {
                merged.set(name, { ...timing });
                continue;
            }
            into.count += timing.count;
            into.total += timing.total;
            into.max = Math.max(into.max, timing.max);
        }
    }

    const rows = {};
    for (const name of [...merged.keys()].sort()) {
        const { count, total, max } = merged.get(name);
        rows[name] = {
            count,
            "total ms": Math.round(total),
            "avg ms": Number((total / count).toFixed(2)),
            "max ms": Number(max.toFixed(2)),
        };
    }
    return rows;
}
