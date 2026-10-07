// Everything the renderer needs before it can draw a region: ground colours, object definitions,
// map scene sprites and area icons. Ported from cache-reader/loaders/map/mapdata.simba.

import { ConfigGroup, Index } from "./store.js";
import { decodeAreaSpriteId, decodeObject, decodeOverlay, decodeSprites, decodeTextureAverageColor, decodeUnderlay } from "./definitions.js";
import { Palette, packHsl } from "./colors.js";

async function decodeConfigGroup(store, group, decode) {
    const files = await store.files(Index.CONFIGS, group);
    const defs = [];
    for (const [id, data] of files) {
        defs[id] = decode(id, data);
    }
    return defs;
}

export class MapData {
    static async load(store, brightness) {
        const mapData = new MapData(store, brightness);
        await mapData._load();
        return mapData;
    }

    constructor(store, brightness) {
        this.store = store;
        this.colors = new Palette(brightness);
        this.areaIcons = new Map();
    }

    async _load() {
        const configs = await this.store.referenceTable(Index.CONFIGS);
        this.objRevision = configs.group(ConfigGroup.OBJ).revision;

        const [underlays, overlays, objectFiles, areaSprites, textureColors, mapScenes] = await Promise.all([
            decodeConfigGroup(this.store, ConfigGroup.UNDERLAY, decodeUnderlay),
            decodeConfigGroup(this.store, ConfigGroup.OVERLAY, decodeOverlay),
            this.store.groupFiles(Index.CONFIGS, ConfigGroup.OBJ),
            decodeConfigGroup(this.store, ConfigGroup.AREA, (id, data) => decodeAreaSpriteId(data)),
            this._loadTextureColors(),
            this._loadMapScenes(),
        ]);

        this.underlays = underlays;
        this.overlays = overlays;
        this.objectFiles = objectFiles;
        this.objects = [];
        this.areaSprites = areaSprites;
        this.textureColors = textureColors;
        this.mapScenes = mapScenes;

        this.buildOverlayColors();
    }

    object(id) {
        let def = this.objects[id];
        if (def === undefined) {
            const data = this.objectFiles?.get(id);
            def = this.objects[id] = data ? decodeObject(id, data, this.objRevision) : null;
        }
        return def;
    }

    async _loadTextureColors() {
        const files = await this.store.files(Index.TEXTURES, 0);
        const colors = [];
        for (const [id, data] of files) {
            colors[id] = decodeTextureAverageColor(data);
        }
        return colors;
    }

    async _loadMapScenes() {
        const sprites = await this.store.referenceTable(Index.SPRITES);
        const group = sprites.groupIdByName("mapscene");
        const frames = await this.loadSprites(group);

        // made opaque, with fully transparent pixels flattened to 0 so drawing one is a copy
        for (const frame of frames) {
            const pixels = frame.pixels;
            for (let i = 0; i < pixels.length; i++) {
                const rgb = pixels[i] & 0xffffff;
                pixels[i] = rgb === 0 ? 0 : 0xff000000 | rgb;
            }
        }
        return frames;
    }

    async loadSprites(group) {
        if (group < 0) return [];
        const data = await this.store.groupData(Index.SPRITES, group);
        return data && data.length > 0 ? decodeSprites(data) : [];
    }

    // The colour each overlay is drawn as on the map: its secondary colour, its texture's average
    // colour, or its own colour, in that order.
    buildOverlayColors() {
        for (const overlay of this.overlays) {
            if (!overlay) continue;
            overlay.minimapColor = 0;

            if (overlay.secondaryRgbColor !== -1) {
                overlay.minimapColor = this.colors.overlayColor(packHsl(overlay.otherHue, overlay.otherSaturation, overlay.otherLightness)) | 0xff000000;
            } else if (overlay.texture >= 0) {
                const average = this.textureColors[overlay.texture];
                if (average !== undefined) {
                    overlay.minimapColor = this.colors.overlayColor(average) | 0xff000000;
                }
            } else if (overlay.rgbColor !== 0xff00ff) {
                overlay.minimapColor = this.colors.overlayColor(packHsl(overlay.hue, overlay.saturation, overlay.lightness)) | 0xff000000;
            }
        }
    }

    // Every sprite group an area icon is drawn from.
    areaIconGroups() {
        return [...new Set(this.areaSprites.filter((spriteId) => spriteId >= 0))];
    }

    // The icon sprite of an area, loaded on first use. Resolves to null if it has none.
    areaIcon(areaId) {
        let icon = this.areaIcons.get(areaId);
        if (icon === undefined) {
            const spriteId = this.areaSprites[areaId] ?? -1;
            icon = this.loadSprites(spriteId).then((frames) => {
                const frame = frames[0];
                return frame && frame.width > 0 && frame.height > 0 ? frame : null;
            });
            this.areaIcons.set(areaId, icon);
        }
        return icon;
    }
}
