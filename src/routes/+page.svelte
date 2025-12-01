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

	const TILE_SIZE = 4
	const MAP_TILE_SIZE = 256
	const maxZoom = 4
	const minZoom = -4
	const maxPlane = 3
	const minPlane = 0
	const minX = 0
	const maxX = 99
	const minY = 0
	const maxY = 199

	let map = $state(page.url.searchParams.get("map") ?? "map")
	let zoom = $state(Number(page.url.searchParams.get("zoom") ?? "0"))
	let plane = 0
	let search = $state("")
	let grid = $state(true)
	let simbaCoordinates = $state(true)
	let copiedChunk = $state(false)
	let copiedCoordinate = $state(false)

	let canvas: HTMLCanvasElement
	let context: CanvasRenderingContext2D

	let isDragging = false

	let mouseX = 0
	let mouseY = 0
	let positionX = 0
	let positionY = 0

	let x = 47
	let y = 55
	let width = 0
	let height = 0

	const size = $derived(zoom >= 0 ? MAP_TILE_SIZE * (zoom + 1) : MAP_TILE_SIZE)

	const centerX = $derived(Math.round(width / 2))
	const centerY = $derived(Math.round(height / 2))

	const step = $derived(zoom >= 0 ? 1 : 2 ** -zoom)

	const effectiveTileSize = $derived(size / step)

	const screenMapUnitsX = $derived((width / size) * step)
	const screenMapUnitsY = $derived((height / size) * step)

	const bufferX = $derived(Math.ceil(screenMapUnitsX / 2) + 2 * step)
	const bufferY = $derived(Math.ceil(screenMapUnitsY / 2) + 2 * step)

	const x1 = $derived(x - bufferX)
	const y1 = $derived(y - bufferY)
	const x2 = $derived(x + bufferX)
	const y2 = $derived(y + bufferY)

	const nearest = $derived(4 * Math.pow(2, -zoom - 1))
	const startX = $derived(step === 1 ? x1 : Math.floor(x1 / nearest) * nearest)
	const startY = $derived(step === 1 ? y2 : Math.floor(y2 / nearest) * nearest)

	const tileCache = new Map<string, ImageBitmap | null>()
	const tilePromises = new Map<string, Promise<ImageBitmap | null>>()

	let mouseMapX = $state(0)
	let mouseMapY = $state(0)

	const hoveredChunk = $derived(`${Math.floor(mouseMapX)},${Math.floor(mouseMapY)}`)

	const rsX = $derived(Math.round((mouseMapX * MAP_TILE_SIZE) / TILE_SIZE))
	const rsY = $derived(Math.round((mouseMapY * MAP_TILE_SIZE) / TILE_SIZE))

	const mapX = $derived(rsX * 4)
	const mapY = $derived(rsY * 4)
	const scaledTile = $derived((TILE_SIZE * size) / MAP_TILE_SIZE)

	function getKey(x: number, y: number) {
		return `${map}-${zoom}-${plane}-${x}-${y}`
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

	function mapToScreen(vx: number, vy: number, hlfSize: number) {
		return {
			x: centerX + ((vx - x) / step) * size - hlfSize,
			y: centerY + ((y - vy) / step) * size - hlfSize
		}
	}

	function drawTiles() {
		context.clearRect(0, 0, canvas.width, canvas.height)

		context.save()
		context.translate(positionX, positionY)

		const halfSize = size / 2
		const data: { drawX: number; drawY: number; x: number; y: number }[] = []

		for (let xx = Math.max(startX, minX); xx <= Math.min(x2, maxX); xx += step) {
			for (let yy = Math.min(startY, maxY); yy >= Math.max(y1, minY); yy -= step) {
				const key = getKey(xx, yy)
				const cached = tileCache.get(key)
				const { x: drawX, y: drawY } = mapToScreen(xx, yy, halfSize)
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

		if (zoom >= -2) {
			if (grid) {
				const sub = size / step
				const fontSize = 32 * (sub / MAP_TILE_SIZE)

				context.font = `normal ${fontSize}px Courier New`
				context.textAlign = "center"
				context.textBaseline = "middle"
				context.fillStyle = "white"
				context.lineWidth = (2 * sub) / MAP_TILE_SIZE
				context.strokeStyle = "white"

				for (let i = 0; i < data.length; i++) {
					const tile = data[i]

					for (let sx = 0; sx < step; sx++) {
						for (let sy = 0; sy < step; sy++) {
							const tx = tile.x + sx
							if (tx < minX || tx > maxX) continue
							const ty = tile.y - sy
							if (ty < minY || ty > maxY) continue

							const gx = tile.drawX + sx * sub
							const gy = tile.drawY + sy * sub

							context.strokeRect(gx, gy, sub, sub)

							const textX = gx + sub / 2
							const textY = gy + sub / 2

							const label = `${tx},${ty}`
							context.strokeText(label, textX, textY)
							context.fillText(label, textX, textY)
						}
					}
				}
			}

			let approxX = (rsX * TILE_SIZE) / MAP_TILE_SIZE
			let approxY = (Math.round(((mouseMapY - 1) * MAP_TILE_SIZE) / TILE_SIZE) * TILE_SIZE) / MAP_TILE_SIZE

			const { x: drawX, y: drawY } = mapToScreen(approxX, approxY, halfSize)

			context.lineWidth = 2
			context.fillStyle = "rgba(255, 165, 0, 0.3)"
			context.fillRect(drawX, drawY, scaledTile, scaledTile)
			context.strokeStyle = "orange"
			context.strokeRect(drawX, drawY, scaledTile, scaledTile)
		}

		context.restore()
	}

	function handleZoom(delta: number) {
		zoom = Math.min(maxZoom, Math.max(minZoom, zoom + (delta > 0 ? -1 : 1)))
		positionX = 0
		positionY = 0
		requestAnimationFrame(drawTiles)
		let query = new URLSearchParams(page.url.searchParams.toString())
		query.set("zoom", zoom.toString())
		goto(`?${query.toString()}`)
	}

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value))
	}

	function getCookie(cname: string) {
		let name = cname + "="
		let decodedCookie = decodeURIComponent(document.cookie)
		let ca = decodedCookie.split(";")
		for (let i = 0; i < ca.length; i++) {
			let c = ca[i]
			while (c.charAt(0) == " ") {
				c = c.substring(1)
			}
			if (c.indexOf(name) == 0) {
				return c.substring(name.length, c.length)
			}
		}
		return ""
	}

	function setCookie(cname: string, cvalue: string, exdays: number) {
		const d = new Date()
		d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000)
		let expires = "expires=" + d.toUTCString()
		document.cookie = cname + "=" + cvalue + ";" + expires + ";path=/"
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
				await navigator.clipboard.writeText(simbaCoordinates ? `${mapX}, ${mapY}` : `${rsX}, ${rsY}`)
				copiedCoordinate = true
				setTimeout(() => (copiedCoordinate = false), 2000)
				break

			case "KeyC":
				e.preventDefault()
				await navigator.clipboard.writeText(hoveredChunk)
				copiedChunk = true
				setTimeout(() => (copiedChunk = false), 2000)
				break

			default:
				break
		}
	}

	onMount(() => {
		const ctx = canvas.getContext("2d", { alpha: false })
		if (!ctx) return

		context = ctx

		window.addEventListener("resize", onResize)
		document.addEventListener("keydown", onKeyboard)
		onResize()

		if (getCookie("grid") != "") grid = getCookie("grid") === "true"
		if (getCookie("simbacoords") != "") simbaCoordinates = getCookie("simbacoords") === "true"

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
		handleZoom(event.deltaY)
	}}
	onmousedown={(event) => {
		isDragging = true
		mouseX = event.clientX
		mouseY = event.clientY
	}}
	onmousemove={(event) => {
		mouseMapX = ((event.clientX - positionX - centerX + size / 2) / size) * step + x
		mouseMapY = ((event.clientY - positionY - centerY + size / 2) / size) * step * -1 + y + 1

		if (!isDragging) {
			requestAnimationFrame(drawTiles)
			return
		}

		const deltaX = event.clientX - mouseX
		const deltaY = event.clientY - mouseY

		mouseX = event.clientX
		mouseY = event.clientY

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
	class="cursor-grab active:cursor-grabbing"
>
</canvas>

<div class="pointer-events-none absolute inset-0 z-50 mx-2 mt-22 mb-2 flex justify-between">
	<div class="flex w-fit flex-col justify-between gap-2">
		<div class="flex flex-col gap-2">
			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80 text-sm"
				class:text-success-500={copiedCoordinate}
				type="button"
				onclick={async () => {
					await navigator.clipboard.writeText(simbaCoordinates ? `${mapX}, ${mapY}` : `${rsX}, ${rsY}`)
					copiedCoordinate = true
					setTimeout(() => (copiedCoordinate = false), 2000)
				}}
			>
				{simbaCoordinates ? `Coordinate: ${mapX}, ${mapY}` : `RSCoordinate: ${rsX}, ${rsY}`}
				{#if copiedCoordinate}
					<ClipboardCheck class="h-4" />
				{:else}
					<Clipboard class="h-4" />
				{/if}
			</button>

			<button
				class="pointer-events-auto btn w-fit cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80 text-sm"
				class:text-success-500={copiedChunk}
				type="button"
				onclick={async () => {
					await navigator.clipboard.writeText(hoveredChunk)
					copiedChunk = true
					setTimeout(() => (copiedChunk = false), 2000)
				}}
			>
				Chunk: {hoveredChunk}
				{#if copiedChunk}
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
					plane = clamp(plane + 1, minPlane, maxPlane)
					requestAnimationFrame(drawTiles)
				}}
			>
				<ArrowUp class="h-4" />
			</button>

			<button
				class="pointer-events-auto btn h-8 w-14 cursor-pointer rounded-md preset-outlined-surface-500 bg-surface-500/80"
				type="button"
				onclick={() => {
					plane = clamp(plane - 1, minPlane, maxPlane)
					requestAnimationFrame(drawTiles)
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
			defaultChecked={simbaCoordinates}
			onCheckedChange={(e) => {
				simbaCoordinates = e.checked
				setCookie("simbacoords", simbaCoordinates.toString(), 360)
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
