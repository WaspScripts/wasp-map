import "../leaflet.js";
import { TileClient } from "../cache/client.js";
import { listCaches, pruneStorage, rememberedCaches } from "../cache/archive.js";
import { record } from "../cache/perf.js";

// Map layers rendered in the browser from a game cache fetched from the cache archive, instead of
// pre-rendered images. Several layers can share one cacheMapSource.

L.CacheMapSource = L.Evented.extend({
    initialize: function (map) {
        this._map = map;
        this._client = null;
        this._errorShown = false;
    },

    // Picks the cache from the url's `cache` parameter if it is one of the offered ones,
    // otherwise the newest.
    load: async function () {
        const remembered = rememberedCaches();
        if (remembered) this._useCaches(remembered);

        let caches;
        try {
            caches = await listCaches();
        } catch (error) {
            if (remembered) return this.caches;
            this._showError(`Could not list game caches: ${error.message}`);
            throw error;
        }
        if (caches.length === 0) {
            if (remembered) return this.caches;
            this._showError("No complete live game caches are available.");
            throw new Error("No caches");
        }

        pruneStorage(caches.map((cache) => cache.id)).catch(() => {});
        this._useCaches(caches);
        return this.caches;
    },

    _useCaches: function (caches) {
        this.caches = caches;
        const wanted = Number(new URL(window.location.href).searchParams.get("cache"));
        this.setCache((caches.find((c) => c.id === wanted) ?? caches[0]).id);
        this.fire("cachelist");
    },

    setCache: function (cacheId) {
        if (this.cacheId === cacheId) return;
        this._client?.terminate();
        this.cacheId = cacheId;
        this._client = new TileClient(cacheId);
        this._client.addEventListener("error", (e) => this._showError(e.message));
        this._client.addEventListener("objectindexing", () => this.fire("objectindexing"));
        this._errorShown = false;

        const url = new URL(window.location.href);
        if (cacheId === this.caches[0].id) {
            url.searchParams.delete("cache");
        } else {
            url.searchParams.set("cache", cacheId);
        }
        history.replaceState(null, "", url.href);

        this.fire("cachechange", { cacheId });
    },

    requestTile: function (layer, plane, z, x, y, onTile, onError) {
        return this._client.requestTile(layer, plane, z, x, y, onTile, onError);
    },

    requestObjects: function (x, y) {
        return this._whenClient().then((client) => client.requestObjects(x, y));
    },

    requestObjectShape: function (id, type, orientation, x, y, plane) {
        return this._whenClient().then((client) => client.requestObjectShape(id, type, orientation, x, y, plane));
    },

    requestNpcShape: function (id) {
        return this._whenClient().then((client) => client.requestNpcShape(id));
    },

    npcNames: function () {
        return this._whenClient().then((client) => client.npcNames());
    },

    npcSpawns: function () {
        return this._whenClient()
            .then((client) => client.npcSpawns())
            .then(npcItems);
    },

    findNpcs: function (names, ids) {
        return this._whenClient()
            .then((client) => client.findNpcs(names, ids))
            .then(npcItems);
    },

    npcHeat: function (npcs, range) {
        const spawns = new Int32Array(npcs.length * 4);
        npcs.forEach((npc, k) => spawns.set([npc.id, npc.p, npc.x, npc.y], k * 4));
        return this._whenClient().then((client) => client.npcHeat(spawns, range));
    },

    findObjects: function (names, ids) {
        return this._whenClient().then((client) => client.findObjects(names, ids));
    },

    objectIds: function (names, ids) {
        return this._whenClient().then((client) => client.objectIds(names, ids));
    },

    objectNames: function () {
        return this._whenClient().then((client) => client.objectNames());
    },

    objectConfig: function (id) {
        return this._whenClient().then((client) => client.objectConfig(id));
    },

    prepareObjectSearch: function () {
        this._whenClient()
            .then((client) => client.objectIndex())
            .catch(() => {});
    },

    _whenClient: function () {
        if (this._client) return Promise.resolve(this._client);
        return new Promise((resolve) => this.once("cachechange", () => resolve(this._client)));
    },

    isPending: function (id) {
        return this._client?.isPending(id) ?? false;
    },

    cancel: function (id) {
        this._client?.cancel(id);
    },

    // Prints where tile time goes, as a table; see perf.js.
    perf: async function () {
        if (!this._client) return;
        console.table(await this._client.perf());
    },

    resetPerf: function () {
        this._client?.resetPerf();
    },

    _showError: function (message) {
        if (this._errorShown) return;
        this._errorShown = true;
        if (this._map.addMessage) {
            this._map.addMessage(`Map rendering failed: ${message}`);
        }
        console.error(message);
    },
});

function npcItems({ spawns, info }) {
    const items = [];
    for (let k = 0; k < spawns.length; k += 4) {
        const id = spawns[k];
        const { name, ...rest } = info[id];
        items.push({ name, id, p: spawns[k + 1], x: spawns[k + 2], y: spawns[k + 3], ...rest });
    }
    return items;
}

L.cacheMapSource = function (map) {
    return new L.CacheMapSource(map);
};

L.GridLayer.CacheMap = L.GridLayer.extend({
    options: {
        layer: "map",
        maxNativeZoom: 2,
        className: "leaflet-cachemap-layer",
    },

    initialize: function (source, options) {
        this._source = source;
        L.setOptions(this, options);
    },

    onAdd: function (map) {
        this._source.on("cachechange", this.redraw, this);
        this.on("tileunload", this._onTileUnload, this);
        L.DomUtil.addClass(map.getContainer(), this._viewClass());
        return L.GridLayer.prototype.onAdd.call(this, map);
    },

    onRemove: function (map) {
        this._source.off("cachechange", this.redraw, this);
        this.off("tileunload", this._onTileUnload, this);
        L.DomUtil.removeClass(map.getContainer(), this._viewClass());
        return L.GridLayer.prototype.onRemove.call(this, map);
    },

    createTile: function (coords, done) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        tile.setAttribute("role", "presentation");

        // until a cache is picked; picking one redraws the layer
        if (!this._source.cacheId) {
            done(null, tile);
            return tile;
        }

        const requested = performance.now();
        const { layer } = this.options;
        const context = tile.getContext("bitmaprenderer");
        let loaded = false;

        const finish = (error) => {
            if (loaded) return;
            loaded = true;
            done(error, tile);
        };

        tile._cacheMapRequest = this._source.requestTile(
            layer,
            this._map.getPlane(),
            coords.z,
            coords.x,
            coords.y,
            (bitmap, final) => {
                if (bitmap) {
                    if (tile._cacheMapUnloaded) {
                        bitmap.close();
                        return;
                    }
                    context.transferFromImageBitmap(bitmap);
                    // from Leaflet asking for the tile to it being shown, as the viewer waits for it
                    const now = performance.now();
                    if (!loaded) record(`screen: first shown ${layer} z=${coords.z}`, now - requested);
                    if (final) record(`screen: finished ${layer} z=${coords.z}`, now - requested);
                }
                finish(null);
            },
            (error) => finish(error)
        );
        tile._cacheMapRelease = () => {
            tile._cacheMapUnloaded = true;
            try {
                context.transferFromImageBitmap(null);
            } catch {}
        };

        return tile;
    },

    setLayer: function (layer) {
        if (this.options.layer === layer) return this;
        const container = this._map?.getContainer();
        if (container) L.DomUtil.removeClass(container, this._viewClass());
        this.options.layer = layer;
        if (container) L.DomUtil.addClass(container, this._viewClass());
        return this.redraw();
    },

    _viewClass: function () {
        return `leaflet-view-${this.options.layer}`;
    },

    _onTileUnload: function (e) {
        const id = e.tile._cacheMapRequest;
        if (id && this._source.isPending(id)) {
            this._source.cancel(id);
        }
        e.tile._cacheMapRelease?.();
    },
});

L.gridLayer.cacheMap = function (source, options) {
    return new L.GridLayer.CacheMap(source, options);
};

// Lets the viewer pick between the caches the source offers.
L.Control.CacheSelector = L.Control.extend({
    options: {
        position: "topleft",
    },

    initialize: function (source, options) {
        this._source = source;
        L.setOptions(this, options);
    },

    onAdd: function () {
        const container = L.DomUtil.create("div", "leaflet-control-mapselector leaflet-control-cacheselector");
        L.DomEvent.disableClickPropagation(container);

        const label = L.DomUtil.create("label", "", container);
        label.textContent = "Cache ";
        this._select = L.DomUtil.create("select", "", label);
        this._select.disabled = true;
        this._select.add(new Option("loading...", ""));

        L.DomEvent.on(this._select, "change", () => this._source.setCache(Number(this._select.value)));
        this._source.on("cachechange cachelist", this._update, this);
        this._update();
        return container;
    },

    onRemove: function () {
        this._source.off("cachechange cachelist", this._update, this);
    },

    _update: function () {
        if (!this._source.caches) return;
        this._select.replaceChildren(
            ...this._source.caches.map((cache) => {
                const date = cache.timestamp.split("T")[0];
                return new Option(`Build ${cache.build} (${date})`, cache.id, false, cache.id === this._source.cacheId);
            })
        );
        this._select.disabled = false;
    },
});

L.control.cacheSelector = function (source, options) {
    return new L.Control.CacheSelector(source, options);
};

L.Control.ViewSelector = L.Control.extend({
    options: {
        position: "topleft",
        views: {
            map: "Map",
            collision: "Collision",
            height: "Height",
        },
    },

    initialize: function (layer, options) {
        this._layer = layer;
        L.setOptions(this, options);
    },

    onAdd: function () {
        const container = L.DomUtil.create("div", "leaflet-control-mapselector leaflet-control-viewselector");
        L.DomEvent.disableClickPropagation(container);

        const label = L.DomUtil.create("label", "", container);
        label.textContent = "View ";
        const select = L.DomUtil.create("select", "", label);
        for (const [view, name] of Object.entries(this.options.views)) {
            select.add(new Option(name, view, false, view === this._layer.options.layer));
        }

        L.DomEvent.on(select, "change", () => this._setView(select.value));
        return container;
    },

    _setView: function (view) {
        this._layer.setLayer(view);

        const url = new URL(window.location.href);
        if (view === "map") {
            url.searchParams.delete("view");
        } else {
            url.searchParams.set("view", view);
        }
        history.replaceState(null, "", url.href);
    },
});

L.Control.ViewSelector.urlView = function (views = L.Control.ViewSelector.prototype.options.views) {
    const wanted = new URL(window.location.href).searchParams.get("view");
    return Object.hasOwn(views, wanted) ? wanted : "map";
};

L.control.viewSelector = function (layer, options) {
    return new L.Control.ViewSelector(layer, options);
};
