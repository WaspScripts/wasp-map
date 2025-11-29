<script lang="ts">
	import { onMount } from "svelte"

	let canvas: HTMLCanvasElement
	let context: CanvasRenderingContext2D

	let isDragging = $state(false)

	let mouseX = $state(0)
	let mouseY = $state(0)
	let positionX = $state(0)
	let positionY = $state(0)

	const size = 256

	let x = $state(47)
	let y = $state(55)

	let width = $state(0)
	let height = $state(0)

	const centerX = $derived(Math.round(width / 2))
	const centerY = $derived(Math.round(height / 2))

	/*
	const bufferX = $derived(Math.ceil((width / size) * 1.1))
	const bufferY = $derived(Math.ceil((height / size) * 1.1))
	*/

	const bufferX = 1
	const bufferY = 1

	const x1 = $derived(x - bufferX)
	const y1 = $derived(y - bufferY)
	const x2 = $derived(x + bufferX)
	const y2 = $derived(y + bufferY)

	function loadImage(src: string) {
		return new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image()
			img.onload = () => resolve(img)
			img.onerror = () => reject(`Failed to load ${src}`)
			img.src = src
		})
	}

	const tileCache = new Map<string, HTMLImageElement>()

	async function loadVisibleTiles() {
		const tiles: { x: number; y: number; img: HTMLImageElement | null }[] = []

		for (let x = x1; x <= x2; x++) {
			for (let y = y2; y >= y1; y--) {
				const key = `${x}-${y}`
				if (tileCache.has(key)) {
					tiles.push({ x: x, y: y, img: tileCache.get(key)! })
					continue
				}

				try {
					const img = await loadImage(`/wasp-map-layers/map/0/${x}-${y}.png`)
					tileCache.set(key, img)
					tiles.push({ x: x, y: y, img })
				} catch (e) {
					console.error(e)
					tiles.push({ x: x, y: y, img: null })
				}
			}
		}

		return tiles
	}

	async function drawTiles() {
		const tiles = loadVisibleTiles()
		context.clearRect(0, 0, canvas.width, canvas.height)

		for (const tile of await tiles) {
			if (!tile.img) continue
			const drawX = centerX + (tile.x - x) * size + positionX - size / 2
			const drawY = centerY + (y - tile.y) * size + positionY - size / 2
			context.drawImage(tile.img, drawX, drawY, size, size)
		}
	}

	function onResize() {
		canvas.width = window.innerWidth
		canvas.height = window.innerHeight
		width = canvas.width
		height = canvas.height
	}

	onMount(async () => {
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		context = ctx

		onResize()
		window.addEventListener("resize", onResize)
		await drawTiles()
	})

	let centerTile = $derived(`${x}-${y}`)
</script>

<canvas
	bind:this={canvas}
	onmousedown={(event) => {
		isDragging = true
		mouseX = event.clientX
		mouseY = event.clientY
	}}
	onmousemove={(event) => {
		if (!isDragging) return

		const deltaX = event.clientX - mouseX
		const deltaY = event.clientY - mouseY

		positionX += deltaX
		positionY += deltaY

		if (Math.abs(positionX) >= size) {
			x -= Math.floor(positionX / size)
			positionX = 0
		}

		if (Math.abs(positionY) >= size) {
			y += Math.floor(positionY / size)
			positionY = 0
		}

		mouseX = event.clientX
		mouseY = event.clientY

		drawTiles()
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
>
</canvas>
<input class="absolute top-24 z-50 mx-12 input w-24 bg-surface-500/60" readonly bind:value={centerTile} />
