"use strict"

import "../leaflet.js"

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
	let copySvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
	let checkSvg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'

	function rawDataText(rawData) {
		let asText = (i) => (typeof i !== "string" ? JSON.stringify(i) : i)
		return Object.entries(rawData)
			.map(([key, value]) => key + " = " + asText(value))
			.join("\n")
	}

	function createCoordsInput(container, value, map) {
		let row = document.createElement("div")
		row.className = "popup-builder-coords-row"

		let input = document.createElement("input")
		input.className = "popup-builder-coords-input"
		input.type = "text"
		input.readOnly = true
		input.value = value

		let btn = document.createElement("button")
		btn.className = "popup-builder-coords-copy-btn"
		btn.setAttribute("type", "button")
		btn.innerHTML = copySvg

		L.DomEvent.on(btn, "click", function (e) {
			L.DomEvent.stopPropagation(e)
			navigator.clipboard.writeText(input.value).then(function () {
				btn.innerHTML = checkSvg
				if (map && map.addMessage) {
					map.addMessage("Coordinates copied to clipboard")
				}
				setTimeout(function () {
					btn.innerHTML = copySvg
				}, 1500)
			})
		})

		row.appendChild(input)
		row.appendChild(btn)
		container.appendChild(row)
	}

	L.PopupBuilder = {
		toV2: function (globalX, globalY, plane) {
			let v2x = globalX * 4 + 25600 * plane
			let v2y = 50430 - globalY * 4
			return { v2x, v2y }
		},

		wikiUrl: function (name, type, id) {
			if (type && id !== undefined && id !== null) {
				let url = "https://oldschool.runescape.wiki/w/Special:Lookup?type=" + type + "&id=" + id
				return name ? url + "&name=" + encodeURIComponent(name) : url
			}
			return "https://oldschool.runescape.wiki/w/" + encodeURIComponent(name)
		},

		objectShape: null,
		npcShape: null,

		simbaCoordinate: function (tileX, tileY, sizeX, sizeY, plane) {
			let mapWidth = 100 * 256
			let top = ((196 + 1) * 64 - 1) * 4
			return {
				x: tileX * 4 + 2 * (sizeX - 1) + mapWidth * plane,
				y: top - tileY * 4 + 2 - 2 * (sizeY - 1)
			}
		},

		simbaHeight: function (height) {
			height = height / 128
			return Math.abs(height) < 0.05 ? 3 : height
		},

		simbaNumber: function (v) {
			return String(Math.round(v * 100) / 100)
		},

		simbaString: function (text) {
			return "'" + text.replace(/'/g, "''") + "'"
		},

		simbaScript: function (variable, type, tileX, tileY, plane, create) {
			let chunkX = tileX >> 6
			let chunkY = tileY >> 6
			return (
				"{$I WaspLib/main.simba}\n" +
				"\n" +
				"var\n" +
				`  ${variable}: ${type};\n` +
				"begin\n" +
				"  Map.Setup([\n" +
				`    Chunk(Box(${chunkX - 1}, ${chunkY + 1}, ${chunkX + 1}, ${chunkY - 1}), ${plane})\n` +
				"  ]);\n" +
				create.replace(/^/gm, "  ") +
				"\n" +
				"\n" +
				"  while True do\n" +
				`    ShowOnTarget(${variable});\n` +
				"end;"
			)
		},

		objectSimbaTemplate: function (name, tileX, tileY, shape) {
			let { x, y } = this.simbaCoordinate(tileX, tileY, shape.sizeX, shape.sizeY, shape.plane)
			let number = this.simbaNumber
			let create =
				"obj := TObject.Create(\n" +
				"  Map.Walker,\n" +
				`  [${number(shape.sizeX * 0.8)}, ${number(shape.sizeY * 0.8)}, ${number(this.simbaHeight(shape.height))}],\n` +
				`  [[${x}, ${y}]],\n` +
				`  [${this.simbaString(name)}]\n` +
				");"
			let script = this.simbaScript("obj", "TObject", tileX, tileY, shape.plane, create)
			return { script, create }
		},

		objectSimba: function (params) {
			let o = params.object || {}
			let fallback = { plane: params.plane || 0, sizeX: 1, sizeY: 1, height: 0 }
			let lookup =
				this.objectShape && o.id !== undefined
					? this.objectShape(o.id, o.type ?? 10, o.rotation ?? 0, params.globalX, params.globalY, o.plane ?? params.plane ?? 0)
					: Promise.resolve(null)
			return lookup
				.catch(() => null)
				.then((shape) => this.objectSimbaTemplate(params.name || "Unknown", params.globalX, params.globalY, shape || fallback))
		},

		npcPreview: function (id) {
			let element = document.createElement("div")
			element.className = "object-image-container"
			let started = false

			let image = (npcId) =>
				new Promise((resolve, reject) => {
					let img = new Image()
					img.className = "object-image"
					img.onload = () => resolve(img)
					img.onerror = reject
					img.src = `https://chisel.weirdgloop.org/static/img/osrs-npc/${npcId}_128.png`
				})

			let load = async (onLoaded) => {
				if (started || id === undefined || id === null) return
				started = true
				let img = await image(id).catch(async () => {
					let shape = this.npcShape ? await this.npcShape(id).catch(() => null) : null
					return shape && shape.form !== id ? image(shape.form).catch(() => null) : null
				})
				if (!img) return
				element.appendChild(img)
				if (onLoaded) onLoaded()
			}

			return { element, load }
		},

		npcSimbaTemplate: function (name, tileX, tileY, plane, shape) {
			let { x, y } = this.simbaCoordinate(tileX, tileY, shape.size, shape.size, plane)
			let number = this.simbaNumber
			let create =
				"npc := TEntity.Create(\n" +
				"  Map.Walker,\n" +
				`  [${number(shape.size * 0.8)}, ${number(shape.size * 0.8)}, ${number(this.simbaHeight(shape.height))}],\n` +
				"  40,\n" +
				`  [[${x}, ${y}]],\n` +
				`  [${this.simbaString(name)}]` +
				(shape.minimapDot ? ",\n  [EDot.NPC]\n" : "\n") +
				");"
			let script = this.simbaScript("npc", "TEntity", tileX, tileY, plane, create)
			return { script, create }
		},

		npcSimba: function (params) {
			let id = params.npc?.id
			let fallback = { size: 1, height: 0, minimapDot: true }
			let lookup = this.npcShape && id !== undefined ? this.npcShape(id) : Promise.resolve(null)
			return lookup
				.catch(() => null)
				.then((shape) =>
					this.npcSimbaTemplate(params.name || "Unknown", params.globalX, params.globalY, params.plane || 0, shape || fallback)
				)
		},

		createPopup: function (type, params, map) {
			if (params.name) {
				params = Object.assign({}, params, { name: params.name.replace(/<[^>]*>/g, "") })
			}

			let container = document.createElement("div")
			container.className = "popup-builder"

			// Header: bold name only
			let header = document.createElement("div")
			header.className = "popup-builder-header"
			let nameEl = document.createElement("strong")
			nameEl.textContent = params.name || "Unknown"
			header.appendChild(nameEl)
			container.appendChild(header)

			// Image container (objects only, caller passes element)
			if (params.imgContainer) {
				container.appendChild(params.imgContainer)
			}

			// V2 Coordinates input
			let v2x, v2y
			if (params.globalX !== undefined && params.globalY !== undefined) {
				let coords = this.toV2(params.globalX, params.globalY, params.plane || 0)
				v2x = coords.v2x
				v2y = coords.v2y
				createCoordsInput(container, "[" + v2x + ", " + v2y + "]", map)
			}

			// Side panel (shared by simba and raw)
			let sidePanel = document.createElement("div")
			sidePanel.className = "popup-builder-side-panel"

			let sidePanelContent = document.createElement("pre")
			sidePanelContent.className = "popup-builder-side-panel-content"
			sidePanel.appendChild(sidePanelContent)

			let sidePanelActions = document.createElement("div")
			sidePanelActions.className = "popup-builder-side-panel-actions"
			sidePanel.appendChild(sidePanelActions)

			let sidePanelCopyBtn = document.createElement("button")
			sidePanelCopyBtn.className = "popup-builder-side-panel-copy-btn"
			sidePanelCopyBtn.setAttribute("type", "button")
			sidePanelCopyBtn.innerHTML = copySvg + " Copy"
			sidePanelActions.appendChild(sidePanelCopyBtn)

			let createText = null
			let sidePanelCreateBtn = document.createElement("button")
			sidePanelCreateBtn.className = "popup-builder-side-panel-copy-btn"
			sidePanelCreateBtn.setAttribute("type", "button")
			sidePanelCreateBtn.innerHTML = copySvg + " Copy Create"
			sidePanelCreateBtn.style.display = "none"
			sidePanelActions.appendChild(sidePanelCreateBtn)

			let activePanel = null

			function togglePanel(panelName, text) {
				if (activePanel === panelName) {
					sidePanel.classList.remove("popup-builder-side-panel-visible")
					activePanel = null
					return null
				}
				sidePanelContent.textContent = text
				sidePanelCreateBtn.style.display = "none"
				sidePanel.classList.add("popup-builder-side-panel-visible")
				activePanel = panelName
				return panelName
			}

			function copyOnClick(btn, label, getText) {
				L.DomEvent.on(btn, "click", function (e) {
					L.DomEvent.stopPropagation(e)
					navigator.clipboard.writeText(getText()).then(function () {
						btn.innerHTML = checkSvg + " Copied!"
						if (map && map.addMessage) {
							map.addMessage("Copied to clipboard")
						}
						setTimeout(function () {
							btn.innerHTML = copySvg + " " + label
						}, 1500)
					})
				})
			}

			copyOnClick(sidePanelCopyBtn, "Copy", () => sidePanelContent.textContent)
			copyOnClick(sidePanelCreateBtn, "Copy Create", () => createText)

			// Toolbar
			let toolbar = document.createElement("div")
			toolbar.className = "popup-builder-toolbar"

			let simba = null
			let makeSimba =
				params.globalX === undefined
					? null
					: type === "object"
						? () => this.objectSimba(params)
						: type === "npc"
							? () => this.npcSimba(params)
							: null
			let getSimba = makeSimba && (() => (simba = simba || makeSimba()))
			let rawText = params.rawData ? rawDataText(params.rawData) : null

			// WIKI button
			if (params.name) {
				let wikiBtn = document.createElement("button")
				wikiBtn.className = "popup-builder-toolbar-btn"
				wikiBtn.setAttribute("type", "button")
				wikiBtn.textContent = "WIKI"
				wikiBtn.dataset.panel = "wiki"
				let wikiUrl =
					type === "npc"
						? this.wikiUrl(params.name, "npc", params.npc?.id)
						: type === "object"
							? this.wikiUrl(params.name, "object", params.object?.id)
							: this.wikiUrl(params.name)
				L.DomEvent.on(wikiBtn, "click", function (e) {
					L.DomEvent.stopPropagation(e)
					window.open(wikiUrl, "_blank")
				})
				toolbar.appendChild(wikiBtn)
			}

			// Simba button (npc/object only)
			let simbaBtn = null
			if (getSimba) {
				simbaBtn = document.createElement("button")
				simbaBtn.className = "popup-builder-toolbar-btn"
				simbaBtn.setAttribute("type", "button")
				simbaBtn.textContent = "Simba"
				simbaBtn.dataset.panel = "simba"
				toolbar.appendChild(simbaBtn)
			}

			// RAW button
			let rawBtn = null
			if (rawText) {
				rawBtn = document.createElement("button")
				rawBtn.className = "popup-builder-toolbar-btn"
				rawBtn.setAttribute("type", "button")
				rawBtn.textContent = "RAW"
				rawBtn.dataset.panel = "raw"
				toolbar.appendChild(rawBtn)
			}

			// Toggle behavior for simba/raw buttons
			function updateActiveStyles() {
				if (simbaBtn) {
					simbaBtn.classList.toggle("popup-builder-toolbar-btn-active", activePanel === "simba")
				}
				if (rawBtn) {
					rawBtn.classList.toggle("popup-builder-toolbar-btn-active", activePanel === "raw")
				}
			}

			if (simbaBtn) {
				L.DomEvent.on(simbaBtn, "click", function (e) {
					L.DomEvent.stopPropagation(e)
					if (togglePanel("simba", "Loading...")) {
						getSimba().then(function (code) {
							if (activePanel !== "simba") return
							sidePanelContent.textContent = code.script
							createText = code.create
							sidePanelCreateBtn.style.display = ""
						})
					}
					updateActiveStyles()
				})
			}

			if (rawBtn) {
				L.DomEvent.on(rawBtn, "click", function (e) {
					L.DomEvent.stopPropagation(e)
					togglePanel("raw", rawText)
					updateActiveStyles()
				})
			}

			container.appendChild(toolbar)
			container.appendChild(sidePanel)

			return container
		}
	}
})
