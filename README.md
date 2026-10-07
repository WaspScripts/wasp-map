# WaspScripts Online Map Tool

A game world map tool inspired on [mejrs' map](https://github.com/mejrs/mejrs.github.io) and [rs-map-viewer](https://github.com/dennisdev/rs-map-viewer).

## How the map is drawn

The map only hosts the html, css and javascript code for the website, everything else, the map and collision layers are rendered in the visitor's browser, on demand, straight from the game cache:

## Running locally

While this is a static site, the map has to be served over HTTP, it does not work opened as a file because
the browser will need an origin url to allow the scripts to run.

```text
python3 -m http.server
```

then open http://localhost:8000/.
