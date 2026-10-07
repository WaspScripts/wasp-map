// Decoded access to a cache through a source that hands out raw JS5 containers by
// (index, group) - see archive.js.

import { decodeContainer } from "./container.js";
import { GroupFiles, ReferenceTable, splitGroup } from "./reftable.js";
import { time } from "./perf.js";

export const Index = {
    CONFIGS: 2,
    MAPS: 5,
    MODELS: 7,
    SPRITES: 8,
    TEXTURES: 9,
};

export const ConfigGroup = {
    UNDERLAY: 1,
    OVERLAY: 4,
    OBJ: 6,
    NPC: 9,
    AREA: 35,
};

export class CacheStore {
    constructor(source) {
        this.source = source;
        this.tables = new Map();
    }

    referenceTable(index) {
        let table = this.tables.get(index);
        if (!table) {
            table = this.source
                .fetchGroup(255, index)
                .then((bytes) => decodeContainer(bytes))
                .then((data) => new ReferenceTable(data));
            this.tables.set(index, table);
            table.catch(() => this.tables.delete(index));
        }
        return table;
    }

    // The decoded bytes of a whole group, or null if the index has no such group.
    async groupData(index, groupId, background = false) {
        const table = await this.referenceTable(index);
        if (!table.group(groupId)) return null;
        const bytes = await this.source.fetchGroup(index, groupId, background);
        if (!bytes) return null;
        return time(`decode: container, index ${index}`, () => decodeContainer(bytes));
    }

    // A group split into its files, as a Map of file id to bytes, or null if there is no such group.
    async files(index, groupId, background = false) {
        const table = await this.referenceTable(index);
        const group = table.group(groupId);
        if (!group) return null;
        const data = await this.groupData(index, groupId, background);
        if (!data) return null;
        return splitGroup(data, group.fileIds);
    }

    async groupFiles(index, groupId) {
        const table = await this.referenceTable(index);
        const group = table.group(groupId);
        if (!group) return null;
        const data = await this.groupData(index, groupId);
        if (!data) return null;
        return new GroupFiles(data, group.fileIds);
    }
}
