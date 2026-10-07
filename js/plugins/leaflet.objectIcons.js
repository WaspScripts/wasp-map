"use strict"

import "../leaflet.js"
import "../layers.js"
import "./leaflet.objects.js"
import "./leaflet.popup-builder.js"

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
	// On-demand object pin layer. Reuses L.DynamicIcons' visible-tile machinery.
	// With an active area selection (the rect tool's box/poly) it only renders
	// pins inside it; without one it renders every pin in view, once zoomed in
	// to viewMinZoom. The interactable objects of each visible chunk are read
	// from the game cache (see regionObjects in js/cache/worker.js), and each pin
	// is the same teardrop the OBJ search uses.
	L.ObjectIcons = L.DynamicIcons.extend({
		options: {
			source: null,
			// Only render pins for the current plane (matches the per-plane painted
			// tiles and avoids stacking up to 4x the markers). Plane changes are
			// handled by _onPlaneChange below.
			show3d: false,
			// Don't recreate markers mid zoom-animation; redraw once it settles.
			updateWhenZooming: false,
			// Keep less off-screen margin so fewer markers linger while panning.
			keepBuffer: 1,
			// Safety cap: never render more than this many pins at once.
			maxVisible: 20000,
			viewMinZoom: 1,
			zoomHint: "Zoom in to 50% or select an area to see objects"
		},

		onAdd: function (map) {
			this._map = map
			this._icon_data = {}
			this._icons = {}
			this._shardCache = {}
			this._shardPromises = {}
			this._cappedWarned = false
			this._canvas = this._canvas || L.canvas({ padding: 0.5, pane: L.MarkerIcon.pinPane(map) })
			map.on("planechange", this._onPlaneChange, this)
			map.on("areaselection", this._onSelectionChange, this)
			map.on("zoomend", this._showZoomHint, this)
			this.options.source.on("cachechange", this._onCacheChange, this)
			this._zoomHintShown = false
			this._showZoomHint()
			this._resetView()
			this._update()
		},

		onRemove: function (map) {
			map.off("planechange", this._onPlaneChange, this)
			map.off("areaselection", this._onSelectionChange, this)
			map.off("zoomend", this._showZoomHint, this)
			this.options.source.off("cachechange", this._onCacheChange, this)
			this._shardPromises = {}
			this._shardCache = {}
			this._icon_data = {}
			L.DynamicIcons.prototype.onRemove.call(this, map)
		},

		// With show3d:false the tile cache key includes the plane, so switching
		// planes means a different set of keys. Drop the current markers and
		// redraw for the new plane (shard data for all planes is already cached).
		_onPlaneChange: function () {
			this._removeAllIcons()
			this._update()
		},

		_onCacheChange: function () {
			this._shardCache = {}
			this._shardPromises = {}
			this._icon_data = {}
			this._removeAllIcons()
			this._update()
		},

		// Re-render when the area selection changes (drawn, dragged, resized,
		// mode-switched) or is cleared (rect card collapsed).
		_pinsHidden: function () {
			return !this._map._areaSelection && this._map.getZoom() < this.options.viewMinZoom
		},

		_onSelectionChange: function () {
			this._showZoomHint()
			this._cappedWarned = false
			this._removeAllIcons()
			this._update()
		},

		// Mirrors L.DynamicIcons._update, but only loads/draws inside the active
		// area selection: tiles outside the selection bounds are skipped, and
		// _addIcons filters each pin against the selection shape. With no
		// selection the layer renders nothing.
		_update: function (center) {
			var map = this._map
			if (!map) {
				return
			}
			var zoom = this.options.nativeZoom

			if (center === undefined) {
				center = map.getCenter()
			}
			if (this._tileZoom === undefined) {
				return
			} // if out of minzoom/maxzoom

			var sel = map._areaSelection
			if (!sel && map.getZoom() < this.options.viewMinZoom) {
				this._removeAllIcons()
				return
			}

			var pixelBounds = this._getTiledPixelBounds(center),
				tileRange = this._pxBoundsToTileRange(pixelBounds),
				margin = this.options.keepBuffer,
				noPruneRange = new L.Bounds(
					tileRange.getBottomLeft().subtract([margin, -margin]),
					tileRange.getTopRight().add([margin, -margin])
				)

			// Sanity check: panic if the tile range contains Infinity somewhere.
			if (
				!(
					isFinite(tileRange.min.x) &&
					isFinite(tileRange.min.y) &&
					isFinite(tileRange.max.x) &&
					isFinite(tileRange.max.y)
				)
			) {
				throw new Error("Attempted to load an infinite number of tiles")
			}

			for (var key in this._icons) {
				var c = this._icons[key].coords
				if (c.z !== this._tileZoom || !noPruneRange.contains(new L.Point(c.x, c.y))) {
					this._icons[key].current = false
					this._removeIcons(key)
				}
			}

			// If the tile zoom level differs too much from the map's, let
			// _setView reset levels and prune old tiles.
			if (Math.abs(zoom - this._tileZoom) > 1) {
				this._setView(center, zoom)
				return
			}

			for (var j = tileRange.min.y; j <= tileRange.max.y; j++) {
				for (var i = tileRange.min.x; i <= tileRange.max.x; i++) {
					var coords = new L.Point(i, j)
					coords.z = this._tileZoom
					coords.plane = this._map.getPlane()

					if (!this._isValidTile(coords)) {
						continue
					}

					// Skip chunks that don't overlap the selection's bounding box.
					var chunkI = coords.x
					var chunkJ = -coords.y
					var chunkBounds = L.latLngBounds(
						[chunkJ << 6, chunkI << 6],
						[(chunkJ + 1) << 6, (chunkI + 1) << 6]
					)
					if (sel && !sel.bounds.intersects(chunkBounds)) {
						continue
					}

					var dataKey = this._tileCoordsToKey(coords)

					if (this._icons[dataKey]) {
						// already drawn
						this._icons[dataKey].current = true
					} else if (dataKey in this._icon_data) {
						// chunk already read & bucketed -> draw now
						this._addIcons(coords)
					} else {
						// not loaded yet -> read the chunk's objects from the cache
						this._ensureShardForCoords(coords)
					}
				}
			}
		},

		// Read (once) the objects of this tile's chunk from the cache, bucket
		// them into _icon_data, then re-run _update to draw them.
		_ensureShardForCoords: function (coords) {
			var chunkI = coords.x
			var chunkJ = -coords.y
			var shardKey = chunkI + "_" + chunkJ

			if (this._shardCache[shardKey] || this._shardPromises[shardKey]) {
				return
			}

			var self = this
			var promise = this.options.source.requestObjects(chunkI, chunkJ)
			this._shardPromises[shardKey] = promise
			promise
				.then(function (records) {
					if (self._shardPromises[shardKey] !== promise) return
					self._bucketShard(records)
					self._shardCache[shardKey] = true
					delete self._shardPromises[shardKey]
					if (self._map) {
						self._update()
					}
				})
				.catch(function (err) {
					if (self._shardPromises[shardKey] === promise) delete self._shardPromises[shardKey]
					console.error(err)
				})
		},

		_bucketShard: function (records) {
			records.forEach((rec) => {
				var key = this._tileCoordsToKey({ plane: rec.p, x: rec.i, y: -rec.j })
				if (!(key in this._icon_data)) {
					this._icon_data[key] = []
				}
				this._icon_data[key].push(rec)
			})
		},

		_totalIcons: function () {
			var n = 0
			for (var key in this._icons) {
				n += this._icons[key].icons.length
			}
			return n
		},

		// Only create markers for pins inside the active selection shape, up to
		// the maxVisible cap.
		_addIcons: function (coords) {
			var key = this._tileCoordsToKey(coords)
			var data = this._icon_data[key]
			var sel = this._map._areaSelection
			var icons = []

			if (data) {
				var total = this._totalIcons()
				for (var n = 0; n < data.length; n++) {
					if (total + icons.length >= this.options.maxVisible) {
						if (!this._cappedWarned) {
							this._cappedWarned = true
							if (this._map.addMessage) {
								this._map.addMessage(
									"Too many objects in view; showing the first " +
										this.options.maxVisible +
										". Zoom in or shrink the selection."
								)
							}
						}
						break
					}
					var rec = data[n]
					var lat = (rec.j << 6) + rec.y + 0.5
					var lng = (rec.i << 6) + rec.x + 0.5
					if (!sel || sel.contains(lat, lng)) {
						var icon = this.createIcon(rec)
						this._map.addLayer(icon)
						icons.push(icon)
					}
				}
			}

			this._icons[key] = { icons: icons, coords: coords, current: true }
		},

		// Builds the same teardrop marker + lazy object popup as the OBJ search
		// (leaflet.objects.js), from a compact shard record {p,i,j,x,y,id,t,r,n}.
		createIcon: function (rec) {
			let item = {
				plane: rec.p,
				storedPlane: rec.z,
				i: rec.i,
				j: rec.j,
				x: rec.x,
				y: rec.y,
				id: rec.id,
				type: rec.t,
				rotation: rec.r,
				name: rec.n
			}

			let latlng = [(item.j << 6) + item.y + 0.5, (item.i << 6) + item.x + 0.5]
			let marker
			if (this._map._areaSelection) {
				let { icon } = L.MarkerIcon.createPair()
				marker = L.marker(latlng, { icon: icon })
				L.MarkerIcon.bindSelection(marker)
			} else {
				marker = new L.MarkerIcon.CanvasPin(latlng, { renderer: this._canvas })
			}

			L.Objects.prototype._bindObjectPopup.call(this, marker, item)

			return marker
		}
	})

	L.objectIcons = function (options) {
		return new L.ObjectIcons(options)
	}
})
