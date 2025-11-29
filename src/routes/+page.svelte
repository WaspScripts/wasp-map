<script lang="ts">
	import { onMount } from "svelte"

	const map = "map"
	const zoom = "0"
	const plane = "0"

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

	const minX = 0
	const maxX = 99
	const minY = 0
	const maxY = 199

	let width = $state(0)
	let height = $state(0)

	const centerX = $derived(Math.round(width / 2))
	const centerY = $derived(Math.round(height / 2))

	const bufferX = $derived(Math.ceil(width / size))
	const bufferY = $derived(Math.ceil(height / size))

	const x1 = $derived(x - bufferX)
	const y1 = $derived(y - bufferY)
	const x2 = $derived(x + bufferX)
	const y2 = $derived(y + bufferY)

	const tileCache = new Map<string, ImageBitmap | null>()
	const tilePromises = new Map<string, Promise<ImageBitmap | null>>()
	const drawQueue: Array<{ key: string; img: ImageBitmap }> = []
	let drawQueueRunning = false

	async function loadTile(key: string, url: string) {
		if (tilePromises.has(key)) return tilePromises.get(key)

		const bmp = (async () => {
			try {
				const res = await fetch(url)
				const blob = await res.blob()
				const bitmap = await createImageBitmap(blob)
				tileCache.set(key, bitmap)
				enqueueTileForDraw(key, bitmap)
				return bitmap
			} catch {
				tileCache.set(key, null)
				return null
			}
		})()

		tilePromises.set(key, bmp)
		return bmp
	}

	function processDrawQueue() {
		const maxPerFrame = 5
		let i = 0

		while (i < maxPerFrame && drawQueue.length > 0) {
			const { key, img } = drawQueue.shift()!
			const [xx, yy] = key.split("-").map(Number)

			const drawX = centerX + (xx - x) * size + positionX - size / 2
			const drawY = centerY + (y - yy) * size + positionY - size / 2

			context.drawImage(img, drawX, drawY, size, size)
			i++
		}

		if (drawQueue.length > 0) {
			requestAnimationFrame(processDrawQueue)
		} else {
			drawQueueRunning = false
		}
	}

	function enqueueTileForDraw(key: string, img: ImageBitmap) {
		drawQueue.push({ key, img })

		if (!drawQueueRunning) {
			drawQueueRunning = true
			requestAnimationFrame(processDrawQueue)
		}
	}

	function drawTiles() {
		context.clearRect(0, 0, canvas.width, canvas.height)

		for (let xx = x1; xx <= x2; xx++) {
			for (let yy = y2; yy >= y1; yy--) {
				const key = `${xx}-${yy}`
				const cached = tileCache.get(key)

				if (cached) {
					// Already loaded > draw immediately
					const drawX = centerX + (xx - x) * size + positionX - size / 2
					const drawY = centerY + (y - yy) * size + positionY - size / 2
					context.drawImage(cached, drawX, drawY, size, size)
				} else {
					// Not loaded > enqueue async load
					if (!tilePromises.has(key)) {
						loadTile(key, `/${map}/${zoom}/${plane}/${xx}-${yy}.webp`)
					}
					// Leave tile black
				}
			}
		}
	}

	function onResize() {
		canvas.width = window.innerWidth
		canvas.height = window.innerHeight
		width = canvas.width
		height = canvas.height
	}

	onMount(() => {
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		context = ctx

		onResize()
		window.addEventListener("resize", onResize)
		drawTiles()
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

		mouseX = event.clientX
		mouseY = event.clientY

		positionX += deltaX
		positionY += deltaY

		if (Math.abs(positionX) >= size) {
			const delta = Math.trunc(positionX / size)
			x = Math.min(Math.max(x - delta, minX), maxX)
			positionX -= delta * size
		}

		if (Math.abs(positionY) >= size) {
			const delta = Math.trunc(positionY / size)
			y = Math.min(Math.max(y + delta, minY), maxY)
			positionY -= delta * size
		}

		drawTiles()
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
>
</canvas>
<input class="absolute top-24 z-50 mx-12 input w-24 bg-surface-500/60" readonly bind:value={centerTile} />
