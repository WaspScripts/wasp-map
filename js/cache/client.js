// Main thread side of the tile workers: spreads tile requests over a few workers, hands back
// ImageBitmaps, and does every cache archive download on the workers' behalf.

import { ArchiveSource, TILE_CACHE_NAME } from "./archive.js";
import { ObjectIndex } from "./objectindex.js";
import { mergeSnapshots, reset, snapshot } from "./perf.js";

// Tiles are sent to workers by blocks of this many regions a side, so neighbouring regions -
// which every region's ground blending needs - are decoded by the same worker.
const AFFINITY_BLOCK = 2;
const NATIVE_ZOOM = 2;
const OBJECT_INDEX_VERSION = 1;

export class TileClient extends EventTarget {
    constructor(cacheId, workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
        super();
        this.cacheId = cacheId;
        this.source = new ArchiveSource(cacheId);
        this.nextId = 1;
        this.batch = 0;
        this.batchOpen = false;
        this.pending = new Map();
        this.perfWaiting = new Map();
        this.answersWaiting = new Map();
        this.workers = [];

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
            worker.onmessage = (e) => this._onMessage(worker, e.data);
            // one worker is enough to have every map icon sprite downloaded in the background
            worker.postMessage({ type: "init", cacheId, preloadIcons: i === 0 });
            this.workers.push(worker);
        }
    }

    _onMessage(worker, msg) {
        switch (msg.type) {
            case "fetch":
                this._fetchForWorker(worker, msg);
                return;
            case "preload":
                for (const group of msg.groups) this.source.preloadGroup(msg.index, group).catch(() => {});
                return;
            case "failed":
                this.dispatchEvent(Object.assign(new Event("error"), { message: msg.error }));
                return;
            case "ready":
                return;
            case "perf":
                this.perfWaiting.get(msg.req)?.(msg.timings);
                this.perfWaiting.delete(msg.req);
                return;
            case "answer":
                this.answersWaiting.get(msg.req)?.(msg);
                this.answersWaiting.delete(msg.req);
                return;
        }

        const request = this.pending.get(msg.id);
        if (!request) {
            msg.bitmap?.close();
            return;
        }
        if (msg.final) this.pending.delete(msg.id);

        if (msg.error) {
            this.dispatchEvent(Object.assign(new Event("error"), { message: msg.error }));
            request.onError(new Error(msg.error));
        } else if (!msg.cancelled) {
            request.onTile(msg.bitmap, msg.final);
        }
    }

    // One download serves every worker that asks for the same group; each gets its own copy, since
    // transferring the shared one would empty it for the rest.
    _fetchForWorker(worker, msg) {
        this.source.fetchGroup(msg.index, msg.group, msg.background).then(
            (bytes) => {
                if (!bytes) {
                    worker.postMessage({ type: "fetched", req: msg.req, bytes: null });
                    return;
                }
                const copy = bytes.slice();
                worker.postMessage({ type: "fetched", req: msg.req, bytes: copy }, [copy.buffer]);
            },
            (error) => worker.postMessage({ type: "fetched", req: msg.req, error: String(error?.message ?? error) })
        );
    }

    _workerFor(z, x, y) {
        // the region at the tile's top left corner, then its block
        const n = 1 << Math.max(0, NATIVE_ZOOM - z);
        const bx = Math.floor((x * n) / AFFINITY_BLOCK);
        const by = Math.floor((y * n) / AFFINITY_BLOCK);
        const hash = (Math.imul(bx, 73856093) ^ Math.imul(by, 19349663)) >>> 0;
        return this.workers[hash % this.workers.length];
    }

    // Calls onTile(bitmap, final) with an ImageBitmap, or null for an empty tile. Zoomed out tiles
    // call it twice: first with only the ground drawn, then with final set once the detail is in.
    // Returns an id for cancel, which is only needed until the final call.
    requestTile(layer, plane, z, x, y, onTile, onError) {
        const id = this.nextId++;
        const worker = this._workerFor(z, x, y);
        this.pending.set(id, { onTile, onError, worker });
        worker.postMessage({ type: "tile", id, batch: this._batch(), layer, plane, z, x, y });
        return id;
    }

    _ask(worker, message) {
        const req = this.nextId++;
        return new Promise((resolve, reject) => {
            this.answersWaiting.set(req, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.value)));
            worker.postMessage({ ...message, req });
        });
    }

    requestObjects(x, y) {
        return this._ask(this._workerFor(NATIVE_ZOOM, x, -(y + 1)), { type: "objects", x, y });
    }

    requestObjectShape(id, objectType, orientation, x, y, z) {
        return this._ask(this._workerFor(NATIVE_ZOOM, x >> 6, -((y >> 6) + 1)), { type: "objectShape", id, objectType, orientation, x, y, z });
    }

    objectNames() {
        return (this._objectNames ??= this._ask(this.workers[0], { type: "objectNames" }));
    }

    requestNpcShape(id) {
        return this._ask(this.workers[0], { type: "npcShape", id });
    }

    npcNames() {
        return (this._npcNames ??= this._ask(this.workers[0], { type: "npcNames" }));
    }

    npcSpawns() {
        return (this._npcSpawns ??= this._ask(this.workers[0], { type: "npcSpawns" }));
    }

    findNpcs(names, ids) {
        return this._ask(this.workers[0], { type: "npcSearch", names, ids });
    }

    npcHeat(spawns, range) {
        return this._ask(this.workers[0], { type: "npcHeat", spawns, range });
    }

    objectIds(names, ids) {
        return this._ask(this.workers[0], { type: "objectIds", names, ids });
    }

    objectConfig(id) {
        this._objectConfigs ??= new Map();
        let config = this._objectConfigs.get(id);
        if (!config) {
            config = this._ask(this.workers[0], { type: "objectConfig", id });
            config.catch(() => this._objectConfigs.delete(id));
            this._objectConfigs.set(id, config);
        }
        return config;
    }

    objectIndex() {
        if (!this._objectIndex) {
            this._objectIndex = this._loadObjectIndex();
            this._objectIndex.catch(() => (this._objectIndex = null));
        }
        return this._objectIndex;
    }

    async _loadObjectIndex() {
        const key = `https://tiles.invalid/caches/objects/${this.cacheId}/regions-v${OBJECT_INDEX_VERSION}.bin`;
        const storage = typeof caches !== "undefined" ? await caches.open(TILE_CACHE_NAME).catch(() => null) : null;
        const stored = await storage?.match(key);
        if (stored) return new ObjectIndex(await stored.arrayBuffer());

        this.dispatchEvent(new Event("objectindexing"));
        const parts = await Promise.all(
            this.workers.map((worker, part) => this._ask(worker, { type: "indexObjects", part, parts: this.workers.length }))
        );
        const index = ObjectIndex.build(parts);
        storage?.put(key, new Response(index.buffer)).catch(() => {});
        return index;
    }

    async findObjects(names, ids) {
        const [wanted, index] = await Promise.all([
            this.objectIds(names, ids),
            this.objectIndex(),
        ]);

        const byWorker = new Map();
        for (const region of index.regionsOf(wanted)) {
            const worker = this._workerFor(NATIVE_ZOOM, region >> 8, -((region & 0xff) + 1));
            const regions = byWorker.get(worker);
            if (regions) regions.push(region);
            else byWorker.set(worker, [region]);
        }

        const parts = await Promise.all(
            [...byWorker].map(([worker, regions]) => this._ask(worker, { type: "findObjects", ids: wanted, regions }))
        );
        const found = new Int32Array(parts.reduce((n, part) => n + part.length, 0));
        let offset = 0;
        for (const part of parts) {
            found.set(part, offset);
            offset += part.length;
        }
        return { ids: wanted, found };
    }

    _batch() {
        if (!this.batchOpen) {
            this.batchOpen = true;
            this.batch++;
            queueMicrotask(() => (this.batchOpen = false));
        }
        return this.batch;
    }

    isPending(id) {
        return this.pending.has(id);
    }

    cancel(id) {
        const request = this.pending.get(id);
        if (request) {
            request.worker.postMessage({ type: "cancel", id });
        }
    }

    // Every worker's timings and this thread's, added up, as rows for console.table.
    async perf() {
        const workerSnapshots = await Promise.all(
            this.workers.map(
                (worker) =>
                    new Promise((resolve) => {
                        const req = this.nextId++;
                        this.perfWaiting.set(req, resolve);
                        worker.postMessage({ type: "perf", req });
                    })
            )
        );
        return mergeSnapshots([snapshot(), ...workerSnapshots]);
    }

    resetPerf() {
        reset();
        for (const worker of this.workers) worker.postMessage({ type: "perfReset" });
    }

    terminate() {
        for (const worker of this.workers) worker.terminate();
        this.pending.clear();
        for (const answer of this.answersWaiting.values()) answer({ error: "The cache was changed" });
        this.answersWaiting.clear();
    }
}
