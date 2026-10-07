function modelType(type) {
    if (type >= 5 && type <= 8) return 4;
    if (type === 11) return 10;
    return type;
}

export function objectModelIds(def, type) {
    const typ = modelType(type);
    if (def.modelTypes === null) {
        return typ === 10 ? def.modelIds : [];
    }
    const i = def.modelTypes.indexOf(typ);
    return i === -1 ? [] : [def.modelIds[i]];
}

function vertexStreams(data) {
    const n = data.length;
    let format = 0;
    if (data[n - 2] === 0xff) {
        format = { 0xfd: 3, 0xfe: 2, 0xff: 1 }[data[n - 1]] ?? 0;
    }
    if (format === 1) return null;

    let o = n - [18, 0, 23, 26][format];
    const u8 = () => data[o++];
    const u16 = () => ((data[o++] << 8) | data[o++]);

    const vertexCount = u16();
    const faceCount = u16();
    const textureCount = u8();

    if (format === 0) {
        const textured = u8(), priority = u8(), transparencies = u8(), packedTransparencies = u8(), packedGroups = u8();
        const xBytes = u16();
        u16();
        u16();
        const faceIndexBytes = u16();
        let at = vertexCount + faceCount;
        if (priority === 255) at += faceCount;
        if (packedTransparencies === 1) at += faceCount;
        if (textured === 1) at += faceCount;
        if (packedGroups === 1) at += vertexCount;
        if (transparencies === 1) at += faceCount;
        at += faceIndexBytes + faceCount * 2 + textureCount * 6 + xBytes;
        return { vertexCount, flags: 0, heights: at };
    }

    if (format === 2) {
        const textured = u8(), priority = u8(), transparencies = u8(), packedTransparencies = u8();
        u8();
        u8();
        const xBytes = u16();
        u16();
        u16();
        const faceIndexBytes = u16();
        const packedGroupBytes = u16();
        let at = vertexCount + faceCount;
        if (priority === 255) at += faceCount;
        if (packedTransparencies === 1) at += faceCount;
        if (textured === 1) at += faceCount;
        at += packedGroupBytes;
        if (transparencies === 1) at += faceCount;
        at += faceIndexBytes + faceCount * 2 + textureCount * 6 + xBytes;
        return { vertexCount, flags: 0, heights: at };
    }

    const renderTypes = u8(), priority = u8(), transparencies = u8(), packedTransparencies = u8(), faceTextures = u8();
    u8();
    u8();
    const xBytes = u16();
    u16();
    u16();
    const faceIndexBytes = u16();
    const textureCoordBytes = u16();
    const packedGroupBytes = u16();
    let at = textureCount + vertexCount;
    if (renderTypes === 1) at += faceCount;
    at += faceCount;
    if (priority === 255) at += faceCount;
    if (packedTransparencies === 1) at += faceCount;
    at += packedGroupBytes;
    if (transparencies === 1) at += faceCount;
    at += faceIndexBytes;
    if (faceTextures === 1) at += faceCount * 2;
    at += textureCoordBytes + faceCount * 2 + xBytes;
    return { vertexCount, flags: textureCount, heights: at };
}

export function modelHeight(data, scaleHeight = 128) {
    const streams = vertexStreams(data);
    if (!streams) return 0;

    let flags = streams.flags;
    let o = streams.heights;
    let y = 0;
    let height = 0;
    for (let i = 0; i < streams.vertexCount; i++) {
        if (data[flags++] & 2) {
            y += data[o] < 128 ? data[o++] - 64 : ((data[o++] << 8) | data[o++]) - 0xc000;
        }
        height = Math.max(height, -Math.trunc((scaleHeight * y) / 128));
    }
    return height;
}
