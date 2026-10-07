import "../leaflet.js"
;(function (factory) {
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
	L.Control.Position = L.Control.extend({
		options: {
			position: "topright",
			separator: ", ",
			emptyString: "Unavailable",
			prefix: "",
			flyDuration: 3 //seconds
		},

		initialize: function (options) {
			L.setOptions(this, options)
			this._map = null
			this._panelOpen = false
			this._panelMode = null
		},

		onAdd: function (map) {
			this._map = map
			this._container = L.DomUtil.create("div", "leaflet-control-position")

			this._chunkBox = L.DomUtil.create("div", "leaflet-control-position-box", this._container)
			this._tileBox = L.DomUtil.create("div", "leaflet-control-position-box", this._container)

			this._panel = L.DomUtil.create("div", "leaflet-control-position-panel", this._container)
			var form = L.DomUtil.create("div", "leaflet-control-position-form", this._panel)
			this._label = L.DomUtil.create("span", "leaflet-control-position-label", form)
			this._label.textContent = "Go to:"
			this._input = L.DomUtil.create("input", "leaflet-control-position-input", form)
			this._input.type = "text"
			this._input.placeholder = "x, y"
			var goBtn = L.DomUtil.create("button", "leaflet-control-position-go", form)
			goBtn.textContent = "Go"

			var boxForm = L.DomUtil.create("div", "leaflet-control-position-form", this._panel)
			this._boxLabel = L.DomUtil.create("span", "leaflet-control-position-label", boxForm)
			this._boxLabel.textContent = "Go to box:"
			this._boxInput = L.DomUtil.create("input", "leaflet-control-position-input", boxForm)
			this._boxInput.type = "text"
			this._boxInput.placeholder = "x1, y1, x2, y2"
			var goBoxBtn = L.DomUtil.create("button", "leaflet-control-position-go", boxForm)
			goBoxBtn.textContent = "Go"

			L.DomEvent.on(goBoxBtn, "click", this._onGoBox, this)
			L.DomEvent.on(
				this._boxInput,
				"keydown",
				function (e) {
					if (e.key === "Enter") {
						this._onGoBox()
					}
				},
				this
			)

			this._rect = L.rectangle(
				[
					[0, 0],
					[1, 1]
				],
				{
					color: "#ff7800",
					weight: 1
				}
			)

			// gross hack because the Path renderer doesn't work properly if this is added right now
			// we delay this for after this event loop finishes
			setTimeout(() => {
				this._rect.addTo(map)
			}, 0)

			L.DomEvent.disableClickPropagation(this._container)
			L.DomEvent.on(
				this._chunkBox,
				"click",
				function () {
					this._openPanel("chunk")
				},
				this
			)
			L.DomEvent.on(
				this._tileBox,
				"click",
				function () {
					this._openPanel("tile")
				},
				this
			)
			L.DomEvent.on(goBtn, "click", this._onGo, this)
			L.DomEvent.on(
				this._input,
				"keydown",
				function (e) {
					if (e.key === "Enter") {
						this._onGo()
					}
				},
				this
			)
			L.DomUtil.disableTextSelection()

			this._map.on("mousemove", this._updateContainerPointCache, this)
			this._map.on("move moveend zoom zoomend resize", this.redrawRect, this)
			this._map.on("mouseout", this.clear.bind(this))

			this._map.on("planechange", this._showIdle, this)
			this._showIdle()

			return this._container
		},

		_openPanel: function (mode) {
			if (this._panelOpen && this._panelMode === mode) {
				this._panelOpen = false
				this._panelMode = null
				L.DomUtil.removeClass(this._panel, "visible")
				return
			}
			this._panelOpen = true
			this._panelMode = mode
			if (mode === "chunk") {
				this._label.textContent = "Go to chunk:"
				this._input.placeholder = "chunkX, chunkY"
			} else {
				this._label.textContent = "Go to tile:"
				this._input.placeholder = "x, y"
			}
			this._input.value = ""
			L.DomUtil.addClass(this._panel, "visible")
			this._input.focus()
		},

		_onGo: function () {
			var input = this._input.value
			if (input) {
				var destination
				if (this._panelMode === "chunk") {
					var numbers = input.match(/\d+/g)
					if (!numbers || numbers.length < 2) return
					var nums = numbers.map(Number)
					destination = {
						plane: this._map.getPlane(),
						globalX: nums[0] * 64 + 32,
						globalY: nums[1] * 64 + 32
					}
				} else {
					var numbers = input.match(/-?\d+/g)
					if (!numbers || numbers.length < 2) return
					var nums = numbers.map(Number)
					destination = {
						plane: this._map.getPlane(),
						globalX: (nums[0] - 25600 * this._map.getPlane()) / 4,
						globalY: (50430 - nums[1]) / 4
					}
				}
				if (this.validateCoordinate(destination)) {
					this.panMap(destination)
					this.placeCrosshair(destination)
					this._input.value = ""
					this._panelOpen = false
					this._panelMode = null
					L.DomUtil.removeClass(this._panel, "visible")
				} else {
					console.error(
						input,
						"was parsed as",
						this.createString(destination),
						"which is not a valid coordinate."
					)
				}
			}
		},

		_onGoBox: function () {
			var input = this._boxInput.value
			if (!input) return
			var numbers = input.match(/-?\d+/g)
			if (!numbers || numbers.length < 4) return
			var nums = numbers.map(Number)
			var x1 = nums[0],
				y1 = nums[1],
				x2 = nums[2],
				y2 = nums[3]
			var centerX = (x1 + x2) / 2
			var centerY = (y1 + y2) / 2
			var destination = {
				plane: this._map.getPlane(),
				globalX: (centerX - 25600 * this._map.getPlane()) / 4,
				globalY: (50430 - centerY) / 4
			}
			if (this.validateCoordinate(destination)) {
				this.panMap(destination)
				this._map.fire("gotobox", { gameCoords: { x1: x1, y1: y1, x2: x2, y2: y2 } })
				this._boxInput.value = ""
				this._panelOpen = false
				this._panelMode = null
				L.DomUtil.removeClass(this._panel, "visible")
			} else {
				console.error(
					input,
					"was parsed as center",
					centerX,
					centerY,
					"which is not a valid coordinate."
				)
			}
		},

		_showIdle: function () {
			if (this._shownTile) return
			this._chunkBox.textContent = "Chunk(0, 0, " + this._map._plane + ")"
			this._tileBox.textContent = "[0, 0]"
		},

		clear: function () {
			if (this._panelOpen) return
			this._shownTile = null
			this._showIdle()
			// hack to make it 'disappear'...not calling .remove()
			// because otherwise `redrawRect` would have to check
			//			every update that it's really on the map
			this._rect.setBounds([
				[-1000, -1000],
				[-1000, -1000]
			])
		},

		onRemove: function (map) {
			map.off("mousemove", this._update)
			this.rect.remove()
		},

		convert: function (_globalX, _globalY) {
			return { chunkX: _globalX >> 6, chunkY: _globalY >> 6 }
		},

		panMap: function (destination) {
			this._map.setPlane(destination.plane)
			this._map.flyTo([destination.globalY, destination.globalX], 3, {
				duration: this.options.flyDuration,
				animate: false
			})
			this._map.once("moveend", function () {
				this.fire("panend")
			})
		},

		placeCrosshair: function (destination) {
			let icon = L.divIcon({
				className: "search-marker",
				iconSize: [40, 40],
				iconAnchor: [20, 20],
				html: '<div class="search-marker-ring"></div><div class="search-marker-pulse"></div><div class="search-marker-dot"></div>'
			})
			let marker = L.marker(L.latLng(destination.globalY + 0.5, destination.globalX + 0.5), {
				icon: icon,
				interactive: false
			})
			marker.addTo(this._map)
			setTimeout(() => {
				if (marker) {
					let el = marker.getElement()
					if (el) L.DomUtil.addClass(el, "search-marker-removing")
					setTimeout(() => {
						if (marker) marker.remove()
					}, 1000)
				}
			}, 49000)
		},

		validateCoordinate: function (destination) {
			return (
				destination &&
				destination.plane < 4 &&
				this._map.options.maxBounds.contains(L.latLng(destination.globalY, destination.globalX))
			)
		},

		createString: function (...args) {
			if (typeof args[0] === "number") {
				return args.join(this.options.separator)
			}
			if (typeof args[0] === "object") {
				let coord = args[0]
				return [coord.plane, coord.chunkX, coord.chunkY, coord.globalX, coord.globalY]
					.filter((item) => item !== undefined)
					.join(this.options.separator)
			}
		},
		_containerPointCache: {
			x: 0,
			y: 0
		},

		_updateContainerPointCache: function (e) {
			this._containerPointCache = e.containerPoint
			this.redrawRect()
		},
		redrawRect: function () {
			if (this._map._hidePositionRect) {
				this._shownTile = null
				this._rect.setBounds([
					[-1000, -1000],
					[-1000, -1000]
				])
				return
			}
			let position = this._map.containerPointToLatLng(this._containerPointCache)
			this.globalX = parseInt(position.lng)
			this.globalY = parseInt(position.lat)
			let shownTile = this.globalX + "," + this.globalY + "," + this._map._plane
			if (shownTile === this._shownTile) return
			this._shownTile = shownTile

			let chunk = this.convert(this.globalX, this.globalY)

			this._chunkBox.textContent = "Chunk(" + chunk.chunkX + ", " + chunk.chunkY + ", " + this._map._plane + ")"
			let v2x = this.globalX * 4 + 25600 * this._map._plane
			let v2y = 50430 - this.globalY * 4
			this._tileBox.textContent = "[" + v2x + ", " + v2y + "]"

			this._rect.setBounds([
				[this.globalY, this.globalX],
				[this.globalY + 1, this.globalX + 1]
			])
		}
	})

	L.control.position = function (options) {
		return new L.Control.Position(options)
	}
})
