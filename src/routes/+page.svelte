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

	const size = 256
	const maxZoom = 8
	const minZoom = -4
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
			const [, , , xx, yy] = key.split("-").map(Number)

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
				const key = `${map}-${zoom}-${plane}-${xx}-${yy}`
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
		drawTiles()
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

<div class="pointer-events-none absolute inset-0 z-50 mx-4 my-24 flex justify-between">
	<div class="flex w-fit flex-col gap-2">
		<button
			class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
			type="button"
			onclick={async (e) => {
				e.preventDefault()
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

	<div class="flex flex-col gap-4">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async (e) => {
					e.preventDefault()
					zoom = Math.min(zoom + 1, maxZoom)
					drawTiles()
				}}
			>
				<ZoomIn class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async (e) => {
					e.preventDefault()
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
				onclick={async (e) => {
					e.preventDefault()
					plane = Math.min(plane + 1, maxPlane)
					drawTiles()
				}}
			>
				<ArrowUp class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={async (e) => {
					e.preventDefault()
					plane = Math.max(plane - 1, minPlane)
					drawTiles()
				}}
			>
				<ArrowDown class="h-4" />
			</button>
		</div>
	</div>
</div>
