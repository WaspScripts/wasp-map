// An index's reference table: which groups it holds and which files are in each.
// Ported from cache-reader/reader/reference_table.simba.

import { Reader, nameHash } from "./io.js";

const FLAG_NAMES = 0x1;
const FLAG_WHIRLPOOL = 0x2;
const FLAG_LENGTHS = 0x4;
const FLAG_CHECKSUMS = 0x8;

export class ReferenceTable {
    constructor(data) {
        const r = new Reader(data);

        this.version = r.u8();
        if (this.version < 5 || this.version > 7) {
            throw new Error(`Unknown reference table version: ${this.version}`);
        }
        this.revision = this.version >= 6 ? r.i32() : 0;
        this.mask = r.u8();

        const named = (this.mask & FLAG_NAMES) !== 0;
        const readId = this.version >= 7 ? () => r.bigSmart() : () => r.u16();

        const count = readId();
        const ids = new Int32Array(count);
        let id = 0;
        for (let i = 0; i < count; i++) {
            id += readId();
            ids[i] = id;
        }

        const groups = new Array(count);
        for (let i = 0; i < count; i++) {
            groups[i] = { id: ids[i], nameHash: 0, revision: 0, fileIds: null, fileNameHashes: null };
        }

        if (named) {
            for (const g of groups) g.nameHash = r.i32();
        }
        for (let i = 0; i < count; i++) r.i32(); // crc
        if (this.mask & FLAG_CHECKSUMS) {
            for (let i = 0; i < count; i++) r.i32();
        }
        if (this.mask & FLAG_WHIRLPOOL) {
            r.offset += 64 * count;
        }
        if (this.mask & FLAG_LENGTHS) {
            r.offset += 8 * count;
        }
        for (const g of groups) g.revision = r.i32();

        const fileCounts = new Int32Array(count);
        for (let i = 0; i < count; i++) fileCounts[i] = readId();

        for (let i = 0; i < count; i++) {
            const fileIds = new Int32Array(fileCounts[i]);
            let fileId = 0;
            for (let j = 0; j < fileIds.length; j++) {
                fileId += readId();
                fileIds[j] = fileId;
            }
            groups[i].fileIds = fileIds;
        }

        if (named) {
            for (const g of groups) {
                g.fileNameHashes = new Int32Array(g.fileIds.length);
                for (let j = 0; j < g.fileIds.length; j++) g.fileNameHashes[j] = r.i32();
            }
        }

        this.named = named;
        this.groups = new Map();
        for (const g of groups) this.groups.set(g.id, g);
    }

    group(id) {
        return this.groups.get(id);
    }

    groupIdByName(name) {
        const hash = nameHash(name);
        for (const g of this.groups.values()) {
            if (g.nameHash === hash) return g.id;
        }
        return -1;
    }
}

// Splits a decoded group into its files. With more than one file the bytes are interleaved in
// chunks, with a table of chunk sizes (each a delta from the previous one) at the end.
// Ported from TArchive.Read in cache-reader/reader/archive/archive.simba.
export function splitGroup(data, fileIds) {
    const files = new Map();
    const fileCount = fileIds.length;
    if (fileCount === 0) return files;
    if (fileCount === 1) {
        files.set(fileIds[0], data);
        return files;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chunkCount = data[data.length - 1];
    const tableStart = data.length - 1 - chunkCount * fileCount * 4;

    const sizes = new Int32Array(fileCount);
    let tableOffset = tableStart;
    for (let i = 0; i < chunkCount; i++) {
        let chunkSize = 0;
        for (let j = 0; j < fileCount; j++) {
            chunkSize += view.getInt32(tableOffset);
            tableOffset += 4;
            sizes[j] += chunkSize;
        }
    }

    const buffers = [];
    for (let j = 0; j < fileCount; j++) buffers.push(new Uint8Array(sizes[j]));
    const writeOffsets = new Int32Array(fileCount);

    let dataOffset = 0;
    tableOffset = tableStart;
    for (let i = 0; i < chunkCount; i++) {
        let chunkSize = 0;
        for (let j = 0; j < fileCount; j++) {
            chunkSize += view.getInt32(tableOffset);
            tableOffset += 4;
            buffers[j].set(data.subarray(dataOffset, dataOffset + chunkSize), writeOffsets[j]);
            dataOffset += chunkSize;
            writeOffsets[j] += chunkSize;
        }
    }

    for (let j = 0; j < fileCount; j++) files.set(fileIds[j], buffers[j]);
    return files;
}

export class GroupFiles {
    constructor(data, fileIds) {
        this.data = data;
        this.fileIds = fileIds;
        this.offsets = null;
        this.files = null;

        const fileCount = fileIds.length;
        if (fileCount <= 1 || data[data.length - 1] !== 1) {
            this.files = splitGroup(data, fileIds);
            return;
        }

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const tableStart = data.length - 1 - fileCount * 4;
        const offsets = new Int32Array(fileCount + 1);
        let size = 0;
        for (let j = 0; j < fileCount; j++) {
            size += view.getInt32(tableStart + j * 4);
            offsets[j + 1] = offsets[j] + size;
        }
        this.offsets = offsets;
    }

    get(id) {
        if (this.files) return this.files.get(id);
        const ids = this.fileIds;
        let lo = 0, hi = ids.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ids[mid] < id) lo = mid + 1;
            else if (ids[mid] > id) hi = mid - 1;
            else return this.data.subarray(this.offsets[mid], this.offsets[mid + 1]);
        }
        return undefined;
    }
}
