"use strict";
import "./leaflet.js";
import "./plugins/leaflet.markerIcon.js";
import "./plugins/leaflet.popup-builder.js";

(function (factory) {
    var L;
    if (typeof define === "function" && define.amd) {
        define(["leaflet"], factory);
    } else if (typeof module !== "undefined") {
        L = require("leaflet");
        module.exports = factory(L);
    } else {
        if (typeof window.L === "undefined") {
            throw new Error("Leaflet must be loaded first");
        }
        factory(window.L);
    }
})(function (L) {
    // see https://stackoverflow.com/a/60391674
    L.Map.include({
        _initControlPos: function () {
            var corners = (this._controlCorners = {}),
                l = "leaflet-",
                container = (this._controlContainer = L.DomUtil.create("div", l + "control-container", this._container));

            function createCorner(vSide, hSide) {
                var className = l + vSide + " " + l + hSide;

                corners[vSide + hSide] = L.DomUtil.create("div", className, container);
            }

            createCorner("top", "left");
            createCorner("top", "right");
            createCorner("bottom", "left");
            createCorner("bottom", "right");

            createCorner("top", "center");
            createCorner("middle", "center");
            createCorner("middle", "left");
            createCorner("middle", "right");
            createCorner("bottom", "center");
        },
    });

    L.GameMap = L.Map.extend({
        initialize: function (id, options) {
            // (HTMLElement or String, Object)

            let parsedUrl = new URL(window.location.href);

            options.zoom = Number(parsedUrl.searchParams.get("zoom") || parsedUrl.searchParams.get("z") || this._limitZoom(options.zoom) || 0);

            this._plane = Number(parsedUrl.searchParams.get("plane") || parsedUrl.searchParams.get("p") || this._limitPlane(options.plane) || 0);

            options.x = Number(parsedUrl.searchParams.get("x")) || options.x || 3232;
            options.y = Number(parsedUrl.searchParams.get("y")) || options.y || 3232;
            options.center = [options.y, options.x];

            options.crs = L.CRS.Simple;

            L.Map.prototype.initialize.call(this, id, options);

            this.on("moveend planechange", this.setSearchParams);

            if (options.messageBox) {
                this._messageContainer = L.DomUtil.create("div", "leaflet-control-message-container");
                this._controlContainer.appendChild(this._messageContainer);
            }
        },

        addMessage: function (message) {
            if (this.options.messageBox) {
                let messageBox = L.DomUtil.create("div", "leaflet-control-message-box");
                L.DomEvent.disableClickPropagation(messageBox);

                let messageContent = L.DomUtil.create("div", "leaflet-control-message-content");
                messageContent.innerHTML = message;
                messageBox.appendChild(messageContent);

                let clearButton = L.DomUtil.create("div", "leaflet-control-message-clear");
                clearButton.innerHTML = "\u00d7";
                clearButton.onclick = () => this._messageContainer.removeChild(messageBox);
                messageBox.appendChild(clearButton);

                this._messageContainer.appendChild(messageBox);
                setTimeout(() => {
                    if (this._messageContainer.contains(messageBox)) {
                        this._messageContainer.removeChild(messageBox);
                    }
                }, 4000);
                return messageBox;
            } else {
                console.log(message);
            }
        },

        setSearchParams: function (
            e,
            parameters = {
                z: this._zoom,
                p: this._plane,
                x: Math.round(this.getCenter().lng),
                y: Math.round(this.getCenter().lat),
            }
        ) {
            let url = new URL(window.location.href);
            let params = url.searchParams;

            for (const param of ["mapId", "mapid", "m", "zoom", "plane", "era"]) {
                params.delete(param);
            }

            for (let [key, value] of Object.entries(parameters)) {
                if (value !== null) {
                    params.set(key, value);
                }
            }
            url.search = params;
            history.replaceState(0, "Location", url);
            return Promise.resolve();
        },

        _limitPlane: function (plane) {
            //todo process allowedPlanes in basemap data
            var min = this.getMinPlane();
            var max = this.getMaxPlane();
            return Math.max(min, Math.min(max, plane));
        },

        getPlane: function () {
            return this._plane;
        },

        getMinPlane: function () {
            return this.options.minPlane || 0;
        },

        getMaxPlane: function () {
            return this.options.maxPlane || 3;
        },

        setPlane: function (_plane) {
            let newPlane = this._limitPlane(_plane);
            let oldPlane = this._plane;
            if (oldPlane !== newPlane) {
                this.fire("preplanechange", {
                    oldPlane: oldPlane,
                    newPlane: newPlane,
                });
                this.fire("viewprereset");
                this._plane = newPlane;
                this.fire("viewreset");
                this.fire("planechange", {
                    oldPlane: oldPlane,
                    newPlane: newPlane,
                });
                return this;
            }
        },

    });

L.gameMap = function (id, options) {
    return new L.GameMap(id, options);
};

L.Grid = L.GridLayer.extend({
    initialize: function (options) {
        options.maxNativeZoom = 2;
        options.minNativeZoom = 2;
        options.minZoom = 1;
        L.setOptions(this, options);
    },

    createTile: function (coords) {
        let tile = L.DomUtil.create("div", "grid");
        tile.innerHTML = [coords.x, -(1 + coords.y)].join(", ");
        return tile;
    },

    _update: function (center) {
        if (this._map.getZoom() >= this.options.minZoom) {
            return L.GridLayer.prototype._update.call(this, center);
        }
    },
});

L.grid = function (options) {
    return new L.Grid(options);
};

L.Heatmap = L.GridLayer.extend({
    initialize: function (options = {}) {
        options.minZoom = 2;
        options.granularity = 2;
        options.gameTilePx = 4;
        options.tileSize = options.gameTilePx * 64;
        options.maxRange = 100;

        L.setOptions(this, options);
        this._markers = [];
    },

    onAdd: function (map) {
        L.GridLayer.prototype.onAdd.call(this, map);
        this._load();
    },

    onRemove: function (map) {
        this._markers.forEach((marker) => marker.remove());
        this._markers = [];
        L.GridLayer.prototype.onRemove.call(this, map);
    },

    _load: async function () {
        let { source, npcs: names, ids, range, showHeat } = this.options;
        let npcs;
        try {
            npcs = await source.findNpcs(names ?? [], ids ?? []);
        } catch (error) {
            console.error(error);
            if (this._map) this._map.addMessage("Unable to find instances of this npc.");
            return;
        }
        if (!this._map) return;

        if (npcs.length === 0) {
            this._map.addMessage("Unable to find instances of this npc.");
            return;
        }
        this._map.addMessage(
            npcs.length > 50 ? `Found ${npcs.length} instances of this npc. Too many to zoom to fit.` : `Found ${npcs.length} instances of this npc`
        );

        let planes = {};
        npcs.forEach((npc) => (planes[npc.p] = (planes[npc.p] || 0) + 1));
        this._map.setPlane(+Object.entries(planes).sort((a, b) => b[1] - a[1])[0][0]);
        if (npcs.length <= 50) {
            let bounds = L.latLngBounds(npcs.map((npc) => [npc.y + 0.5, npc.x + 0.5]));
            this._map.fitBounds(bounds, { maxZoom: 6, animate: false });
        }

        this._markers = npcs.map((npc) => this.addMarker(npc, this._map));

        if (showHeat && range > 0) {
            let heat = await source.npcHeat(npcs, Math.min(range, this.options.maxRange)).catch((error) => {
                console.error(error);
                return null;
            });
            if (!heat || !this._map) return;
            this._heatData = heat;
            this._maxHeat = Math.max(1, ...Object.values(heat).map((counts) => counts.reduce((a, b) => Math.max(a, b), 0)));
            this.redraw();
        }
    },

    colors: {},

    getColor: function (tileData) {
        let key = tileData.toString();
        if (!this.colors[key]) {
            this.colors[key] = "rgba(" + parseInt((255 * tileData) / this._maxHeat) + ",0, 0, " + parseInt((100 * tileData) / this._maxHeat) / 100 + ")";
        }
        return this.colors[key];
    },

    textColors: {},

    getTextColor: function (tileData) {
        let key = tileData.toString();
        if (!this.textColors[key]) {
            this.textColors[key] = "rgba( 255 ,255, 255, " + parseInt((100 * tileData) / this._maxHeat) / 100 + ")";
        }
        return this.textColors[key];
    },

    addMarker: function (npc, map) {
        let { icon, greyscaleIcon } = L.MarkerIcon.createPair("huechange");

        let marker = L.marker([npc.y + 0.5, npc.x + 0.5], {
            icon: npc.p === this._map.getPlane() ? icon : greyscaleIcon,
        });

        L.MarkerIcon.bindSelection(marker);

        this._map.on("planechange", function (e) {
            marker.setIcon(npc.p === e.newPlane ? icon : greyscaleIcon);
            if (marker.isPopupOpen()) {
                let el = marker.getElement();
                if (el) L.DomUtil.addClass(el, "marker-selected");
            }
        });

        let rawData = {};
        for (const [key, value] of Object.entries(npc)) {
            rawData[key] = value;
        }

        let preview = L.PopupBuilder.npcPreview(npc.id);
        let popup = L.PopupBuilder.createPopup(
            "npc",
            {
                name: npc.name,
                globalX: npc.x,
                globalY: npc.y,
                plane: npc.p,
                npc: { id: npc.id },
                imgContainer: preview.element,
                rawData: rawData,
            },
            this._map
        );
        marker.bindPopup(popup, {
            autoPan: true,
            autoPanPadding: L.point(40, 40),
        });
        marker.on("popupopen", () => preview.load(() => marker.getPopup()?.update()));
        marker.addTo(map);

        return marker;
    },

    createTile: function (coords) {
        var tileSize = this.getTileSize();
        var tile = document.createElement("canvas");
        tile.setAttribute("width", tileSize.x);
        tile.setAttribute("height", tileSize.y);

        let plane = this._map.getPlane();
        let properX = coords.x >> (coords.z - 2);
        let properY = -(1 + coords.y) >> (coords.z - 2);
        let data = this._heatData?.[`${plane}_${properX}_${properY}`];
        if (data) this._drawTile(tile, coords, data);

        return tile;
    },

    _drawTile: function (tile, coords, data) {
        let pixelsInGameTile = this.options.gameTilePx * 2 ** (coords.z - this.options.granularity);
        let gameTilesInTile = 64 * 2 ** (this.options.granularity - coords.z);
        let modifier = 2 ** (coords.z - this.options.granularity) - 1;

        let startX = (coords.x & modifier) * gameTilesInTile;
        let startY = (-(1 + coords.y) & modifier) * gameTilesInTile;

        var ctx = tile.getContext("2d");

        for (let i = startX; i < startX + gameTilesInTile; i++) {
            for (let j = startY; j < startY + gameTilesInTile; j++) {
                let tileData = data[(i << 6) | j];
                if (tileData) {
                    this._drawRect(ctx, startX, startY, i, j, pixelsInGameTile, tileData);
                }
            }
        }
    },

    _drawRect: function (ctx, startX, startY, i, j, pixelsInGameTile, tileData) {
        let x = (i - startX) * pixelsInGameTile;
        let y = this.getTileSize().y - (j + 1 - startY) * pixelsInGameTile;

        ctx.fillStyle = this.getColor(tileData);
        ctx.fillRect(x, y, pixelsInGameTile, pixelsInGameTile);
        ctx.font = pixelsInGameTile + "px serif";

        ctx.textBaseline = "middle";
        ctx.textAlign = "center";

        ctx.fillStyle = this.getTextColor(tileData);
        ctx.fillText(tileData, x + 0.5 * pixelsInGameTile, y + 0.5 * pixelsInGameTile);
    },
});

L.heatmap = function (options) {
    return new L.Heatmap(options);
};

// @factory L.DynamicIcons(options?: DynamicIcons options)
// Creates a new layer  with the supplied options.

L.DynamicIcons = L.Layer.extend({
    options: {
        updateWhenIdle: L.Browser.mobile,
        updateWhenZooming: true,
        updateInterval: 200,
        zIndex: 1,
        bounds: null,
        minZoom: undefined,
        maxZoom: undefined,

        // @option nativeZoom: Number
        // The zoom level at which one tile corresponds to one unit of granularity of the icon data
        nativeZoom: 2,

        // @option nativeZoomTileSize: Number
        // Px size of one tile at nativeZoom. Use a number if width and height are equal, or `L.point(width, height)` otherwise.
        nativeTileSize: 256,

        className: "",
        keepBuffer: 2,

        loadData: undefined,

        // @option show3d: boolean
        // If true, shows a greyed marker if the marker is on a different plane
        show3d: true,

        canvas: false,

        pinHue: 0,

        zoomHint: undefined,

        popupType: "generic",
    },

    initialize: function (options) {
        L.setOptions(this, options);
    },

    onAdd: function (map) {
        // eslint-disable-line no-unused-vars
        if (this.options.canvas) {
            this._canvas = this._canvas || L.canvas({ padding: 0.5, pane: L.MarkerIcon.pinPane(map) });
            map.on("planechange", this._redrawPins, this);
        }
        map.on("zoomend", this._showZoomHint, this);
        this._zoomHintShown = false;
        this._showZoomHint();

        if (this.options.loadData) {
            this.options
                .loadData()
                .then((response) => {
                    if (!this._map) return;
                    this._icon_data = this.parseData(response);
                    this._icons = {};
                    this._resetView();
                    this._update();
                })
                .catch(console.error);
        } else {
            throw new Error("No loadData specified");
        }
    },

    parseData: function (data) {
        data.forEach(
            (item) =>
            (item.key = this._tileCoordsToKey({
                plane: item.p ?? item.plane,
                x: item.x >> 6,
                y: -(item.y >> 6),
            }))
        );

        let icon_data = {};
        data.forEach((item) => {
            if (!(item.key in icon_data)) {
                icon_data[item.key] = [];
            }
            icon_data[item.key].push(item);
        });

        console.info("Added", data.length, "items");
        return icon_data;
    },

    onRemove: function (map) {
        // eslint-disable-line
        map.off("planechange", this._redrawPins, this);
        map.off("zoomend", this._showZoomHint, this);
        this._removeAllIcons();

        this._tileZoom = undefined;
    },

    _redrawPins: function () {
        for (const key in this._icons) {
            this._icons[key].icons.forEach((icon) => icon.redraw());
        }
    },

    _pinsHidden: function () {
        return this.options.minZoom !== undefined && this._map.getZoom() < this.options.minZoom;
    },

    _showZoomHint: function () {
        let hidden = this._pinsHidden();
        if (hidden && !this._zoomHintShown && this.options.zoomHint && this._map.addMessage) {
            this._map.addMessage(this.options.zoomHint);
        }
        this._zoomHintShown = hidden;
    },

    // @method setZIndex(zIndex: Number): this
    // Changes the [zIndex](#gridlayer-zindex) of the grid layer.
    setZIndex: function (zIndex) {
        return L.GridLayer.prototype.setZIndex.call(this, zIndex);
    },

    // @method isLoading: Boolean
    // Returns `true` if any tile in the grid layer has not finished loading.
    isLoading: function () {
        return this._loading;
    },

    // @method redraw: this
    // Causes the layer to clear all the tiles and request them again.
    redraw: function () {
        if (this._map) {
            this._removeAllIcons();
            this._update();
        }
        return this;
    },

    getEvents: function () {
        return L.GridLayer.prototype.getEvents.call(this);
    },

    // @section
    // @method getTileSize: Point
    // Normalizes the [tileSize option](#gridlayer-tilesize) into a point. Used by the `createTile()` method.
    getTileSize: function () {
        var s = this.options.nativeTileSize;
        return s instanceof L.Point ? s : new L.Point(s, s);
    },

    _updateZIndex: function () {
        if (this._container && this.options.zIndex !== undefined && this.options.zIndex !== null) {
            this._container.style.zIndex = this.options.zIndex;
        }
    },

    _setAutoZIndex: function (compare) {
        return L.GridLayer.prototype._setAutoZIndex.call(this, compare);
    },

    _pruneIcons: function () {
        if (!this._map) {
            return;
        }

        var key, icons;

        var zoom = this._map.getZoom();
        if (zoom > this.options.maxZoom || zoom < this.options.minZoom) {
            this._removeAllIcons();
            return;
        }

        for (key in this._icons) {
            icons = this._icons[key];
            icons.retain = icons.current;
        }

        for (key in this._icons) {
            let tile = this._icons[key];
            if (tile.current && !tile.active) {
                var coords = tile.coords;
                if (!this._retainParent(coords.x, coords.y, coords.z, coords.z - 5)) {
                    this._retainChildren(coords.x, coords.y, coords.z, coords.z + 2);
                }
            }
        }

        for (key in this._icons) {
            if (!this._icons[key].retain) {
                this._removeIcons(key);
            }
        }
    },

    _removeTilesAtZoom: function (zoom) {
        for (var key in this._icons) {
            if (this._icons[key].coords.z !== zoom) {
                continue;
            }
            this._removeIcons(key);
        }
    },

    _removeAllIcons: function () {
        for (var key in this._icons) {
            this._removeIcons(key);
        }
    },

    _invalidateAll: function () {
        this._removeAllIcons();

        this._tileZoom = undefined;
    },

    _retainParent: function (x, y, z, minZoom) {
        var x2 = Math.floor(x / 2),
            y2 = Math.floor(y / 2),
            z2 = z - 1,
            coords2 = new L.Point(+x2, +y2);
        coords2.z = +z2;

        var key = this._tileCoordsToKey(coords2),
            tile = this._icons[key];

        if (tile && tile.active) {
            tile.retain = true;
            return true;
        } else if (tile && tile.loaded) {
            tile.retain = true;
        }

        if (z2 > minZoom) {
            return this._retainParent(x2, y2, z2, minZoom);
        }

        return false;
    },

    _retainChildren: function (x, y, z, maxZoom) {
        for (var i = 2 * x; i < 2 * x + 2; i++) {
            for (var j = 2 * y; j < 2 * y + 2; j++) {
                var coords = new L.Point(i, j);
                coords.z = z + 1;

                var key = this._tileCoordsToKey(coords),
                    tile = this._icons[key];

                if (tile && tile.active) {
                    tile.retain = true;
                    continue;
                } else if (tile && tile.loaded) {
                    tile.retain = true;
                }

                if (z + 1 < maxZoom) {
                    this._retainChildren(i, j, z + 1, maxZoom);
                }
            }
        }
    },

    _resetView: function (e) {
        return L.GridLayer.prototype._resetView.call(this, e);
    },

    _animateZoom: function (e) {
        return L.GridLayer.prototype._resetView.call(this, e);
    },

    _setView: function (center, zoom, noPrune, noUpdate) {
        var tileZoom = this.options.nativeZoom;

        if ((this.options.maxZoom !== undefined && zoom > this.options.maxZoom) || (this.options.minZoom !== undefined && zoom < this.options.minZoom)) {
            tileZoom = undefined;
        }

        var tileZoomChanged = this.options.updateWhenZooming && tileZoom !== this._tileZoom;
        if (!noUpdate || tileZoomChanged) {
            this._tileZoom = tileZoom;

            if (this._abortLoading) {
                this._abortLoading();
            }

            this._resetGrid();

            if (tileZoom !== undefined) {
                this._update(center);
            }

            if (!noPrune) {
                this._pruneIcons();
            }

            this._noPrune = !!noPrune;
        }
    },
    _onMoveEnd: function () {
        return L.GridLayer.prototype._onMoveEnd.call(this);
    },

    _resetGrid: function () {
        return L.GridLayer.prototype._resetGrid.call(this);
    },

    _pxBoundsToTileRange: function (bounds) {
        var tileSize = this.getTileSize();
        return new L.Bounds(bounds.min.unscaleBy(tileSize).floor(), bounds.max.unscaleBy(tileSize).ceil());
    },

    _getTiledPixelBounds: function (center) {
        return L.GridLayer.prototype._getTiledPixelBounds.call(this, center);
    },

    // Private method to load icons in the grid's active zoom level according to map bounds
    _update: function (center) {
        var map = this._map;
        if (!map) {
            return;
        }
        var zoom = this.options.nativeZoom;

        if (center === undefined) {
            center = map.getCenter();
        }
        if (this._tileZoom === undefined) {
            return;
        } // if out of minzoom/maxzoom

        var pixelBounds = this._getTiledPixelBounds(center),
            tileRange = this._pxBoundsToTileRange(pixelBounds),
            tileCenter = tileRange.getCenter(),
            queue = [],
            margin = this.options.keepBuffer,
            noPruneRange = new L.Bounds(tileRange.getBottomLeft().subtract([margin, -margin]), tileRange.getTopRight().add([margin, -margin]));

        // Sanity check: panic if the tile range contains Infinity somewhere.
        if (!(isFinite(tileRange.min.x) && isFinite(tileRange.min.y) && isFinite(tileRange.max.x) && isFinite(tileRange.max.y))) {
            throw new Error("Attempted to load an infinite number of tiles");
        }

        for (var key in this._icons) {
            var c = this._icons[key].coords;

            if (c.z !== this._tileZoom || !noPruneRange.contains(new L.Point(c.x, c.y))) {
                this._icons[key].current = false;
                this._removeIcons(key);
            }
        }

        // _update just loads more tiles. If the tile zoom level differs too much
        // from the map's, let _setView reset levels and prune old tiles.
        if (Math.abs(zoom - this._tileZoom) > 1) {
            this._setView(center, zoom);
            return;
        }

        // create a queue of coordinates to load icons for
        for (var j = tileRange.min.y; j <= tileRange.max.y; j++) {
            for (var i = tileRange.min.x; i <= tileRange.max.x; i++) {
                var coords = new L.Point(i, j);
                coords.z = this._tileZoom;
                coords.plane = this._map.getPlane();

                if (!this._isValidTile(coords)) {
                    continue;
                }

                var tile = this._icons ? this._icons[this._tileCoordsToKey(coords)] : undefined;
                if (tile) {
                    tile.current = true;
                } else {
                    var dataKey = this._tileCoordsToKey(coords);

                    if (this._icon_data && dataKey in this._icon_data) {
                        queue.push(coords);
                    }
                }
            }
        }

        // Not really necessary for icons
        // sort tile queue to load tiles in order of their distance to center
        // queue.sort((a, b) => a.distanceTo(tileCenter) - b.distanceTo(tileCenter));

        if (queue.length !== 0) {
            // if it's the first batch of tiles to load
            if (!this._loading) {
                this._loading = true;
                // @event loading: Event
                // Fired when the grid layer starts loading tiles.
                this.fire("loading");
            }

            queue.forEach((coord) => this._addIcons(coord));
            this._loading = false;
        }
    },

    _isValidTile: function (coords) {
        return L.GridLayer.prototype._isValidTile.call(this, coords);
    },

    _keyToBounds: function (key) {
        return this._tileCoordsToBounds(this._keyToTileCoords(key));
    },

    _tileCoordsToNwSe: function (coords) {
        return L.GridLayer.prototype._tileCoordsToNwSe.call(this, coords);
    },

    // converts tile coordinates to its geographical bounds
    _tileCoordsToBounds: function (coords) {
        return L.GridLayer.prototype._tileCoordsToBounds.call(this, coords);
    },
    // converts tile coordinates to key for the tile cache
    _tileCoordsToKey: function (coords) {
        try {
            return (this.options.show3d ? 0 : coords.plane) + ":" + coords.x + ":" + coords.y;
        } catch {
            throw new Error("Error parsing " + JSON.stringify(coords));
        }
    },

    // converts tile cache key to coordinates
    _keyToTileCoords: function (key) {
        var k = key.split(":");

        return {
            plane: this.options.show3d ? 0 : +k[0],
            x: +k[1],
            y: +k[2],
        };
    },

    _removeIcons: function (key) {
        var icons = this._icons[key].icons;

        if (!icons) {
            return;
        }

        icons.forEach((item) => this._map.removeLayer(item));

        delete this._icons[key];

        // Fired when a group of icons is removed
        this.fire("iconunload", {
            coords: this._keyToTileCoords(key),
        });
    },

    _getTilePos: function (coords) {
        return L.GridLayer.prototype._getTilePos.call(this, coords);
    },

    createIcon: function (item) {
        let marker;
        if (this.options.canvas) {
            marker = new L.MarkerIcon.CanvasPin([item.y + 0.5, item.x + 0.5], {
                renderer: this._canvas,
                hue: this.options.pinHue,
                plane: this.options.show3d ? item.p ?? item.plane : null,
            });
        } else {
            let { icon, greyscaleIcon } = L.MarkerIcon.createPair(this.options.markerClass);

            marker = L.marker([item.y + 0.5, item.x + 0.5], {
                icon: (item.p ?? item.plane) === this._map.getPlane() ? icon : greyscaleIcon,
            });

            L.MarkerIcon.bindSelection(marker);

            this._map.on("planechange", function (e) {
                marker.setIcon((item.p ?? item.plane) === e.newPlane ? icon : greyscaleIcon);
                if (marker.isPopupOpen()) {
                    let el = marker.getElement();
                    if (el) L.DomUtil.addClass(el, "marker-selected");
                }
            });
        }

        let rawData = {};
        for (const [key, value] of Object.entries(item)) {
            rawData[key] = value;
        }

        let preview = this.options.popupType === "npc" ? L.PopupBuilder.npcPreview(item.id) : null;
        let popup = L.PopupBuilder.createPopup(
            this.options.popupType,
            {
                name: item.name,
                globalX: item.x,
                globalY: item.y,
                plane: item.p ?? item.plane,
                npc: { id: item.id },
                imgContainer: preview?.element,
                rawData: rawData,
            },
            this._map
        );
        marker.bindPopup(popup, {
            autoPan: true,
            autoPanPadding: L.point(40, 40),
        });
        if (preview) marker.on("popupopen", () => preview.load(() => marker.getPopup()?.update()));

        return marker;
    },

    _addIcons: function (coords) {
        //var tilePos = this._getTilePos(coords);
        var key = this._tileCoordsToKey(coords);
        var dataKey = this._tileCoordsToKey(coords);
        var data = this._icon_data[dataKey];
        var icons = [];

        data.forEach((item) => {
            var icon = this.createIcon(item);
            this._map.addLayer(icon);
            icons.push(icon);
        });
        this._icons[key] = {
            icons: icons,
            coords: coords,
            current: true,
        };
    },
});

L.dynamicIcons = function (options) {
    return new L.DynamicIcons(options);
};
});
