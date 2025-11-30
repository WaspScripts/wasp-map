<script lang="ts">
	import { onMount } from "svelte"
	import Clipboard from "@lucide/svelte/icons/clipboard"
	import ClipboardCheck from "@lucide/svelte/icons/clipboard-check"
	import ZoomIn from "@lucide/svelte/icons/zoom-in"
	import ZoomOut from "@lucide/svelte/icons/zoom-out"
	import ArrowUp from "@lucide/svelte/icons/arrow-up"
	import ArrowDown from "@lucide/svelte/icons/arrow-down"
	import Grid2x2Check from "@lucide/svelte/icons/grid-2x2-check"
	import Grid2x2X from "@lucide/svelte/icons/grid-2x2-x"
	import { Switch } from "@skeletonlabs/skeleton-svelte"

	const TILE_MARGIN = 2

	let map = $state("map")
	let zoom = $state(0)
	let plane = $state(0)
	let search = $state("")
	let grid = $state(false)

	let canvas: HTMLCanvasElement
	let context: CanvasRenderingContext2D

	let isDragging = $state(false)

	let mouseX = $state(0)
	let mouseY = $state(0)

	let positionX = $state(0)
	let positionY = $state(0)

	let x = $state(47)
	let y = $state(55)

	let width = $state(0)
	let height = $state(0)

	let copiedCenterTile = $state(false)

	const size = $derived(zoom >= 0 ? 256 * (zoom + 1) : 256)
	const maxZoom = 4
	const minZoom = -4
	const maxPlane = 3
	const minPlane = 0
	const minX = 0
	const maxX = 99
	const minY = 0
	const maxY = 199

	const centerX = $derived(Math.round(width / 2))
	const centerY = $derived(Math.round(height / 2))

	const step = $derived(zoom >= 0 ? 1 : 2 ** -zoom)

	const effectiveTileSize = $derived(size / step)

	const screenMapUnitsX = $derived((width / size) * step)
	const screenMapUnitsY = $derived((height / size) * step)

	const bufferX = $derived(Math.ceil(screenMapUnitsX / 2) + TILE_MARGIN * step)
	const bufferY = $derived(Math.ceil(screenMapUnitsY / 2) + TILE_MARGIN * step)

	const x1 = $derived(x - bufferX)
	const y1 = $derived(y - bufferY)
	const x2 = $derived(x + bufferX)
	const y2 = $derived(y + bufferY)

	const nearest = $derived(4 * Math.pow(2, -zoom - 1))
	const startX = $derived(step === 1 ? x1 : Math.floor(x1 / nearest) * nearest)
	const startY = $derived(step === 1 ? y2 : Math.floor(y2 / nearest) * nearest)

	let centerTile = $derived(`${x}-${y}`)

	const tileCache = new Map<string, ImageBitmap | null>()
	const tilePromises = new Map<string, Promise<ImageBitmap | null>>()

	let needsRedraw = $state(false)

	function pruneTileCache() {
		const currentKeys = new Set<string>()
		for (let xx = startX; xx <= x2; xx += step) {
			for (let yy = startY; yy >= y1; yy -= step) {
				currentKeys.add(`${map}-${zoom}-${plane}-${xx}-${yy}`)
			}
		}

		for (const key of tileCache.keys()) {
			if (!currentKeys.has(key)) {
				const bitmap = tileCache.get(key)
				tileCache.delete(key)
				tilePromises.delete(key)
				if (bitmap instanceof ImageBitmap) {
					bitmap.close()
				}
			}
		}
	}

	async function loadTile(key: string, url: string) {
		if (tilePromises.has(key)) return tilePromises.get(key)

		const bmp = (async () => {
			try {
				const res = await fetch(url)
				const blob = await res.blob()
				const bitmap = await createImageBitmap(blob)
				tileCache.set(key, bitmap)

				scheduleRedraw()
				return bitmap
			} catch (e) {
				tileCache.set(key, null)
				return null
			}
		})()

		tilePromises.set(key, bmp)
		return bmp
	}

	function scheduleRedraw() {
		if (!needsRedraw) {
			needsRedraw = true
			requestAnimationFrame(redrawLoop)
		}
	}

	function redrawLoop() {
		if (!context || !canvas) return

		drawTiles()
		needsRedraw = false
	}

	function drawTiles() {
		context.clearRect(0, 0, canvas.width, canvas.height)

		context.save()
		context.translate(positionX, positionY)

		const halfSize = size / 2
		const data: { drawX: number; drawY: number; x: number; y: number }[] = []

		for (let xx = startX; xx <= x2; xx += step) {
			for (let yy = startY; yy >= y1; yy -= step) {
				const key = `${map}-${zoom}-${plane}-${xx}-${yy}`
				const cached = tileCache.get(key)

				const drawX = centerX + ((xx - x) / step) * size - halfSize
				const drawY = centerY + ((y - yy) / step) * size - halfSize
				data.push({ drawX, drawY, x: xx, y: yy })

				if (cached) {
					context.drawImage(cached, drawX, drawY, size, size)
				} else if (cached === undefined) {
					if (!tilePromises.has(key)) {
						loadTile(key, `/${map}/${zoom}/${plane}/${xx}-${yy}.webp`)
					}
				}
			}
		}

		if (grid && zoom > -1) {
			context.font = `normal ${(24 * size) / 256}px Courier New`
			context.textAlign = "center"
			context.textBaseline = "middle"
			context.fillStyle = "white"
			context.lineWidth = (2 * size) / 256
			context.strokeStyle = "white"

			for (let i = 0; i < data.length; i++) {
				context.beginPath()
				context.strokeRect(data[i].drawX, data[i].drawY, size, size)
				context.closePath()

				const textX = data[i].drawX + halfSize
				const textY = data[i].drawY + halfSize
				const coordText = `${data[i].x},${data[i].y}`
				context.strokeText(coordText, textX, textY)
				context.fillText(coordText, textX, textY)
			}
		}

		context.restore()
	}

	function redrawAndPrune() {
		pruneTileCache()
		scheduleRedraw()
	}

	function onResize() {
		if (canvas) {
			canvas.width = window.innerWidth
			canvas.height = window.innerHeight
			width = window.innerWidth
			height = window.innerHeight
			redrawAndPrune()
		}
	}

	function handleZoom(delta: number) {
		if (delta > 0) {
			zoom = Math.max(zoom - 1, minZoom)
		} else {
			zoom = Math.min(zoom + 1, maxZoom)
		}

		positionX = 0
		positionY = 0
		redrawAndPrune()
	}

	onMount(() => {
		const ctx = canvas.getContext("2d", { alpha: false })
		if (!ctx) return

		context = ctx

		window.addEventListener("resize", onResize)
		onResize()

		return () => {
			window.removeEventListener("resize", onResize)
		}
	})
</script>

<canvas
	bind:this={canvas}
	onwheel={(event) => {
		event.preventDefault()
		handleZoom(event.deltaY)
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

		if (Math.abs(positionX) >= effectiveTileSize) {
			const delta = Math.trunc(positionX / effectiveTileSize)
			x = Math.min(Math.max(x - delta, minX), maxX)
			positionX -= delta * effectiveTileSize

			redrawAndPrune()
		}

		if (Math.abs(positionY) >= effectiveTileSize) {
			const delta = Math.trunc(positionY / effectiveTileSize)
			y = Math.min(Math.max(y + delta, minY), maxY)
			positionY -= delta * effectiveTileSize

			redrawAndPrune()
		}

		scheduleRedraw()
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
	class="cursor-grab active:cursor-grabbing"
>
</canvas>

<div class="pointer-events-none absolute inset-0 z-50 mx-4 mt-24 mb-4 flex justify-between">
	<div class="flex w-fit flex-col justify-between gap-2">
		<div class="w-around flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-32 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
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
				class="pointer-events-auto select btn w-32 bg-surface-500/80 p-2"
				bind:value={map}
				onchange={redrawAndPrune}
			>
				<option value="map">Map</option>
				<option value="heightmap">Heightmap</option>
				<option value="collision">Collision</option>
			</select>
		</div>
		<div class="rounded-md preset-outlined-surface-500 bg-surface-500/80 p-2">
			Copy coordinate:
			<kbd class="kbd">CTRL + SPACE</kbd>
		</div>
	</div>

	<div class="flex flex-col">
		<input
			type="search"
			inputmode="search"
			class="pointer-events-auto input w-64 bg-surface-500/80"
			bind:value={search}
			placeholder="🔎 Search..."
			onchange={redrawAndPrune}
		/>
	</div>

	<div class="flex flex-col gap-6">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => handleZoom(0)}
			>
				<ZoomIn class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => handleZoom(1)}
			>
				<ZoomOut class="h-4" />
			</button>
		</div>

		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => {
					plane = Math.min(plane + 1, maxPlane)
					redrawAndPrune()
				}}
			>
				<ArrowUp class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => {
					plane = Math.max(plane - 1, minPlane)
					redrawAndPrune()
				}}
			>
				<ArrowDown class="h-4" />
			</button>
		</div>

		<Switch
			class="pointer-events-auto mx-auto"
			defaultChecked={grid}
			onCheckedChange={(e) => {
				grid = e.checked
				redrawAndPrune()
			}}
		>
			<Switch.Control class="scale-150 preset-outlined-surface-500 bg-surface-500/80">
				<Switch.Thumb class="preset-filled-surface-200-800">
					<Switch.Context>
						{#snippet children(switch_)}
							{#if switch_().checked}
								<Grid2x2Check class="size-3" />
							{:else}
								<Grid2x2X class="size-3" />
							{/if}
						{/snippet}
					</Switch.Context>
				</Switch.Thumb>
			</Switch.Control>
			<Switch.HiddenInput />
		</Switch>
	</div>
</div>
