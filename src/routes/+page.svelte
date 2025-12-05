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
	import MapMinus from "@lucide/svelte/icons/map-minus"
	import MapPlus from "@lucide/svelte/icons/map-plus"
	import { Switch } from "@skeletonlabs/skeleton-svelte"
	import { page } from "$app/state"
	import { goto } from "$app/navigation"
	import { getCookie, setCookie } from "$lib/utils"

	const TILE_SIZE = 4
	const MAP_TILE_SIZE = 256
	const maxZoom = 0
	const minZoom = -4
	const trueMaxZoom = 6
	const trueMinZoom = -6

	const multipliers = [0.5, 0.75, 1, 1, 1, 1, 1, 2, 4, 8, 16, 32, 64]

	const maxPlane = 3
	const minPlane = 0
	const minX = 0
	const maxX = 99
	const minY = 0
	const maxY = 199

	let map = $state(page.url.searchParams.get("map") ?? "map")

	let trueZoom = $state(Number(page.url.searchParams.get("zoom") ?? "0"))
	let zoom = $derived(clamp(trueZoom, minZoom, maxZoom))
	let plane = $state(clamp(Number(page.url.searchParams.get("plane") ?? "0"), minPlane, maxPlane))
	let search = $state("")
	let grid = $state(true)
	let coordinates = $state(true)
	let copied = $state([false, false])
	const multiplier = $derived(multipliers[trueZoom + Math.abs(trueMinZoom)])

	let canvas: HTMLCanvasElement
	let context: CanvasRenderingContext2D

	let isDragging = false

	let mouseX = 0
	let mouseY = 0
	let positionX = 0
	let positionY = 0

	let x = $state(47)
	let y = $state(55)

	let width = $state(0)
	let height = $state(0)

	const size = $derived(zoom == trueZoom ? MAP_TILE_SIZE : MAP_TILE_SIZE * multiplier)

	const halfSize = $derived(size / 2)

	const centerX = $derived(width / 2)
	const centerY = $derived(height / 2)

	const step = $derived(trueZoom >= 0 ? 1 : 2 ** -trueZoom)

	const effectiveTileSize = $derived(size / step)

	const bufferX = $derived(Math.ceil(((width / size) * step) / 2) + 2 * step)
	const bufferY = $derived(Math.ceil(((height / size) * step) / 2) + 2 * step)

	const x1 = $derived(Math.max(step === 1 ? x - bufferX : Math.floor((x - bufferX) / step) * step, minX))
	const y1 = $derived(Math.max(y - bufferY, minY))
	const x2 = $derived(Math.min(x + bufferX, maxX))
	const y2 = $derived(Math.min(step === 1 ? y + bufferY : Math.floor((y + bufferY) / step) * step, maxY))

	const tileCache = new Map<string, ImageBitmap | null>()
	const tilePromises = new Map<string, Promise<ImageBitmap | null>>()

	let mouseMapX = $state(0)
	let mouseMapY = $state(0)

	const hoveredChunk = $derived(`${Math.floor(mouseMapX)},${Math.floor(mouseMapY)}`)

	const hoverX = $derived((Math.round((mouseMapX * MAP_TILE_SIZE) / TILE_SIZE) * TILE_SIZE) / MAP_TILE_SIZE)

	const hoverY = $derived(
		(Math.round(((mouseMapY - 1) * MAP_TILE_SIZE) / TILE_SIZE) * TILE_SIZE) / MAP_TILE_SIZE
	)

	const rsX = $derived(Math.round(hoverX * MAP_TILE_SIZE))
	const rsY = $derived(Math.round((hoverY + 1) * MAP_TILE_SIZE) - TILE_SIZE * 2)

	const getKey = (x: number, y: number) => `${map}-${zoom}-${plane}-${x}-${y}`

	async function copyToClipboard(index: number, value: string) {
		await navigator.clipboard.writeText(value)
		copied[index] = true
		setTimeout(() => (copied[index] = false), 2000)
	}

	async function loadTile(key: string, url: string) {
		if (tilePromises.has(key)) return tilePromises.get(key)

		const bmp = (async () => {
			try {
				const res = await fetch(url)
				const blob = await res.blob()
				const bitmap = await createImageBitmap(blob)
				tileCache.set(key, bitmap)

				requestAnimationFrame(drawTiles)
				return bitmap
			} catch (e) {
				tileCache.set(key, null)
				return null
			}
		})()

		tilePromises.set(key, bmp)
		return bmp
	}

	function mapToScreen(vx: number, vy: number) {
		return {
			x: Math.round(centerX + ((vx - x) / step) * size - halfSize),
			y: Math.round(centerY + ((y - vy) / step) * size - halfSize)
		}
	}

	function drawTiles() {
		context.clearRect(0, 0, canvas.width, canvas.height)

		context.save()
		context.translate(positionX, positionY)
		const data: { drawX: number; drawY: number; x: number; y: number }[] = []

		context.imageSmoothingEnabled = false

		for (let x = x1; x <= x2; x += step) {
			//console.log(x)
			for (let y = y2; y >= y1; y -= step) {
				const key = getKey(x, y)
				const cached = tileCache.get(key)
				const { x: drawX, y: drawY } = mapToScreen(x, y)
				data.push({ drawX, drawY, x, y })

				if (cached === null) continue

				if (cached) {
					context.drawImage(cached, drawX, drawY, size, size)
					continue
				}

				if (!tilePromises.has(key)) {
					loadTile(key, `/api/${map}/${zoom}/${plane}/${x}-${y}.webp`)
				}
			}
		}

		if (trueZoom >= -2) {
			if (grid) {
				const fontSize = 32 * (effectiveTileSize / MAP_TILE_SIZE)

				context.font = `normal ${fontSize}px Courier New`
				context.textAlign = "center"
				context.textBaseline = "middle"
				context.fillStyle = "white"
				context.lineWidth = (2 * effectiveTileSize) / MAP_TILE_SIZE

				const mid = effectiveTileSize / 2
				for (let i = 0; i < data.length; i++) {
					const tile = data[i]

					for (let sx = 0; sx < step; sx++) {
						for (let sy = 0; sy < step; sy++) {
							const tx = tile.x + sx
							if (tx < minX || tx > maxX) continue
							const ty = tile.y - sy
							if (ty < minY || ty > maxY) continue

							const gx = tile.drawX + sx * effectiveTileSize
							const gy = tile.drawY + sy * effectiveTileSize

							context.strokeStyle = trueZoom >= 0 ? "white" : "rgba(255, 255, 255, 0.5)"
							context.strokeRect(gx, gy, effectiveTileSize, effectiveTileSize)

							const textX = gx + mid
							const textY = gy + mid

							const label = `${tx},${ty}`
							context.strokeStyle = "white"
							context.strokeText(label, textX, textY)
							context.fillText(label, textX, textY)
						}
					}
				}
			}

			if (trueZoom >= 1) {
				const { x: drawX, y: drawY } = mapToScreen(hoverX, hoverY)

				context.lineWidth = 2
				context.fillStyle = "rgba(255, 165, 0, 0.3)"
				const scaled = Math.round(multiplier * TILE_SIZE)
				context.fillRect(drawX, drawY, scaled, scaled)
				context.strokeStyle = "orange"
				context.strokeRect(drawX, drawY, scaled, scaled)
			}
		}

		context.restore()
	}

	function changeZoom(value: number) {
		trueZoom = clamp(trueZoom + value, trueMinZoom, trueMaxZoom)

		requestAnimationFrame(drawTiles)
		let query = new URLSearchParams(page.url.searchParams.toString())
		query.set("zoom", trueZoom.toString())
		goto(`?${query.toString()}`)
	}

	function changePlane(value: number) {
		plane = clamp(plane + value, minPlane, maxPlane)

		requestAnimationFrame(drawTiles)
		let query = new URLSearchParams(page.url.searchParams.toString())
		query.set("plane", plane.toString())
		goto(`?${query.toString()}`)
	}

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value))
	}

	//listeners
	function onResize() {
		if (canvas) {
			canvas.width = window.innerWidth
			canvas.height = window.innerHeight
			width = window.innerWidth
			height = window.innerHeight
			requestAnimationFrame(drawTiles)
		}
	}

	async function onKeyboard(e: KeyboardEvent) {
		if (!e.ctrlKey) return

		switch (e.code) {
			case "Space":
				e.preventDefault()
				await copyToClipboard(0, coordinates ? `${rsX}, ${rsY}` : `${rsX / TILE_SIZE}, ${rsY / TILE_SIZE}`)
				break

			case "KeyC":
				e.preventDefault()
				await copyToClipboard(1, hoveredChunk)
				break

			default:
				break
		}
	}

	onMount(() => {
		const ctx = canvas.getContext("2d", { alpha: false })
		if (!ctx) return

		context = ctx
		context.imageSmoothingEnabled = false

		window.addEventListener("resize", onResize)
		document.addEventListener("keydown", onKeyboard)
		onResize()

		if (getCookie("grid") != "") grid = getCookie("grid") === "true"
		if (getCookie("simbacoords") != "") coordinates = getCookie("simbacoords") === "true"

		return () => {
			window.removeEventListener("resize", onResize)
			document.removeEventListener("keydown", onKeyboard)
		}
	})
</script>

<canvas
	bind:this={canvas}
	onwheel={(event) => {
		event.preventDefault()
		changeZoom(event.deltaY >= 0 ? -1 : 1)
	}}
	onmousedown={(event) => {
		isDragging = true
		mouseX = event.clientX
		mouseY = event.clientY
	}}
	onmousemove={(event) => {
		const { clientX, clientY } = event
		mouseMapX = clamp(((clientX - positionX - centerX + halfSize) / size) * step + x, minX, maxX)
		mouseMapY = clamp(y + 1 - ((clientY - positionY - centerY + halfSize) / size) * step, minY, maxY)

		if (!isDragging) {
			requestAnimationFrame(drawTiles)
			return
		}

		const deltaX = clientX - mouseX
		const deltaY = clientY - mouseY

		mouseX = clientX
		mouseY = clientY

		positionX += deltaX
		positionY += deltaY

		if (Math.abs(positionX) >= effectiveTileSize) {
			const delta = Math.trunc(positionX / effectiveTileSize)
			x = clamp(x - delta, minX, maxX)
			positionX -= delta * effectiveTileSize
		}

		if (Math.abs(positionY) >= effectiveTileSize) {
			const delta = Math.trunc(positionY / effectiveTileSize)
			y = Math.min(Math.max(y + delta, minY), maxY)
			positionY -= delta * effectiveTileSize
		}

		requestAnimationFrame(drawTiles)
	}}
	onmouseup={() => (isDragging = false)}
	onmouseleave={() => (isDragging = false)}
	class=" active:cursor-grabbing"
>
</canvas>

<div class="pointer-events-none absolute inset-0 z-50 mx-2 mt-22 mb-2 flex justify-between">
	<div class="flex w-fit flex-col justify-between gap-2">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80 text-sm"
				class:text-success-500={copied[0]}
				type="button"
				onclick={async () =>
					await copyToClipboard(0, coordinates ? `${rsX}, ${rsY}` : `${rsX / TILE_SIZE}, ${rsY / TILE_SIZE}`)}
			>
				{coordinates ? `Coordinate: ${rsX}, ${rsY}` : `RSCoordinate: ${rsX / TILE_SIZE}, ${rsY / TILE_SIZE}`}
				{#if copied[0]}
					<ClipboardCheck class="h-4" />
				{:else}
					<Clipboard class="h-4" />
				{/if}
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80 text-sm"
				class:text-success-500={copied[1]}
				type="button"
				onclick={async () => await copyToClipboard(1, hoveredChunk)}
			>
				Chunk: {hoveredChunk}
				{#if copied[1]}
					<ClipboardCheck class="h-4" />
				{:else}
					<Clipboard class="h-4" />
				{/if}
			</button>

			<select
				class="pointer-events-auto select btn w-32 bg-surface-500/80 p-2 text-sm"
				bind:value={map}
				onchange={() => {
					requestAnimationFrame(drawTiles)
					let query = new URLSearchParams(page.url.searchParams.toString())
					query.set("map", map)
					goto(`?${query.toString()}`)
				}}
			>
				<option value="map">Map</option>
				<option value="heightmap">Heightmap</option>
				<option value="collision">Collision</option>
			</select>
		</div>
		<div class="flex flex-col gap-2">
			<div class="hidden w-fit rounded-md preset-outlined-surface-500 bg-surface-500/80 p-2 text-sm md:block">
				Copy chunk:
				<kbd class="kbd">CTRL + C</kbd>
			</div>
			<div class="hidden w-fit rounded-md preset-outlined-surface-500 bg-surface-500/80 p-2 text-sm md:block">
				Copy coordinate:
				<kbd class="kbd">CTRL + SPACE</kbd>
			</div>
		</div>
	</div>

	<div class="flex flex-col">
		<input
			type="search"
			inputmode="search"
			class="pointer-events-auto input w-64 bg-surface-500/80"
			bind:value={search}
			placeholder="🔎 Search..."
			onchange={() => {
				requestAnimationFrame(drawTiles)
				let query = new URLSearchParams(page.url.searchParams.toString())
				query.set("search", search)
				goto(`?${query.toString()}`)
			}}
		/>
	</div>

	<div class="flex flex-col gap-6">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => changeZoom(1)}
			>
				<ZoomIn class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => changeZoom(-1)}
			>
				<ZoomOut class="h-4" />
			</button>
		</div>

		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => changePlane(1)}
			>
				<ArrowUp class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => changePlane(-1)}
			>
				<ArrowDown class="h-4" />
			</button>
		</div>

		<Switch
			class="pointer-events-auto mx-auto"
			checked={grid}
			onCheckedChange={(e) => {
				grid = e.checked
				requestAnimationFrame(drawTiles)
				setCookie("grid", grid.toString(), 360)
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

		<Switch
			class="pointer-events-auto mx-auto"
			checked={coordinates}
			onCheckedChange={(e) => {
				coordinates = e.checked
				setCookie("simbacoords", coordinates.toString(), 360)
			}}
		>
			<Switch.Control class="scale-150 preset-outlined-surface-500 bg-surface-500/80">
				<Switch.Thumb class="preset-filled-surface-200-800">
					<Switch.Context>
						{#snippet children(switch_)}
							{#if switch_().checked}
								<MapPlus class="size-3" />
							{:else}
								<MapMinus class="size-3" />
							{/if}
						{/snippet}
					</Switch.Context>
				</Switch.Thumb>
			</Switch.Control>
			<Switch.HiddenInput />
		</Switch>
	</div>
</div>
