import { FastResizeFilter, ResizeFilterType, Transformer } from "@napi-rs/image"
import { mkdir, readdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { createHash } from "crypto"

const path = join(".", "static", "wasp-map-layers", "map")

const TILE_SIZE = 256
const imgSize = TILE_SIZE * TILE_SIZE * 4
const steps = [0, 1, 2, 4, 8, 16, 32]
const minZoom = -6
const maxZoom = 2
const minPlane = 0
const maxPlane = 3
const pngs: string[][] = []
const maps = ["map", "heightmap", "collision"]

const empty = await readFile(join(".", "static", "empty.webp"))
const emptyBlue = await readFile(join(".", "static", "empty-blue.webp"))
const emptyWhite = await readFile(join(".", "static", "empty-white.webp"))
const emptyHash = hashBuffer(empty)
const emptyBlueHash = hashBuffer(emptyBlue)
const emptyWhiteHash = hashBuffer(emptyWhite)

const scope = await getScope()

function hashBuffer(buf: Buffer) {
	return createHash("md5").update(buf).digest("hex")
}

async function getScope() {
	let lo = { x: 9999, y: 9999 }
	let hi = { x: 0, y: 0 }

	const planeFiles: Promise<string[]>[] = []
	for (let plane = minPlane; plane <= maxPlane; plane++) {
		planeFiles.push(readdir(join(path, plane.toString())))
	}
	const files = await Promise.all(planeFiles)
	files.forEach((f) => pngs.push(f))

	for (let i = 0; i < pngs[0].length; i++) {
		const match = pngs[0][i].match(/(\d+)-(\d+)/)
		if (match == null) continue

		const y: number = parseInt(match[2], 10)
		const x: number = parseInt(match[1], 10)

		lo.x = Math.min(x, lo.x)
		hi.x = Math.max(x, hi.x)
		hi.y = Math.max(y, hi.y)
		lo.y = Math.min(y, lo.y)
	}

	return { x1: lo.x, y1: lo.y, x2: hi.x, y2: hi.y }
}

async function upscale(map: string, x: number, y: number, zoom: number, plane: number) {
	const planeStr = plane.toString()
	const path = join(".", "static", map, zoom.toString(), planeStr)
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
	const path = join(".", "static", map, zoom.toString(), plane.toString())
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

async function startDownscale(map: string) {
	console.log("Starting downscaling of ", map)
	const start = performance.now()
	const step = steps[-minZoom]

	for (let zoom = 0; zoom >= minZoom; zoom--) {
		for (let plane = minPlane; plane <= maxPlane; plane++) {
			console.log("Downscaling zoom ", zoom, " plane ", plane)
			for (let y = scope.y1; y <= scope.y2; y++) {
				for (let x = scope.x1; x <= scope.x2; x++) {
					await downscale(map, x, y, zoom, plane, step)
				}
			}
		}
	}

	console.log(map, " downscaling took: ", performance.now() - start, "ms.")
}

async function startUpscale(map: string) {
	console.log("Starting upscaling of ", map)
	const start = performance.now()

	for (let zoom = 0; zoom <= maxZoom; zoom++) {
		for (let plane = minPlane; plane <= maxPlane; plane++) {
			console.log("Upscaling zoom ", zoom, " plane ", plane)
			for (let y = scope.y1; y <= scope.y2; y++) {
				for (let x = scope.x1; x <= scope.x2; x++) {
					await upscale(map, x, y, zoom, plane)
				}
			}
		}
	}

	console.log(map, " upscaling took: ", performance.now() - start, "ms.")
}

for (let i = 0; i < maps.length; i++) {
	await startDownscale(maps[i])
	await startUpscale(maps[i])
}
