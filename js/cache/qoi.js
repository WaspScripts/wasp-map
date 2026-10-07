import { gunzip } from "./inflate.js";

const OP_INDEX = 0x00;
const OP_DIFF = 0x40;
const OP_LUMA = 0x80;
const OP_RUN = 0xc0;
const OP_RGB = 0xfe;
const OP_RGBA = 0xff;
const MAGIC = 0x716f6966;
const HEADER_SIZE = 14;
const END_SIZE = 8;

function hash(c) {
    return ((c & 0xff) * 3 + ((c >>> 8) & 0xff) * 5 + ((c >>> 16) & 0xff) * 7 + (c >>> 24) * 11) & 63;
}

export function qoiEncode(pixels, width, height) {
    const px = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
    const out = new Uint8Array(HEADER_SIZE + px.length * 5 + END_SIZE);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC);
    view.setUint32(4, width);
    view.setUint32(8, height);
    out[12] = 4;
    out[13] = 0;

    const index = new Uint32Array(64);
    let p = HEADER_SIZE;
    let prev = 0xff000000;
    let run = 0;
    for (let i = 0; i < px.length; i++) {
        const c = px[i];
        if (c === prev) {
            if (++run === 62) {
                out[p++] = OP_RUN | (run - 1);
                run = 0;
            }
            continue;
        }
        if (run > 0) {
            out[p++] = OP_RUN | (run - 1);
            run = 0;
        }

        const h = hash(c);
        if (index[h] === c) {
            out[p++] = OP_INDEX | h;
        } else {
            index[h] = c;
            const r = c & 0xff, g = (c >>> 8) & 0xff, b = (c >>> 16) & 0xff, a = c >>> 24;
            if (a === prev >>> 24) {
                const vr = ((r - (prev & 0xff)) << 24) >> 24;
                const vg = ((g - ((prev >>> 8) & 0xff)) << 24) >> 24;
                const vb = ((b - ((prev >>> 16) & 0xff)) << 24) >> 24;
                const vgr = vr - vg, vgb = vb - vg;
                if (vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1) {
                    out[p++] = OP_DIFF | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
                } else if (vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7) {
                    out[p++] = OP_LUMA | (vg + 32);
                    out[p++] = ((vgr + 8) << 4) | (vgb + 8);
                } else {
                    out[p++] = OP_RGB;
                    out[p++] = r;
                    out[p++] = g;
                    out[p++] = b;
                }
            } else {
                out[p++] = OP_RGBA;
                out[p++] = r;
                out[p++] = g;
                out[p++] = b;
                out[p++] = a;
            }
        }
        prev = c;
    }
    if (run > 0) out[p++] = OP_RUN | (run - 1);
    p += END_SIZE - 1;
    out[p++] = 1;
    return out.subarray(0, p);
}

export function qoiDecode(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < HEADER_SIZE + END_SIZE || view.getUint32(0) !== MAGIC) {
        throw new Error("Not a QOI image");
    }
    const px = new Uint32Array(view.getUint32(4) * view.getUint32(8));
    const end = data.length - END_SIZE;

    const index = new Uint32Array(64);
    let c = 0xff000000;
    let p = HEADER_SIZE;
    for (let i = 0; i < px.length; ) {
        if (p >= end) throw new Error("QOI image ends early");
        const b1 = data[p++];
        if (b1 === OP_RGB) {
            c = ((c & 0xff000000) | data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) >>> 0;
            p += 3;
        } else if (b1 === OP_RGBA) {
            c = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
            p += 4;
        } else {
            const op = b1 & 0xc0;
            if (op === OP_INDEX) {
                px[i++] = c = index[b1];
                continue;
            }
            if (op === OP_RUN) {
                const stop = Math.min(px.length, i + (b1 & 0x3f) + 1);
                px.fill(c, i, stop);
                i = stop;
                continue;
            }
            let r = c & 0xff, g = (c >>> 8) & 0xff, b = (c >>> 16) & 0xff;
            if (op === OP_DIFF) {
                r += ((b1 >> 4) & 3) - 2;
                g += ((b1 >> 2) & 3) - 2;
                b += (b1 & 3) - 2;
            } else {
                const b2 = data[p++];
                const vg = (b1 & 0x3f) - 32;
                r += vg - 8 + (b2 >> 4);
                g += vg;
                b += vg - 8 + (b2 & 0x0f);
            }
            c = ((c & 0xff000000) | (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16)) >>> 0;
        }
        index[hash(c)] = c;
        px[i++] = c;
    }
    return px;
}

export function encodeTile(pixels, size) {
    const qoi = qoiEncode(pixels, size, size);
    return new Response(new Blob([qoi]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

export async function decodeTile(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(bytes.length - 4, true);
    return qoiDecode(gunzip(bytes, length));
}
