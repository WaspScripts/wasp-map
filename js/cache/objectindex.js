export class ObjectIndex {
    constructor(buffer) {
        const [count, total] = new Uint32Array(buffer, 0, 2);
        this.buffer = buffer;
        this.offsets = new Uint32Array(buffer, 8, count);
        this.regions = new Uint16Array(buffer, 8 + count * 4, total);
    }

    static build(parts) {
        let maxId = -1;
        let total = 0;
        for (const pairs of parts) {
            total += pairs.length / 2;
            for (let i = 0; i < pairs.length; i += 2) {
                if (pairs[i] > maxId) maxId = pairs[i];
            }
        }

        const count = maxId + 2;
        const buffer = new ArrayBuffer(8 + count * 4 + total * 2);
        new Uint32Array(buffer, 0, 2).set([count, total]);
        const offsets = new Uint32Array(buffer, 8, count);
        for (const pairs of parts) {
            for (let i = 0; i < pairs.length; i += 2) offsets[pairs[i] + 1]++;
        }
        for (let i = 1; i < count; i++) offsets[i] += offsets[i - 1];

        const regions = new Uint16Array(buffer, 8 + count * 4, total);
        const cursor = offsets.slice(0, count - 1);
        for (const pairs of parts) {
            for (let i = 0; i < pairs.length; i += 2) regions[cursor[pairs[i]]++] = pairs[i + 1];
        }
        return new ObjectIndex(buffer);
    }

    regionsOf(ids) {
        const found = new Set();
        const last = this.offsets.length - 1;
        for (const id of ids) {
            if (id < 0 || id >= last) continue;
            for (let k = this.offsets[id]; k < this.offsets[id + 1]; k++) found.add(this.regions[k]);
        }
        return found;
    }
}
