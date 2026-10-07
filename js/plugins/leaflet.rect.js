import "../leaflet.js"
import "./leaflet.displays.js"

export default void (function (factory) {
	var L
	if (typeof define === "function" && define.amd) {
		define(["leaflet"], factory)
	} else if (typeof module !== "undefined") {
		L = require("leaflet")
		module.exports = factory(L)
	} else {
		if (typeof window.L === "undefined") {
			throw new Error("Leaflet must be loaded first")
		}
		factory(window.L)
	}
})(function (L) {
	// --- Coordinate helpers ---
	function mapToGame(latlng) {
		return {
			x: latlng.lng * 4,
			y: 60 - (latlng.lat * 4 - 50370)
		}
	}

	function gameToMap(x, y) {
		return L.latLng((50430 - y) / 4, x / 4)
	}

	function pointInPolygon(x, y, vertices) {
		let inside = false
		for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
			let xi = vertices[i].x,
				yi = vertices[i].y
			let xj = vertices[j].x,
				yj = vertices[j].y
			if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
				inside = !inside
			}
		}
		return inside
	}

	function selectionChunks(bounds) {
		let west = Math.floor(bounds.getWest())
		let south = Math.floor(bounds.getSouth())
		let east = Math.max(west + 1, Math.ceil(bounds.getEast()))
		let north = Math.max(south + 1, Math.ceil(bounds.getNorth()))
		return {
			x1: west >> 6,
			y1: (north - 1) >> 6,
			x2: (east - 1) >> 6,
			y2: south >> 6
		}
	}

	function chunkGridLines(chunk) {
		let west = chunk.x1 << 6
		let east = (chunk.x2 + 1) << 6
		let south = chunk.y2 << 6
		let north = (chunk.y1 + 1) << 6
		let lines = []
		for (let x = west; x <= east; x += 64) {
			lines.push([
				[south, x],
				[north, x]
			])
		}
		for (let y = south; y <= north; y += 64) {
			lines.push([
				[y, west],
				[y, east]
			])
		}
		return lines
	}

	function computeTilesInPolygon(gameVertices) {
		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity
		for (let v of gameVertices) {
			if (v.x < minX) minX = v.x
			if (v.x > maxX) maxX = v.x
			if (v.y < minY) minY = v.y
			if (v.y > maxY) maxY = v.y
		}
		minX = Math.floor(minX / 4) * 4
		maxX = Math.ceil(maxX / 4) * 4
		minY = Math.floor((minY - 2) / 4) * 4 + 2
		maxY = Math.ceil((maxY - 2) / 4) * 4 + 2

		let tileCount = ((maxX - minX) / 4) * ((maxY - minY) / 4)
		if (tileCount > 50000) {
			return null
		}

		let selected = []
		let border = []
		for (let y = minY; y < maxY; y += 4) {
			for (let x = minX; x < maxX; x += 4) {
				let count = 0
				for (let sy = 0; sy < 4; sy++) {
					for (let sx = 0; sx < 4; sx++) {
						if (pointInPolygon(x + sx + 0.5, y + sy + 0.5, gameVertices)) {
							count++
						}
					}
				}
				if (count === 16) {
					selected.push([x, y])
				} else if (count > 0) {
					border.push([x, y])
				}
			}
		}
		return { selected, border }
	}

	// --- TileHighlight canvas overlay ---
	let TileHighlight = L.Layer.extend({
		initialize: function () {
			this._selected = []
			this._border = []
		},

		onAdd: function (map) {
			this._canvas = L.DomUtil.create("canvas", "")
			this._canvas.style.position = "absolute"
			this._canvas.style.pointerEvents = "none"
			map.getPanes().overlayPane.appendChild(this._canvas)

			this._redraw = this._redraw.bind(this)
			this._onAnimZoom = this._onAnimZoom.bind(this)

			map.on("moveend viewreset zoomend", this._redraw)
			map.on("zoomanim", this._onAnimZoom)
			this._redraw()
			return this
		},

		onRemove: function (map) {
			map.off("moveend viewreset zoomend", this._redraw)
			map.off("zoomanim", this._onAnimZoom)
			L.DomUtil.remove(this._canvas)
			this._canvas = null
			return this
		},

		setTiles: function (selected, border) {
			this._selected = selected
			this._border = border
			if (this._map) this._redraw()
		},

		_onAnimZoom: function (e) {
			let map = this._map
			let scale = map.getZoomScale(e.zoom)
			let offset = map._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min
			L.DomUtil.setTransform(this._canvas, offset, scale)
		},

		_redraw: function () {
			let map = this._map
			if (!map || !this._canvas) return

			let size = map.getSize()
			let dpr = window.devicePixelRatio || 1
			let canvas = this._canvas

			canvas.width = size.x * dpr
			canvas.height = size.y * dpr
			canvas.style.width = size.x + "px"
			canvas.style.height = size.y + "px"

			let topLeft = map.containerPointToLayerPoint([0, 0])
			L.DomUtil.setPosition(canvas, topLeft)

			let ctx = canvas.getContext("2d")
			ctx.scale(dpr, dpr)
			ctx.clearRect(0, 0, size.x, size.y)

			let viewBounds = map.getBounds()

			let sets = [
				{ tiles: this._border, color: "rgba(255, 120, 0, 0.15)" },
				{ tiles: this._selected, color: "rgba(0, 212, 255, 0.15)" }
			]

			for (let s = 0; s < sets.length; s++) {
				let tiles = sets[s].tiles
				ctx.fillStyle = sets[s].color
				for (let i = 0; i < tiles.length; i++) {
					let gx = tiles[i][0]
					let gy = tiles[i][1]

					let nw = gameToMap(gx, gy)
					let se = gameToMap(gx + 4, gy + 4)

					if (se.lng < viewBounds.getWest() || nw.lng > viewBounds.getEast()) continue
					if (se.lat > viewBounds.getNorth() || nw.lat < viewBounds.getSouth()) continue

					let pNW = map.latLngToLayerPoint(nw)
					let pSE = map.latLngToLayerPoint(se)
					ctx.fillRect(pNW.x - topLeft.x, pNW.y - topLeft.y, pSE.x - pNW.x, pSE.y - pNW.y)
				}
			}
		}
	})

	// --- Vertex and DraggableSquare (unchanged) ---
	let VertexIcon = L.DivIcon.extend({
		options: {
			iconSize: new L.Point(14, 14),
			className: "leaflet-vertex-handle"
		}
	})

	let Vertex = L.Marker.extend({
		initialize: function (latlng, owner, cursor) {
			L.Util.setOptions(this, {
				draggable: true,
				icon: new VertexIcon(),
				owner: owner
			})
			this._cursor = cursor
			this._latlng = L.latLng(latlng)
			this.trunc()
		},

		onAdd: function (map) {
			this.on("drag", this.onDragEnd.bind(this))
			L.Marker.prototype.onAdd.call(this, map)
			if (this._cursor) {
				this._icon.style.cursor = this._cursor
			}
			return this
		},

		onDragEnd: function () {
			this.trunc()
			this.options.owner.update(this)
		},

		trunc: function () {
			let latlng = this.getLatLng()
			let newLat = Math.trunc(latlng.lat)
			let newLng = Math.trunc(latlng.lng)
			let newLatLng = L.latLng(newLat, newLng)
			this.setLatLng(newLatLng)
			return this
		}
	})

	// Edge cursors: S=ns, W=ew, N=ns, E=ew
	let edgeDefs = [
		{ name: "south", vertexIndices: [0, 3], axis: "lat", cursor: "ns-resize" },
		{ name: "west", vertexIndices: [0, 1], axis: "lng", cursor: "ew-resize" },
		{ name: "north", vertexIndices: [1, 2], axis: "lat", cursor: "ns-resize" },
		{ name: "east", vertexIndices: [2, 3], axis: "lng", cursor: "ew-resize" }
	]

	L.DraggableSquare = L.Rectangle.extend({
		initialize: function (latLngBounds, options) {
			let bounds = L.latLngBounds(latLngBounds)
			// do not change order, important: SW, NW, NE, SE
			let corners = [
				bounds.getSouthWest(),
				bounds.getNorthWest(),
				bounds.getNorthEast(),
				bounds.getSouthEast()
			]
			// Per-corner resize cursors
			let cursors = ["nesw-resize", "nwse-resize", "nesw-resize", "nwse-resize"]
			this.vertices = corners.map((c, i) => this.createVertex(c, cursors[i]))
			this.edges = []
			this._dragging = false
			this._edgeDragging = false
			return L.Rectangle.prototype.initialize.call(this, bounds, options)
		},

		onAdd: function (map) {
			this.vertices.forEach((v) => v.trunc().addTo(map))
			L.Rectangle.prototype.onAdd.call(this, map)
			this._createEdges(map)

			// Drag-to-move handlers
			this._onDragStart = this._onDragStart.bind(this)
			this._onDragMove = this._onDragMove.bind(this)
			this._onDragEnd = this._onDragEnd.bind(this)
			this._onEdgeDragMove = this._onEdgeDragMove.bind(this)
			this._onEdgeDragEnd = this._onEdgeDragEnd.bind(this)

			this.on("mousedown", this._onDragStart)

			this.options.owner.updateBox(this.getBounds())
		},

		createVertex: function (latlng, cursor) {
			return new Vertex(latlng, this, cursor)
		},

		// --- Edge handles ---
		_createEdges: function (map) {
			this.edges = edgeDefs.map((def) => {
				let v1 = this.vertices[def.vertexIndices[0]]
				let v2 = this.vertices[def.vertexIndices[1]]
				let line = L.polyline([v1.getLatLng(), v2.getLatLng()], {
					weight: 12,
					opacity: 0,
					bubblingMouseEvents: false,
					className: "leaflet-edge-handle"
				})
				line._edgeDef = def
				line.addTo(map)

				// Set per-edge cursor on the DOM element
				line.getElement().style.cursor = def.cursor

				line.on("mousedown", this._onEdgeDragStart, this)
				return line
			})
		},

		_updateEdges: function () {
			if (!this.edges.length) return
			edgeDefs.forEach((def, i) => {
				let v1 = this.vertices[def.vertexIndices[0]]
				let v2 = this.vertices[def.vertexIndices[1]]
				this.edges[i].setLatLngs([v1.getLatLng(), v2.getLatLng()])
			})
		},

		_onEdgeDragStart: function (e) {
			L.DomEvent.stopPropagation(e.originalEvent)
			L.DomEvent.preventDefault(e.originalEvent)
			this._edgeDragging = true
			this._activeEdge = e.target._edgeDef
			this._dragStartLatLng = this._map.mouseEventToLatLng(e.originalEvent)
			this._map.dragging.disable()

			this._map.on("mousemove", this._onEdgeDragMove)
			this._map.on("mouseup", this._onEdgeDragEnd)
			L.DomEvent.on(document, "mouseup", this._onEdgeDragEnd)
		},

		_onEdgeDragMove: function (e) {
			if (!this._edgeDragging) return
			let def = this._activeEdge
			let current = e.latlng
			let delta =
				def.axis === "lat"
					? Math.trunc(current.lat) - Math.trunc(this._dragStartLatLng.lat)
					: Math.trunc(current.lng) - Math.trunc(this._dragStartLatLng.lng)
			if (delta === 0) return

			this._dragStartLatLng = current

			def.vertexIndices.forEach((vi) => {
				let v = this.vertices[vi]
				let pos = v.getLatLng()
				let newPos =
					def.axis === "lat"
						? L.latLng(Math.trunc(pos.lat + delta), pos.lng)
						: L.latLng(pos.lat, Math.trunc(pos.lng + delta))
				v.setLatLng(newPos)
			})

			let newBounds = L.latLngBounds(this.vertices.map((v) => v.getLatLng()))
			this.setRectBounds(newBounds)
			this._updateEdges()
			this.options.owner.updateBox(newBounds)
		},

		_onEdgeDragEnd: function () {
			if (!this._edgeDragging) return
			this._edgeDragging = false
			this._activeEdge = null
			this._map.dragging.enable()

			this._map.off("mousemove", this._onEdgeDragMove)
			this._map.off("mouseup", this._onEdgeDragEnd)
			L.DomEvent.off(document, "mouseup", this._onEdgeDragEnd)
		},

		// --- Drag to move ---
		_onDragStart: function (e) {
			if (this._edgeDragging) return
			L.DomEvent.stopPropagation(e.originalEvent)
			L.DomEvent.preventDefault(e.originalEvent)
			this._dragging = true
			this._dragStartLatLng = this._map.mouseEventToLatLng(e.originalEvent)
			this._map.dragging.disable()

			this._map.on("mousemove", this._onDragMove)
			this._map.on("mouseup", this._onDragEnd)
			L.DomEvent.on(document, "mouseup", this._onDragEnd)
		},

		_onDragMove: function (e) {
			if (!this._dragging) return
			let current = e.latlng
			let dLat = Math.trunc(current.lat) - Math.trunc(this._dragStartLatLng.lat)
			let dLng = Math.trunc(current.lng) - Math.trunc(this._dragStartLatLng.lng)
			if (dLat === 0 && dLng === 0) return

			this._dragStartLatLng = current

			this.vertices.forEach((v) => {
				let pos = v.getLatLng()
				v.setLatLng(L.latLng(Math.trunc(pos.lat + dLat), Math.trunc(pos.lng + dLng)))
			})

			let newBounds = L.latLngBounds(this.vertices.map((v) => v.getLatLng()))
			this.setRectBounds(newBounds)
			this._updateEdges()
			this.options.owner.updateBox(newBounds)
		},

		_onDragEnd: function () {
			if (!this._dragging) return
			this._dragging = false
			this._map.dragging.enable()

			this._map.off("mousemove", this._onDragMove)
			this._map.off("mouseup", this._onDragEnd)
			L.DomEvent.off(document, "mouseup", this._onDragEnd)
		},

		// --- Vertex corner resize ---
		update: function (changedVertex) {
			let changedIdx = this.vertices.indexOf(changedVertex)
			let oppositeIdx = (changedIdx + 2) & 0x3
			let oppositeVertex = this.vertices[oppositeIdx]

			let corner1 = oppositeVertex.getLatLng()
			let corner2 = changedVertex.getLatLng()
			let newBounds = L.latLngBounds([corner1, corner2])
			this.setRectBounds(newBounds)

			let positions = [
				newBounds.getSouthWest(),
				newBounds.getNorthWest(),
				newBounds.getNorthEast(),
				newBounds.getSouthEast()
			]
			for (let i = 0; i < 4; i++) {
				if (i !== changedIdx && i !== oppositeIdx) {
					this.vertices[i].setLatLng(positions[i])
				}
			}

			this._updateEdges()
			this.options.owner.updateBox(newBounds)
		},

		setRectBounds: function (bounds) {
			return L.Rectangle.prototype.setBounds.call(this, bounds)
		},

		setBounds: function (bounds) {
			let positions = [
				bounds.getSouthWest(),
				bounds.getNorthWest(),
				bounds.getNorthEast(),
				bounds.getSouthEast()
			]
			this.vertices.forEach((v, i) => v.setLatLng(positions[i]).trunc())
			bounds = L.latLngBounds(this.vertices.map((v) => v.getLatLng()))
			this.setRectBounds(bounds)
			this._updateEdges()
		},

		remove: function () {
			if (this._dragging) this._onDragEnd()
			if (this._edgeDragging) this._onEdgeDragEnd()
			this.edges.forEach((e) => e.remove())
			this.vertices.forEach((v) => v.remove())
			return L.Rectangle.prototype.remove.call(this)
		}
	})

	L.draggableSquare = function (bounds, options) {
		return new L.DraggableSquare(bounds, options)
	}

	// --- L.DraggablePolygon ---
	L.DraggablePolygon = L.Polygon.extend({
		initialize: function (latlngs, options) {
			this.vertices = latlngs.map((ll) => new Vertex(ll, this, "move"))
			this.edges = []
			this._dragging = false
			this._hoverPreview = null
			return L.Polygon.prototype.initialize.call(this, latlngs, options)
		},

		onAdd: function (map) {
			this.vertices.forEach((v) => v.trunc().addTo(map))
			this._createEdges(map)
			L.Polygon.prototype.onAdd.call(this, map)

			this._onDragStart = this._onDragStart.bind(this)
			this._onDragMove = this._onDragMove.bind(this)
			this._onDragEnd = this._onDragEnd.bind(this)

			this.on("mousedown", this._onDragStart)

			this.options.owner.updatePoly()
			return this
		},

		update: function () {
			let latlngs = this.vertices.map((v) => v.getLatLng())
			this.setLatLngs(latlngs)
			this._updateEdges()
			this.options.owner.updatePoly()
		},

		getVertexLatLngs: function () {
			return this.vertices.map((v) => v.getLatLng())
		},

		// --- Edge handles for vertex insertion ---
		_createEdges: function (map) {
			this.edges = []
			for (let i = 0; i < this.vertices.length; i++) {
				let j = (i + 1) % this.vertices.length
				let line = L.polyline([this.vertices[i].getLatLng(), this.vertices[j].getLatLng()], {
					weight: 36,
					opacity: 0,
					bubblingMouseEvents: false,
					className: "leaflet-edge-handle"
				})
				line._edgeIndex = i
				line.addTo(map)
				line.getElement().style.cursor = "none"
				line.on("mousedown", this._onEdgeClick, this)
				line.on("mousemove", this._onEdgeHover, this)
				line.on("mouseout", this._onEdgeHoverEnd, this)
				this.edges.push(line)
			}
		},

		_updateEdges: function () {
			if (!this.edges || !this.edges.length) return
			this._removeHoverPreview()
			this.edges.forEach((e) => e.remove())
			this._createEdges(this._map)
		},

		_projectOnSegment: function (p, a, b) {
			let dx = b.lng - a.lng
			let dy = b.lat - a.lat
			let len2 = dx * dx + dy * dy
			if (len2 === 0) return a
			let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2
			t = Math.max(0, Math.min(1, t))
			return L.latLng(a.lat + t * dy, a.lng + t * dx)
		},

		_nearVertex: function (e) {
			let pt = this._map.latLngToContainerPoint(e.latlng)
			for (let v of this.vertices) {
				let vpt = this._map.latLngToContainerPoint(v.getLatLng())
				if (pt.distanceTo(vpt) < 16) return true
			}
			return false
		},

		_onEdgeHover: function (e) {
			if (this._nearVertex(e)) {
				this._removeHoverPreview()
				return
			}
			let pts = e.target.getLatLngs()
			let latlng = this._projectOnSegment(e.latlng, pts[0], pts[1])
			if (!this._hoverPreview) {
				this._hoverPreview = L.circleMarker(latlng, {
					radius: 6,
					color: "#00d4ff",
					fillColor: "#00d4ff",
					fillOpacity: 0.4,
					weight: 2,
					interactive: false
				}).addTo(this._map)
			} else {
				this._hoverPreview.setLatLng(latlng)
			}
			this._map._hidePositionRect = true
		},

		_onEdgeHoverEnd: function () {
			this._removeHoverPreview()
		},

		_removeHoverPreview: function () {
			if (this._hoverPreview) {
				this._hoverPreview.remove()
				this._hoverPreview = null
			}
			if (this._map) {
				this._map._hidePositionRect = false
			}
		},

		_onEdgeClick: function (e) {
			if (this._nearVertex(e)) return
			L.DomEvent.stopPropagation(e.originalEvent)
			L.DomEvent.preventDefault(e.originalEvent)
			let insertAfter = e.target._edgeIndex
			let latlng = this._map.mouseEventToLatLng(e.originalEvent)
			let newVertex = new Vertex(latlng, this, "move")
			newVertex.trunc().addTo(this._map)
			this.vertices.splice(insertAfter + 1, 0, newVertex)
			this.update()
		},

		_onDragStart: function (e) {
			L.DomEvent.stopPropagation(e.originalEvent)
			L.DomEvent.preventDefault(e.originalEvent)
			this._dragging = true
			this._dragStartLatLng = this._map.mouseEventToLatLng(e.originalEvent)
			this._map.dragging.disable()

			this._map.on("mousemove", this._onDragMove)
			this._map.on("mouseup", this._onDragEnd)
			L.DomEvent.on(document, "mouseup", this._onDragEnd)
		},

		_onDragMove: function (e) {
			if (!this._dragging) return
			let current = e.latlng
			let dLat = Math.trunc(current.lat) - Math.trunc(this._dragStartLatLng.lat)
			let dLng = Math.trunc(current.lng) - Math.trunc(this._dragStartLatLng.lng)
			if (dLat === 0 && dLng === 0) return

			this._dragStartLatLng = current

			this.vertices.forEach((v) => {
				let pos = v.getLatLng()
				v.setLatLng(L.latLng(Math.trunc(pos.lat + dLat), Math.trunc(pos.lng + dLng)))
			})

			this.setLatLngs(this.vertices.map((v) => v.getLatLng()))
			this._updateEdges()
			this.options.owner.updatePoly()
		},

		_onDragEnd: function () {
			if (!this._dragging) return
			this._dragging = false
			this._map.dragging.enable()

			this._map.off("mousemove", this._onDragMove)
			this._map.off("mouseup", this._onDragEnd)
			L.DomEvent.off(document, "mouseup", this._onDragEnd)
		},

		remove: function () {
			if (this._dragging) this._onDragEnd()
			this._removeHoverPreview()
			this.edges.forEach((e) => e.remove())
			this.vertices.forEach((v) => v.remove())
			return L.Polygon.prototype.remove.call(this)
		}
	})

	// --- Shared polygon options ---
	let polyOpts = {
		color: "#00d4ff",
		fillColor: "#00d4ff",
		fillOpacity: 0,
		weight: 3,
		className: "leaflet-draggable-poly",
		bubblingMouseEvents: false
	}

	// --- SVG icons ---
	let copySvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
	let checkSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'

	let boxIconSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="12" height="12" rx="1"/></svg>'
	let polyIconSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="9,2 15,6 14,13 4,13 3,6"/></svg>'
	let newIconSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="9" y1="3" x2="9" y2="15"/><line x1="3" y1="9" x2="15" y2="9"/></svg>'

	function formatVertices(verts) {
		return "[" + verts.map((v) => `[${v[0]}, ${v[1]}]`).join(", ") + "]"
	}

	function wrapWithCopyBtn(input, map) {
		let wrapper = L.DomUtil.create("div", "leaflet-control-display-input-copy-wrapper")
		input.parentNode.insertBefore(wrapper, input)
		wrapper.appendChild(input)
		input.style.paddingRight = "24px"
		input.style.width = "100%"
		input.style.boxSizing = "border-box"

		let btn = L.DomUtil.create("button", "leaflet-control-display-input-copy-btn", wrapper)
		btn.setAttribute("type", "button")
		btn.innerHTML = copySvg

		L.DomEvent.on(btn, "click", function (e) {
			L.DomEvent.stopPropagation(e)
			navigator.clipboard.writeText(input.value).then(function () {
				btn.innerHTML = checkSvg
				map.addMessage(`Copied to clipboard: ${input.value}`)
				setTimeout(function () {
					btn.innerHTML = copySvg
				}, 1500)
			})
		})

		return wrapper
	}

	L.Control.Display.Rect = L.Control.Display.extend({
		onAdd: function (map) {
			this._mode = "box"
			this._drawState = null
			this._drawCursor = null

			this.rect = L.draggableSquare(
				[
					[3232, 3200],
					[3200, 3232]
				],
				{
					owner: this,
					color: "#00d4ff",
					fillColor: "#00d4ff",
					fillOpacity: 0.15,
					weight: 3,
					className: "leaflet-draggable-rect",
					bubblingMouseEvents: false
				}
			)

			this.poly = null
			this._polyLatlngs = null
			this._tileHighlight = new TileHighlight()
			this._chunkGrid = L.polyline([], {
				color: "#f9a915",
				weight: 1.5,
				opacity: 0.8,
				dashArray: "8 6",
				interactive: false
			})
			this._chunkOutline = L.rectangle(
				[
					[0, 0],
					[0, 0]
				],
				{
					color: "#f9a915",
					weight: 4,
					fill: false,
					interactive: false
				}
			)
			this._chunkMask = L.polygon([], {
				stroke: false,
				fillColor: "#000",
				fillOpacity: 0.4,
				interactive: false
			})
			this._chunkLayer = L.layerGroup([this._chunkMask, this._chunkGrid, this._chunkOutline])

			map.on("gotobox", this._onGotoBox, this)

			return L.Control.Display.prototype.onAdd.call(this, map)
		},

		options: {
			position: "topleft",
			title: "Chunk",
			label: "MAP",
			icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4l5-2 6 2 5-2v12l-5 2-6-2-5 2z"/><path d="M6 2v12m6-10v12"/></svg>'
		},

		createInterface: function () {
			let container = L.DomUtil.create(
				"div",
				"leaflet-control-display-expanded leaflet-control-display-expanded-rect"
			)
			let map = this._map

			// --- Chunk section (Simba fields) ---
			let chunkSection = L.DomUtil.create("div", "leaflet-control-display-chunk-section", container)

			let simba20Row = L.DomUtil.create("div", "leaflet-control-map-row", chunkSection)
			let simba20Label = L.DomUtil.create("label", "leaflet-control-display-label", simba20Row)
			simba20Label.innerHTML = "Simba 2.0"
			this.map2000 = L.DomUtil.create("input", "leaflet-control-map-input", simba20Row)
			this.map2000.setAttribute("type", "text")
			this.map2000.setAttribute("name", "map2000")
			this.map2000.setAttribute("readOnly", true)
			wrapWithCopyBtn(this.map2000, map)

			// --- Area Selection header + mode toggle ---
			let headerRow = L.DomUtil.create("div", "leaflet-control-display-section-header", container)
			let sectionTitle = L.DomUtil.create(
				"span",
				"leaflet-control-display-section-title-inline",
				headerRow
			)
			sectionTitle.textContent = "Area Selection"
			let toggle = L.DomUtil.create("div", "leaflet-control-display-mode-toggle-inline", headerRow)

			this._boxBtn = L.DomUtil.create(
				"button",
				"leaflet-control-display-mode-btn leaflet-control-display-mode-btn-active",
				toggle
			)
			this._boxBtn.setAttribute("type", "button")
			this._boxBtn.setAttribute("title", "Box mode")
			this._boxBtn.innerHTML = boxIconSvg

			this._polyBtn = L.DomUtil.create("button", "leaflet-control-display-mode-btn", toggle)
			this._polyBtn.setAttribute("type", "button")
			this._polyBtn.setAttribute("title", "Polygon mode")
			this._polyBtn.innerHTML = polyIconSvg

			L.DomEvent.on(
				this._boxBtn,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					this._switchMode("box")
				},
				this
			)

			L.DomEvent.on(
				this._polyBtn,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					this._switchMode("poly")
				},
				this
			)

			// --- Box card ---
			this._boxCard = L.DomUtil.create(
				"form",
				"leaflet-control-display-form leaflet-control-display-form-rect",
				container
			)

			let boxRow = L.DomUtil.create("div", "leaflet-control-map-row", this._boxCard)
			let boxRowLabel = L.DomUtil.create("label", "leaflet-control-display-label", boxRow)
			boxRowLabel.innerHTML = "Box"
			this._boxField = L.DomUtil.create("input", "leaflet-control-map-input", boxRow)
			this._boxField.setAttribute("type", "text")
			this._boxField.setAttribute("readOnly", true)
			wrapWithCopyBtn(this._boxField, map)

			let arrayRow = L.DomUtil.create("div", "leaflet-control-map-row", this._boxCard)
			let arrayRowLabel = L.DomUtil.create("label", "leaflet-control-display-label", arrayRow)
			arrayRowLabel.innerHTML = "Array"
			this._arrayField = L.DomUtil.create("input", "leaflet-control-map-input", arrayRow)
			this._arrayField.setAttribute("type", "text")
			this._arrayField.setAttribute("readOnly", true)
			wrapWithCopyBtn(this._arrayField, map)

			let widthLabel = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			widthLabel.innerHTML = "Width"
			this.width = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.width.setAttribute("type", "number")
			this.width.setAttribute("name", "width")

			let heightLabel = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			heightLabel.innerHTML = "Height"
			this.height = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.height.setAttribute("type", "number")
			this.height.setAttribute("name", "height")

			let x1Label = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			x1Label.innerHTML = "X1"
			this.x1 = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.x1.setAttribute("type", "number")
			this.x1.setAttribute("name", "x1")

			let y1Label = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			y1Label.innerHTML = "Y1"
			this.y1 = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.y1.setAttribute("type", "number")
			this.y1.setAttribute("name", "y1")

			let x2Label = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			x2Label.innerHTML = "X2"
			this.x2 = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.x2.setAttribute("type", "number")
			this.x2.setAttribute("name", "x2")

			let y2Label = L.DomUtil.create("label", "leaflet-control-display-label", this._boxCard)
			y2Label.innerHTML = "Y2"
			this.y2 = L.DomUtil.create("input", "leaflet-control-display-input-number", this._boxCard)
			this.y2.setAttribute("type", "number")
			this.y2.setAttribute("name", "y2")
			;[this.width, this.height, this.x1, this.y1, this.x2, this.y2].forEach(function (input) {
				wrapWithCopyBtn(input, map)
			})

			let boxVertsRow = L.DomUtil.create("div", "leaflet-control-map-row", this._boxCard)
			let boxVertsLabel = L.DomUtil.create("label", "leaflet-control-display-label", boxVertsRow)
			boxVertsLabel.innerHTML = "Vertices"
			this._boxVertices = L.DomUtil.create("input", "leaflet-control-map-input", boxVertsRow)
			this._boxVertices.setAttribute("type", "text")
			this._boxVertices.setAttribute("readOnly", true)
			wrapWithCopyBtn(this._boxVertices, map)

			let boxCoordsRow = L.DomUtil.create(
				"div",
				"leaflet-control-display-coords-row",
				this._boxCard
			)
			let boxCoordsLabel = L.DomUtil.create("label", "leaflet-control-display-label", boxCoordsRow)
			boxCoordsLabel.innerHTML = "Coords"
			this._boxCoords = L.DomUtil.create("textarea", "", boxCoordsRow)
			this._boxCoords.setAttribute("readOnly", true)
			this._boxCoords.setAttribute("rows", "3")

			L.DomEvent.on(
				this._boxCoords,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					let text = this._boxCoords.value
					if (text) {
						navigator.clipboard.writeText(text).then(() => {
							this._map.addMessage("Copied box coordinates to clipboard")
						})
					}
				},
				this
			)

			// Box New button
			this._boxNewBtn = L.DomUtil.create(
				"button",
				"leaflet-control-display-submit leaflet-control-display-new-btn",
				this._boxCard
			)
			this._boxNewBtn.setAttribute("type", "button")
			this._boxNewBtn.innerHTML = newIconSvg + " New"

			L.DomEvent.on(
				this._boxNewBtn,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					this._handleNewBox()
				},
				this
			)

			this._boxCard.addEventListener("change", this.changeRect.bind(this))

			// --- Poly card ---
			this._polyCard = L.DomUtil.create(
				"div",
				"leaflet-control-display-form-poly leaflet-control-display-card-hidden",
				container
			)

			this._polyVertexList = L.DomUtil.create(
				"div",
				"leaflet-control-display-poly-vertices",
				this._polyCard
			)

			let polyVertsRow = L.DomUtil.create("div", "leaflet-control-map-row", this._polyCard)
			let polyVertsLabel = L.DomUtil.create("label", "leaflet-control-display-label", polyVertsRow)
			polyVertsLabel.innerHTML = "Vertices"
			this._polyVertices = L.DomUtil.create("input", "leaflet-control-map-input", polyVertsRow)
			this._polyVertices.setAttribute("type", "text")
			this._polyVertices.setAttribute("readOnly", true)
			wrapWithCopyBtn(this._polyVertices, map)

			let coordsRow = L.DomUtil.create("div", "leaflet-control-display-coords-row", this._polyCard)
			let coordsLabel = L.DomUtil.create("label", "leaflet-control-display-label", coordsRow)
			coordsLabel.innerHTML = "Coords"
			this._polyCoords = L.DomUtil.create("textarea", "", coordsRow)
			this._polyCoords.setAttribute("readOnly", true)
			this._polyCoords.setAttribute("rows", "3")

			L.DomEvent.on(
				this._polyCoords,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					let text = this._polyCoords.value
					if (text) {
						navigator.clipboard.writeText(text).then(() => {
							this._map.addMessage("Copied polygon coordinates to clipboard")
						})
					}
				},
				this
			)

			// Poly New button
			this._polyNewBtn = L.DomUtil.create(
				"button",
				"leaflet-control-display-submit leaflet-control-display-new-btn",
				this._polyCard
			)
			this._polyNewBtn.setAttribute("type", "button")
			this._polyNewBtn.innerHTML = newIconSvg + " New"

			L.DomEvent.on(
				this._polyNewBtn,
				"click",
				function (e) {
					L.DomEvent.stopPropagation(e)
					this._handleNewPoly()
				},
				this
			)

			return container
		},

		_switchMode: function (mode) {
			if (mode === this._mode) return
			this._cancelDrawing()

			this._mode = mode

			if (mode === "box") {
				L.DomUtil.addClass(this._boxBtn, "leaflet-control-display-mode-btn-active")
				L.DomUtil.removeClass(this._polyBtn, "leaflet-control-display-mode-btn-active")
				L.DomUtil.removeClass(this._boxCard, "leaflet-control-display-card-hidden")
				L.DomUtil.addClass(this._polyCard, "leaflet-control-display-card-hidden")

				if (this.poly && this._map) {
					this._polyLatlngs = this.poly.getVertexLatLngs()
					this.poly.remove()
				}
				if (this._tileHighlight._map) this._tileHighlight.remove()

				if (this._expanded) {
					let bounds = this._map.getBounds().pad(-0.3)
					this.rect.setBounds(bounds)
					this.rect.addTo(this._map)
				}
			} else {
				L.DomUtil.removeClass(this._boxBtn, "leaflet-control-display-mode-btn-active")
				L.DomUtil.addClass(this._polyBtn, "leaflet-control-display-mode-btn-active")
				L.DomUtil.addClass(this._boxCard, "leaflet-control-display-card-hidden")
				L.DomUtil.removeClass(this._polyCard, "leaflet-control-display-card-hidden")

				if (this.rect._map) {
					this.rect.remove()
				}

				if (this._expanded) {
					let latlngs = this._polyLatlngs || this._defaultPentagon()
					this.poly = new L.DraggablePolygon(latlngs, L.extend({ owner: this }, polyOpts))
					this.poly.addTo(this._map)
					this._tileHighlight.addTo(this._map)
				}
			}
		},

		_defaultPentagon: function () {
			let center = this._map.getCenter()
			let zoom = this._map.getZoom()
			let r = Math.max(8, 80 / Math.pow(2, zoom - 2)) * (2 / 3)
			let pts = []
			for (let i = 0; i < 5; i++) {
				let angle = Math.PI / 2 + (2 * Math.PI * i) / 5
				pts.push(
					L.latLng(
						Math.trunc(center.lat + r * Math.sin(angle)),
						Math.trunc(center.lng + r * Math.cos(angle))
					)
				)
			}
			return pts
		},

		changeRect: function () {
			let width = Number(this.width.value)
			let height = Number(this.height.value)
			let x1 = Number(this.x1.value)
			let x2 = Number(this.x2.value)
			let y1 = Number(this.y1.value)
			let y2 = Number(this.y2.value)

			if (["width", "height"].includes(document.activeElement.name)) {
				x2 = x1 + width
				y1 = y2 + height
			}

			let planeOffset = 25600 * this._map.getPlane()
			let nw = gameToMap(x1 - planeOffset, y1)
			let se = gameToMap(x2 - planeOffset, y2)
			let bounds = L.latLngBounds([nw, se])
			this.rect.setBounds(bounds)
			this.updateBox(bounds)
		},

		updateBox: function (bounds) {
			let chunk = selectionChunks(bounds)
			this._showChunks(chunk)

			let planeOffset = 25600 * this._map.getPlane()
			let global = {
				x1: bounds.getWest() * 4 + planeOffset,
				y1: 60 - (bounds.getNorth() * 4 - 50370),
				x2: bounds.getEast() * 4 + planeOffset,
				y2: 60 - (bounds.getSouth() * 4 - 50370)
			}

			let width = global.x2 - global.x1
			let height = global.y1 - global.y2

			this.width.value = width
			this.height.value = height
			this.x1.value = global.x1
			this.x2.value = global.x2
			this.y1.value = global.y1
			this.y2.value = global.y2
			this._boxField.value = `Box(${global.x1}, ${global.y1}, ${global.x2}, ${global.y2})`
			this._arrayField.value = `[${global.x1}, ${global.y1}, ${global.x2}, ${global.y2}]`
			this._boxVertices.value = formatVertices([
				[global.x1, global.y1],
				[global.x2, global.y1],
				[global.x2, global.y2],
				[global.x1, global.y2]
			])
			this.map2000.value = `Map.Setup([Chunk(Box(${chunk.x1}, ${chunk.y1}, ${chunk.x2}, ${
				chunk.y2
			}), ${this._map.getPlane()})]);`

			let tMinX = Math.floor(global.x1 / 4) * 4
			let tMaxX = Math.ceil(global.x2 / 4) * 4
			let tMinY = Math.floor((global.y1 - 2) / 4) * 4 + 2
			let tMaxY = Math.ceil((global.y2 - 2) / 4) * 4 + 2
			let tileCount = ((tMaxX - tMinX) / 4) * ((tMaxY - tMinY) / 4)
			if (tileCount > 50000) {
				this._boxCoords.value = "Area too large (>50,000 tiles)"
			} else {
				let tiles = []
				for (let y = tMinY; y < tMaxY; y += 4) {
					for (let x = tMinX; x < tMaxX; x += 4) {
						tiles.push([x, y + 4])
					}
				}
				this._boxCoords.value = formatVertices(tiles)
			}

			this._emitSelection()
		},

		update: function (boundsOrVertex) {
			if (this._mode === "box") {
				this.updateBox(boundsOrVertex)
			}
		},

		updatePoly: function () {
			if (!this.poly) return

			let latlngs = this.poly.getVertexLatLngs()
			let gameCoords = latlngs.map((ll) => mapToGame(ll))
			let planeOffset = 25600 * this._map.getPlane()

			this._polyVertices.value = formatVertices(
				gameCoords.map((c) => [Math.round(c.x + planeOffset), Math.round(c.y)])
			)

			this._updateVertexList(gameCoords, planeOffset)

			let result = computeTilesInPolygon(gameCoords)
			if (result === null) {
				this._polyCoords.value = "Area too large (>50,000 tiles)"
				this._tileHighlight.setTiles([], [])
			} else {
				let { selected, border } = result
				let outputTiles = selected.map((t) => [t[0] + planeOffset, t[1] + 4])
				this._polyCoords.value = formatVertices(outputTiles)
				this._tileHighlight.setTiles(selected, border)
			}

			// Compute bounding box chunk for Simba fields
			let chunk = selectionChunks(L.latLngBounds(latlngs))
			this._showChunks(chunk)
			let plane = this._map.getPlane()
			this.map2000.value = `Map.Setup([Chunk(Box(${chunk.x1}, ${chunk.y1}, ${chunk.x2}, ${chunk.y2}), ${plane})]);`

			this._emitSelection()
		},

		// Publishes the current selection (box or poly) on the map as
		// `map._areaSelection` and fires an "areaselection" event. Other layers
		// (e.g. object pins) use this to render only what's inside the selection.
		// Geometry is in map-unit lat/lng (lat = game Y, lng = game X), the same
		// space markers are placed in.
		_emitSelection: function () {
			let map = this._map
			if (!map) return
			let sel = null

			if (this._mode === "box" && this.rect && this.rect._map) {
				let b = this.rect.getBounds()
				sel = {
					mode: "box",
					bounds: b,
					contains: function (lat, lng) {
						return b.contains([lat, lng])
					}
				}
			} else if (this._mode === "poly" && this.poly && this.poly._map) {
				let verts = this.poly.getVertexLatLngs()
				let pts = verts.map((ll) => ({ x: ll.lng, y: ll.lat }))
				sel = {
					mode: "poly",
					bounds: L.latLngBounds(verts),
					contains: function (lat, lng) {
						return pointInPolygon(lng, lat, pts)
					}
				}
			}

			map._areaSelection = sel
			map.fire("areaselection", { selection: sel })
		},

		_showChunks: function (chunk) {
			let south = chunk.y2 << 6
			let west = chunk.x1 << 6
			let north = (chunk.y1 + 1) << 6
			let east = (chunk.x2 + 1) << 6
			this._chunkGrid.setLatLngs(chunkGridLines(chunk))
			this._chunkOutline.setBounds([
				[south, west],
				[north, east]
			])
			this._chunkMask.setLatLngs([
				[
					[-1000, -1000],
					[-1000, 13800],
					[13800, 13800],
					[13800, -1000]
				],
				[
					[south, west],
					[north, west],
					[north, east],
					[south, east]
				]
			])
			if (!this._map.hasLayer(this._chunkLayer)) this._chunkLayer.addTo(this._map)
		},

		_clearSelection: function () {
			if (this._map && this._map.hasLayer(this._chunkLayer)) this._chunkLayer.remove()
			if (!this._map) return
			this._map._areaSelection = null
			this._map.fire("areaselection", { selection: null })
		},

		_updateVertexList: function (gameCoords, planeOffset) {
			this._polyVertexList.innerHTML = ""

			gameCoords.forEach((coord, i) => {
				let row = L.DomUtil.create(
					"div",
					"leaflet-control-display-poly-vertex-row",
					this._polyVertexList
				)

				let xLabel = L.DomUtil.create("label", "leaflet-control-display-label", row)
				xLabel.textContent = "V" + (i + 1) + " X"
				xLabel.title = "Vertex " + (i + 1)

				let xInput = L.DomUtil.create("input", "leaflet-control-display-input-number", row)
				xInput.setAttribute("type", "number")
				xInput.value = Math.round(coord.x + planeOffset)
				xInput.dataset.index = i
				xInput.dataset.axis = "x"
				wrapWithCopyBtn(xInput, this._map)

				let yLabel = L.DomUtil.create("label", "leaflet-control-display-label", row)
				yLabel.textContent = "Y"
				yLabel.title = "Vertex " + (i + 1)

				let yInput = L.DomUtil.create("input", "leaflet-control-display-input-number", row)
				yInput.setAttribute("type", "number")
				yInput.value = Math.round(coord.y)
				yInput.dataset.index = i
				yInput.dataset.axis = "y"
				wrapWithCopyBtn(yInput, this._map)

				L.DomEvent.on(xInput, "change", this._onVertexInputChange, this)
				L.DomEvent.on(yInput, "change", this._onVertexInputChange, this)
			})
		},

		_onVertexInputChange: function (e) {
			let input = e.target
			let idx = Number(input.dataset.index)
			if (!this.poly || idx >= this.poly.vertices.length) return

			let latlngs = this.poly.getVertexLatLngs()
			let game = mapToGame(latlngs[idx])
			let planeOffset = 25600 * this._map.getPlane()

			if (input.dataset.axis === "x") {
				game.x = Number(input.value) - planeOffset
			} else {
				game.y = Number(input.value)
			}

			let newLatLng = gameToMap(game.x, game.y)
			this.poly.vertices[idx].setLatLng(newLatLng).trunc()
			this.poly.setLatLngs(this.poly.vertices.map((v) => v.getLatLng()))
			this.updatePoly()
		},

		// --- Draw cursor ---
		_createDrawCursor: function (latlng) {
			if (!this._drawCursor) {
				this._drawCursor = L.circleMarker(latlng, {
					radius: 5,
					color: "#00d4ff",
					fillColor: "#00d4ff",
					fillOpacity: 0.4,
					weight: 2,
					interactive: false
				}).addTo(this._map)
			} else {
				this._drawCursor.setLatLng(latlng)
			}
		},

		_removeDrawCursor: function () {
			if (this._drawCursor) {
				this._drawCursor.remove()
				this._drawCursor = null
			}
			if (this._map) {
				this._map._hidePositionRect = false
			}
		},

		// --- Drawing state machine ---
		_handleNewBox: function () {
			if (this._drawState === "box_first" || this._drawState === "box_second") {
				this._cancelDrawing()
				return
			}
			this._cancelDrawing()

			if (this.rect._map) this.rect.remove()
			this._clearSelection()
			this._drawState = "box_first"
			this._map._hidePositionRect = true
			this._map.getContainer().style.cursor = "crosshair"
			this._boxNewBtn.innerHTML = newIconSvg + " Cancel"

			this._drawMapClick = this._onDrawMapClick.bind(this)
			this._drawMapMove = this._onDrawMapMove.bind(this)
			this._map.on("click", this._drawMapClick)
			this._map.on("mousemove", this._drawMapMove)
		},

		_handleNewPoly: function () {
			if (this._drawState === "poly_first" || this._drawState === "poly_drawing") {
				this._cancelDrawing()
				return
			}
			this._cancelDrawing()

			if (this.poly) {
				this._polyLatlngs = this.poly.getVertexLatLngs()
				this.poly.remove()
				this.poly = null
			}
			if (this._tileHighlight._map) this._tileHighlight.remove()
			this._clearSelection()
			this._drawState = "poly_first"
			this._map._hidePositionRect = true
			this._drawPoints = []
			this._map.getContainer().style.cursor = "crosshair"
			this._polyNewBtn.innerHTML = newIconSvg + " Cancel"

			this._previewLine = L.polyline([], {
				color: "#00d4ff",
				weight: 2,
				dashArray: "6,4",
				bubblingMouseEvents: false
			}).addTo(this._map)

			this._closeIndicator = null

			this._drawMapClick = this._onDrawMapClick.bind(this)
			this._drawMapMove = this._onDrawMapMove.bind(this)
			this._map.on("click", this._drawMapClick)
			this._map.on("mousemove", this._drawMapMove)
		},

		_onDrawMapClick: function (e) {
			let latlng = L.latLng(Math.round(e.latlng.lat), Math.round(e.latlng.lng))

			if (this._drawState === "box_first") {
				this._drawCorner1 = latlng
				this._drawRect = L.rectangle([latlng, latlng], {
					color: "#00d4ff",
					fillColor: "#00d4ff",
					fillOpacity: 0.15,
					weight: 3,
					dashArray: "6,4"
				}).addTo(this._map)
				this._drawState = "box_second"
			} else if (this._drawState === "box_second") {
				this._map.off("mousemove", this._drawMapMove)
				this._map.off("click", this._drawMapClick)
				if (this._drawRect) {
					this._drawRect.remove()
					this._drawRect = null
				}
				this._removeDrawCursor()
				this._map.getContainer().style.cursor = ""
				this._boxNewBtn.innerHTML = newIconSvg + " New"

				let bounds = L.latLngBounds([this._drawCorner1, latlng])
				this.rect.setBounds(bounds)
				this.rect.addTo(this._map)
				this._drawState = null
			} else if (this._drawState === "poly_first") {
				this._drawPoints.push(latlng)
				this._drawState = "poly_drawing"
			} else if (this._drawState === "poly_drawing") {
				// Check if closing
				if (this._drawPoints.length >= 3) {
					let startPt = this._map.latLngToLayerPoint(this._drawPoints[0])
					let clickPt = this._map.latLngToLayerPoint(latlng)
					let dist = startPt.distanceTo(clickPt)
					if (dist <= 10) {
						this._finishPolyDrawing()
						return
					}
				}
				this._drawPoints.push(latlng)
				this._updateCloseIndicator()
			}
		},

		_onDrawMapMove: function (e) {
			let latlng = L.latLng(Math.round(e.latlng.lat), Math.round(e.latlng.lng))
			this._createDrawCursor(latlng)

			if (this._drawState === "box_second" && this._drawRect) {
				this._drawRect.setBounds(L.latLngBounds([this._drawCorner1, latlng]))
			} else if (this._drawState === "poly_first" || this._drawState === "poly_drawing") {
				let pts = this._drawPoints.concat([latlng])
				if (this._previewLine) {
					this._previewLine.setLatLngs(pts)
				}
			}
		},

		_updateCloseIndicator: function () {
			if (this._closeIndicator) {
				this._closeIndicator.remove()
				this._closeIndicator = null
			}
			if (this._drawPoints.length >= 3) {
				this._closeIndicator = L.circleMarker(this._drawPoints[0], {
					radius: 8,
					color: "#00d4ff",
					fillColor: "#00d4ff",
					fillOpacity: 0.3,
					weight: 2,
					bubblingMouseEvents: false
				}).addTo(this._map)
			}
		},

		_finishPolyDrawing: function () {
			this._map.off("click", this._drawMapClick)
			this._map.off("mousemove", this._drawMapMove)
			if (this._previewLine) {
				this._previewLine.remove()
				this._previewLine = null
			}
			if (this._closeIndicator) {
				this._closeIndicator.remove()
				this._closeIndicator = null
			}
			this._removeDrawCursor()
			this._map.getContainer().style.cursor = ""
			this._polyNewBtn.innerHTML = newIconSvg + " New"

			this.poly = new L.DraggablePolygon(this._drawPoints, L.extend({ owner: this }, polyOpts))
			this.poly.addTo(this._map)
			this._tileHighlight.addTo(this._map)
			this._polyLatlngs = this._drawPoints.slice()
			this._drawPoints = []
			this._drawState = null
		},

		_cancelDrawing: function () {
			if (!this._drawState) return

			this._map.off("click", this._drawMapClick)
			this._map.off("mousemove", this._drawMapMove)
			this._removeDrawCursor()
			this._map.getContainer().style.cursor = ""

			if (this._drawRect) {
				this._drawRect.remove()
				this._drawRect = null
			}
			if (this._previewLine) {
				this._previewLine.remove()
				this._previewLine = null
			}
			if (this._closeIndicator) {
				this._closeIndicator.remove()
				this._closeIndicator = null
			}

			// Restore previous shape
			if (this._drawState === "box_first" || this._drawState === "box_second") {
				this._boxNewBtn.innerHTML = newIconSvg + " New"
				let bounds = this._map.getBounds().pad(-0.3)
				this.rect.setBounds(bounds)
				this.rect.addTo(this._map)
			} else if (this._drawState === "poly_first" || this._drawState === "poly_drawing") {
				this._polyNewBtn.innerHTML = newIconSvg + " New"
				if (this._polyLatlngs && this._polyLatlngs.length >= 3) {
					this.poly = new L.DraggablePolygon(this._polyLatlngs, L.extend({ owner: this }, polyOpts))
					this.poly.addTo(this._map)
					this._tileHighlight.addTo(this._map)
				}
			}

			this._drawPoints = []
			this._drawState = null
		},

		expand: function () {
			this._map._clickCopyDisabled = true

			if (this._mode === "box") {
				let bounds = this._map.getBounds().pad(-0.3)
				this.rect.setBounds(bounds)
				this.rect.addTo(this._map)
			} else {
				let latlngs = this._polyLatlngs || this._defaultPentagon()
				this.poly = new L.DraggablePolygon(latlngs, L.extend({ owner: this }, polyOpts))
				this.poly.addTo(this._map)
				this._tileHighlight.addTo(this._map)
			}

			return L.Control.Display.prototype.expand.call(this)
		},

		_onGotoBox: function (e) {
			let gc = e.gameCoords
			let planeOffset = 25600 * this._map.getPlane()
			let nw = gameToMap(gc.x1 - planeOffset, gc.y1)
			let se = gameToMap(gc.x2 - planeOffset, gc.y2)
			let bounds = L.latLngBounds([nw, se])

			if (this._mode !== "box") this._switchMode("box")
			this._cancelDrawing()
			if (!this._expanded) this.expand()

			this.rect.setBounds(bounds)
			if (!this.rect._map) this.rect.addTo(this._map)
			this.updateBox(bounds)
		},

		collapse: function () {
			this._map._clickCopyDisabled = false
			this._cancelDrawing()

			if (this.rect._map) {
				this.rect.remove()
			}
			if (this.poly) {
				this._polyLatlngs = this.poly.getVertexLatLngs()
				this.poly.remove()
				this.poly = null
			}
			if (this._tileHighlight._map) this._tileHighlight.remove()

			this._clearSelection()

			return L.Control.Display.prototype.collapse.call(this)
		}
	})

	L.control.display.rect = function (options) {
		return new L.Control.Display.Rect(options)
	}
})
