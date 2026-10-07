// Decoders for the definitions the map renderer needs. Ported from cache-reader/definitions/*.simba,
// keeping only the fields the map uses but reading every opcode so the stream stays aligned.

import { Reader } from "./io.js";
import { rgba, rgbToHsl } from "./colors.js";

export function decodeUnderlay(id, data) {
    const r = new Reader(data);
    let color = 0;
    for (let opcode = r.u8(); opcode !== 0; opcode = r.u8()) {
        if (opcode === 1) color = r.u24();
    }

    const hsl = rgbToHsl(color);
    let hueMultiplier = Math.trunc(hsl.l > 0.5 ? hsl.s * (1 - hsl.l) * 512 : hsl.s * hsl.l * 512);
    if (hueMultiplier < 1) hueMultiplier = 1;

    return {
        id,
        hue: Math.trunc(hueMultiplier * hsl.h),
        saturation: hsl.saturation,
        lightness: hsl.lightness,
        hueMultiplier,
    };
}

export function decodeOverlay(id, data) {
    const r = new Reader(data);
    const def = {
        id,
        rgbColor: 0,
        texture: -1,
        secondaryRgbColor: -1,
        hideUnderlay: true,
        hue: 0,
        saturation: 0,
        lightness: 0,
        otherHue: 0,
        otherSaturation: 0,
        otherLightness: 0,
        minimapColor: 0,
    };

    for (let opcode = r.u8(); opcode !== 0; opcode = r.u8()) {
        switch (opcode) {
            case 1:
                def.rgbColor = r.u24();
                break;
            case 2:
                def.texture = r.u8();
                break;
            case 5:
                def.hideUnderlay = false;
                break;
            case 7:
                def.secondaryRgbColor = r.u24();
                break;
        }
    }

    if (def.secondaryRgbColor !== -1) {
        const hsl = rgbToHsl(def.secondaryRgbColor);
        def.otherHue = Math.trunc(256 * hsl.h);
        def.otherSaturation = hsl.saturation;
        def.otherLightness = hsl.lightness;
    }

    const hsl = rgbToHsl(def.rgbColor);
    def.hue = Math.trunc(256 * hsl.h);
    def.saturation = hsl.saturation;
    def.lightness = hsl.lightness;

    return def;
}

// Only the average colour is wanted, which is what a textured ground overlay is drawn as.
// Build 233 replaced the multi-sprite texture format, and both put the average colour where
// this reads it from.
export function decodeTextureAverageColor(data, rev233 = true) {
    const r = new Reader(data);
    if (rev233) {
        r.u16(); // sprite id
    }
    return r.u16();
}

function readOps(r, ops, index) {
    const text = r.cstring();
    if (text.toLowerCase() !== "hidden") {
        ops[index] = text;
    }
}

function u16OrNone(r) {
    const v = r.u16();
    return v === 0xffff ? -1 : v;
}

function readPairs(r) {
    const len = r.u8();
    const find = [];
    const replace = [];
    for (let i = 0; i < len; i++) {
        find.push(r.u16());
        replace.push(r.u16());
    }
    return [find, replace];
}

// World objects. Ported from TObjectDefinition.Create in cache-reader/definitions/objects.simba.
export function decodeObject(id, data, revision) {
    const r = new Reader(data);
    const rev220SoundData = revision >= 1673;

    const def = {
        id,
        name: "null",
        sizeX: 1,
        sizeY: 1,
        interactType: 2,
        wallOrDoor: -1,
        mapSceneId: -1,
        mapAreaId: -1,
        hasModels: false,
        modelIds: [],
        modelTypes: null,
        modelSizeHeight: 128,
        offsetHeight: 0,
        openableDoor: false,
        interactable: false,
    };
    const ops = [];

    loop: for (;;) {
        const opcode = r.u8();
        switch (opcode) {
            case 0:
                break loop;
            case 1:
            case 6: {
                const len = r.u8();
                if (len <= 0) break;
                def.hasModels = true;
                def.modelIds = [];
                def.modelTypes = [];
                for (let i = 0; i < len; i++) {
                    def.modelIds.push(opcode === 1 ? r.u16() : r.i32());
                    def.modelTypes.push(r.u8());
                }
                break;
            }
            case 2:
                def.name = r.cstring();
                break;
            case 5:
            case 7: {
                const len = r.u8();
                if (len <= 0) break;
                def.hasModels = true;
                def.modelIds = [];
                def.modelTypes = null;
                for (let i = 0; i < len; i++) {
                    def.modelIds.push(opcode === 5 ? r.u16() : r.i32());
                }
                break;
            }
            case 14:
                def.sizeX = r.u8();
                break;
            case 15:
                def.sizeY = r.u8();
                break;
            case 17:
                def.interactType = 0;
                def.blocksProjectile = false;
                break;
            case 18:
                def.blocksProjectile = false;
                break;
            case 19:
                def.wallOrDoor = r.u8();
                break;
            case 21:
                def.contouredGround = 0;
                break;
            case 22:
                def.mergeNormals = true;
                break;
            case 23:
                def.modelClipped = true;
                break;
            case 24:
                def.animationId = u16OrNone(r);
                break;
            case 27:
                def.interactType = 1;
                break;
            case 28:
                def.decorDisplacement = r.u8();
                break;
            case 29:
                def.ambient = r.i8();
                break;
            case 39:
                def.contrast = r.i8() * 25;
                break;
            case 30:
            case 31:
            case 32:
            case 33:
            case 34:
                readOps(r, ops, opcode - 30);
                break;
            case 40:
                [def.recolorToFind, def.recolorToReplace] = readPairs(r);
                break;
            case 41:
                [def.retextureToFind, def.retextureToReplace] = readPairs(r);
                break;
            case 61:
                def.category = r.u16();
                break;
            case 62:
                def.rotated = true;
                break;
            case 64:
                def.shadow = false;
                break;
            case 65:
                def.modelSizeX = r.u16();
                break;
            case 66:
                def.modelSizeHeight = r.u16();
                break;
            case 67:
                def.modelSizeY = r.u16();
                break;
            case 68:
                def.mapSceneId = r.u16();
                break;
            case 69:
                def.blockingMask = r.u8();
                break;
            case 70:
                def.offsetX = r.i16();
                break;
            case 71:
                def.offsetHeight = r.i16();
                break;
            case 72:
                def.offsetY = r.i16();
                break;
            case 73:
                def.obstructsGround = true;
                break;
            case 74:
                def.hollow = true;
                break;
            case 75:
                def.supportsItems = r.u8();
                break;
            case 77:
            case 92: {
                def.varbitId = u16OrNone(r);
                def.varpId = u16OrNone(r);
                const last = opcode === 92 ? u16OrNone(r) : -1;
                const len = r.u8();
                def.morphs = [];
                for (let i = 0; i <= len; i++) def.morphs.push(u16OrNone(r));
                def.morphs.push(last);
                break;
            }
            case 78:
                def.ambientSoundId = r.u16();
                def.ambientSoundDistance = r.u8();
                if (rev220SoundData) def.ambientSoundRetain = r.u8();
                break;
            case 79: {
                def.ambientSoundChangeTicksMin = r.u16();
                def.ambientSoundChangeTicksMax = r.u16();
                def.ambientSoundDistance = r.u8();
                if (rev220SoundData) def.ambientSoundRetain = r.u8();
                const len = r.u8();
                def.ambientSoundIds = [];
                for (let i = 0; i < len; i++) def.ambientSoundIds.push(r.u16());
                break;
            }
            case 81:
                def.contouredGround = r.u8() * 256;
                break;
            case 82:
                def.mapAreaId = r.u16();
                break;
            case 89:
                def.randomizeAnimStart = true;
                break;
            case 90:
                def.deferAnimChange = true;
                break;
            case 91:
                def.soundDistanceFadeCurve = r.u8();
                break;
            case 93:
                def.soundFadeInCurve = r.u8();
                def.soundFadeInDuration = r.u16();
                def.soundFadeOutCurve = r.u8();
                def.soundFadeOutDuration = r.u16();
                break;
            case 94:
                def.opcode94 = true;
                break;
            case 95:
                def.soundVisibility = r.u8();
                break;
            case 96:
                def.opcode96 = r.u8();
                break;
            case 100:
                (def.subOps ??= []).push([r.u8(), r.u8(), r.cstring()]);
                break;
            case 101:
                (def.conditionalOps ??= []).push([r.u8(), r.u16(), r.u16(), r.i32(), r.i32(), r.cstring()]);
                break;
            case 102:
                (def.conditionalSubOps ??= []).push([r.u8(), r.u16(), r.u16(), r.u16(), r.i32(), r.i32(), r.cstring()]);
                break;
            case 249: {
                const len = r.u8();
                def.params = {};
                for (let i = 0; i < len; i++) {
                    const isString = r.u8() === 1;
                    const key = r.u24();
                    def.params[key] = isString ? r.cstring() : r.i32();
                }
                break;
            }
            default:
                console.warn(`Unrecognized object opcode ${opcode} for object ${id}, parsing stopped there.`);
                break loop;
        }
    }

    if (ops.length > 0) {
        def.actions = Array.from({ length: 5 }, (_, i) => ops[i] ?? null);
    }

    if (def.wallOrDoor === -1) {
        def.wallOrDoor = 0;
        if (def.hasModels && (def.modelTypes === null || def.modelTypes[0] === 10)) def.wallOrDoor = 1;
        if (ops.some((op) => op !== undefined)) def.wallOrDoor = 1;
    }

    if (def.wallOrDoor !== 0 && !def.name.includes("urtain")) {
        def.openableDoor = ops.includes("Close");
    }

    def.interactable = def.name !== "null" && def.name !== "" && ops.some((op) => op !== undefined && op !== "None" && op.trim() !== "");

    return def;
}

export function decodeNpc(id, data, revision) {
    const r = new Reader(data);
    const rev210HeadIcons = revision >= 1493;

    const def = {
        id,
        name: "null",
        size: 1,
        models: [],
        heightScale: 128,
        combatLevel: -1,
        minimapVisible: true,
        interactable: true,
        morphs: [],
    };
    const ops = [];

    const readIds = (read) => {
        const len = r.u8();
        const ids = [];
        for (let i = 0; i < len; i++) ids.push(read());
        return ids;
    };

    loop: for (;;) {
        const opcode = r.u8();
        switch (opcode) {
            case 0:
                break loop;
            case 1:
                def.models = readIds(() => r.u16());
                break;
            case 2:
                def.name = r.cstring();
                break;
            case 12:
                def.size = r.u8();
                break;
            case 13:
            case 14:
            case 15:
            case 16:
            case 18:
            case 42:
            case 97:
            case 103:
            case 114:
            case 116:
            case 124:
            case 126:
            case 146:
                r.u16();
                break;
            case 17:
            case 115:
            case 117:
                r.offset += 8;
                break;
            case 30:
            case 31:
            case 32:
            case 33:
            case 34:
                readOps(r, ops, opcode - 30);
                break;
            case 40:
            case 41: {
                const len = r.u8();
                r.offset += len * 4;
                break;
            }
            case 60:
                readIds(() => r.u16());
                break;
            case 61:
                def.models = readIds(() => r.i32());
                break;
            case 62:
                readIds(() => r.i32());
                break;
            case 74:
            case 75:
            case 76:
            case 77:
            case 78:
            case 79:
                r.u16();
                break;
            case 93:
                def.minimapVisible = false;
                break;
            case 95:
                def.combatLevel = r.u16();
                break;
            case 98:
                def.heightScale = r.u16();
                break;
            case 99:
            case 109:
            case 111:
            case 122:
            case 123:
            case 129:
            case 130:
            case 145:
            case 147:
                break;
            case 100:
            case 101:
                r.u8();
                break;
            case 102: {
                if (!rev210HeadIcons) {
                    r.u16();
                    break;
                }
                const bitfield = r.u8();
                for (let i = 0; bitfield >> i !== 0; i++) {
                    if (bitfield & (1 << i)) {
                        r.bigSmart2();
                        r.uShortSmart();
                    }
                }
                break;
            }
            case 106:
            case 118: {
                r.u16();
                r.u16();
                const last = opcode === 118 ? r.u16() : 0xffff;
                const len = r.u8();
                def.morphs = [];
                for (let i = 0; i <= len; i++) {
                    const v = r.u16();
                    def.morphs.push(v === 0xffff ? -1 : v);
                }
                def.morphs.push(last === 0xffff ? -1 : last);
                break;
            }
            case 107:
                def.interactable = false;
                break;
            case 249: {
                const len = r.u8();
                for (let i = 0; i < len; i++) {
                    const isString = r.u8() === 1;
                    r.u24();
                    isString ? r.cstring() : r.i32();
                }
                break;
            }
            case 251:
                r.u8();
                r.u8();
                r.cstring();
                break;
            case 252:
                r.u8();
                r.u16();
                r.u16();
                r.i32();
                r.i32();
                r.cstring();
                break;
            case 253:
                r.u8();
                r.u16();
                r.u16();
                r.u16();
                r.i32();
                r.i32();
                r.cstring();
                break;
            default:
                console.warn(`Unrecognized NPC opcode ${opcode} for NPC ${id}, parsing stopped there.`);
                break loop;
        }
    }

    def.actions = ops.filter((op) => op !== undefined);
    return def;
}

// Map areas: only the icon sprite is wanted. Ported from TAreaDefinition.Create in
// cache-reader/definitions/area.simba.
export function decodeAreaSpriteId(data) {
    const r = new Reader(data);
    let spriteId = -1;

    for (;;) {
        const opcode = r.u8();
        switch (opcode) {
            case 0:
                return spriteId;
            case 1:
                spriteId = r.bigSmart2();
                break;
            case 2:
            case 18:
            case 25:
                r.bigSmart2();
                break;
            case 3:
            case 10:
            case 11:
            case 12:
            case 13:
            case 14:
            case 17:
                r.cstring();
                break;
            case 4:
            case 5:
                r.u24();
                break;
            case 6:
            case 7:
            case 8:
            case 28:
            case 29:
            case 30:
                r.u8();
                break;
            case 15: {
                const count = r.u8();
                r.offset += count * 4;
                r.i32();
                const colors = r.u8();
                r.offset += colors * 4 + count;
                break;
            }
            case 16:
                break;
            case 19:
                r.u16();
                break;
            case 21:
            case 22:
                r.i32();
                break;
            case 23:
                r.offset += 3;
                break;
            case 24:
                r.offset += 4;
                break;
            default:
                // the Simba decoder skips unknown opcodes without reading anything, so does this
                break;
        }
    }
}

// A sprite group decodes to several frames sharing a palette. Pixels are 0xAABBGGRR.
// Ported from TSpriteDefinition.Create in cache-reader/definitions/sprites.simba.
export function decodeSprites(data) {
    const r = new Reader(data);

    r.offset = data.length - 2;
    const count = r.u16();

    r.offset = data.length - 7 - count * 8;
    const maxWidth = r.u16();
    const maxHeight = r.u16();
    const paletteLength = r.u8() + 1;

    const frames = [];
    for (let i = 0; i < count; i++) {
        frames.push({ frame: i, maxWidth, maxHeight, offsetX: 0, offsetY: 0, width: 0, height: 0, pixels: null });
    }
    for (const f of frames) f.offsetX = r.u16();
    for (const f of frames) f.offsetY = r.u16();
    for (const f of frames) f.width = r.u16();
    for (const f of frames) f.height = r.u16();

    r.offset = data.length - 7 - count * 8 - (paletteLength - 1) * 3;
    const palette = new Int32Array(paletteLength);
    for (let i = 1; i < paletteLength; i++) {
        palette[i] = rgba(r.u24() || 1);
    }

    r.offset = 0;
    for (const f of frames) {
        const w = f.width, h = f.height, size = w * h;
        const flags = r.u8();
        const vertical = (flags & 1) !== 0;
        const hasAlpha = (flags & 2) !== 0;

        const readPlane = () => {
            const plane = new Uint8Array(size);
            if (!vertical) {
                plane.set(data.subarray(r.offset, r.offset + size));
                r.offset += size;
            } else {
                for (let x = 0; x < w; x++) {
                    for (let y = 0; y < h; y++) {
                        plane[w * y + x] = data[r.offset++];
                    }
                }
            }
            return plane;
        };

        const indices = readPlane();
        const alphas = hasAlpha ? readPlane() : null;

        f.pixels = new Int32Array(size);
        for (let i = 0; i < size; i++) {
            const index = indices[i];
            if (index !== 0) {
                f.pixels[i] = 0xff000000 | palette[index];
            } else if (alphas) {
                f.pixels[i] = alphas[i] << 24;
            }
        }
    }

    return frames;
}
