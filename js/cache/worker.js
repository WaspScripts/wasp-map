// Renders map tiles in the background. Tiles use Leaflet's numbering for a map where one game
// tile is one unit: at zoom 2 a 256px tile is exactly one 64x64 region, and higher zooms are
// Leaflet scaling zoom 2 up.
//
// Zooms 0 to 2 are drawn from the regions under the tile, unless the four tiles a zoom level in
// are all stored already, in which case they are shrunk into it instead. Below zoom 0 a tile is
// always built from the four under it, building any that are not stored yet the same way, down
// to zoom 0. There a game tile is a pixel, so the ground alone is drawn a pixel per game tile
// rather than drawn full size and shrunk. Every tile built along the way is stored.

import { CacheStore, Index } from "./store.js";
import { GROUP_CACHE_NAME, TILE_CACHE_NAME, groupUrl } from "./archive.js";
import { MapData } from "./mapdata.js";
import { MapRenderer, IMAGE_SIZE, SCALE } from "./renderer.js";
import { REGION_SIZE, drawnPlane } from "./region.js";
import { modelHeight, objectModelIds } from "./model.js";
import { BRIGHTNESS_MAX } from "./colors.js";
import { record, reset, snapshot, time } from "./perf.js";
import { decodeTile, encodeTile } from "./qoi.js";
import { ObjectCatalog, cleanName, findInRegions, indexRegions } from "./objectsearch.js";
import { NpcCatalog, NpcDefinitions, npcHeat } from "./npcs.js";

const NATIVE_ZOOM = 2;
// Below this zoom tiles are always built from the four tiles under them.
const PYRAMID_ZOOM = 0;
// At this zoom and below a game tile is a pixel or less: the ground is drawn first, on its own,
// and walls, map scenes and icons are added afterwards in the background.
const GROUND_FIRST_ZOOM = 0;
// Below this zoom walls, map scenes and icons are left out altogether.
const MIN_DETAIL_ZOOM = -2;
// Tiles the viewer is waiting for, and background detail passes, are limited separately so a
// detail pass never holds up a tile that has nothing on screen yet. Detail passes mostly wait on
// icon sprite downloads, so more than one runs at a time.
const MAX_TILE_JOBS = 3;
const MAX_DETAIL_JOBS = 2;

// Groups are fetched by the main thread (client.js), which merges requests from all workers.
class BrokerSource {
    constructor() {
        this.nextReq = 1;
        this.waiting = new Map();
        this.cacheId = null;
        this.storage = caches.open(GROUP_CACHE_NAME).catch(() => null);
    }

    async fetchGroup(index, group, background = false) {
        const lookupStart = performance.now();
        const stored = await (await this.storage)?.match(groupUrl(this.cacheId, index, group));
        if (stored) {
            const bytes = new Uint8Array(await stored.arrayBuffer());
            record("fetch: group from storage, worker", performance.now() - lookupStart);
            return bytes;
        }

        const req = this.nextReq++;
        const promise = new Promise((resolve, reject) => {
            this.waiting.set(req, { resolve, reject });
            postMessage({ type: "fetch", req, index, group, background });
        });
        return time("fetch: group round trip, worker", () => promise);
    }

    onFetched(msg) {
        const waiting = this.waiting.get(msg.req);
        if (!waiting) return;
        this.waiting.delete(msg.req);
        if (msg.error) waiting.reject(new Error(msg.error));
        else waiting.resolve(msg.bytes);
    }
}

const source = new BrokerSource();
let state = null;
const cancelled = new Set();
const queue = [];

class Cancelled extends Error {}

function init(cacheId) {
    source.cacheId = cacheId;
    const store = new CacheStore(source);
    const tilesReady = time("init: tiles ready", async () => {
        const [mapsTable, tiles] = await Promise.all([store.referenceTable(Index.MAPS), caches.open(TILE_CACHE_NAME).catch(() => null)]);
        if (mapsTable.named) {
            throw new Error("This cache uses the old named map format, which is not supported.");
        }

        const regionGrid = new Uint8Array(256 * 256);
        for (const id of mapsTable.groups.keys()) {
            if (id < regionGrid.length) regionGrid[id] = 1;
        }
        return { mapsTable, regionGrid, tiles, renderer: null };
    });
    const ready = time("init: worker ready", async () => {
        const [mapData, resolved] = await Promise.all([MapData.load(store, BRIGHTNESS_MAX), tilesReady]);
        resolved.renderer = new MapRenderer(store, mapData, resolved.mapsTable);
        return resolved;
    });
    // registered before anything else waits on ready, so it is set by the time they carry on
    state = { cacheId, tilesReady, ready, resolved: null };
    tilesReady.then(
        (resolved) => (state.resolved = resolved),
        () => {}
    );
    ready.catch(() => {});
}

// The regions under a tile, as the existing ones of x in rx..rx+n-1 and y in ry..ry+n-1.
function tileRegions(grid, z, x, y) {
    const n = 1 << Math.max(0, NATIVE_ZOOM - z);
    const rx = x * n;
    const ry = -(y + 1) * n;
    const regions = [];
    for (let i = Math.max(0, rx); i < Math.min(256, rx + n); i++) {
        for (let j = Math.max(0, ry); j < Math.min(256, ry + n); j++) {
            if (grid[(i << 8) | j]) regions.push([i, j]);
        }
    }
    return { n, rx, ry, regions };
}

// Starts loading the regions a tile is drawn from, and for the map the neighbours their ground
// blends with and whose icons reach into it, in the order they are drawn. They then download and
// decode while earlier ones are drawn, and the renderer keeps them until they are. Tiles with
// detail start on the icon sprites those regions show too.
function prefetchRegions(t) {
    const { renderer, regionGrid } = state.resolved;
    const { n, rx, ry } = tileRegions(regionGrid, t.z, t.x, t.y);
    const ring = t.layer === "height" ? 0 : 1;
    const icons = t.layer === "map" && !t.ground;
    for (let i = rx - ring; i < rx + n + ring; i++) {
        for (let j = ry - ring; j < ry + n + ring; j++) {
            // blending reaches straight across a region edge, never diagonally
            const corner = (i < rx || i >= rx + n) && (j < ry || j >= ry + n);
            if (!corner && i >= 0 && i < 256 && j >= 0 && j < 256 && regionGrid[(i << 8) | j]) {
                renderer.loadRegion(i, j).catch(() => {});
                if (icons) renderer.prefetchIcons(i, j, t.plane);
            }
        }
    }
}

// Tiles are { layer, plane, z, x, y, ground }, ground being the version with only the ground
// drawn, which zoomed out map tiles have. Below MIN_DETAIL_ZOOM that is the only version, and it
// is kept under the plain key.
function tileKey(t) {
    const key = `https://tiles.invalid/caches/tiles/${state.cacheId}/${t.layer}/${t.plane}/${t.z}/${t.x}/${t.y}.qoi.gz`;
    return t.ground && t.z >= MIN_DETAIL_ZOOM ? key + "?ground" : key;
}

function tileName(t) {
    return `${t.layer}${t.ground ? " ground" : ""} z=${t.z}`;
}

// The four tiles a zoom level in, in the order of the quarters they fill: dx, dy is which one.
function childTiles(t) {
    const children = [];
    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            children.push({ ...t, z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy, dx, dy });
        }
    }
    return children;
}

// Box filters a size x size square of pixels down by n into the tile at dx, dy. Each byte of a
// pixel is averaged alike, so it works the same on ARGB and RGBA.
function downsampleInto(tile, pixels, size, n, dx, dy) {
    if (n === 1) {
        for (let row = 0; row < size; row++) {
            tile.set(pixels.subarray(row * size, (row + 1) * size), (dy + row) * IMAGE_SIZE + dx);
        }
        return;
    }
    const out = size / n;
    if (n === 2) {
        for (let oy = 0; oy < out; oy++) {
            const rowOut = (dy + oy) * IMAGE_SIZE + dx;
            for (let ox = 0, i = 2 * oy * size; ox < out; ox++, i += 2) {
                const a = pixels[i], b = pixels[i + 1], c = pixels[i + size], d = pixels[i + size + 1];
                const low = (a & 0x00ff00ff) + (b & 0x00ff00ff) + (c & 0x00ff00ff) + (d & 0x00ff00ff);
                const high = ((a >>> 8) & 0x00ff00ff) + ((b >>> 8) & 0x00ff00ff) + ((c >>> 8) & 0x00ff00ff) + ((d >>> 8) & 0x00ff00ff);
                tile[rowOut + ox] = (((high >>> 2) & 0x00ff00ff) << 8) | ((low >>> 2) & 0x00ff00ff);
            }
        }
        return;
    }
    const shift = 2 * Math.log2(n);
    for (let oy = 0; oy < out; oy++) {
        const rowOut = (dy + oy) * IMAGE_SIZE + dx;
        const rowIn = oy * n * size;
        for (let ox = 0; ox < out; ox++) {
            let low = 0, high = 0;
            for (let i = rowIn + ox * n, end = i + n * size; i < end; i += size) {
                for (let j = i; j < i + n; j++) {
                    const p = pixels[j];
                    low += p & 0x00ff00ff;
                    high += (p >>> 8) & 0x00ff00ff;
                }
            }
            tile[rowOut + ox] = (((high >>> shift) & 0x00ff00ff) << 8) | ((low >>> shift) & 0x00ff00ff);
        }
    }
}

function tilePixels(tile) {
    return tile.pixels ?? time("tile: decode stored", () => decodeTile(tile.blob));
}

async function answer(id, tile, final) {
    const pixels = tile && (await tilePixels(tile));
    const bitmap =
        pixels &&
        (await time("tile: to bitmap", () => createImageBitmap(new ImageData(new Uint8ClampedArray(pixels.buffer), IMAGE_SIZE, IMAGE_SIZE))));
    postMessage({ id, bitmap, final }, bitmap ? [bitmap] : []);
}

// Draws a tile from the regions under it. Resolves to RGBA pixels, or null if nothing was drawn.
async function renderRegions(job, t) {
    const { renderer, regionGrid } = state.resolved;
    const { n, rx, ry, regions } = tileRegions(regionGrid, t.z, t.x, t.y);
    prefetchRegions(t);

    const tile = new Int32Array(IMAGE_SIZE * IMAGE_SIZE);
    const size = IMAGE_SIZE / n;
    // once a game tile is a pixel or less the ground can be drawn at that size, not shrunk to it
    const pixelPerTile = (t.layer === "height" || (t.layer === "map" && t.ground)) && n >= SCALE;
    const from = pixelPerTile ? REGION_SIZE : IMAGE_SIZE;
    let drawn = false;

    for (const [i, j] of regions) {
        if (cancelled.has(job)) throw new Cancelled();

        let pixels;
        if (t.layer === "collision") pixels = await renderer.renderCollision(i, j, t.plane);
        else if (t.layer === "height") pixels = await renderer.renderHeight(i, j, t.plane, pixelPerTile ? 1 : SCALE);
        else if (pixelPerTile) pixels = await renderer.renderGround(i, j, t.plane);
        else pixels = await renderer.renderMap(i, j, t.plane, !t.ground);
        if (!pixels) continue;
        if (n === 1 && from === IMAGE_SIZE) return pixels;

        time("tile: downsample", () => downsampleInto(tile, pixels, from, from / size, (i - rx) * size, (ry + n - 1 - j) * size));
        drawn = true;
    }

    return drawn ? tile : null;
}

async function storedTile(key) {
    const { tiles } = state.resolved;
    const start = performance.now();
    const stored = await tiles?.match(key);
    if (!stored) {
        record("storage: tile lookup, miss", performance.now() - start);
        return undefined;
    }
    const blob = await stored.blob();
    record("storage: tile lookup, hit", performance.now() - start);
    return blob.size > 0 ? blob : null;
}

async function saveTile(key, pixels) {
    const { tiles } = state.resolved;
    if (!tiles) return;
    const blob = pixels ? await time("tile: encode", () => encodeTile(pixels, IMAGE_SIZE)) : new Blob([]);
    await time("storage: tile put", () =>
        tiles.put(key, new Response(blob)).catch(() => {})
    );
}

function hasRegions(t) {
    return tileRegions(state.resolved.regionGrid, t.z, t.x, t.y).regions.length > 0;
}

// Tiles being built, by key, so one that two jobs need is only built once.
const building = new Map();

async function availableTile(key) {
    const built = building.get(key)?.built;
    if (built !== undefined) return built;
    const blob = await storedTile(key);
    return blob === undefined ? undefined : blob && { blob };
}

// The four tiles under t as stored: { blob }, null where nothing is drawn, or undefined where one
// is not stored yet.
function availableChildren(children) {
    return Promise.all(children.map((child) => (hasRegions(child) ? availableTile(tileKey(child)) : null)));
}

// Shrinks the four tiles under a tile into its quarters. Resolves to RGBA pixels, or null if none
// of them has anything drawn.
async function combineChildren(children, results) {
    const tile = new Uint32Array(IMAGE_SIZE * IMAGE_SIZE);
    const half = IMAGE_SIZE / 2;
    let drawn = false;
    for (let k = 0; k < children.length; k++) {
        const result = results[k];
        if (!result) continue;
        const pixels = await tilePixels(result);
        time("tile: downsample", () => downsampleInto(tile, pixels, IMAGE_SIZE, 2, children[k].dx * half, children[k].dy * half));
        drawn = true;
    }
    return drawn ? tile : null;
}

// Builds a tile that is not stored. Resolves to RGBA pixels, or null where nothing is drawn.
async function buildTile(job, t) {
    const pyramid = t.z < PYRAMID_ZOOM;
    // the ground only version is never stored a zoom level in from where it is drawn
    const fromStoredChildren = !pyramid && t.z < NATIVE_ZOOM && !(t.ground && t.z >= PYRAMID_ZOOM);

    if (pyramid || fromStoredChildren) {
        const children = childTiles(t);
        const results = await availableChildren(children);
        if (pyramid || results.every((result) => result !== undefined)) {
            return time(`build: from tiles under it, ${tileName(t)}`, async () => {
                // the missing ones one after another, starting each one's downloads before the
                // previous one is drawn, so they download while it is
                const missing = children.filter((_, k) => results[k] === undefined);
                for (let k = 0; k < children.length; k++) {
                    if (results[k] !== undefined) continue;
                    if (cancelled.has(job)) throw new Cancelled();
                    const next = missing[missing.indexOf(children[k]) + 1];
                    if (children[k].z >= PYRAMID_ZOOM) prefetchRegions(children[k]);
                    if (next && next.z >= PYRAMID_ZOOM) prefetchRegions(next);
                    results[k] = await getTile(job, children[k], true);
                }
                return combineChildren(children, results);
            });
        }
    }

    return time(`build: from regions, ${tileName(t)}`, () => renderRegions(job, t));
}

// A tile from storage, or built and stored. Resolves to { blob } or { pixels }, pixels if it was
// just built, or to null where nothing is drawn. notStored skips the storage lookup.
async function getTile(job, t, notStored = false) {
    if (!hasRegions(t)) return null;
    const key = tileKey(t);

    if (!notStored) {
        const tile = await availableTile(key);
        if (tile !== undefined) return tile;
    }

    for (;;) {
        let entry = building.get(key);
        if (!entry) {
            const forget = () => building.get(key) === entry && building.delete(key);
            entry = { built: undefined };
            entry.promise = state.ready.then(() => buildTile(job, t)).then((pixels) => {
                entry.built = pixels && { pixels };
                saveTile(key, pixels).finally(forget);
                return entry.built;
            });
            entry.promise.catch(forget);
            building.set(key, entry);
        }
        try {
            return await entry.promise;
        } catch (error) {
            // it was being built for a job that has since been cancelled: build it for this one
            if (error instanceof Cancelled && !cancelled.has(job)) continue;
            throw error;
        }
    }
}

// Answers a tile request. Map tiles that are drawn ground first get two answers: the ground right
// away, then the finished tile once the background detail pass is done.
async function handleTile(msg) {
    const { id, layer, plane, z, x, y } = msg;
    await state.tilesReady;
    const start = performance.now();
    record(`tile: queue wait z=${z}`, start - msg.received);
    // the time from picking the tile up to answering, by how it was answered
    const answered = (how) => record(`tile: ${how} ${layer} z=${z}`, performance.now() - start);

    const t = { layer, plane, z, x, y, ground: layer === "map" && z < MIN_DETAIL_ZOOM };
    if (!hasRegions(t)) {
        return postMessage({ id, bitmap: null, final: true });
    }

    const groundFirst = layer === "map" && z <= GROUND_FIRST_ZOOM && z >= MIN_DETAIL_ZOOM;
    if (!groundFirst) {
        const tile = await getTile(id, t);
        await answer(id, tile, true);
        answered(tile === null ? "empty" : tile.pixels ? "built" : "from storage");
        return;
    }

    const finished = await availableTile(tileKey(t));
    if (finished !== undefined) {
        await answer(id, finished, true);
        answered("from storage");
        return;
    }

    // a tile drawn from its regions loads them, and their icon sprites, for the detail pass now,
    // so the icons download while the ground is drawn
    await state.ready;
    if (z >= PYRAMID_ZOOM) prefetchRegions(t);
    const ground = await getTile(id, { ...t, ground: true });
    await answer(id, ground, false);
    answered("ground pass ready");
    detailQueue.push({ ...msg, t, received: performance.now() });
    pump();
}

async function handleDetail(msg) {
    const { id, layer, z, t } = msg;
    const start = performance.now();
    record(`tile: detail queue wait z=${z}`, start - msg.received);
    const tile = await getTile(id, t);
    await answer(id, tile, true);
    record(`tile: detail pass ${layer} z=${z}`, performance.now() - start);
}

const detailQueue = [];
function reply(msg, promise) {
    promise.then(
        (value) => postMessage({ type: "answer", req: msg.req, value }),
        (error) => postMessage({ type: "answer", req: msg.req, error: String(error?.message ?? error) })
    );
}

async function regionObjects(x, y) {
    const { renderer } = await state.ready;
    const region = await renderer.loadRegion(x, y);
    const objects = [];
    region?.forEachLocation((id, type, orientation, z, localX, localY) => {
        const def = renderer.mapData.object(id);
        if (def?.interactable) {
            const p = drawnPlane(region, z, localX, localY);
            objects.push({ p, z, i: x, j: y, x: localX, y: localY, id, t: type, r: orientation, n: cleanName(def.name) });
        }
    });
    return objects;
}

async function objectShape(id, type, orientation, x, y, z) {
    const { renderer } = await state.ready;
    const def = renderer.mapData.object(id);
    if (!def) return null;

    const region = await renderer.loadRegion(x >> 6, y >> 6);
    const plane = region ? drawnPlane(region, z, x & 63, y & 63) : z;
    const turned = (orientation & 1) === 1;

    let height = 0;
    for (const modelId of objectModelIds(def, type)) {
        const data = await renderer.mapData.store.groupData(Index.MODELS, modelId);
        if (!data) {
            height = 0;
            break;
        }
        height = Math.max(height, modelHeight(data, def.modelSizeHeight));
    }

    return {
        plane,
        sizeX: turned ? def.sizeY : def.sizeX,
        sizeY: turned ? def.sizeX : def.sizeY,
        height: Math.max(0, height - def.offsetHeight),
    };
}

let npcDefinitions = null;
let npcCatalog = null;

async function npcs() {
    const { renderer } = await state.ready;
    return (npcDefinitions ??= new NpcDefinitions(renderer.store));
}

async function catalogOfNpcs() {
    const definitions = await npcs();
    if (!npcCatalog) {
        npcCatalog = NpcCatalog.load(definitions);
        npcCatalog.catch(() => (npcCatalog = null));
    }
    return npcCatalog;
}

async function heatOfNpcs(spawns, range) {
    const { renderer } = await state.ready;
    return time("npcs: heat", () => npcHeat(renderer, spawns, range));
}

let catalog = null;

async function objectCatalog() {
    const { renderer } = await state.ready;
    return (catalog ??= time("objects: catalog", () => new ObjectCatalog(renderer.mapData)));
}

async function indexObjects(part, parts) {
    const { renderer, mapsTable } = await state.ready;
    return time("objects: index regions", () => indexRegions(renderer.store, mapsTable, part, parts));
}

async function findObjects(ids, regions) {
    const { renderer } = await state.ready;
    return time("objects: find in regions", () => findInRegions(renderer.store, renderer, ids, regions));
}

let runningTiles = 0;
let runningDetails = 0;

function run(msg, handler, onDone) {
    if (cancelled.delete(msg.id)) {
        postMessage({ id: msg.id, cancelled: true, final: true });
        onDone();
        return;
    }
    handler(msg)
        .catch((error) => {
            cancelled.delete(msg.id);
            if (error instanceof Cancelled) {
                postMessage({ id: msg.id, cancelled: true, final: true });
            } else {
                console.error(error);
                postMessage({ id: msg.id, error: String(error?.message ?? error), final: true });
            }
        })
        .finally(onDone);
}

function takeNext(list) {
    let best = 0;
    for (let i = 1; i < list.length; i++) {
        if (list[i].batch > list[best].batch) best = i;
    }
    return list.splice(best, 1)[0];
}

function pump() {
    // newest first: the tiles the user is looking at now matter more than ones queued earlier
    while (runningTiles < MAX_TILE_JOBS && queue.length > 0) {
        runningTiles++;
        run(takeNext(queue), handleTile, () => {
            runningTiles--;
            pump();
        });
    }
    while (runningDetails < MAX_DETAIL_JOBS && detailQueue.length > 0) {
        runningDetails++;
        run(takeNext(detailQueue), handleDetail, () => {
            runningDetails--;
            pump();
        });
    }
}

self.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
        case "init":
            init(msg.cacheId);
            state.ready.then(
                ({ renderer }) => {
                    postMessage({ type: "ready" });
                    // an icon's sprite is only known once its region has downloaded, which would
                    // make drawing it wait on a second download: have them all downloaded ahead
                    if (msg.preloadIcons) {
                        postMessage({ type: "preload", index: Index.SPRITES, groups: renderer.mapData.areaIconGroups() });
                    }
                },
                (error) => postMessage({ type: "failed", error: String(error?.message ?? error) })
            );
            break;
        case "fetched":
            source.onFetched(msg);
            break;
        case "tile":
            msg.received = performance.now();
            queue.push(msg);
            pump();
            break;
        case "cancel":
            cancelled.add(msg.id);
            break;
        case "objects":
            reply(msg, regionObjects(msg.x, msg.y));
            break;
        case "objectShape":
            reply(msg, objectShape(msg.id, msg.objectType, msg.orientation, msg.x, msg.y, msg.z));
            break;
        case "npcShape":
            reply(msg, npcs().then((definitions) => definitions.shape(msg.id)));
            break;
        case "npcNames":
            reply(msg, catalogOfNpcs().then((c) => c.names));
            break;
        case "npcSearch":
            reply(msg, catalogOfNpcs().then((c) => c.search(msg.names, msg.ids)));
            break;
        case "npcSpawns":
            reply(msg, catalogOfNpcs().then((c) => c.all()));
            break;
        case "npcHeat":
            reply(msg, heatOfNpcs(msg.spawns, msg.range));
            break;
        case "objectNames":
            reply(msg, objectCatalog().then((c) => c.names));
            break;
        case "objectIds":
            reply(msg, objectCatalog().then((c) => c.ids(msg.names, msg.ids)));
            break;
        case "objectConfig":
            reply(msg, objectCatalog().then((c) => c.config(msg.id)));
            break;
        case "indexObjects":
            reply(msg, indexObjects(msg.part, msg.parts));
            break;
        case "findObjects":
            reply(msg, findObjects(msg.ids, msg.regions));
            break;
        case "perf":
            postMessage({ type: "perf", req: msg.req, timings: snapshot() });
            break;
        case "perfReset":
            reset();
            break;
    }
};
