const COSINE = new Int32Array(2048);
for (let i = 0; i < 2048; i++) {
    COSINE[i] = Math.trunc(Math.cos(i * 0.0030679615) * 65536);
}

const COARSE_WEIGHTS = [0, 1, 2, 3].map((i) => (65536 - COSINE[256 * i]) >> 1);
const MID_WEIGHTS = [0, 1].map((i) => (65536 - COSINE[512 * i]) >> 1);

export function noise(x, y) {
    let n = (x + Math.imul(y, 57)) | 0;
    n ^= n << 13;
    const hash = (Math.imul(n, (Math.imul(Math.imul(n, n), 0x3d73) + 0xc0ae5) | 0) + 0x5208dd0d) | 0;
    return ((hash & 0x7fffffff) >>> 19) & 0xff;
}

function smoothedNoiseArea(x, y, width, height) {
    const stride = height + 2;
    const raw = new Int32Array((width + 2) * stride);
    for (let i = 0; i < width + 2; i++) {
        for (let j = 0; j < stride; j++) {
            raw[i * stride + j] = noise(x - 1 + i, y - 1 + j);
        }
    }

    const result = new Int32Array(width * height);
    for (let i = 0; i < width; i++) {
        const left = i * stride;
        const middle = left + stride;
        const right = middle + stride;
        for (let j = 0; j < height; j++) {
            const corners = raw[left + j] + raw[right + j] + raw[left + j + 2] + raw[right + j + 2];
            const sides = raw[left + j + 1] + raw[right + j + 1] + raw[middle + j] + raw[middle + j + 2];
            result[i * height + j] = (raw[middle + j + 1] >> 2) + (sides >> 3) + (corners >> 4);
        }
    }
    return result;
}

function interpolatedNoiseArea(x, y, size, frequency, weights) {
    const gridX = Math.floor(x / frequency);
    const gridY = Math.floor(y / frequency);
    const gridHeight = Math.floor((y + size - 1) / frequency) - gridY + 2;
    const grid = smoothedNoiseArea(gridX, gridY, Math.floor((x + size - 1) / frequency) - gridX + 2, gridHeight);

    const idxX = new Int32Array(size);
    const idxY = new Int32Array(size);
    const weightXs = new Int32Array(size);
    const weightYs = new Int32Array(size);
    for (let i = 0; i < size; i++) {
        idxX[i] = Math.floor((x + i) / frequency) - gridX;
        weightXs[i] = weights[(x + i) & (frequency - 1)];
        idxY[i] = Math.floor((y + i) / frequency) - gridY;
        weightYs[i] = weights[(y + i) & (frequency - 1)];
    }

    const result = new Int32Array(size * size);
    for (let i = 0; i < size; i++) {
        const row = idxX[i] * gridHeight;
        const nextRow = row + gridHeight;
        const weightX = weightXs[i];
        const invWeightX = 65536 - weightX;

        for (let j = 0; j < size; j++) {
            const k = idxY[j];
            const low = ((invWeightX * grid[row + k]) >> 16) + ((grid[nextRow + k] * weightX) >> 16);
            const high = ((invWeightX * grid[row + k + 1]) >> 16) + ((grid[nextRow + k + 1] * weightX) >> 16);
            const weightY = weightYs[j];
            result[i * size + j] = (((65536 - weightY) * low) >> 16) + ((high * weightY) >> 16);
        }
    }
    return result;
}

export function calculateArea(x, y, size) {
    const coarse = interpolatedNoiseArea(x + 45365, y + 91923, size, 4, COARSE_WEIGHTS);
    const mid = interpolatedNoiseArea(x + 10294, y + 37821, size, 2, MID_WEIGHTS);
    const fine = smoothedNoiseArea(x, y, size, size);

    const result = new Int32Array(size * size);
    for (let i = 0; i < result.length; i++) {
        let n = coarse[i] - 128 + ((mid[i] - 128) >> 1) + ((fine[i] - 128) >> 2);
        n = Math.trunc(n * 0.3) + 35;
        result[i] = n < 10 ? 10 : n > 60 ? 60 : n;
    }
    return result;
}
