import { error } from "@sveltejs/kit"

export const GET = async ({ params }) => {
	switch (params.map) {
		case "map":
		case "heightmap":
		case "collision":
			break
		default:
			error(
				404,
				`Map type "${params.map}" is not valid. Only valid map types are: "map", "heightmap" and "collision".`
			)
			break
	}

	if (Number(params.plane) < 0 || Number(params.plane) > 3)
		error(404, `Plane "${params.plane}" is not valid. Planes must be between 0 and 3.`)

	if (Number(params.zoom) < -4 || Number(params.zoom) > 4)
		error(404, `Zoom "${params.zoom}" is not valid. Zoom must be between -4 and 4`)

	if (Number(params.x) < 0 || Number(params.x) > 99)
		error(404, `X "${params.x}" is not valid. X must be between 0 and 99`)

	if (Number(params.y) < 0 || Number(params.y) > 199)
		error(404, `Y "${params.y}" is not valid. Y must be between 0 and 199`)

	const headers = {
		"Cache-Control": "max-age=0, s-maxage=3600",
		"Content-Type": "application/json"
	}

	return new Response(`{"Test": "test"}`, { headers })
}
