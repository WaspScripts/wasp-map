// Fetches caches straight from a public cache archive, so nothing of the game's is hosted here.
// Groups are kept in the visitor's own Cache Storage, since a cache id's contents never change.

import { record, time } from "./perf.js";

const ARCHIVE = "https://archive.openrs2.org";
export const GROUP_CACHE_NAME = "map-groups-v1";
// rendered tiles, kept by worker.js under the same /caches/{scope}/{id}/ url shape as groups
export const TILE_CACHE_NAME = "map-tiles-v1";

// How many caches to offer, newest first.
export const CACHE_COUNT = 5;
const CACHE_LIST_KEY = "map-caches-v1";

export function groupUrl(cacheId, index, group) {
    return `${ARCHIVE}/caches/runescape/${cacheId}/archives/${index}/groups/${group}.dat`;
}

// Only caches the archive downloaded from Jagex itself, rather than ones submitted by users.
function isFromJagex(cache) {
    return (cache.sources ?? []).some((source) => /jagex/i.test(source));
}

function isComplete(cache) {
    return cache.indexes > 0 && cache.valid_indexes === cache.indexes && cache.valid_groups / cache.groups >= 0.99;
}

export async function listCaches() {
    const resp = await fetch(`${ARCHIVE}/caches.json`);
    if (!resp.ok) {
        throw new Error(`Cache archive caches.json returned ${resp.status}`);
    }
    const all = await resp.json();

    const caches = all.filter(
        (cache) =>
            cache.scope === "runescape" &&
            cache.game === "oldschool" &&
            cache.environment === "live" &&
            cache.language === "en" &&
            !cache.hidden &&
            cache.timestamp &&
            cache.builds?.length > 0 &&
            isFromJagex(cache) &&
            isComplete(cache)
    );

    caches.sort((a, b) => b.builds[0].major - a.builds[0].major || Date.parse(b.timestamp) - Date.parse(a.timestamp));

    const list = caches.slice(0, CACHE_COUNT).map((cache) => ({
        id: cache.id,
        build: cache.builds[0].major,
        timestamp: cache.timestamp,
    }));
    try {
        localStorage.setItem(CACHE_LIST_KEY, JSON.stringify(list));
    } catch {}
    return list;
}

export function rememberedCaches() {
    try {
        const list = JSON.parse(localStorage.getItem(CACHE_LIST_KEY));
        return Array.isArray(list) && list.length > 0 ? list : null;
    } catch {
        return null;
    }
}

// Limits how many downloads are in flight at once, so a zoomed out view does not fire off
// thousands of them together. Needed downloads are first come first served, since workers ask for
// regions in the order they draw them; background ones only start when no needed one is waiting.
class DownloadQueue {
    constructor(max) {
        this.max = max;
        this.active = 0;
        this.needed = [];
        this.background = [];
    }

    // Runs fn once a slot is free. ticket is { background }, and is what promote takes.
    async run(fn, ticket) {
        if (this.active >= this.max) {
            await new Promise((resolve) => {
                ticket.resolve = resolve;
                (ticket.background ? this.background : this.needed).push(ticket);
            });
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            (this.needed.shift() ?? this.background.shift())?.resolve();
        }
    }

    // A background download something now waits on: it moves up to wait with the needed ones.
    promote(ticket) {
        if (!ticket.background) return;
        ticket.background = false;
        const i = this.background.indexOf(ticket);
        if (i >= 0) {
            this.background.splice(i, 1);
            this.needed.push(ticket);
        }
    }
}

// Used once on the main thread, as the broker every tile worker fetches through (see client.js),
// so requests from different workers for the same group are merged and the concurrency limit is
// shared rather than per worker.
export class ArchiveSource {
    constructor(cacheId, { concurrency = 48 } = {}) {
        this.cacheId = cacheId;
        this.queue = new DownloadQueue(concurrency);
        this.pending = new Map();
        this.storage = typeof caches !== "undefined" ? caches.open(GROUP_CACHE_NAME).catch(() => null) : Promise.resolve(null);
    }

    groupUrl(index, group) {
        return groupUrl(this.cacheId, index, group);
    }

    // The raw container of a group, or null if the archive does not have it.
    fetchGroup(index, group, background = false) {
        const url = this.groupUrl(index, group);
        const pending = this.pending.get(url);
        if (pending) {
            if (!background) this.queue.promote(pending.ticket);
            // a background request that found the group stored did not read it
            return pending.promise.then((bytes) => (bytes === undefined ? this.fetchGroup(index, group, background) : bytes));
        }
        return this._start(url, background, true).promise;
    }

    // Downloads a group into storage, if it is not there yet, behind every download something
    // waits on. Resolves once that is done.
    preloadGroup(index, group) {
        const url = this.groupUrl(index, group);
        return (this.pending.get(url) ?? this._start(url, true, false)).promise;
    }

    _start(url, background, read) {
        const ticket = { background, read, stored: null };
        const forget = () => this.pending.delete(url);
        const promise = this._fetch(url, ticket).then(
            (bytes) => {
                if (ticket.stored) ticket.stored.then(forget);
                else forget();
                return bytes;
            },
            (error) => {
                forget();
                throw error;
            }
        );
        const pending = { promise, ticket };
        this.pending.set(url, pending);
        return pending;
    }

    // Resolves to the group's bytes, or null if the archive does not have it - or, for a background
    // request that finds it stored, to undefined without reading it.
    async _fetch(url, ticket) {
        const storage = await this.storage;
        const kind = ticket.background ? ", preload" : "";
        const lookupStart = performance.now();
        const cached = await storage?.match(url);
        if (cached) {
            if (!ticket.read) {
                record("fetch: preload already stored", performance.now() - lookupStart);
                return undefined;
            }
            const bytes = new Uint8Array(await cached.arrayBuffer());
            record("fetch: group from storage", performance.now() - lookupStart);
            return bytes;
        }
        record(`fetch: group storage miss${kind}`, performance.now() - lookupStart);

        const queued = performance.now();
        return this.queue.run(async () => {
            record(`fetch: group download queue wait${kind}`, performance.now() - queued);
            const start = performance.now();
            const resp = await fetch(url);
            if (resp.status === 404) {
                return null;
            }
            if (!resp.ok) {
                throw new Error(`Cache archive returned ${resp.status} for ${url}`);
            }
            const bytes = new Uint8Array(await resp.arrayBuffer());
            record(`fetch: group download${kind}`, performance.now() - start);
            ticket.stored = time("storage: group put", () => storage?.put(url, new Response(bytes)).catch(() => {}));
            return bytes;
        }, ticket);
    }
}

// Drops stored groups and tiles that belong to caches no longer offered.
export async function pruneStorage(keepIds) {
    if (typeof caches === "undefined") return;
    for (const name of await caches.keys()) {
        if (name !== GROUP_CACHE_NAME && name !== TILE_CACHE_NAME) await caches.delete(name);
    }
    const keep = new Set(keepIds.map(String));
    for (const name of [GROUP_CACHE_NAME, TILE_CACHE_NAME]) {
        const storage = await caches.open(name);
        for (const request of await storage.keys()) {
            const match = request.url.match(/\/caches\/[a-z]+\/(\d+)\//);
            if (match && !keep.has(match[1])) {
                await storage.delete(request);
            }
        }
    }
}
