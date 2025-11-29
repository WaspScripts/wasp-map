import { error } from "@sveltejs/kit"
import { mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { ResizeFilterType, Transformer } from "@napi-rs/image"

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

	const path = join(process.cwd(), "cache", map, zoom, plane)
	const file = x + "-" + y

	try {
		const fileBuffer = await readFile(join(path, file + ".webp"))
		return new Response(fileBuffer, {
			status: 200,
			headers: {
				Source: "Cache",
				"Content-Type": "image/webp",
				"Content-Length": fileBuffer.length.toString(),
				"Cache-Control": "max-age=0, s-maxage=3600"
			}
		})
	} catch (e) {
		try {
			const saticPath = join(".", "static", "wasp-map-layers", map, plane)
			const pngPath = join(saticPath, file + ".png")
			const promises = await Promise.all([readFile(pngPath), mkdir(path, { recursive: true })])
			const png = promises[0]
			const transformer = new Transformer(png)
			let webp: Buffer<ArrayBufferLike>

			console.log(zoomN)
			if (zoomN == 0) {
				webp = await transformer.webpLossless()
				await writeFile(join(path, file + ".webp"), webp)
			} else if (zoomN > 0) {
				const size = (zoomN + 1) * 256

				webp = await transformer.resize(size, size, ResizeFilterType.Nearest).webpLossless()
				await writeFile(join(path, file + ".webp"), webp)
			} else {
				await mkdir(path, { recursive: true })
				const size = 256 / (2 * Math.abs(zoomN))
				webp = await transformer.resize(size, size, ResizeFilterType.Nearest).webpLossless()
				await writeFile(join(path, file + ".webp"), webp)
			}

			return new Response(webp, {
				status: 200,
				headers: {
					Source: "Computed",
					"Content-Type": "image/webp",
					"Content-Length": webp.length.toString(),
					"Cache-Control": "max-age=0, s-maxage=3600"
				}
			})
		} catch (err) {
			console.error(err)
		}
	}

	error(404, "Image doesn't exist.")
}
