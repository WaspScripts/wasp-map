import { Index } from "./store.js";
import { decodeObject } from "./definitions.js";
import { Region, decodeLocations, gamePlane } from "./region.js";

const CONCURRENCY = 32;

async function forEachLimited(items, limit, fn) {
    let next = 0;
    const run = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function mapGroup(store, regionId, background = false) {
    const files = await store.files(Index.MAPS, regionId, background);
    const terrain = files?.get(0);
    return terrain ? { terrain, locations: files.get(1) } : null;
}

function regionLocations(group, regionId) {
    try {
        return decodeLocations(group.locations, regionId >> 8, regionId & 0xff);
    } catch (error) {
        console.warn(error.message);
        return null;
    }
}

class IntList {
    constructor() {
        this.values = new Int32Array(4096);
        this.length = 0;
    }

    push(a, b, c) {
        if (this.length + 3 > this.values.length) {
            const grown = new Int32Array(this.values.length * 2);
            grown.set(this.values);
            this.values = grown;
        }
        this.values[this.length++] = a;
        this.values[this.length++] = b;
        if (c !== undefined) this.values[this.length++] = c;
    }

    toArray() {
        return this.values.slice(0, this.length);
    }
}

export async function indexRegions(store, mapsTable, part, parts) {
    const regionIds = [...mapsTable.groups.keys()].filter((id, k) => id < 0x10000 && k % parts === part);
    const pairs = new IntList();
    await forEachLimited(regionIds, CONCURRENCY, async (regionId) => {
        const group = await mapGroup(store, regionId, true);
        const locations = group && regionLocations(group, regionId);
        if (!locations) return;
        const ids = locations.ids;
        for (let i = 0; i < ids.length; i++) {
            if (ids[i] !== ids[i - 1]) pairs.push(ids[i], regionId);
        }
    });
    return pairs.toArray();
}

export async function findInRegions(store, renderer, ids, regionIds) {
    const wanted = new Set(ids);
    const found = new IntList();
    await forEachLimited(regionIds, CONCURRENCY, async (regionId) => {
        const group = await mapGroup(store, regionId);
        const locations = group && regionLocations(group, regionId);
        if (!locations) return;

        const hits = [];
        for (let i = 0; i < locations.ids.length; i++) {
            if (wanted.has(locations.ids[i])) hits.push(i);
        }
        if (hits.length === 0) return;

        const x = regionId >> 8;
        const y = regionId & 0xff;
        let region = await renderer.loadedRegion(x, y)?.catch(() => undefined);
        if (region === undefined) {
            try {
                region = new Region(x, y, group.terrain, null);
            } catch {
                region = null;
            }
        }

        for (const i of hits) {
            const packed = locations.packed[i];
            const z = (packed >> 12) & 3;
            const plane = region ? gamePlane(region, z, (packed >> 6) & 0x3f, packed & 0x3f) : z;
            found.push(locations.ids[i], regionId, packed | (plane << 22));
        }
    });
    return found.toArray();
}

export function cleanName(name) {
    return name.replace(/<[^>]*>/g, "");
}

export class ObjectCatalog {
    constructor(mapData) {
        this.mapData = mapData;
        this.byName = new Map();
        this.parents = new Map();
        const names = new Set();
        const files = mapData.objectFiles;

        for (const id of files?.fileIds ?? []) {
            const def = mapData.objects[id] ?? decodeObject(id, files.get(id), mapData.objRevision);
            const name = cleanName(def.name);
            if (name !== "null" && name !== "") {
                names.add(name);
                const key = name.toLowerCase();
                const ids = this.byName.get(key);
                if (ids) ids.push(id);
                else this.byName.set(key, [id]);
            }
            for (const child of def.morphs ?? []) {
                if (child < 0) continue;
                const parents = this.parents.get(child);
                if (!parents) this.parents.set(child, [id]);
                else if (parents[parents.length - 1] !== id) parents.push(id);
            }
        }

        this.names = [...names].sort(new Intl.Collator(undefined, { sensitivity: "base" }).compare);
    }

    ids(names, ids) {
        const found = new Set();
        for (const name of names) {
            for (const id of this.byName.get(name.trim().toLowerCase()) ?? []) found.add(id);
        }
        for (const id of ids) found.add(id);
        for (const id of [...found]) {
            for (const parent of this.parents.get(id) ?? []) found.add(parent);
        }
        return Int32Array.from(found).sort();
    }

    config(id) {
        const def = this.mapData.object(id);
        if (!def) return null;
        const { hasModels, interactable, openableDoor, ...config } = def;
        return config;
    }
}
