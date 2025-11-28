<script lang="ts">
	import { onMount } from "svelte"

	let canvas: HTMLCanvasElement
	let isDragging = $state(false)
	let startMouseX = $state(0)
	let startMouseY = $state(0)
	let offsetX = $state(0)
	let offsetY = $state(0)

	const size = 256
	let x = $state(47)
	let y = $state(55)

	let width = $state(0)
	let height = $state(0)

	const buffer = 0

	let x1 = $derived(Math.round(x - (offsetX + size) / size) - buffer)
	let x2 = $derived(Math.round(x + (width - offsetX) / size) + buffer)
	let y1 = $derived(Math.round(y - (height - offsetY) / size) - buffer)
	let y2 = $derived(Math.round(y + (offsetY + size) / size) + buffer)

	function loadImage(src: string) {
		return new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image()
			img.onload = () => resolve(img)
			img.onerror = () => reject(`Failed to load ${src}`)
			img.src = src
		})
	}

	const tileCache = new Map<string, HTMLImageElement>()

	async function loadVisibleTiles(offsetX: number, offsetY: number, cols: number, rows: number) {
		const tiles: { x: number; y: number; img: HTMLImageElement }[] = []

		for (let xx = x1; xx <= x2; xx++) {
			for (let yy = y2; yy >= y1; yy--) {
				const key = `${xx}-${yy}`
				if (tileCache.has(key)) {
					tiles.push({ x: xx, y: yy, img: tileCache.get(key)! })
				} else {
					loadImage(`/wasp-map-layers/map/0/${xx}-${yy}.png`)
						.then((img) => {
							tileCache.set(key, img)

							drawTiles()
						})
						.catch((e) => {
							console.error(`Tile ${xx}-${yy} failed: ${e}`)
						})
				}
			}
		}

		return tiles
	}

	async function drawTiles() {
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		canvas.width = window.innerWidth
		canvas.height = window.innerHeight

		const cols = Math.ceil(canvas.width / size) + buffer
		const rows = Math.ceil(canvas.height / size) + buffer

		const startTileX = 0
		const startTileY = 0

		const tiles = await loadVisibleTiles(startTileX, startTileY, cols, rows)

		// clear and draw whatever we have cached right now
		ctx.clearRect(0, 0, canvas.width, canvas.height)

		for (const tile of tiles) {
			const drawX = (tile.x - x) * size + offsetX
			const drawY = (y - tile.y) * size + offsetY
			ctx.drawImage(tile.img, drawX, drawY, size, size)
		}
	}

	onMount(async () => {
		width = canvas.width
		height = canvas.height
		await drawTiles()
	})

	let centerTile = $derived(`${x}-${y}`)
</script>

<canvas
	bind:this={canvas}
	class="h-full w-full"
	onmousedown={(event) => {
		isDragging = true
		startMouseX = event.clientX
		startMouseY = event.clientY
	}}
	onmousemove={(event) => {
		if (!isDragging) return

		const deltaX = event.clientX - startMouseX
		const deltaY = event.clientY - startMouseY

		offsetX += deltaX
		offsetY += deltaY

		startMouseX = event.clientX
		startMouseY = event.clientY

		drawTiles()
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
>
</canvas>
<input class="absolute top-24 z-50 mx-12 input w-24 bg-surface-500/60" readonly bind:value={centerTile} />
