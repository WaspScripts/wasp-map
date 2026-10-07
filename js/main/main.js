'use strict';

import "../../js/leaflet.js";
import "../../js/layers.js";
import "../../js/plugins/leaflet.fullscreen.js";
import "../../js/plugins/leaflet.zoom.js";
import "../../js/plugins/leaflet.plane.js";
import "../../js/plugins/leaflet.position.js";
import "../../js/plugins/leaflet.displays.js";
import "../../js/plugins/leaflet.urllayers.js";
import "../../js/plugins/leaflet.objectIcons.js";
import "../../js/plugins/leaflet.rect.js";
import "../../js/plugins/leaflet.clickcopy.js";
import "../../js/plugins/leaflet.cachemap.js";

void function (global) {
    let game_map = global.game_map = L.gameMap('map', {

        maxBounds: [[-1000, -1000], [12800 + 1000, 12800 + 1000]],
        maxBoundsViscosity: 0.5,

        customZoomControl: true,
        planeControl: true,
        messageBox: true,
        plane: 0,
        x: 3200,
        y: 3200,
        minPlane: 0,
        maxPlane: 3,
        minZoom: -4,
        maxZoom: 8,
        doubleClickZoom: false,
        enableUrlLocation: true,
        attributionControl: false
    });

    // The map itself is rendered in the browser from the game cache, fetched from the cache archive.
    let cacheSource = L.cacheMapSource(game_map);
    cacheSource.load().catch(() => {});

    L.PopupBuilder.objectShape = (...args) => cacheSource.requestObjectShape(...args);
    L.PopupBuilder.npcShape = (id) => cacheSource.requestNpcShape(id);

    // `await mapPerf()` in the console prints where tile time goes, `mapPerf.reset()` starts over
    global.mapPerf = () => cacheSource.perf();
    global.mapPerf.reset = () => cacheSource.resetPerf();

    let brand = L.control({ position: 'topleft' });
    brand.onAdd = () => {
        let link = L.DomUtil.create('a', 'leaflet-control-brand');
        link.href = 'https://waspscripts.com';
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = 'WaspScripts';
        link.innerHTML = '<img src="images/waspscripts.svg" alt=""><span>WaspScripts</span>';
        return link;
    };
    brand.addTo(game_map);

    let github = L.control({ position: 'topleft' });
    github.onAdd = () => {
        let link = L.DomUtil.create('a', 'leaflet-control-brand leaflet-control-github');
        link.href = 'https://github.com/WaspScripts/wasp-map';
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = 'GitHub';
        link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg><span>GitHub</span>';
        return link;
    };
    github.addTo(game_map);

    L.control.display.npcs({
        source: cacheSource,
        show3d: true,
    }).addTo(game_map);

    L.control.display.objects({
        source: cacheSource,
        show3d: true,
        displayLayer: L.objects.game
    }).addTo(game_map);

    let rectControl = L.control.display.rect();
    rectControl.addTo(game_map);
    rectControl.map2000.addEventListener("click", () => {
        rectControl.map2000.select();
        navigator.clipboard.writeText(rectControl.map2000.value).then(
            () => game_map.addMessage(`Copied to clipboard: ${rectControl.map2000.value}`),
            () => console.error("Cannot copy text to clipboard")
        );
    });

    let mapLayer = L.gridLayer.cacheMap(cacheSource, {
        layer: L.Control.ViewSelector.urlView(),
        minZoom: -4,
        maxZoom: 8,
    }).addTo(game_map).bringToBack();

    L.control.cacheSelector(cacheSource).addTo(game_map);
    L.control.viewSelector(mapLayer).addTo(game_map);

    L.control.position().addTo(game_map);
    L.control.fullscreen().addTo(game_map);

    let mapContainer = game_map.getContainer();
    let topLeft = game_map._controlCorners.topleft;
    let topRight = game_map._controlCorners.topright;
    let narrowScreen = window.matchMedia('(max-width: 1000px)');
    let phoneScreen = window.matchMedia('(max-width: 480px)');
    let positionWidth = 0;
    let rowWidth = (controls) => {
        let shown = controls.filter((el) => el.offsetWidth > 0);
        return shown.reduce((w, el) => w + el.offsetWidth, 0) + 6 * Math.max(shown.length - 1, 0);
    };
    let fitTopControls = () => {
        let leftControls = [...topLeft.children];
        let leftFirstRow = leftControls.filter((el) => !el.matches('.leaflet-control-cacheselector, .leaflet-control-viewselector'));
        let boxes = [...topRight.querySelectorAll('.leaflet-control-position-box')];
        positionWidth = Math.max(positionWidth, rowWidth(boxes));
        let fullscreen = topRight.querySelector('.leaflet-control-fullscreen');
        let width = mapContainer.clientWidth - 40 - 12;
        let compact = narrowScreen.matches || rowWidth(leftControls) + positionWidth + 6 + fullscreen.offsetWidth > width;
        let stacked = phoneScreen.matches || (compact && rowWidth(leftFirstRow) + positionWidth > width);
        mapContainer.classList.toggle('leaflet-compact-controls', compact);
        mapContainer.classList.toggle('leaflet-stacked-position', stacked);
    };
    let controlsObserver = new ResizeObserver(fitTopControls);
    controlsObserver.observe(mapContainer);
    [...topLeft.children, ...topRight.querySelectorAll('.leaflet-control-position-box, .leaflet-control-fullscreen')]
        .forEach((el) => controlsObserver.observe(el));
    narrowScreen.addEventListener('change', fitTopControls);
    phoneScreen.addEventListener('change', fitTopControls);
    fitTopControls();

    let disclaimer = L.control({ position: 'bottomleft' });
    disclaimer.onAdd = () => {
        let container = L.DomUtil.create('div', 'leaflet-control-credits');
        container.textContent = 'WaspScripts is not affiliated with or endorsed by Jagex. The map is drawn in your browser from the game files that belong to Jagex.';
        L.DomEvent.disableClickPropagation(container);
        return container;
    };
    disclaimer.addTo(game_map);

    let objects = L.objectIcons({
        source: cacheSource,
    });

    let grid = L.grid({
        bounds: [[0, 0], [12800, 6400]],
    });

    let npcs = L.dynamicIcons({
        loadData: () => cacheSource.npcSpawns(),
        minZoom: 1,
        canvas: true,
        pinHue: 120,
        zoomHint: "Zoom in to 50% to see NPCs",
        popupType: "npc",
    });

    L.control.layerToggles([
        {
            name: "objects",
            layer: objects,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1L2 5v8l7 4 7-4V5z"/><path d="M2 5l7 4m0 0l7-4M9 9v8"/></svg>'
        },
        {
            name: "npcs",
            layer: npcs,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="3"/><path d="M3 17c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>'
        },
        {
            name: "grid",
            layer: grid,
            default: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="1" x2="6" y2="17"/><line x1="12" y1="1" x2="12" y2="17"/><line x1="1" y1="6" x2="17" y2="6"/><line x1="1" y1="12" x2="17" y2="12"/></svg>'
        }
    ]).addTo(game_map);

}
(this || window);
