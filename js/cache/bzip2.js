// Minimal bzip2 decoder for cache containers. The cache stores bzip2 payloads without their
// "BZh1" stream header, so decoding starts straight at the first block.

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const END_MAGIC_HI = 0x177245;
const END_MAGIC_LO = 0x385090;
const MAX_GROUPS = 6;
const MAX_CODE_LEN = 23;
const GROUP_SIZE = 50;
const FAST_BITS = 10;
const SHORT_RUN = 64;

// the cache always compresses at level 1, but any level decodes as long as tt is big enough
const MAX_BLOCK_SIZE = 900000;
let tt = null;

class BitReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.pos = 0;
        this.buf = 0;
        this.count = 0;
    }

    // n must be at most 24
    bits(n) {
        while (this.count < n) {
            this.buf = ((this.buf << 8) | (this.bytes[this.pos++] ?? 0)) >>> 0;
            this.count += 8;
        }
        this.count -= n;
        const v = (this.buf >>> this.count) & ((1 << n) - 1);
        this.buf &= (1 << this.count) - 1;
        return v;
    }
}

function buildTable(lengths, alphaSize) {
    let minLen = 32, maxLen = 0;
    for (let i = 0; i < alphaSize; i++) {
        minLen = Math.min(minLen, lengths[i]);
        maxLen = Math.max(maxLen, lengths[i]);
    }

    const perm = new Int32Array(alphaSize);
    let pp = 0;
    for (let len = minLen; len <= maxLen; len++) {
        for (let s = 0; s < alphaSize; s++) {
            if (lengths[s] === len) {
                perm[pp++] = s;
            }
        }
    }

    const base = new Int32Array(MAX_CODE_LEN + 2);
    const limit = new Int32Array(MAX_CODE_LEN + 2);
    for (let i = 0; i < alphaSize; i++) {
        base[lengths[i] + 1]++;
    }
    for (let i = 1; i < base.length; i++) {
        base[i] += base[i - 1];
    }

    let vec = 0;
    for (let len = minLen; len <= maxLen; len++) {
        vec += base[len + 1] - base[len];
        limit[len] = vec - 1;
        vec <<= 1;
    }
    for (let len = minLen + 1; len <= maxLen; len++) {
        base[len] = ((limit[len - 1] + 1) << 1) - base[len];
    }

    const fast = new Uint32Array(1 << FAST_BITS);
    let code = 0;
    pp = 0;
    for (let len = minLen; len <= maxLen; len++) {
        for (; pp < alphaSize && lengths[perm[pp]] === len; pp++, code++) {
            if (len > FAST_BITS) continue;
            const shift = FAST_BITS - len;
            fast.fill((perm[pp] << 5) | len, code << shift, (code + 1) << shift);
        }
        code <<= 1;
    }

    return { minLen, maxLen, perm, base, limit, fast };
}

function decodeSymbols(br, tables, selectors, seqToUnseq, eob, counts) {
    const input = br.bytes;
    let { pos, buf, count } = br;
    const mtf = new Uint8Array(256);
    for (let i = 0; i < seqToUnseq.length; i++) {
        mtf[i] = seqToUnseq[i];
    }

    let nblock = 0;
    let groupPos = 0;
    let selector = 0;
    let table = null;
    let runLength = 0;
    let runBit = 1;

    for (;;) {
        if (groupPos === 0) {
            table = tables[selectors[selector++]];
            groupPos = GROUP_SIZE;
        }
        groupPos--;

        while (count < 24) {
            buf = (buf << 8) | (input[pos++] ?? 0);
            count += 8;
        }
        let sym;
        const entry = table.fast[(buf >>> (count - FAST_BITS)) & ((1 << FAST_BITS) - 1)];
        if (entry !== 0) {
            sym = entry >>> 5;
            count -= entry & 31;
        } else {
            const { maxLen, limit } = table;
            let len = Math.max(table.minLen, FAST_BITS + 1);
            let code = (buf >>> (count - len)) & ((1 << len) - 1);
            while (len <= maxLen && code > limit[len]) {
                len++;
                code = (buf >>> (count - len)) & ((1 << len) - 1);
            }
            if (len > maxLen) {
                throw new Error("bzip2: bad huffman code");
            }
            sym = table.perm[code - table.base[len]];
            count -= len;
        }

        if (sym <= 1) {
            runLength += (sym + 1) * runBit;
            runBit <<= 1;
            continue;
        }

        if (runLength > 0) {
            const b = mtf[0];
            counts[b] += runLength;
            if (nblock + runLength > tt.length) {
                throw new Error("bzip2: block too big");
            }
            if (runLength < SHORT_RUN) {
                for (const stop = nblock + runLength; nblock < stop; ) tt[nblock++] = b;
            } else {
                tt.fill(b, nblock, nblock + runLength);
                nblock += runLength;
            }
            runLength = 0;
            runBit = 1;
        }

        if (sym === eob) {
            break;
        }

        const idx = sym - 1;
        const b = mtf[idx];
        if (idx < SHORT_RUN) {
            for (let k = idx; k > 0; k--) {
                mtf[k] = mtf[k - 1];
            }
        } else {
            mtf.copyWithin(1, 0, idx);
        }
        mtf[0] = b;

        counts[b]++;
        tt[nblock++] = b;
    }

    br.pos = pos;
    br.count = count;
    br.buf = (buf & ((1 << count) - 1)) >>> 0;
    return nblock;
}

export function bunzip2(input, outLength) {
    if (!tt) {
        tt = new Uint32Array(MAX_BLOCK_SIZE);
    }

    const out = new Uint8Array(outLength);
    let outPos = 0;
    const br = new BitReader(input);

    // run-length state carries across blocks
    let last = -1;
    let run = 0;

    for (;;) {
        const magicHi = br.bits(24);
        const magicLo = br.bits(24);
        br.bits(16);
        br.bits(16); // block crc

        if (magicHi === END_MAGIC_HI && magicLo === END_MAGIC_LO) {
            break;
        }
        if (magicHi !== BLOCK_MAGIC_HI || magicLo !== BLOCK_MAGIC_LO) {
            throw new Error("bzip2: bad block header");
        }
        if (br.bits(1)) {
            throw new Error("bzip2: randomised blocks are not supported");
        }

        const origPtr = br.bits(24);

        const seqToUnseq = [];
        const usedGroups = br.bits(16);
        for (let i = 0; i < 16; i++) {
            if (usedGroups & (0x8000 >> i)) {
                const used = br.bits(16);
                for (let j = 0; j < 16; j++) {
                    if (used & (0x8000 >> j)) {
                        seqToUnseq.push(i * 16 + j);
                    }
                }
            }
        }

        const alphaSize = seqToUnseq.length + 2;
        const nGroups = br.bits(3);
        const nSelectors = br.bits(15);
        if (nGroups < 2 || nGroups > MAX_GROUPS || nSelectors < 1) {
            throw new Error("bzip2: bad group count");
        }

        const selectors = new Uint8Array(nSelectors);
        const groupMtf = [0, 1, 2, 3, 4, 5];
        for (let i = 0; i < nSelectors; i++) {
            let j = 0;
            while (br.bits(1)) {
                j++;
            }
            const v = groupMtf[j];
            for (; j > 0; j--) {
                groupMtf[j] = groupMtf[j - 1];
            }
            groupMtf[0] = v;
            selectors[i] = v;
        }

        const tables = [];
        const lengths = new Uint8Array(alphaSize);
        for (let t = 0; t < nGroups; t++) {
            let len = br.bits(5);
            for (let s = 0; s < alphaSize; s++) {
                while (br.bits(1)) {
                    len += br.bits(1) ? -1 : 1;
                }
                lengths[s] = len;
            }
            tables.push(buildTable(lengths, alphaSize));
        }

        // huffman -> move to front -> run lengths of zeros, straight into tt
        const counts = new Int32Array(256);
        const nblock = decodeSymbols(br, tables, selectors, seqToUnseq, alphaSize - 1, counts);

        if (origPtr >= nblock) {
            throw new Error("bzip2: bad origPtr");
        }

        // inverse BWT: the byte stays in the low 8 bits, the next index goes above it
        let sum = 0;
        for (let i = 0; i < 256; i++) {
            const c = counts[i];
            counts[i] = sum;
            sum += c;
        }
        for (let i = 0; i < nblock; i++) {
            const b = tt[i] & 0xff;
            tt[counts[b]++] |= i << 8;
        }

        // tt[origPtr] holds the block's last byte, so output starts from the entry it points at
        let pos = tt[origPtr] >>> 8;
        for (let i = 0; i < nblock; i++) {
            const entry = tt[pos];
            const b = entry & 0xff;
            pos = entry >>> 8;

            // undo the initial run-length encoding: 4 equal bytes are followed by a repeat count
            if (run === 4) {
                for (let k = 0; k < b; k++) {
                    out[outPos++] = last;
                }
                run = 0;
                last = -1;
                continue;
            }

            if (b === last) {
                run++;
            } else {
                run = 1;
                last = b;
            }
            out[outPos++] = b;
        }
    }

    if (outPos !== outLength) {
        throw new Error(`bzip2: expected ${outLength} bytes, got ${outPos}`);
    }
    return out;
}
