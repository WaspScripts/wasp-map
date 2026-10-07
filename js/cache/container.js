// JS5 containers: a compression byte, the compressed length, the decompressed length when
// compressed, then the payload. Ported from cache-reader/reader/archive/archive_sector.simba.

import { bunzip2 } from "./bzip2.js";
import { gunzip } from "./inflate.js";

const NONE = 0;
const BZIP2 = 1;
const GZIP = 2;

export function decodeContainer(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compression = view.getUint8(0);
    const length = view.getInt32(1);

    if (compression === NONE) {
        return bytes.slice(5, 5 + length);
    }

    const decompressedLength = view.getInt32(5);
    const payload = bytes.subarray(9, 9 + length);

    let data;
    switch (compression) {
        case BZIP2:
            data = bunzip2(payload, decompressedLength);
            break;
        case GZIP:
            data = gunzip(payload, decompressedLength);
            break;
        default:
            throw new Error(`Unsupported container compression ${compression}`);
    }

    if (data.length !== decompressedLength) {
        throw new Error("Decompressed expected length and actual length don't match.");
    }
    return data;
}
