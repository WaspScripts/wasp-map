// Renders regions straight from the cache: map images, collision maps and height maps, 4 pixels
// per tile.
// Ported from cache-reader/loaders/map/mapchunk.simba and regionloader.simba.
//
// Pixel buffers are Int32Array of 0xAABBGGRR, row-major, north at the top.

import { Index } from "./store.js";
import { Region, REGION_SIZE, PLANES, tileIndex } from "./region.js";
import {
    WALL_COLOR,
    DOOR_COLOR,
    COLLISION_COLOR,
    COLLISION_WALL_COLOR,
    COLLISION_DOOR_COLOR,
    COLLISION_WALKABLE_COLOR,
    HEIGHT_COLORS,
    MAX_HEIGHT,
} from "./colors.js";
import { time } from "./perf.js";

export const SCALE = 4;
export const IMAGE_SIZE = REGION_SIZE * SCALE;
const BLEND = 5;
const COLLISION_SOURCES = [
    [-1, -1],
    [-1, 0],
    [0, -1],
    [0, 1],
    [0, 0],
];

const TILE_SHAPE_2D = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1],
    [1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1],
    [1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1],
];

const TILE_ROTATION_2D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [12, 8, 4, 0, 13, 9, 5, 1, 14, 10, 6, 2, 15, 11, 7, 3],
    [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    [3, 7, 11, 15, 2, 6, 10, 14, 1, 5, 9, 13, 0, 4, 8, 12],
];

// every rotation of every shape up front: Masks[shape * 4 + rotation] is 1 where the overlay is drawn
const TILE_MASKS = [];
for (let shape = 0; shape < TILE_SHAPE_2D.length; shape++) {
    for (let rotation = 0; rotation < 4; rotation++) {
        const mask = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            mask[i] = TILE_SHAPE_2D[shape][TILE_ROTATION_2D[rotation][i]];
        }
        TILE_MASKS.push(mask);
    }
}

// Wraps a coordinate that ran off the edge of a region back into that neighbour. Matches the
// client's conversion, including where it lands for negative values.
function convertLocal(d) {
    if (d >= 0) return d % 64;
    return 63 + (d % 64);
}

function regionId(x, y) {
    return (x << 8) | y;
}

class LruCache {
    constructor(max) {
        this.max = max;
        this.map = new Map();
    }

    get(key) {
        const value = this.map.get(key);
        if (value !== undefined) {
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.max) {
            this.map.delete(this.map.keys().next().value);
        }
    }
}

export class MapRenderer {
    constructor(store, mapData, mapsTable, { maxRegions = 384, maxPlaneSets = 48, maxGroundPlanes = 256 } = {}) {
        this.store = store;
        this.mapData = mapData;
        this.mapsTable = mapsTable;

        // loading promises, so a region asked for twice is only fetched once. Enough for a few
        // tiles' regions and neighbours each, plus the next tile's, which are loaded ahead.
        this.regions = new LruCache(maxRegions);
        // per region: rendered planes and the per plane tile composition codes, kept together so
        // codes never outlive the planes they point at
        this.planeSets = new LruCache(maxPlaneSets);
        this.groundPlanes = new LruCache(maxGroundPlanes);
        this.icons = new WeakMap();
    }

    groundColors() {
        if (!this._groundColors) {
            const { underlays, overlays } = this.mapData;
            const count = underlays.length;
            const colors = {
                count,
                hue: new Int32Array(count),
                saturation: new Int32Array(count),
                lightness: new Int32Array(count),
                multiplier: new Int32Array(count),
                overlayColors: new Int32Array(overlays.length),
            };
            for (let i = 0; i < count; i++) {
                const underlay = underlays[i];
                if (!underlay) continue;
                colors.hue[i] = underlay.hue;
                colors.saturation[i] = underlay.saturation;
                colors.lightness[i] = underlay.lightness;
                colors.multiplier[i] = underlay.hueMultiplier;
            }
            for (let i = 0; i < overlays.length; i++) {
                colors.overlayColors[i] = overlays[i]?.minimapColor ?? 0;
            }
            this._groundColors = colors;
        }
        return this._groundColors;
    }

    hasRegion(x, y) {
        return x >= 0 && x < 256 && y >= 0 && y < 256 && this.mapsTable.group(regionId(x, y)) !== undefined;
    }

    loadRegion(x, y) {
        if (!this.hasRegion(x, y)) {
            return Promise.resolve(null);
        }
        const id = regionId(x, y);
        let region = this.regions.get(id);
        if (!region) {
            region = this.store.files(Index.MAPS, id).then((files) => {
                const terrain = files?.get(0);
                if (!terrain) return null;
                try {
                    return time("region: parse", () => new Region(x, y, terrain, files.get(1)));
                } catch (error) {
                    // the maps index holds a few groups that are not regions at all
                    console.warn(error.message);
                    return null;
                }
            });
            region.catch(() => this.regions.map.delete(id));
            this.regions.set(id, region);
        }
        return region;
    }

    loadedRegion(x, y) {
        return this.regions.map.get(regionId(x, y));
    }

    // The region and its four neighbours, which ground blending reaches into. Resolves to a
    // lookup from region id to Region for whichever of them exist.
    async loadNeighbourhood(x, y) {
        const coords = [
            [x, y],
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
        ];
        const regions = await Promise.all(coords.map(([cx, cy]) => this.loadRegion(cx, cy)));
        const lookup = new Map();
        for (const region of regions) {
            if (region) lookup.set(regionId(region.x, region.y), region);
        }
        return lookup;
    }

    // Renders one region on plane z. Resolves to null if there is no such region.
    // With detail off only the ground is drawn - no walls, map scenes or icons - which is all that
    // shows once a tile is a pixel or less.
    async renderMap(x, y, z, detail = true) {
        const lookup = await time("render: wait for regions", () => this.loadNeighbourhood(x, y));
        const region = lookup.get(regionId(x, y));
        if (!region) return null;

        // ground-only renders are for building zoomed out tiles, where each region is drawn once,
        // so they are not cached and do not push out the planes zoomed in views keep reusing
        const id = regionId(x, y);
        let planeSet = detail ? this.planeSets.get(id) : undefined;
        if (!planeSet) {
            planeSet = { planes: new Array(PLANES).fill(null), codes: new Array(PLANES).fill(null) };
            if (detail) this.planeSets.set(id, planeSet);
        }

        let tileCodes = planeSet.codes[z];
        if (!tileCodes) {
            const needed = [false, false, false, false];
            tileCodes = time("render: classify tiles", () => this.classifyTiles(region, z, needed));
            const planeName = detail ? "render: plane" : "render: plane, ground only";
            for (let i = 0; i < PLANES; i++) {
                if (needed[i] && !planeSet.planes[i]) {
                    planeSet.planes[i] = time(planeName, () => this.buildRegionPlane(region, i, this.groundPlane(region, i, lookup), detail));
                }
            }
            planeSet.codes[z] = tileCodes;
        }

        const pixels = time("render: composite planes", () => compositePlanes(planeSet.planes, tileCodes));

        if (detail) {
            // the neighbours' icons too, so one straddling a region edge is not cut in half
            await time("render: map icons", () => this.drawMapIcons(pixels, lookup, x, y, z));
        }

        return pixels;
    }

    // The ground of one region on plane z a pixel per game tile, REGION_SIZE square: the same as
    // renderMap with detail off shrunk SCALE times, without drawing it full size first. Resolves
    // to null if there is no such region.
    async renderGround(x, y, z) {
        const lookup = await time("render: wait for regions", () => this.loadNeighbourhood(x, y));
        const region = lookup.get(regionId(x, y));
        if (!region) return null;

        const needed = [false, false, false, false];
        const tileCodes = time("render: classify tiles", () => this.classifyTiles(region, z, needed));
        const planes = new Array(PLANES).fill(null);
        for (let i = 0; i < PLANES; i++) {
            if (needed[i]) planes[i] = this.groundPlane(region, i, lookup);
        }
        return time("render: composite planes, ground 1px", () => compositeGround(planes, tileCodes));
    }

    // Each tile composites up to 3 planes, topmost first: the low nibble of its code is how
    // many and each nibble above holds one plane index.
    classifyTiles(region, z, needed) {
        const settings = region.settings;
        const tileCodes = new Int32Array(REGION_SIZE * REGION_SIZE);

        for (let x = 0; x < REGION_SIZE; x++) {
            for (let y = 0; y < REGION_SIZE; y++) {
                const invertedY = REGION_SIZE - y - 1;

                const isBridge = (settings[tileIndex(1, x, invertedY)] & 2) !== 0 ? 1 : 0;
                const tileZ = z + isBridge;
                if (tileZ >= PLANES) continue;

                let code = 0;
                let n = 0;

                if ((settings[tileIndex(z, x, invertedY)] & 24) === 0) {
                    // a bridge tile keeps plane 0 underneath it, which stays nibble 0 of the code
                    if (z === 0 && isBridge === 1) {
                        needed[0] = true;
                        n++;
                    }
                    code |= tileZ << (4 + 4 * n);
                    needed[tileZ] = true;
                    n++;
                }

                if (tileZ < PLANES - 1 && z + 1 < PLANES && (settings[tileIndex(z + 1, x, invertedY)] & 8) !== 0) {
                    code |= (tileZ + 1) << (4 + 4 * n);
                    needed[tileZ + 1] = true;
                    n++;
                }

                tileCodes[y * REGION_SIZE + x] = code | n;
            }
        }

        return tileCodes;
    }

    // Ground colours of one plane, then walls, doors and map scenes.
    buildRegionPlane(region, z, ground, detail = true) {
        const pixels = new Int32Array(IMAGE_SIZE * IMAGE_SIZE);
        const { colors, overlays, masks } = ground;

        for (let ty = 0; ty < REGION_SIZE; ty++) {
            const rowStart = ty * SCALE * IMAGE_SIZE;
            let masked = false;
            for (let t = ty * REGION_SIZE, i = rowStart; t < (ty + 1) * REGION_SIZE; t++) {
                const color = colors[t];
                for (const end = i + SCALE; i < end; i++) pixels[i] = color;
                if (masks[t] >= 0) masked = true;
            }
            for (let row = 1; row < SCALE; row++) {
                pixels.copyWithin(rowStart + row * IMAGE_SIZE, rowStart, rowStart + IMAGE_SIZE);
            }
            if (!masked) continue;

            for (let t = ty * REGION_SIZE; t < (ty + 1) * REGION_SIZE; t++) {
                if (masks[t] < 0) continue;
                const mask = TILE_MASKS[masks[t]];
                const color = colors[t];
                const overlay = overlays[t];
                const start = rowStart + (t & (REGION_SIZE - 1)) * SCALE;
                let m = 0;
                for (let row = start; row < start + SCALE * IMAGE_SIZE; row += IMAGE_SIZE) {
                    for (let i = row; i < row + SCALE; i++, m++) {
                        pixels[i] = mask[m] !== 0 ? overlay : color;
                    }
                }
            }
        }

        if (detail) {
            region.forEachLocation((id, type, orientation, locZ, localX, localY) => {
                if (locZ === z) this.drawObject(pixels, id, type, orientation, localX, localY);
            });
        }

        return pixels;
    }

    // One plane's ground a value per game tile, indexed row * REGION_SIZE + x with north at the
    // top: `colors` holds the tile's colour, or its underlay colour where an overlay covers part
    // of it, `overlays` that overlay's colour and `masks` its TILE_MASKS index, -1 for none.
    groundPlane(region, z, lookup) {
        const key = (regionId(region.x, region.y) << 2) | z;
        let ground = this.groundPlanes.get(key);
        if (!ground) {
            ground = time("render: blend ground", () => this.blendGround(region, z, lookup));
            this.groundPlanes.set(key, ground);
        }
        return ground;
    }

    blendGround(region, z, lookup) {
        const colors = new Int32Array(REGION_SIZE * REGION_SIZE);
        const overlays = new Int32Array(REGION_SIZE * REGION_SIZE);
        const masks = new Int8Array(REGION_SIZE * REGION_SIZE).fill(-1);

        const minimapPalette = this.mapData.colors.minimap;
        const { hue: uHue, saturation: uSat, lightness: uLight, multiplier: uMul, count: underlayCount, overlayColors } = this.groundColors();

        const has = (x, y) => lookup.has(regionId(x, y));
        const columns = [-1, 0, 1].map((dx) => [-1, 0, 1].map((dy) => lookup.get(regionId(region.x + dx, region.y + dy)) ?? null));

        const span = REGION_SIZE + BLEND * 2;
        const hues = new Int32Array(span);
        const sats = new Int32Array(span);
        const light = new Int32Array(span);
        const mul = new Int32Array(span);
        const num = new Int32Array(span);
        const localYs = new Int32Array(span);
        const rowBuckets = new Int32Array(span);

        const x1 = has(region.x - 1, region.y) ? -BLEND : 0;
        const x2 = has(region.x + 1, region.y) ? REGION_SIZE + BLEND - 1 : REGION_SIZE - 1;
        const y1 = has(region.x, region.y - 1) ? -BLEND : 0;
        const y2 = has(region.x, region.y + 1) ? REGION_SIZE + BLEND - 1 : REGION_SIZE - 1;

        // which of the three region rows a blend row falls in, and where in it
        for (let y = y1; y <= y2; y++) {
            const idx = y + BLEND;
            localYs[idx] = convertLocal(y);
            rowBuckets[idx] = y < 0 ? 0 : y >= REGION_SIZE ? 2 : 1;
        }

        const planeBase = z << 12;

        for (let x = x1 - BLEND; x <= x2 + BLEND; x++) {
            for (let dir = 1; dir >= -1; dir -= 2) {
                const neighbor = x + BLEND * dir;
                if (neighbor < x1 || neighbor > x2) continue;

                const localX = convertLocal(neighbor);
                const rowRegions = columns[neighbor < 0 ? 0 : neighbor >= REGION_SIZE ? 2 : 1];
                const columnBase = planeBase | (localX << 6);

                for (let y = y1; y <= y2; y++) {
                    const idx = y + BLEND;
                    const rowRegion = rowRegions[rowBuckets[idx]];
                    if (rowRegion === null) continue;

                    const u = (rowRegion.underlayIds[columnBase | localYs[idx]] & 0x7fff) - 1;
                    if (u < 0 || u >= underlayCount || uMul[u] === 0) continue;

                    hues[idx] += dir * uHue[u];
                    sats[idx] += dir * uSat[u];
                    light[idx] += dir * uLight[u];
                    mul[idx] += dir * uMul[u];
                    num[idx] += dir;
                }
            }

            if (x < 0 || x >= REGION_SIZE) continue;

            let runHue = 0, runSat = 0, runLight = 0, runMul = 0, runNum = 0;

            const columnBase = planeBase | (x << 6);

            for (let y = y1 - BLEND; y <= y2 + BLEND; y++) {
                let neighbor = y + BLEND;
                if (neighbor <= y2) {
                    const idx = neighbor + BLEND;
                    runHue += hues[idx];
                    runSat += sats[idx];
                    runLight += light[idx];
                    runMul += mul[idx];
                    runNum += num[idx];
                }

                neighbor = y - BLEND;
                if (neighbor >= y1) {
                    const idx = neighbor + BLEND;
                    runHue -= hues[idx];
                    runSat -= sats[idx];
                    runLight -= light[idx];
                    runMul -= mul[idx];
                    runNum -= num[idx];
                }

                if (y < 0 || y >= REGION_SIZE) continue;

                const tile = columnBase | y;
                const underlayId = region.underlayIds[tile] & 0x7fff;
                const overlayId = region.overlayIds[tile] & 0x7fff;
                if (underlayId <= 0 && overlayId <= 0) continue;

                let underlayColor = 0;
                if (underlayId > 0 && runMul !== 0 && runNum !== 0) {
                    const hue = Math.trunc((runHue * 256) / runMul);
                    let saturation = Math.trunc(runSat / runNum);
                    let luminance = Math.trunc(runLight / runNum);
                    if (luminance < 0) luminance = 0;
                    else if (luminance > 255) luminance = 255;

                    if (luminance > 179) saturation >>= 1;
                    if (luminance > 192) saturation >>= 1;
                    if (luminance > 217) saturation >>= 1;
                    if (luminance > 243) saturation >>= 1;

                    underlayColor = minimapPalette[((saturation >> 5) << 7) + ((hue >> 2) << 10) + (luminance >> 1)] | 0xff000000;
                }

                const t = (REGION_SIZE - 1 - y) * REGION_SIZE + x;
                if (overlayId === 0) {
                    colors[t] = underlayColor;
                    continue;
                }
                const overlayColor = overlayId <= overlayColors.length ? overlayColors[overlayId - 1] : 0;
                const path = region.overlayPaths[tile];
                if (path === 0) {
                    colors[t] = overlayColor;
                } else {
                    colors[t] = underlayColor;
                    overlays[t] = overlayColor;
                    masks[t] = (path + 1) * 4 + region.overlayRotations[tile];
                }
            }
        }

        return { colors, overlays, masks };
    }

    // Walls and doors as lines on the tile edges they occupy, and map scene symbols in place of
    // the objects that have one.
    drawObject(pixels, id, type, orientation, x, y) {
        // 0..3 walls/doors, 9 diagonal walls, 10..11 and 22 can carry map scenes
        if (type > 3 && !(type >= 9 && type <= 11) && type !== 22) return;

        const obj = this.mapData.object(id);
        if (!obj) return;

        const px = x * SCALE;
        const py = (REGION_SIZE - obj.sizeY - y) * SCALE;

        if (obj.mapSceneId > -1) {
            this.blitMapScene(pixels, px, py, obj);
            return;
        }

        if (type > 9) return;

        const color = obj.wallOrDoor !== 0 ? DOOR_COLOR : WALL_COLOR;
        const last = SCALE - 1;
        const set = (dx, dy) => {
            const sx = px + dx, sy = py + dy;
            if (sx >= 0 && sx < IMAGE_SIZE && sy >= 0 && sy < IMAGE_SIZE) pixels[sy * IMAGE_SIZE + sx] = color;
        };

        switch (type) {
            case 0:
                for (let i = 0; i < SCALE; i++) {
                    if (orientation === 0) set(0, i);
                    else if (orientation === 1) set(i, 0);
                    else if (orientation === 2) set(last, i);
                    else set(i, last);
                }
                break;
            case 2:
                // corner walls occupy two edges
                for (let i = 0; i < SCALE; i++) {
                    if (orientation === 0) {
                        set(0, i);
                        set(i, 0);
                    } else if (orientation === 1) {
                        set(i, 0);
                        set(last, i);
                    } else if (orientation === 2) {
                        set(last, i);
                        set(i, last);
                    } else {
                        set(i, last);
                        set(0, i);
                    }
                }
                break;
            case 3:
                if (orientation === 0) set(0, 0);
                else if (orientation === 1) set(last, 0);
                else if (orientation === 2) set(last, last);
                else set(0, last);
                break;
            case 9:
                for (let i = 0; i < SCALE; i++) {
                    if (orientation !== 0 && orientation !== 2) set(i, i);
                    else set(i, last - i);
                }
                break;
        }
    }

    blitMapScene(pixels, x, y, obj) {
        const sprite = this.mapData.mapScenes[obj.mapSceneId];
        if (!sprite || sprite.width <= 0 || sprite.height <= 0) return;

        const drawX = x + ((obj.sizeX * SCALE - sprite.width) >> 1) + sprite.offsetX;
        const drawY = y + ((obj.sizeY * SCALE - sprite.height) >> 1) + sprite.offsetY;

        const sx1 = Math.max(0, -drawX);
        const sy1 = Math.max(0, -drawY);
        const sx2 = Math.min(sprite.width, IMAGE_SIZE - drawX) - 1;
        const sy2 = Math.min(sprite.height, IMAGE_SIZE - drawY) - 1;

        for (let sy = sy1; sy <= sy2; sy++) {
            const src = sy * sprite.width;
            const dst = (drawY + sy) * IMAGE_SIZE + drawX;
            for (let sx = sx1; sx <= sx2; sx++) {
                const color = sprite.pixels[src + sx];
                if (color !== 0) pixels[dst + sx] = color;
            }
        }
    }

    // The area icons (banks, altars, shops...) a region shows on plane z, as [areaId, x, y].
    mapIcons(region, z) {
        let planes = this.icons.get(region);
        if (!planes) {
            planes = new Array(PLANES).fill(null);
            this.icons.set(region, planes);
        }
        if (planes[z]) return planes[z];

        const icons = [];
        const mapData = this.mapData;

        region.forEachLocation((id, type, orientation, locZ, x, y) => {
            const isBridge = (region.settings[tileIndex(1, x, y)] & 2) !== 0 ? 1 : 0;
            if (locZ !== z + isBridge) return;
            const obj = mapData.object(id);
            if (!obj || obj.mapAreaId < 0) return;
            icons.push([obj.mapAreaId, x, y]);
        });

        return (planes[z] = icons);
    }

    // Starts loading the icon sprites region x, y shows on plane z once it is loaded, so drawing
    // it does not wait on their downloads one at a time.
    prefetchIcons(x, y, z) {
        this.loadRegion(x, y)
            .then((region) => {
                if (!region) return;
                for (const [areaId] of this.mapIcons(region, z)) {
                    this.mapData.areaIcon(areaId).catch(() => {});
                }
            })
            .catch(() => {});
    }

    // The area icons of region x, y and its neighbours, alpha blended over its finished image and
    // clipped to it - the neighbours' too, so one straddling a region edge is not cut in half.
    // Every sprite is loaded before any is drawn, all at once.
    async drawMapIcons(pixels, lookup, x, y, z) {
        const placed = [];
        for (const region of lookup.values()) {
            const offsetX = (region.x - x) * IMAGE_SIZE;
            const offsetY = (y - region.y) * IMAGE_SIZE;
            for (const [areaId, ix, iy] of this.mapIcons(region, z)) {
                placed.push([areaId, offsetX + 2 + ix * SCALE, offsetY + 2 + (REGION_SIZE - 1 - iy) * SCALE]);
            }
        }

        const sprites = await Promise.all(placed.map(([areaId]) => this.mapData.areaIcon(areaId)));

        for (let i = 0; i < placed.length; i++) {
            const sprite = sprites[i];
            if (!sprite) continue;
            const [, px, py] = placed[i];
            blendSprite(pixels, sprite, px - (sprite.maxWidth >> 1) + sprite.offsetX, py - (sprite.maxHeight >> 1) + sprite.offsetY);
        }
    }

    // One region's collision on plane z: blocked terrain, walls, doors and the footprints of the
    // objects standing on it, including the parts of its neighbours' objects that reach into it.
    async renderCollision(x, y, z) {
        const regions = await time("render: wait for regions", () =>
            Promise.all(COLLISION_SOURCES.map(([dx, dy]) => this.loadRegion(x + dx, y + dy)))
        );
        if (!regions[regions.length - 1]) return null;
        return time("render: collision", () => this.drawCollision(regions, z));
    }

    drawCollision(regions, z) {
        const region = regions[regions.length - 1];
        const pixels = new Int32Array(IMAGE_SIZE * IMAGE_SIZE).fill(COLLISION_WALKABLE_COLOR);
        const settings = region.settings;

        for (let ty = 0; ty < REGION_SIZE; ty++) {
            const invertedY = REGION_SIZE - ty - 1;
            for (let tx = 0; tx < REGION_SIZE; tx++) {
                // a bridge tile is walked on at plane 1, so on the ground plane its settings count
                let setting = settings[tileIndex(z, tx, invertedY)];
                if ((setting & 24) === 0 && z === 0 && (settings[tileIndex(1, tx, invertedY)] & 2) !== 0) {
                    setting = settings[tileIndex(1, tx, invertedY)];
                }
                if ((setting & 1) !== 0) fillSquare(pixels, ty * SCALE * IMAGE_SIZE + tx * SCALE, COLLISION_WALL_COLOR);
            }
        }

        for (const source of regions) {
            if (source) this.drawCollisionObjects(pixels, source, z, source.baseX - region.baseX, source.baseY - region.baseY);
        }

        return pixels;
    }

    drawCollisionObjects(pixels, region, z, offsetX, offsetY) {
        const settings = region.settings;
        region.forEachLocation((id, type, orientation, locZ, localX, localY) => {
            const tile = tileIndex(z, localX, localY);
            if (z === 0) {
                if ((settings[tile] & 24) !== 0) return;
                const tileZ = (settings[tileIndex(1, localX, localY)] & 2) !== 0 ? 1 : 0;
                if (locZ !== tileZ) return;
            } else {
                if (locZ !== z) return;
                if ((settings[tile] & 24) !== 0) return;
            }
            this.drawCollisionObject(pixels, id, type, orientation, localX + offsetX, localY + offsetY);
        });
    }

    async renderHeight(x, y, z, size = SCALE) {
        const region = await time("render: wait for regions", () => this.loadRegion(x, y));
        if (!region) return null;
        return time("render: height", () => drawHeight(region, z, size));
    }

    drawCollisionObject(pixels, id, type, orientation, x, y) {
        if (type >= 4 && type <= 8) return;

        const obj = this.mapData.object(id);
        if (!obj || obj.interactType === 0) return;
        if (type === 22 && obj.interactType !== 1) return;

        const drawX = x * SCALE;
        const drawY = (REGION_SIZE - obj.sizeY - y) * SCALE;

        const color = obj.wallOrDoor !== 0 ? COLLISION_DOOR_COLOR : COLLISION_WALL_COLOR;

        if (type <= 3) {
            if (id === 24720) return;
            switch (type) {
                case 0:
                    drawCollisionWall(pixels, drawX, drawY, orientation, color, obj.openableDoor);
                    break;
                case 2:
                    drawCollisionWall(pixels, drawX, drawY, orientation, color, obj.openableDoor);
                    // corner walls occupy two edges, so the wall itself is drawn plus the edge next to it
                    drawCollisionEdge(pixels, drawX, drawY, (orientation + 1) & 3, color);
                    break;
                case 3: {
                    const last = SCALE - 1;
                    const corner = [
                        [0, 0],
                        [last, 0],
                        [last, last],
                        [0, last],
                    ][orientation];
                    plot(pixels, drawX + corner[0], drawY + corner[1], color);
                    break;
                }
            }
            return;
        }

        if (type === 9) {
            for (let i = 0; i < SCALE; i++) {
                const dy = orientation !== 0 && orientation !== 2 ? i : SCALE - 1 - i;
                plot(pixels, drawX + i, drawY + dy, color);
            }
            return;
        }

        // types 10..22: objects block their whole footprint, rotated with them
        const turned = orientation === 1 || orientation === 3;
        const width = (turned ? obj.sizeY : obj.sizeX) * SCALE;
        const height = (turned ? obj.sizeX : obj.sizeY) * SCALE;
        const top = (REGION_SIZE - y) * SCALE - height;

        const x0 = Math.max(0, drawX);
        const x1 = Math.min(IMAGE_SIZE, drawX + width);
        const y1 = Math.min(IMAGE_SIZE, top + height);
        for (let py = Math.max(0, top); py < y1; py++) {
            for (let i = py * IMAGE_SIZE + x0, end = py * IMAGE_SIZE + x1; i < end; i++) {
                if (pixels[i] !== COLLISION_WALL_COLOR) pixels[i] = COLLISION_COLOR;
            }
        }
    }
}

function drawHeight(region, z, size) {
    const heights = region.heights();
    const settings = region.settings;
    const width = REGION_SIZE * size;
    const pixels = new Int32Array(width * width);

    for (let ty = 0; ty < REGION_SIZE; ty++) {
        const start = (REGION_SIZE - 1 - ty) * size * width;
        for (let tx = 0, px = start; tx < REGION_SIZE; tx++) {
            let i = tileIndex(z, tx, ty);
            if (z < 3 && (settings[tileIndex(1, tx, ty)] & 2) !== 0) i += 4096;
            const height = -heights[i];
            const color = HEIGHT_COLORS[height <= 0 ? 0 : height >= MAX_HEIGHT ? MAX_HEIGHT : height];
            for (const end = px + size; px < end; px++) pixels[px] = color;
        }
        for (let row = 1; row < size; row++) {
            pixels.copyWithin(start + row * width, start, start + width);
        }
    }
    return pixels;
}

function plot(pixels, x, y, color) {
    if (x >= 0 && x < IMAGE_SIZE && y >= 0 && y < IMAGE_SIZE) pixels[y * IMAGE_SIZE + x] = color;
}

function fillSquare(pixels, start, color) {
    for (let row = start; row < start + SCALE * IMAGE_SIZE; row += IMAGE_SIZE) {
        for (let i = row; i < row + SCALE; i++) pixels[i] = color;
    }
}

// Draws one edge of a tile: 0 left, 1 top, 2 right, 3 bottom, the order wall orientations use.
function drawCollisionEdge(pixels, drawX, drawY, edge, color) {
    const last = SCALE - 1;
    for (let i = 0; i < SCALE; i++) {
        switch (edge) {
            case 0:
                plot(pixels, drawX, drawY + i, color);
                break;
            case 1:
                plot(pixels, drawX + i, drawY, color);
                break;
            case 2:
                plot(pixels, drawX + last, drawY + i, color);
                break;
            case 3:
                plot(pixels, drawX + i, drawY + last, color);
                break;
        }
    }
}

// A door blocks the tile it swings into, so it is drawn one edge further round, and a
// south-facing one lands on the row below.
function drawCollisionWall(pixels, drawX, drawY, orientation, color, isDoor) {
    if (!isDoor) {
        drawCollisionEdge(pixels, drawX, drawY, orientation, color);
        return;
    }
    if (orientation === 2) {
        for (let i = 0; i < SCALE; i++) {
            plot(pixels, drawX + i, drawY + SCALE, color);
        }
        return;
    }
    drawCollisionEdge(pixels, drawX, drawY, (orientation + 1) & 3, color);
}

// Flattens the planes a region uses into pixels following the per tile plan in tileCodes: the
// topmost plane is copied and the ones below only fill in what it left clear.
function compositePlanes(planes, tileCodes) {
    const pixels = new Int32Array(IMAGE_SIZE * IMAGE_SIZE);
    for (let ty = 0; ty < REGION_SIZE; ty++) {
        const codesStart = ty * REGION_SIZE;
        const rowStart = ty * SCALE * IMAGE_SIZE;

        for (let tx = 0; tx < REGION_SIZE; ) {
            const code = tileCodes[codesStart + tx];
            const n = code & 0xf;

            if (n <= 1) {
                let end = tx + 1;
                while (end < REGION_SIZE && tileCodes[codesStart + end] === code) end++;
                const from = rowStart + tx * SCALE;
                const to = rowStart + end * SCALE;
                tx = end;

                if (n === 0) {
                    for (let row = 0; row < SCALE * IMAGE_SIZE; row += IMAGE_SIZE) {
                        pixels.fill(0xff000000 | 0, from + row, to + row);
                    }
                    continue;
                }
                const top = planes[(code >> 4) & 0xf];
                for (let row = 0; row < SCALE * IMAGE_SIZE; row += IMAGE_SIZE) {
                    for (let i = from + row; i < to + row; i++) pixels[i] = top[i] | 0xff000000;
                }
                continue;
            }

            const top = planes[(code >> (4 * n)) & 0xf];
            const start = rowStart + tx * SCALE;
            for (let row = start; row < start + SCALE * IMAGE_SIZE; row += IMAGE_SIZE) {
                for (let i = row; i < row + SCALE; i++) {
                    let color = top[i];
                    for (let k = n - 2; color === 0 && k >= 0; k--) {
                        color = planes[(code >> (4 + 4 * k)) & 0xf][i];
                    }
                    pixels[i] = color | 0xff000000;
                }
            }
            tx++;
        }
    }
    return pixels;
}

// Flattens ground planes from groundPlane a pixel per tile, following tileCodes like
// compositePlanes. Each pixel is the average of the SCALE x SCALE block compositePlanes would draw
// there, with nothing drawn counting as black, so it matches a full size render box filtered down.
function compositeGround(planes, tileCodes) {
    const pixels = new Int32Array(REGION_SIZE * REGION_SIZE);
    const subpixels = SCALE * SCALE;

    for (let t = 0; t < pixels.length; t++) {
        const code = tileCodes[t];
        let k = (code & 0xf) - 1;

        // planes of one colour across the tile: the topmost one with something drawn wins
        let color = 0;
        for (; k >= 0; k--) {
            const plane = planes[(code >> (4 + 4 * k)) & 0xf];
            if (plane.masks[t] >= 0) break;
            color = plane.colors[t];
            if (color !== 0) break;
        }
        if (k < 0 || color !== 0) {
            pixels[t] = color | 0xff000000;
            continue;
        }

        // an overlay covers part of plane k: each subpixel takes the topmost colour from k down
        let r = 0, g = 0, b = 0;
        for (let s = 0; s < subpixels; s++) {
            let c = 0;
            for (let j = k; j >= 0 && c === 0; j--) {
                const plane = planes[(code >> (4 + 4 * j)) & 0xf];
                const mask = plane.masks[t];
                c = mask >= 0 && TILE_MASKS[mask][s] !== 0 ? plane.overlays[t] : plane.colors[t];
            }
            r += (c >> 16) & 0xff;
            g += (c >> 8) & 0xff;
            b += c & 0xff;
        }
        pixels[t] = 0xff000000 | (((r / subpixels) & 0xff) << 16) | (((g / subpixels) & 0xff) << 8) | ((b / subpixels) & 0xff);
    }

    return pixels;
}

function blendSprite(pixels, sprite, drawX, drawY) {
    for (let sy = 0; sy < sprite.height; sy++) {
        const py = drawY + sy;
        if (py < 0 || py >= IMAGE_SIZE) continue;
        for (let sx = 0; sx < sprite.width; sx++) {
            const px = drawX + sx;
            if (px < 0 || px >= IMAGE_SIZE) continue;

            const src = sprite.pixels[sy * sprite.width + sx];
            const a = (src >>> 24) & 0xff;
            if (a === 0) continue;

            const i = py * IMAGE_SIZE + px;
            if (a === 255) {
                pixels[i] = src;
                continue;
            }

            const dst = pixels[i];
            const inv = 255 - a;
            const r = (((src >> 16) & 0xff) * a + ((dst >> 16) & 0xff) * inv) / 255;
            const g = (((src >> 8) & 0xff) * a + ((dst >> 8) & 0xff) * inv) / 255;
            const b = ((src & 0xff) * a + (dst & 0xff) * inv) / 255;
            pixels[i] = 0xff000000 | (r << 16) | (g << 8) | b;
        }
    }
}
