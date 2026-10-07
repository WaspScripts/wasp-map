// The game's colour model: 16 bit packed hue/saturation/luminance indices into a palette.
// Ported from cache-reader/utils/color.simba. Colours are 0xAABBGGRR throughout.

export function rgba(rgb) {
    return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

export const WALL_COLOR = 0xff000000 | rgba(0xeeeeee);
export const DOOR_COLOR = 0xff000000 | rgba(0xee0000);

export const COLLISION_COLOR = 0xff000000 | rgba(0x333333);
export const COLLISION_WALL_COLOR = 0xff000000 | rgba(0x000000);
export const COLLISION_DOOR_COLOR = 0xff000000 | rgba(0xff0000);
export const COLLISION_WALKABLE_COLOR = 0xff000000 | rgba(0xffffff);

export const MAX_HEIGHT = 6048;

function roundHalfEven(v) {
    const floor = Math.floor(v);
    const fraction = v - floor;
    if (fraction !== 0.5) return fraction < 0.5 ? floor : floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
}

export const HEIGHT_COLORS = new Int32Array(MAX_HEIGHT + 1);
for (let i = 0; i <= MAX_HEIGHT; i++) {
    const v = Math.min(255, Math.max(0, roundHalfEven((i / MAX_HEIGHT) * 255)));
    HEIGHT_COLORS[i] = 0xff000000 | (v << 16) | (v << 8) | v;
}

export const BRIGHTNESS_MAX = 0.5;

const TARGET_LUM = 96;

export function packHsl(hue, saturation, luminance) {
    if (luminance > 179) saturation >>= 1;
    if (luminance > 192) saturation >>= 1;
    if (luminance > 217) saturation >>= 1;
    if (luminance > 243) saturation >>= 1;
    return ((saturation >> 5) << 7) + ((hue >> 2) << 10) + (luminance >> 1);
}

function createHsvPalette(brightness) {
    const palette = new Int32Array(65536);

    const gamma = new Int32Array(257);
    for (let i = 0; i <= 256; i++) {
        gamma[i] = Math.trunc(Math.pow(i / 256, brightness) * 256);
    }

    for (let i = 0; i < 65536; i++) {
        const hue = ((i >> 10) & 0x3f) / 64 + 0.0078125;
        const sat = ((i >> 7) & 0x7) / 8 + 0.0625;
        const lum = (i & 0x7f) / 128;

        let r = lum, g = lum, b = lum;

        if (sat !== 0) {
            const q = lum < 0.5 ? (sat + 1) * lum : lum + sat - sat * lum;
            const p = lum * 2 - q;

            let t1 = hue + 1 / 3;
            if (t1 > 1) t1 -= 1;
            let t2 = hue - 1 / 3;
            if (t2 < 0) t2 += 1;

            if (hue * 6 < 1) g = p + hue * 6 * (q - p);
            else if (hue * 2 < 1) g = q;
            else if (hue * 3 < 2) g = (q - p) * (0.6666666666666666 - hue) * 6 + p;
            else g = p;

            if (t1 * 6 < 1) r = t1 * 6 * (q - p) + p;
            else if (t1 * 2 < 1) r = q;
            else if (t1 * 3 < 2) r = p + (q - p) * 6 * (0.6666666666666666 - t1);
            else r = p;

            if (t2 * 6 < 1) b = p + (q - p) * 6 * t2;
            else if (t2 * 2 < 1) b = q;
            else if (t2 * 3 < 2) b = (0.6666666666666666 - t2) * (q - p) * 6 + p;
            else b = p;
        }

        const rIdx = gamma[Math.trunc(r * 256)];
        const gIdx = gamma[Math.trunc(g * 256)];
        let bIdx = gamma[Math.trunc(b * 256)];
        if ((rIdx | gIdx | bIdx) === 0) bIdx = 1;

        palette[i] = 0xff000000 | (bIdx << 16) | (gIdx << 8) | rIdx;
    }

    return palette;
}

export class Palette {
    constructor(brightness = BRIGHTNESS_MAX) {
        this.palette = createHsvPalette(brightness);

        // the same lookup with the flatter minimap lighting folded in
        this.minimap = new Int32Array(65536);
        for (let i = 0; i < 65536; i++) {
            const lum = Math.min(126, Math.max(2, ((i & 127) * TARGET_LUM) >> 7));
            this.minimap[i] = this.palette[(i & 65408) + lum];
        }
    }

    overlayColor(hsl) {
        if (hsl === -2) return rgba(12345678);
        if (hsl === -1) return this.palette[TARGET_LUM];
        return this.minimap[hsl];
    }
}

// Splits a 0xRRGGBB colour into HSL, both as 0..1 doubles and as the 0..255 integers the
// cache packs. Ported from TColor.ToHSLEx in cache-reader/utils/helpers.simba.
export function rgbToHsl(rgb) {
    const r = ((rgb >> 16) & 0xff) / 256;
    const g = ((rgb >> 8) & 0xff) / 256;
    const b = (rgb & 0xff) / 256;

    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);

    let h = 0, s = 0;
    const l = (mn + mx) * 0.5;

    const delta = mx - mn;
    if (delta !== 0) {
        s = l < 0.5 ? delta / (mx + mn) : delta / (2 - mx - mn);
        if (r === mx) h = (g - b) / delta;
        else if (g === mx) h = 2 + (b - r) / delta;
        else h = 4 + (r - g) / delta;
    }

    h /= 6;
    if (h < 0) h += 1;

    return {
        h,
        s,
        l,
        saturation: Math.min(255, Math.max(0, Math.trunc(s * 256))),
        lightness: Math.min(255, Math.max(0, Math.trunc(l * 256))),
    };
}
