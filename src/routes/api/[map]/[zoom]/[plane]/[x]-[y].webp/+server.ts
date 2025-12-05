import { error } from "@sveltejs/kit"
import { mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { FastResizeFilter, ResizeFilterType, Transformer } from "@napi-rs/image"
import { createHash } from "crypto"

const TILE_SIZE = 256
const imgSize = TILE_SIZE * TILE_SIZE * 4
const steps = [0, 1, 2, 4, 8, 16, 32]
const empty = await readFile(join(".", "static", "empty.webp"))
const emptyBlue = await readFile(join(".", "static", "empty-blue.webp"))
const emptyWhite = await readFile(join(".", "static", "empty-white.webp"))
const emptyHash = hashBuffer(empty)
const emptyBlueHash = hashBuffer(emptyBlue)
const emptyWhiteHash = hashBuffer(emptyWhite)

function hashBuffer(buf: Buffer) {
	return createHash("md5").update(buf).digest("hex")
}

async function upscale(map: string, x: number, y: number, zoom: number, plane: number) {
	const planeStr = plane.toString()
	const path = join(".", "cache", map, zoom.toString(), planeStr)
	const file = x + "-" + y

	const fileBuffer = await readFile(join(path, file + ".webp")).catch(() => null)
	if (fileBuffer) return fileBuffer

	const saticPath = join(".", "static", "wasp-map-layers", map, planeStr)
	const pngPath = join(saticPath, file + ".png")

	const [png] = await Promise.all([
		readFile(pngPath).catch(() => null),
		mkdir(path, { recursive: true }).catch(() => undefined)
	])
	if (!png) return empty

	const hash = createHash("md5").update(png).digest("hex")
	if (hash === emptyHash) return empty
	if (map === "map" && hash === emptyBlueHash) return emptyBlue
	if (map === "collision" && hash === emptyWhiteHash) return emptyWhite

	let transformer = new Transformer(png)

	if (zoom > 0) {
		const size = (zoom + 1) * TILE_SIZE
		transformer = transformer.resize({ width: size, height: size, filter: ResizeFilterType.Nearest })
	}

	const webp = await transformer.webpLossless().catch((e) => {
		console.error(e)
		return null
	})
	if (!webp) return empty
	await writeFile(join(path, file + ".webp"), webp).catch((e) => console.error(e))
	return webp
}

async function downscale(map: string, x: number, y: number, zoom: number, plane: number, step: number) {
	const path = join(".", "cache", map, zoom.toString(), plane.toString())
	const file = x + "-" + y
	const filePath = join(path, file + ".webp")

	const fileBuffer = await readFile(filePath).catch(() => null)
	if (fileBuffer) return fileBuffer

	await mkdir(path, { recursive: true }).catch(() => undefined)

	if (zoom === 0) {
		return await upscale(map, x, y, zoom, plane)
	}

	const files = [
		{ x, y },
		{ x, y: y - step },
		{ x: x + step, y },
		{ x: x + step, y: y - step }
	]

	const nextZoom = zoom + 1
	const nextStep = steps[-nextZoom]

	// Recursively get the four child tiles
	const buffers = await Promise.all(files.map((f) => downscale(map, f.x, f.y, nextZoom, plane, nextStep)))

	const allEmpty = buffers.every((b) => createHash("md5").update(b).digest("hex") === emptyHash)
	if (allEmpty) return empty

	if (map === "map") {
		const allBlue = buffers.every((b) => createHash("md5").update(b).digest("hex") === emptyBlueHash)
		if (allBlue) return emptyBlue
	} else if (map === "collision") {
		const allWhite = buffers.every((b) => createHash("md5").update(b).digest("hex") === emptyWhiteHash)
		if (allWhite) return emptyWhite
	}

	const transformer = Transformer.fromRgbaPixels(new Uint8ClampedArray(imgSize), TILE_SIZE, TILE_SIZE)

	const coordinates = [
		{ x: 0, y: 0 },
		{ x: 0, y: 128 },
		{ x: 128, y: 0 },
		{ x: 128, y: 128 }
	]

	// Resize all buffers
	const resizedBuffers = await Promise.all(
		buffers.map(async (buffer) => {
			try {
				return await new Transformer(buffer)
					.fastResize({
						width: 128,
						height: 128,
						filter: FastResizeFilter.Box
					})
					.bmp()
			} catch {
				return empty
			}
		})
	)

	// Overlay the four tiles
	for (let i = 0; i < resizedBuffers.length; i++) {
		transformer.overlay(resizedBuffers[i], coordinates[i].x, coordinates[i].y)
	}

	const webp = await transformer.webp().catch((e) => {
		console.error(e)
		return null
	})
	if (!webp) return empty

	await writeFile(filePath, webp).catch((e) => console.error(e))

	return webp
}

export const GET = async ({ params: { map, zoom, plane, x, y } }) => {
	switch (map) {
		case "map":
		case "heightmap":
		case "collision":
			break
		default:
			error(
				404,
				`Map type "${map}" is not valid. Only valid map types are: "map", "heightmap" and "collision".`
			)
	}

	const zoomN = Number(zoom)
	if (zoomN < -4 || zoomN > 4) error(404, `Zoom "${zoom}" is not valid. Zoom must be between -4 and 4`)
	const planeN = Number(plane)
	if (planeN < 0 || planeN > 3) error(404, `Plane "${plane}" is not valid. Planes must be between 0 and 3.`)
	const xN = Number(x)
	if (xN < 0 || xN > 99) error(404, `X "${x}" is not valid. X must be between 0 and 99`)
	const yN = Number(y)
	if (yN < 0 || yN > 199) error(404, `Y "${y}" is not valid. Y must be between 0 and 199`)

	let webp: Buffer<ArrayBufferLike>

	if (zoomN >= 0) {
		webp = await upscale(map, xN, yN, zoomN, planeN)
	} else {
		const step = steps[-zoomN]
		const nearest = 2 ** -zoomN
		const startX = Math.floor(xN / nearest) * nearest
		const startY = Math.floor(yN / nearest) * nearest
		if (xN != startX || yN != startY)
			error(404, `The zoomed out file you are requesting is not valid. Request ${startX}-${startY} instead.`)

		webp = await downscale(map, xN, yN, zoomN, planeN, step)
	}

	return new Response(webp, {
		status: 200,
		headers: {
			Source: "Computed",
			"Content-Type": "image/webp",
			"Content-Length": webp.length.toString(),
			"Cache-Control": `max-age=${process.env.NODE_ENV == "production" ? "3600" : "0"}, s-maxage=3600`
		}
	})
}
