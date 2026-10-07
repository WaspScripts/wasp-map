// Big-endian byte reader for cache data. Ported from cache-reader/utils/helpers.simba.

export class Reader {
    constructor(bytes, offset = 0) {
        this.bytes = bytes;
        this.offset = offset;
    }

    get remaining() {
        return this.bytes.length - this.offset;
    }

    u8() {
        return this.bytes[this.offset++];
    }

    i8() {
        const v = this.bytes[this.offset++];
        return v > 127 ? v - 256 : v;
    }

    u16() {
        const b = this.bytes, o = this.offset;
        this.offset += 2;
        return (b[o] << 8) | b[o + 1];
    }

    i16() {
        const v = this.u16();
        return v > 32767 ? v - 65536 : v;
    }

    u24() {
        const b = this.bytes, o = this.offset;
        this.offset += 3;
        return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
    }

    i32() {
        const b = this.bytes, o = this.offset;
        this.offset += 4;
        return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    }

    // 2 bytes if the top bit is clear, otherwise 4 with the top bit masked off
    bigSmart() {
        if (this.bytes[this.offset] < 128) {
            return this.u16();
        }
        return this.i32() & 0x7fffffff;
    }

    // bigSmart where the 2 byte value 32767 means "none"
    bigSmart2() {
        if (this.bytes[this.offset] >= 128) {
            return this.i32() & 0x7fffffff;
        }
        const v = this.u16();
        return v === 32767 ? -1 : v;
    }

    uShortSmart() {
        if (this.bytes[this.offset] < 128) {
            return this.u8();
        }
        return this.u16() - 0x8000;
    }

    uIntSmartShortCompat() {
        let result = 0;
        let v = this.uShortSmart();
        while (v === 32767) {
            result += 32767;
            v = this.uShortSmart();
        }
        return result + v;
    }

    // NUL terminated, one byte per character
    cstring() {
        const b = this.bytes;
        const start = this.offset;
        while (this.offset < b.length && b[this.offset] !== 0) {
            this.offset++;
        }
        const s = String.fromCharCode.apply(null, b.subarray(start, this.offset));
        this.offset++;
        return s;
    }
}

// The hash the cache stores in place of an archive or file name.
export function nameHash(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (name.charCodeAt(i) + Math.imul(hash, 31)) | 0;
    }
    return hash;
}
