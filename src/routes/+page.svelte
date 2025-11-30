<script lang="ts">
	import { onMount } from "svelte"
	import Clipboard from "@lucide/svelte/icons/clipboard"
	import ClipboardCheck from "@lucide/svelte/icons/clipboard-check"
	import ZoomIn from "@lucide/svelte/icons/zoom-in"
	import ZoomOut from "@lucide/svelte/icons/zoom-out"
	import ArrowUp from "@lucide/svelte/icons/arrow-up"
	import ArrowDown from "@lucide/svelte/icons/arrow-down"

	let map = $state("map")
	let zoom = $state(0)
	let plane = $state(0)
	let search = $state("")

	let canvas: HTMLCanvasElement
	let context: CanvasRenderingContext2D

	let isDragging = $state(false)

	let mouseX = $state(0)
	let mouseY = $state(0)
	let positionX = $state(0)
	let positionY = $state(0)

	const size = $derived(zoom >= 0 ? 256 * (zoom + 1) : 256)
	const maxZoom = 4
	const minZoom = -6
	const maxPlane = 3
	const minPlane = 0

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

	const step = $derived(zoom >= 0 ? 1 : 2 ** -zoom)
	const bufferX = $derived(Math.ceil((width / size) * step))
	const bufferY = $derived(Math.ceil((height / size) * step))

	const x1 = $derived(x - bufferX)
	const y1 = $derived(y - bufferY)
	const x2 = $derived(x + bufferX)
	const y2 = $derived(y + bufferY)

	const nearest = $derived(4 * Math.pow(2, -zoom - 1))
	const startX = $derived(step === 1 ? x1 : Math.floor(x1 / nearest) * nearest)
	const startY = $derived(step === 1 ? y2 : Math.floor(y2 / nearest) * nearest)

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
			const [, , , xx, yy] = key.split("-").map(Number)

			const drawX = centerX + ((xx - x) / step) * size + positionX - size / 2
			const drawY = centerY + ((y - yy) / step) * size + positionY - size / 2

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

		for (let xx = startX; xx <= x2; xx += step) {
			for (let yy = startY; yy >= y1; yy -= step) {
				const key = `${map}-${zoom}-${plane}-${xx}-${yy}`
				const cached = tileCache.get(key)

				if (cached) {
					const drawX = centerX + ((xx - x) / step) * size + positionX - size / 2
					const drawY = centerY + ((y - yy) / step) * size + positionY - size / 2
					context.drawImage(cached, drawX, drawY, size, size)
				} else {
					if (!tilePromises.has(key)) {
						loadTile(key, `/${map}/${zoom}/${plane}/${xx}-${yy}.webp`)
					}
				}
			}
		}
	}

	function onResize() {
		if (canvas) {
			canvas.width = window.innerWidth
			canvas.height = window.innerHeight
			width = window.innerWidth
			height = window.innerHeight
			drawTiles()
		}
	}

	onMount(() => {
		const ctx = canvas.getContext("2d")
		if (!ctx) return

		context = ctx

		window.addEventListener("resize", onResize)
		onResize()
	})

	let centerTile = $derived(`${x}-${y}`)
	let copiedCenterTile = $state(false)
</script>

<canvas
	bind:this={canvas}
	onwheel={(event) => {
		if (event.deltaY > 0) {
			zoom = Math.max(zoom - 1, minZoom)
			drawTiles()
		} else {
			zoom = Math.min(zoom + 1, maxZoom)
			drawTiles()
		}
	}}
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

		if (Math.abs(positionX) >= size / step) {
			const delta = Math.trunc(positionX / size / step)
			x = Math.min(Math.max(x - delta, minX), maxX)
			positionX -= delta * (size / step)
		}

		if (Math.abs(positionY) >= size / step) {
			const delta = Math.trunc(positionY / size / step)
			y = Math.min(Math.max(y + delta, minY), maxY)
			positionY -= delta * (size / step)
		}

		drawTiles()
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
	class="cursor-pointer"
>
</canvas>

<div class="pointer-events-none absolute inset-0 z-50 mx-4 my-24 flex justify-between">
	<div class="flex w-fit flex-col gap-2">
		<button
			class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
			type="button"
			onclick={async () => {
				await navigator.clipboard.writeText(centerTile)
				copiedCenterTile = true
				setTimeout(() => (copiedCenterTile = false), 2000)
			}}
		>
			<span class="w-18 truncate">{centerTile}</span>
			{#if copiedCenterTile}
				<ClipboardCheck class="h-4" />
			{:else}
				<Clipboard class="h-4" />
			{/if}
		</button>

		<select
			class="pointer-events-auto select btn w-full bg-surface-500/80 p-2"
			bind:value={map}
			onchange={() => drawTiles()}
		>
			<option value="map">Map</option>
			<option value="heightmap">Heightmap</option>
			<option value="collision">Collision</option>
		</select>
	</div>

	<div class="flex flex-col">
		<input
			type="search"
			inputmode="search"
			class="pointer-events-auto input w-64 bg-surface-500/80"
			bind:value={search}
			placeholder="🔎 Search..."
			onchange={() => drawTiles()}
		/>
	</div>

	<div class="flex flex-col gap-6">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async () => {
					zoom = Math.min(zoom + 1, maxZoom)
					drawTiles()
				}}
			>
				<ZoomIn class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async () => {
					zoom = Math.max(zoom - 1, minZoom)
					drawTiles()
				}}
			>
				<ZoomOut class="h-4" />
			</button>
		</div>

		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async () => {
					plane = Math.min(plane + 1, maxPlane)
					drawTiles()
				}}
			>
				<ArrowUp class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async () => {
					plane = Math.max(plane - 1, minPlane)
					drawTiles()
				}}
			>
				<ArrowDown class="h-4" />
			</button>
		</div>
	</div>
</div>
