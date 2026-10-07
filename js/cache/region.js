// One 64 by 64 tile region: its terrain flags and ground types per plane, and the objects on it.
// Ported from cache-reader/definitions/map.simba, locations.simba and loaders/map/region.simba.
//
// Tile arrays are flat and indexed z * 4096 + x * 64 + y, matching the Simba [z, x, y] layout.

import { Reader } from "./io.js";
import { calculateArea } from "./heightcalc.js";

export const REGION_SIZE = 64;
export const PLANES = 4;
const TILES = PLANES * REGION_SIZE * REGION_SIZE;

export function tileIndex(z, x, y) {
    return (z << 12) | (x << 6) | y;
}

export class Region {
    constructor(regionX, regionY, terrain, locations) {
        this.x = regionX;
        this.y = regionY;
        this.baseX = regionX << 6;
        this.baseY = regionY << 6;

        this.settings = new Uint8Array(TILES);
        this.overlayIds = new Uint16Array(TILES);
        this.overlayPaths = new Uint8Array(TILES);
        this.overlayRotations = new Uint8Array(TILES);
        this.underlayIds = new Uint16Array(TILES);
        this.storedHeights = new Int16Array(TILES).fill(-1);
        this._heights = null;

        this.decodeTerrain(terrain);
        this.decodeLocations(locations);
    }

    // Each tile is a run of attributes ending at 0, or at 1 followed by the tile's height.
    // Attributes 2..49 carry the overlay with its shape and rotation, 50..81 the settings flags,
    // and anything above is the underlay.
    decodeTerrain(data) {
        const r = new Reader(data);
        for (let i = 0; i < TILES; i++) {
            for (;;) {
                if (r.remaining < 2) {
                    throw new Error(`Region ${this.x},${this.y}: terrain data ends early`);
                }
                const attribute = r.u16();
                if (attribute === 0) {
                    break;
                }
                if (attribute === 1) {
                    this.storedHeights[i] = r.u8();
                    break;
                }
                if (attribute <= 49) {
                    this.overlayIds[i] = r.i16() & 0x7fff;
                    this.overlayPaths[i] = (attribute - 2) >> 2;
                    this.overlayRotations[i] = (attribute - 2) & 3;
                } else if (attribute <= 81) {
                    this.settings[i] = attribute - 49;
                } else {
                    this.underlayIds[i] = (attribute - 81) & 0x7fff;
                }
            }
        }
    }

    heights() {
        if (this._heights) return this._heights;
        const heights = new Int32Array(TILES);
        let procedural = null;
        for (let i = 0; i < TILES; i++) {
            const z = i >> 12;
            let height = this.storedHeights[i];
            if (height === -1) {
                if (z === 0) {
                    procedural ??= calculateArea(this.baseX + 0xe3b7b, this.baseY + 0x87cce, REGION_SIZE);
                    height = procedural[i];
                } else {
                    height = 30;
                }
            } else if (height === 1) {
                height = 0;
            }
            heights[i] = z === 0 ? -height * 8 : heights[i - 4096] - height * 8;
        }
        return (this._heights = heights);
    }

    decodeLocations(data) {
        const { ids, packed } = decodeLocations(data, this.x, this.y);
        this.locIds = ids;
        this.locPacked = packed;
    }

    // Calls fn(id, type, orientation, z, localX, localY) for every placed object.
    forEachLocation(fn) {
        const ids = this.locIds, packed = this.locPacked;
        for (let i = 0; i < ids.length; i++) {
            const p = packed[i];
            fn(ids[i], p >> 16, (p >> 14) & 3, (p >> 12) & 3, (p >> 6) & 0x3f, p & 0x3f);
        }
    }
}

export function gamePlane(region, z, x, y) {
    return z > 0 && region.settings[tileIndex(1, x, y)] & 2 ? z - 1 : z;
}

export function drawnPlane(region, z, x, y) {
    return region.settings[tileIndex(z, x, y)] & 8 ? 0 : gamePlane(region, z, x, y);
}

// Placements are stored as deltas; each one packs local x and y, the plane, the shape (loc
// type) and the orientation.
export function decodeLocations(data, regionX, regionY) {
    if (!data) return { ids: new Int32Array(0), packed: new Int32Array(0) };

    let ids = new Int32Array(1024);
    let packed = new Int32Array(1024);
    let count = 0;
    const r = new Reader(data);
    let id = -1;
    // a read past the end would come back as a non-zero delta forever, so every read checks
    const check = () => {
        if (r.remaining <= 0) throw new Error(`Region ${regionX},${regionY}: location data ends early`);
    };

    for (;;) {
        check();
        const idOffset = r.uIntSmartShortCompat();
        if (idOffset === 0) break;
        id += idOffset;

        let position = 0;
        for (;;) {
            check();
            const posOffset = r.uShortSmart();
            if (posOffset === 0) break;
            position += posOffset - 1;

            check();
            const attributes = r.u8();

            if (count === ids.length) {
                const grownIds = new Int32Array(count * 2);
                const grownPacked = new Int32Array(count * 2);
                grownIds.set(ids);
                grownPacked.set(packed);
                ids = grownIds;
                packed = grownPacked;
            }
            ids[count] = id;
            packed[count] = ((attributes >> 2) << 16) | ((attributes & 3) << 14) | (position & 0x3fff);
            count++;
        }
    }

    return { ids: ids.slice(0, count), packed: packed.slice(0, count) };
}
