"use strict"

import "../leaflet.js"
import "../layers.js"
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
	function placementItem(found, k) {
		let regionId = found[k + 1]
		let packed = found[k + 2]
		return {
			id: found[k],
			i: regionId >> 8,
			j: regionId & 0xff,
			x: (packed >> 6) & 0x3f,
			y: packed & 0x3f,
			plane: (packed >> 22) & 3,
			storedPlane: (packed >> 12) & 3,
			type: (packed >> 16) & 0x3f,
			rotation: (packed >> 14) & 3
		}
	}

	function itemPosition(item) {
		return "location" in item
			? item.location
			: { plane: item.plane, x: (item.i << 6) + item.x, y: (item.j << 6) + item.y }
	}

	L.Objects = L.DynamicIcons.extend({
		onAdd: function (map) {
			this._map = map
			if (!(this.options.names?.length || this.options.ids?.length)) {
				throw new Error("No objects specified")
			}
			this._icon_data = {}
			this._icons = {}
			map.on("planechange", this._onPlaneChange, this)
			this.options.source.on("cachechange", this._refresh, this)
			this._search(true)
		},

		onRemove: function (map) {
			map.off("planechange", this._onPlaneChange, this)
			this.options.source.off("cachechange", this._refresh, this)
			this._searchToken = null
			L.DynamicIcons.prototype.onRemove.call(this, map)
		},

		_refresh: function () {
			this._search(false)
		},

		_search: function (fit) {
			let token = (this._searchToken = {})
			this.getData(this.options.names ?? [], this.options.ids ?? [])
				.then((locations) => {
					if (this._searchToken !== token || !this._map) return
					if (fit && locations.length > 0) {
						let positions = locations.map(itemPosition)
						let planes = {}
						positions.forEach((p) => (planes[p.plane] = (planes[p.plane] || 0) + 1))
						let mostCommonPlane = +Object.entries(planes).sort((a, b) => b[1] - a[1])[0][0]
						this._map.setPlane(mostCommonPlane)
						if (locations.length <= 50) {
							let bounds = L.latLngBounds(positions.map((p) => [p.y + 0.5, p.x + 0.5]))
							this._map.fitBounds(bounds, { maxZoom: 6, animate: false })
						}
					}

					this._removeAllIcons()
					this._icon_data = this.parseData(locations)
					this._icons = {}
					this._resetView()
					this._update()
				})
				.catch((error) => {
					if (this._searchToken === token) console.error(error)
				})
		},

		getData: async function (names, ids) {
			let { found } = await this.options.source.findObjects(names, ids)
			let locations = []
			for (let k = 0; k < found.length; k += 3) {
				locations.push(placementItem(found, k))
			}
			return locations
		},

		parseData: function (data) {
			let icon_data = {}

			data.forEach((item) => {
				let p = itemPosition(item)
				let key = this._tileCoordsToKey({ plane: p.plane, x: p.x >> 6, y: -(p.y >> 6) })

				if (!(key in icon_data)) {
					icon_data[key] = []
				}
				icon_data[key].push(item)
			})

			let reallyLoadEverything =
				data.length < 10000 ? true : confirm(`Really load ${data.length} markers?`)
			if (reallyLoadEverything) {
				this._map.addMessage(`Found ${data.length} locations of this object.`)
				return icon_data
			} else {
				return {}
			}
		},

		_onPlaneChange: function (e) {
			for (let key in this._icons) {
				for (let marker of this._icons[key].icons) {
					let { icon, greyscaleIcon } = marker._objectIcons
					marker.setIcon(marker._objectPlane === e.newPlane ? icon : greyscaleIcon)
					if (marker.isPopupOpen()) {
						let el = marker.getElement()
						if (el) L.DomUtil.addClass(el, "marker-selected")
					}
				}
			}
		},

		createIcon: function (item) {
			let p = itemPosition(item)
			let icons = L.MarkerIcon.createPair()

			let marker = L.marker([p.y + 0.5, p.x + 0.5], {
				icon: p.plane === this._map.getPlane() ? icons.icon : icons.greyscaleIcon
			})
			marker._objectIcons = icons
			marker._objectPlane = p.plane

			L.MarkerIcon.bindSelection(marker)
			this._bindObjectPopup(marker, item)
			return marker
		},

		_bindObjectPopup: function (marker, item) {
			let placeholder = document.createElement("div")
			placeholder.textContent = "Loading..."
			marker.bindPopup(placeholder, {
				autoPan: true,
				autoPanPadding: L.point(40, 40),
				offset: L.Popup.prototype.options.offset
			})

			marker.once("popupopen", async () => {
				let config = (await this.options.source.objectConfig(item.id).catch(() => null)) ?? {
					id: item.id,
					name: item.name
				}

				let server = "location" in item
				let p = itemPosition(item)
				let rawData = server
					? { plane: p.plane, x: p.x, y: p.y, label: item.label }
					: { plane: p.plane, x: p.x, y: p.y, id: item.id, type: item.type, rotation: item.rotation }
				for (const [key, value] of Object.entries(config)) {
					if (key !== "name") rawData[key] = value
				}

				let imgContainer = document.createElement("div")
				imgContainer.setAttribute("class", "object-image-container")
				L.Objects.prototype.createModelTab
					.call(this, item, config)
					.then((img) => imgContainer.appendChild(img))

				let popup = L.PopupBuilder.createPopup(
					"object",
					{
						name: config.name || item.name,
						globalX: p.x,
						globalY: p.y,
						plane: p.plane,
						object: server
							? { id: item.id, plane: p.plane }
							: { id: item.id, type: item.type, rotation: item.rotation, plane: item.storedPlane ?? item.plane },
						imgContainer: imgContainer,
						rawData: rawData
					},
					this._map
				)

				marker.getPopup().setContent(popup)
				marker.getPopup().update()
			})
		},

		createModelTab: async function (loc, location_config) {
			function getImage(id) {
				return new Promise((resolve, reject) => {
					let img = new Image()
					img.onload = () => resolve(img)
					img.onerror = () => {
						console.warn(`Unable to load the image of object ${id}`)
						reject()
					}
					let rotation = loc.rotation ?? 0
					img.src = `https://chisel.weirdgloop.org/static/img/osrs-object/${id}_orient${rotation}.png`
				})
			}
			let ids = [location_config.id ?? loc.id]

			let imgs = await Promise.allSettled(ids.map(getImage))

			if (imgs.length === 1 && imgs[0].status === "fulfilled") {
				let img = imgs[0].value
				img.setAttribute("class", "object-image")
				return img
			} else if (imgs.some((img) => img.status === "fulfilled")) {
				let tabs = document.createElement("div")
				tabs.setAttribute("class", "tabs")

				let content = document.createElement("div")
				content.setAttribute("class", "content")

				imgs.forEach((img_promise, i) => {
					if (
						img_promise.status === "fulfilled" &&
						(img_promise.value.width > 1 || img_promise.value.height > 1)
					) {
						if (!content.innerHTML) {
							let img = img_promise.value
							img.setAttribute("class", "object-image")
							content.appendChild(img)
						}

						let button = document.createElement("div")
						button.innerHTML = ids[i]
						button.addEventListener("click", () => {
							content.innerHTML = ""
							let img = img_promise.value
							img.setAttribute("class", "object-image")
							content.appendChild(img)
						})
						button.setAttribute("class", "tabbutton")
						tabs.appendChild(button)
					}
				})
				let combined = document.createElement("div")
				combined.appendChild(tabs)
				combined.appendChild(content)
				return combined
			} else {
				return document.createElement("div")
			}
		}
	})

	L.objects = function (options) {
		return new L.Objects(options)
	}

	L.Objects.Game = L.Objects.extend({
		getData: async function (names, ids) {
			let serverData = this.options.source
				.objectIds(names, ids)
				.then((allIds) =>
					Promise.allSettled(
						Array.from(allIds, (id) =>
							fetch(`https://chisel.weirdgloop.org/scenery/server_mapdata?id=${id}`).then((res) =>
								res.ok ? res.json() : []
							)
						)
					)
				)
			let [locations, server] = await Promise.all([
				L.Objects.prototype.getData.call(this, names, ids),
				serverData
			])
			for (let result of server) {
				if (result.status === "fulfilled") locations.push(...[result.value].flat())
			}
			return locations
		}
	})

	L.objects.game = function (options) {
		return new L.Objects.Game(options)
	}
})
