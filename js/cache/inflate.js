// Synchronous gzip decompression. Cache groups are a few kilobytes each, and for data that size
// DecompressionStream's fixed cost per call outweighs the work itself.
//
// Deflate (RFC 1951) inside a gzip wrapper (RFC 1952). The gzip checksum is not checked: the
// container's decompressed length is, by the caller.

const LENGTH_BASE = new Uint16Array([
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = new Uint16Array([
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
    16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
// the order a dynamic block lists the code lengths of its code length code in
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const GZIP_FLAGS = { FHCRC: 2, FEXTRA: 4, FNAME: 8, FCOMMENT: 16 };

const TABLE_BITS = 10;
const INPUT_PADDING = 16;
const COPY_WITHIN_MIN = 32;

// A Huffman code as a table indexed by the next `bits` bits of input, lowest bit first. Each entry
// is symbol << 4 | code length; 0 where no code of up to `bits` bits matches.
function buildTable(lengths) {
    let maxLength = 0;
    const counts = new Uint16Array(16);
    for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i];
        counts[length]++;
        if (length > maxLength) maxLength = length;
    }
    counts[0] = 0;

    const offsets = new Uint16Array(16);
    for (let length = 1; length < 15; length++) offsets[length + 1] = offsets[length] + counts[length];
    const symbols = new Uint16Array(lengths.length);
    for (let symbol = 0; symbol < lengths.length; symbol++) {
        if (lengths[symbol] !== 0) symbols[offsets[lengths[symbol]]++] = symbol;
    }

    const nextCode = new Uint16Array(16);
    for (let length = 1, code = 0; length < 16; length++) {
        code = (code + counts[length - 1]) << 1;
        nextCode[length] = code;
    }

    const bits = Math.min(maxLength, TABLE_BITS);
    const table = new Uint16Array(1 << bits);
    for (let symbol = 0; symbol < lengths.length; symbol++) {
        const length = lengths[symbol];
        if (length === 0 || length > bits) continue;
        // codes are stored most significant bit first, but read lowest bit first
        let code = nextCode[length]++;
        let reversed = 0;
        for (let i = 0; i < length; i++) {
            reversed = (reversed << 1) | (code & 1);
            code >>= 1;
        }
        for (let i = reversed; i < table.length; i += 1 << length) {
            table[i] = (symbol << 4) | length;
        }
    }
    return { table, bits, counts, symbols };
}

function decodeLong(huffman, bitBuf) {
    const { counts, symbols } = huffman;
    let code = 0, first = 0, index = 0;
    for (let length = 1; length < 16; length++) {
        code |= (bitBuf >>> (length - 1)) & 1;
        const count = counts[length];
        if (code - first < count) return (symbols[index + code - first] << 4) | length;
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    return 0;
}

let fixedTables = null;

function getFixedTables() {
    if (!fixedTables) {
        const lit = new Uint8Array(288);
        lit.fill(8, 0, 144);
        lit.fill(9, 144, 256);
        lit.fill(7, 256, 280);
        lit.fill(8, 280, 288);
        fixedTables = { lit: buildTable(lit), dist: buildTable(new Uint8Array(30).fill(5)) };
    }
    return fixedTables;
}

function grow(out, needed) {
    const grown = new Uint8Array(Math.max(out.length * 2, needed));
    grown.set(out);
    return grown;
}

function inflateCodes(stream, lit, dist) {
    const data = stream.data;
    const end = stream.end;
    let { pos, bitBuf, bitCount, out, outPos } = stream;
    let outLength = out.length;
    const litTable = lit.table, litMask = (1 << lit.bits) - 1;
    const distTable = dist.table, distMask = (1 << dist.bits) - 1;

    for (;;) {
        // past the end reads as zeros, which only a truncated stream would ever use
        if (pos > end) throw new Error("Deflate stream ends early");
        if (bitCount < 15) {
            bitBuf |= (data[pos] << bitCount) | (data[pos + 1] << (bitCount + 8));
            pos += 2;
            bitCount += 16;
        }
        let entry = litTable[bitBuf & litMask];
        if (entry === 0) {
            entry = decodeLong(lit, bitBuf);
            if (entry === 0) throw new Error("Invalid deflate code");
        }
        let length = entry & 15;
        bitBuf >>>= length;
        bitCount -= length;
        let symbol = entry >> 4;

        if (symbol < 256) {
            if (outPos >= outLength) {
                out = grow(out, outPos + 1);
                outLength = out.length;
            }
            out[outPos++] = symbol;
            continue;
        }
        if (symbol === 256) break;

        symbol -= 257;
        if (symbol >= 29) throw new Error("Invalid deflate length");
        let extra = LENGTH_EXTRA[symbol];
        if (bitCount < extra) {
            bitBuf |= (data[pos] << bitCount) | (data[pos + 1] << (bitCount + 8));
            pos += 2;
            bitCount += 16;
        }
        const matchLength = LENGTH_BASE[symbol] + (bitBuf & ((1 << extra) - 1));
        bitBuf >>>= extra;
        bitCount -= extra;

        if (bitCount < 15) {
            bitBuf |= (data[pos] << bitCount) | (data[pos + 1] << (bitCount + 8));
            pos += 2;
            bitCount += 16;
        }
        entry = distTable[bitBuf & distMask];
        if (entry === 0) {
            entry = decodeLong(dist, bitBuf);
            if (entry === 0) throw new Error("Invalid deflate code");
        }
        length = entry & 15;
        bitBuf >>>= length;
        bitCount -= length;
        const distSymbol = entry >> 4;
        if (distSymbol >= 30) throw new Error("Invalid deflate distance");

        extra = DIST_EXTRA[distSymbol];
        if (bitCount < extra) {
            bitBuf |= (data[pos] << bitCount) | (data[pos + 1] << (bitCount + 8));
            pos += 2;
            bitCount += 16;
        }
        const distance = DIST_BASE[distSymbol] + (bitBuf & ((1 << extra) - 1));
        bitBuf >>>= extra;
        bitCount -= extra;
        if (distance > outPos) throw new Error("Invalid deflate distance");

        if (outPos + matchLength > outLength) {
            out = grow(out, outPos + matchLength);
            outLength = out.length;
        }
        let from = outPos - distance;
        if (matchLength <= COPY_WITHIN_MIN) {
            // byte by byte, since a match may overlap the bytes it is copying
            for (const stop = outPos + matchLength; outPos < stop; ) {
                out[outPos++] = out[from++];
            }
        } else if (distance === 1) {
            out.fill(out[from], outPos, outPos + matchLength);
            outPos += matchLength;
        } else if (distance >= matchLength) {
            out.copyWithin(outPos, from, from + matchLength);
            outPos += matchLength;
        } else {
            const stop = outPos + matchLength;
            for (let chunk = distance; outPos + chunk < stop; chunk = outPos - from) {
                out.copyWithin(outPos, from, from + chunk);
                outPos += chunk;
            }
            out.copyWithin(outPos, from, from + (stop - outPos));
            outPos = stop;
        }
    }

    Object.assign(stream, { pos, bitBuf, bitCount, out, outPos });
}

// Decompresses a gzip stream. expectedLength sizes the output up front; it grows if that is short.
export function gunzip(input, expectedLength = input.length * 4) {
    if (input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) {
        throw new Error("Not a gzip stream");
    }
    const data = new Uint8Array(input.length + INPUT_PADDING);
    data.set(input);
    const dataLength = input.length;
    const end = dataLength + 4;
    const flags = data[3];
    let pos = 10;
    if (flags & GZIP_FLAGS.FEXTRA) pos += 2 + (data[pos] | (data[pos + 1] << 8));
    if (flags & GZIP_FLAGS.FNAME) while (data[pos++] !== 0 && pos < dataLength);
    if (flags & GZIP_FLAGS.FCOMMENT) while (data[pos++] !== 0 && pos < dataLength);
    if (flags & GZIP_FLAGS.FHCRC) pos += 2;

    let out = new Uint8Array(Math.max(expectedLength, 64));
    let outPos = 0;
    let bitBuf = 0;
    let bitCount = 0;

    const ensure = (extra) => {
        if (outPos + extra > out.length) out = grow(out, outPos + extra);
    };

    const need = (n) => {
        while (bitCount < n) {
            // past the end reads as zeros, which only a truncated stream would ever use
            if (pos >= end) throw new Error("Deflate stream ends early");
            bitBuf |= data[pos++] << bitCount;
            bitCount += 8;
        }
    };

    const bits = (n) => {
        need(n);
        const value = bitBuf & ((1 << n) - 1);
        bitBuf >>>= n;
        bitCount -= n;
        return value;
    };

    const decode = (huffman) => {
        need(15);
        let entry = huffman.table[bitBuf & ((1 << huffman.bits) - 1)];
        if (entry === 0) entry = decodeLong(huffman, bitBuf);
        const length = entry & 15;
        if (length === 0) throw new Error("Invalid deflate code");
        bitBuf >>>= length;
        bitCount -= length;
        return entry >> 4;
    };

    let final = 0;
    while (!final) {
        final = bits(1);
        const type = bits(2);

        if (type === 0) {
            // stored: the bytes after the current one, which may already be in the bit buffer
            pos -= bitCount >> 3;
            bitBuf = 0;
            bitCount = 0;
            const length = data[pos] | (data[pos + 1] << 8);
            pos += 4;
            if (pos + length > dataLength) throw new Error("Deflate stream ends early");
            ensure(length);
            out.set(data.subarray(pos, pos + length), outPos);
            outPos += length;
            pos += length;
            continue;
        }

        let lit, dist;
        if (type === 1) {
            ({ lit, dist } = getFixedTables());
        } else if (type === 2) {
            const litCount = bits(5) + 257;
            const distCount = bits(5) + 1;
            const codeLengthCount = bits(4) + 4;

            const codeLengths = new Uint8Array(19);
            for (let i = 0; i < codeLengthCount; i++) {
                codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
            }
            const codeLengthTable = buildTable(codeLengths);

            const lengths = new Uint8Array(litCount + distCount);
            for (let i = 0; i < lengths.length; ) {
                const symbol = decode(codeLengthTable);
                if (symbol < 16) {
                    lengths[i++] = symbol;
                    continue;
                }
                let repeat, value = 0;
                if (symbol === 16) {
                    if (i === 0) throw new Error("Invalid deflate code lengths");
                    value = lengths[i - 1];
                    repeat = 3 + bits(2);
                } else if (symbol === 17) {
                    repeat = 3 + bits(3);
                } else {
                    repeat = 11 + bits(7);
                }
                if (i + repeat > lengths.length) throw new Error("Invalid deflate code lengths");
                lengths.fill(value, i, i + repeat);
                i += repeat;
            }
            lit = buildTable(lengths.subarray(0, litCount));
            dist = buildTable(lengths.subarray(litCount));
        } else {
            throw new Error("Invalid deflate block type");
        }

        const stream = { data, end, pos, bitBuf, bitCount, out, outPos };
        inflateCodes(stream, lit, dist);
        ({ pos, bitBuf, bitCount, out, outPos } = stream);
    }

    return outPos === out.length ? out : out.subarray(0, outPos);
}
