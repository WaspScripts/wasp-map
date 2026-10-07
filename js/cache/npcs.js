import { ConfigGroup, Index } from "./store.js";
import { decodeNpc } from "./definitions.js";
import { modelHeight } from "./model.js";
import { COLLISION_WALKABLE_COLOR } from "./colors.js";
import { cleanName } from "./objectsearch.js";

export const NPC_SPAWNS_URL = "https://db.waspscripts.com/storage/v1/object/public/assets/files/npcspawns.txt";

const REGION_PIXELS = 256;
const TILE_PIXELS = 4;

export class NpcDefinitions {
    constructor(store) {
        this.store = store;
        this.decoded = new Map();
        this.ready = Promise.all([store.referenceTable(Index.CONFIGS), store.groupFiles(Index.CONFIGS, ConfigGroup.NPC)]).then(([table, files]) => {
            this.revision = table.group(ConfigGroup.NPC).revision;
            this.files = files;
        });
    }

    get(id) {
        let def = this.decoded.get(id);
        if (def === undefined) {
            const data = this.files?.get(id);
            def = data ? decodeNpc(id, data, this.revision) : null;
            this.decoded.set(id, def);
        }
        return def;
    }

    resolve(id) {
        const def = this.get(id);
        if (!def) return null;
        for (const child of def.morphs) {
            const form = child >= 0 ? this.get(child) : null;
            if (form && form.name !== "null" && form.name !== "") return form;
        }
        return def;
    }

    async shape(id) {
        await this.ready;
        const def = this.resolve(id);
        if (!def) return null;

        let height = 0;
        for (const modelId of def.models) {
            const data = await this.store.groupData(Index.MODELS, modelId);
            if (!data) {
                height = 0;
                break;
            }
            height = Math.max(height, modelHeight(data, def.heightScale));
        }

        return { form: def.id, size: def.size, height, minimapDot: def.minimapVisible };
    }
}

export class NpcCatalog {
    static async load(definitions) {
        const [text] = await Promise.all([
            fetch(NPC_SPAWNS_URL).then((response) => {
                if (!response.ok) throw new Error(`NPC spawns returned ${response.status}`);
                return response.text();
            }),
            definitions.ready,
        ]);
        return new NpcCatalog(definitions, text);
    }

    constructor(definitions, text) {
        this.info = new Map();
        const spawns = [];
        const names = new Set();

        for (const line of text.split("\n")) {
            const parts = line.trim().split(" ");
            if (parts.length !== 4) continue;
            const [id, plane, x, y] = parts.map(Number);

            let info = this.info.get(id);
            if (info === undefined) {
                info = this.describe(definitions, id);
                this.info.set(id, info);
                if (info) names.add(info.name);
            }
            if (info) spawns.push(id, plane, x, y);
        }

        this.spawns = Int32Array.from(spawns);
        this.names = [...names].sort(new Intl.Collator(undefined, { sensitivity: "base" }).compare);
    }

    describe(definitions, id) {
        const def = definitions.get(id);
        if (!def) return null;
        const shown = definitions.resolve(id);
        const name = cleanName(shown.name);
        if (name === "null" || name === "") return null;
        return {
            name,
            form: shown.id,
            combatLevel: Math.max(0, shown.combatLevel),
            actions: shown.actions,
            size: shown.size,
            minimapDot: shown.minimapVisible,
            morphs: def.morphs.filter((morph) => morph >= 0),
        };
    }

    search(names, ids) {
        const wantedNames = new Set(names.map((name) => name.trim().toLowerCase()));
        const wantedIds = new Set(ids);
        const matching = new Set();
        for (const [id, info] of this.info) {
            if (!info) continue;
            if (
                wantedNames.has(info.name.toLowerCase()) ||
                wantedIds.has(id) ||
                wantedIds.has(info.form) ||
                info.morphs.some((morph) => wantedIds.has(morph))
            ) {
                matching.add(id);
            }
        }

        const found = [];
        for (let k = 0; k < this.spawns.length; k += 4) {
            if (matching.has(this.spawns[k])) found.push(this.spawns[k], this.spawns[k + 1], this.spawns[k + 2], this.spawns[k + 3]);
        }
        return this.package(Int32Array.from(found));
    }

    all() {
        return this.package(this.spawns);
    }

    package(spawns) {
        const info = {};
        for (let k = 0; k < spawns.length; k += 4) {
            const id = spawns[k];
            if (id in info) continue;
            const { morphs, ...shown } = this.info.get(id);
            info[id] = shown;
        }
        return { spawns, info };
    }
}

export async function npcHeat(renderer, spawns, range) {
    const grids = new Map();
    const heat = new Map();
    const size = 2 * range + 1;
    const seen = new Uint8Array(size * size);
    const queue = new Int32Array(size * size);

    const grid = (plane, i, j) => grids.get((plane << 16) | (i << 8) | j);

    const loadGrids = (plane, x, y) => {
        const loads = [];
        for (let i = (x - range) >> 6; i <= (x + range) >> 6; i++) {
            for (let j = (y - range) >> 6; j <= (y + range) >> 6; j++) {
                const key = (plane << 16) | (i << 8) | j;
                if (grids.has(key) || i < 0 || j < 0 || i > 255 || j > 255) continue;
                grids.set(key, null);
                loads.push(
                    renderer.renderCollision(i, j, plane).then(
                        (pixels) => grids.set(key, pixels),
                        () => {}
                    )
                );
            }
        }
        return Promise.all(loads);
    };

    const tile = (plane, x, y) => {
        const pixels = x >= 0 && y >= 0 ? grid(plane, x >> 6, y >> 6) : null;
        if (!pixels) return null;
        return { pixels, at: (63 - (y & 63)) * TILE_PIXELS * REGION_PIXELS + (x & 63) * TILE_PIXELS };
    };

    const open = (t, col, row) => t.pixels[t.at + row * REGION_PIXELS + col] === COLLISION_WALKABLE_COLOR;
    const edgeOpen = (t, side) => {
        switch (side) {
            case 0:
                return open(t, 0, 1) && open(t, 0, 2);
            case 1:
                return open(t, 1, 0) && open(t, 2, 0);
            case 2:
                return open(t, 3, 1) && open(t, 3, 2);
            default:
                return open(t, 1, 3) && open(t, 2, 3);
        }
    };

    const steps = [
        [-1, 0, 0, 2],
        [0, 1, 1, 3],
        [1, 0, 2, 0],
        [0, -1, 3, 1],
    ];

    for (let k = 0; k < spawns.length; k += 4) {
        const plane = spawns[k + 1];
        const x = spawns[k + 2];
        const y = spawns[k + 3];
        await loadGrids(plane, x, y);

        seen.fill(0);
        let head = 0;
        let tail = 0;
        const start = range * size + range;
        seen[start] = 1;
        queue[tail++] = start;

        while (head < tail) {
            const index = queue[head++];
            const lx = index % size;
            const ly = (index - lx) / size;
            const gx = x - range + lx;
            const gy = y - range + ly;

            const key = (plane << 16) | ((gx >> 6) << 8) | (gy >> 6);
            let counts = heat.get(key);
            if (!counts) heat.set(key, (counts = new Int32Array(4096)));
            counts[((gx & 63) << 6) | (gy & 63)]++;

            const from = tile(plane, gx, gy);
            if (!from) continue;
            for (const [dx, dy, out, into] of steps) {
                const nx = lx + dx;
                const ny = ly + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                const next = ny * size + nx;
                if (seen[next]) continue;
                const to = tile(plane, gx + dx, gy + dy);
                if (!to || !open(to, 1, 1) || !edgeOpen(from, out) || !edgeOpen(to, into)) continue;
                seen[next] = 1;
                queue[tail++] = next;
            }
        }
    }

    const result = {};
    for (const [key, counts] of heat) {
        result[`${key >> 16}_${(key >> 8) & 0xff}_${key & 0xff}`] = counts;
    }
    return result;
}
