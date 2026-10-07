"use strict"

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
	L.MarkerIcon = {
		_svg:
			'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="28" viewBox="0 0 20 28">' +
			'<path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 7 10 18 10 18s10-11 10-18C20 4.477 15.523 0 10 0zM14 10a4 4 0 1 0-8 0 4 4 0 1 0 8 0z" fill="#00e5ff"/>' +
			"</svg>",

		createPair: function (extraClass) {
			var cls = "marker-location" + (extraClass ? " " + extraClass : "")
			var html =
				'<div class="marker-location-icon">' +
				this._svg +
				"</div>" +
				'<div class="marker-location-pulse"></div>'

			var icon = L.divIcon({
				className: cls,
				html: html,
				iconSize: [20, 28],
				iconAnchor: [10, 28],
				popupAnchor: [0, -30],
				tooltipAnchor: [12, -20]
			})

			var greyscaleIcon = L.divIcon({
				className: cls + " marker-location-greyscale",
				html: html,
				iconSize: [20, 28],
				iconAnchor: [10, 28],
				popupAnchor: [0, -30],
				tooltipAnchor: [12, -20]
			})

			return { icon: icon, greyscaleIcon: greyscaleIcon }
		},

		pinPane: function (map) {
			if (!map.getPane("pinPane")) {
				map.createPane("pinPane").style.zIndex = 550
			}
			return "pinPane"
		},

		bindSelection: function (marker) {
			marker.on("popupopen", function () {
				var el = marker.getElement()
				if (el) L.DomUtil.addClass(el, "marker-selected")
			})
			marker.on("popupclose", function () {
				var el = marker.getElement()
				if (el) L.DomUtil.removeClass(el, "marker-selected")
			})
		}
	}

	var PIN_WIDTH = 20
	var PIN_HEIGHT = 28
	var PIN_PAD = 4
	var PIN_PATH =
		"M10 0C4.477 0 0 4.477 0 10c0 7 10 18 10 18s10-11 10-18C20 4.477 15.523 0 10 0zM14 10a4 4 0 1 0-8 0 4 4 0 1 0 8 0z"
	var sprites = {}

	function pinColor(deg) {
		var a = (deg * Math.PI) / 180
		var c = Math.cos(a)
		var s = Math.sin(a)
		var rgb = [0, 229, 255]
		var m = [
			[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
			[0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
			[0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
		]
		return m.map(function (row) {
			var v = row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]
			return Math.max(0, Math.min(255, Math.round(v)))
		})
	}

	function getSprite(hue, grey) {
		var key = hue + ":" + grey
		if (sprites[key]) return sprites[key]

		var rgb = pinColor(hue)
		if (grey) {
			var l = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2])
			rgb = [l, l, l]
		}

		var scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1))
		var canvas = document.createElement("canvas")
		canvas.width = (PIN_WIDTH + 2 * PIN_PAD) * scale
		canvas.height = (PIN_HEIGHT + 2 * PIN_PAD) * scale
		var ctx = canvas.getContext("2d")
		ctx.scale(scale, scale)
		ctx.translate(PIN_PAD, PIN_PAD)
		if (grey) {
			ctx.globalAlpha = 0.5
		} else {
			ctx.shadowColor = "rgba(0, 0, 0, 0.5)"
			ctx.shadowBlur = 3
			ctx.shadowOffsetY = 2
		}
		ctx.fillStyle = "rgb(" + rgb.join(", ") + ")"
		ctx.fill(new Path2D(PIN_PATH), "evenodd")
		sprites[key] = canvas
		return canvas
	}

	function pinScale(zoom) {
		return Math.min(1, Math.max(0.5, 0.5 + (zoom - 1) / 6))
	}

	L.Canvas.include({
		_updateMarkerPin: function (layer) {
			if (!this._drawing || layer._empty()) {
				return
			}
			var p = layer._point
			var s = layer._scale
			this._ctx.drawImage(
				getSprite(layer.options.hue, layer._isGrey()),
				p.x - (PIN_WIDTH / 2 + PIN_PAD) * s,
				p.y - (PIN_HEIGHT + PIN_PAD) * s,
				(PIN_WIDTH + 2 * PIN_PAD) * s,
				(PIN_HEIGHT + 2 * PIN_PAD) * s
			)
		}
	})

	L.MarkerIcon.CanvasPin = L.CircleMarker.extend({
		options: {
			radius: PIN_HEIGHT,
			hue: 0,
			plane: null
		},

		_isGrey: function () {
			return this.options.plane !== null && this.options.plane !== this._map.getPlane()
		},

		_updateBounds: function () {
			var p = this._point
			var s = (this._scale = pinScale(this._map.getZoom()))
			this._pxBounds = new L.Bounds(
				p.subtract([(PIN_WIDTH / 2 + PIN_PAD) * s, (PIN_HEIGHT + PIN_PAD) * s]),
				p.add([(PIN_WIDTH / 2 + PIN_PAD) * s, PIN_PAD * s])
			)
			if (this._popup) {
				this._popup.options.offset = L.point(0, 7 - (PIN_HEIGHT + 2) * s)
			}
		},

		_updatePath: function () {
			this._renderer._updateMarkerPin(this)
		},

		_containsPoint: function (p) {
			var d = p.subtract(this._point)
			var s = this._scale
			return Math.abs(d.x) <= (PIN_WIDTH / 2) * s && d.y >= -PIN_HEIGHT * s && d.y <= 0
		},

		openPopup: function () {
			return L.CircleMarker.prototype.openPopup.call(this, this._latlng)
		}
	})
})
