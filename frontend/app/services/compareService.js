(function () {
    'use strict';

    /**
     * Compares the open document with another revision of it, page by page (page N with page N).
     * Both pages are rendered at the same size and their dark ("inked") pixels compared, with a
     * one-pixel tolerance so anti-aliasing does not count as a change:
     *   - differences: what only the other revision has (removed, red) and what only this one has (added, green)
     *   - overlay:     this revision in blue, the other in red, what both have in dark grey
     *   - other page:  the other revision's page as drawn, for side by side (otherUrl)
     *   - regions:     boxes around groups of changes, in PDF units (for clouds and "next change"), each with its
     *                  kind: 'added' (only new ink), 'removed' (only ink the other revision had) or 'changed' (both:
     *                  an element moved, resized or rewritten)
     * The other revision is read in the browser (web, pdf.js) or opened by the desktop host (PDFium).
     */
    angular.module('pdfViewerApp').factory('compareService', ['$http', '$q', 'pdfService', 'desktopService',
        function ($http, $q, pdfService, desktopService) {
            var MAX_SIDE_PX = 1800;     // comparison resolution: the longer page side
            var MAX_SCALE = 3;
            var INK = 200;              // luminance below this is ink
            var CELL_PX = 12;           // changes are grouped in cells this size
            var MIN_CELL_CHANGES = 3;   // fewer changed pixels in a cell is noise
            var MAX_REGIONS = 200;
            var CACHE_PAGES = 6;
            var KIND_SHARE = 0.12;      // a region is changed when both added and removed ink are at least this share

            var other = null;           // { fileName, pageCount, doc (web) | token (desktop), task }
            var cache = [];             // [{ key, result }], newest last
            var pendingOpen = null;     // desktop: deferred waiting for the host

            if (desktopService.isDesktop) {
                desktopService.on('compare-opened', function (m) {
                    settleOpen(function (d) {
                        setOther({ fileName: m.fileName, pageCount: m.pageCount, token: m.token });
                        d.resolve(other);
                    });
                });
                desktopService.on('compare-error', function (m) { settleOpen(function (d) { d.reject(m.message); }); });
                desktopService.on('compare-cancelled', function () { settleOpen(function (d) { d.resolve(null); }); });
            }

            function settleOpen(action) {
                var d = pendingOpen;
                pendingOpen = null;
                if (d) { action(d); }
            }

            function setOther(next) {
                closeOther();
                other = next;
            }

            /** Web: reads the chosen file; resolves with the revision info. Rejects with a message. */
            function openFile(file) {
                var problem = pdfService.validateFile(file);
                if (problem) { return $q.reject(problem); }
                return $q.when(file.arrayBuffer()).then(function (data) {
                    var task = pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
                    return $q.when(task.promise).then(function (doc) {
                        setOther({ fileName: file.name, pageCount: doc.numPages, doc: doc, task: task });
                        return other;
                    }, function (error) {
                        task.destroy();
                        return $q.reject(error && error.name === 'PasswordException'
                            ? 'That PDF is password-protected.' : 'That file is not a PDF that can be compared.');
                    });
                }, function () { return $q.reject('Unable to read that file.'); });
            }

            /** Desktop: the host shows the open dialog; resolves with the revision info, or null if cancelled. */
            function openDesktop() {
                if (pendingOpen) { pendingOpen.resolve(null); }
                pendingOpen = $q.defer();
                desktopService.send('open-compare');
                return pendingOpen.promise;
            }

            function closeOther() {
                cache = [];
                if (!other) { return; }
                if (other.task) { other.task.destroy(); }
                if (other.token) { desktopService.send('close-compare'); }
                other = null;
            }

            // ----- Rendering into a canvas of a given pixel size -----
            function blankCanvas(width, height) {
                var canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                var ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                return canvas;
            }

            function loadImage(url) {
                var d = $q.defer();
                var image = new Image();
                image.onload = function () { d.resolve(image); };
                image.onerror = function () { d.reject(new Error('Page image failed to load')); };
                image.src = url;
                return d.promise;
            }

            function otherPageSize(pageNumber) {
                if (other.token) {
                    return $http.get('api/local/' + other.token + '/pages/' + pageNumber + '/size').then(function (r) { return r.data; });
                }
                return $q.when(other.doc.getPage(pageNumber)).then(function (page) {
                    var v = page.getViewport({ scale: 1 });
                    return { width: v.width, height: v.height };
                });
            }

            /** Draws the other revision's page into `canvas`, scaled to the canvas width (top-left aligned). */
            function drawOtherPage(pageNumber, canvas) {
                return otherPageSize(pageNumber).then(function (size) {
                    var scale = canvas.width / size.width;
                    var ctx = canvas.getContext('2d');
                    if (other.token) {
                        return loadImage('api/local/' + other.token + '/pages/' + pageNumber + '?scale=' + scale.toFixed(4)).then(function (image) {
                            ctx.drawImage(image, 0, 0);
                        });
                    }
                    return $q.when(other.doc.getPage(pageNumber)).then(function (page) {
                        var tmp = blankCanvas(Math.ceil(size.width * scale), Math.ceil(size.height * scale));
                        return $q.when(page.render({ canvasContext: tmp.getContext('2d'), viewport: page.getViewport({ scale: scale }) }).promise)
                            .then(function () { ctx.drawImage(tmp, 0, 0); });
                    });
                });
            }

            function drawThisPage(pageNumber, canvas) {
                return pdfService.renderThumbnail(pageNumber, canvas.width, canvas.height).then(function (rendered) {
                    if (!rendered) { return $q.reject(new Error('Document changed')); }
                    canvas.getContext('2d').drawImage(rendered, 0, 0, canvas.width, canvas.height);
                });
            }

            // ----- Comparing -----
            function inkMask(canvas) {
                var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
                var mask = new Uint8Array(canvas.width * canvas.height);
                for (var i = 0, p = 0; p < mask.length; i += 4, p++) {
                    // Luminance, with transparent pixels as white.
                    var a = data[i + 3] / 255;
                    var lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a);
                    mask[p] = lum < INK ? 1 : 0;
                }
                return mask;
            }

            // Grows the ink by one pixel in every direction (the anti-aliasing tolerance).
            function dilate(mask, w, h) {
                var out = new Uint8Array(mask.length);
                for (var y = 0; y < h; y++) {
                    for (var x = 0; x < w; x++) {
                        if (!mask[y * w + x]) { continue; }
                        for (var dy = -1; dy <= 1; dy++) {
                            var yy = y + dy;
                            if (yy < 0 || yy >= h) { continue; }
                            for (var dx = -1; dx <= 1; dx++) {
                                var xx = x + dx;
                                if (xx >= 0 && xx < w) { out[yy * w + xx] = 1; }
                            }
                        }
                    }
                }
                return out;
            }

            function compareMasks(thisInk, otherInk, w, h) {
                var thisNear = dilate(thisInk, w, h), otherNear = dilate(otherInk, w, h);
                var diff = new ImageData(w, h), overlay = new ImageData(w, h);
                var cols = Math.ceil(w / CELL_PX), rows = Math.ceil(h / CELL_PX);
                var addedCells = new Uint32Array(cols * rows), removedCells = new Uint32Array(cols * rows);
                var added = 0, removed = 0;
                for (var p = 0, i = 0; p < thisInk.length; p++, i += 4) {
                    var isAdded = thisInk[p] && !otherNear[p];
                    var isRemoved = otherInk[p] && !thisNear[p];
                    var o = overlay.data;
                    if (isAdded) {
                        diff.data[i] = 0; diff.data[i + 1] = 170; diff.data[i + 2] = 60; diff.data[i + 3] = 255;
                        o[i] = 20; o[i + 1] = 90; o[i + 2] = 230;
                        added++;
                    } else if (isRemoved) {
                        diff.data[i] = 230; diff.data[i + 1] = 30; diff.data[i + 2] = 30; diff.data[i + 3] = 255;
                        o[i] = 225; o[i + 1] = 35; o[i + 2] = 35;
                        removed++;
                    } else if (thisInk[p] || otherInk[p]) {
                        o[i] = 70; o[i + 1] = 70; o[i + 2] = 70;
                    } else {
                        o[i] = 255; o[i + 1] = 255; o[i + 2] = 255;
                    }
                    o[i + 3] = 255;
                    if (isAdded || isRemoved) {
                        var x = p % w, y = (p - x) / w;
                        (isAdded ? addedCells : removedCells)[Math.floor(y / CELL_PX) * cols + Math.floor(x / CELL_PX)]++;
                    }
                }
                return { diff: diff, overlay: overlay, addedCells: addedCells, removedCells: removedCells, cols: cols, rows: rows,
                         added: added, removed: removed };
            }

            /** What a group of changes is, from its added and removed pixel counts. */
            function kindOf(added, removed) {
                var total = added + removed;
                if (removed < total * KIND_SHARE) { return 'added'; }
                if (added < total * KIND_SHARE) { return 'removed'; }
                return 'changed';
            }

            // Groups changed cells (touching or one cell apart) into boxes, in pixels, with their kind.
            function regionsOf(addedCells, removedCells, cols, rows) {
                var marked = new Uint8Array(addedCells.length);
                for (var c = 0; c < marked.length; c++) { marked[c] = addedCells[c] + removedCells[c] >= MIN_CELL_CHANGES ? 1 : 0; }
                var seen = new Uint8Array(marked.length), regions = [];
                for (var start = 0; start < marked.length && regions.length < MAX_REGIONS; start++) {
                    if (!marked[start] || seen[start]) { continue; }
                    var stack = [start], box = { x0: cols, y0: rows, x1: 0, y1: 0, added: 0, removed: 0 };
                    seen[start] = 1;
                    while (stack.length) {
                        var cell = stack.pop(), cx = cell % cols, cy = (cell - cx) / cols;
                        box.added += addedCells[cell];
                        box.removed += removedCells[cell];
                        box.x0 = Math.min(box.x0, cx); box.y0 = Math.min(box.y0, cy);
                        box.x1 = Math.max(box.x1, cx); box.y1 = Math.max(box.y1, cy);
                        for (var dy = -2; dy <= 2; dy++) {
                            for (var dx = -2; dx <= 2; dx++) {
                                var nx = cx + dx, ny = cy + dy;
                                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) { continue; }
                                var n = ny * cols + nx;
                                if (marked[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
                            }
                        }
                    }
                    regions.push(box);
                }
                return regions.map(function (b) {
                    return { x: b.x0 * CELL_PX, y: b.y0 * CELL_PX, width: (b.x1 - b.x0 + 1) * CELL_PX, height: (b.y1 - b.y0 + 1) * CELL_PX,
                             kind: kindOf(b.added, b.removed) };
                });
            }

            function toUrl(imageData) {
                var canvas = document.createElement('canvas');
                canvas.width = imageData.width;
                canvas.height = imageData.height;
                canvas.getContext('2d').putImageData(imageData, 0, 0);
                return canvas.toDataURL('image/png');
            }

            /**
             * Compares page N of both revisions. Resolves with { pageNumber, diffUrl, overlay, regions, added, removed,
             * missing } (regions in PDF units with their kind, top to bottom); `missing` if the other revision has no page N.
             */
            function comparePage(pageNumber) {
                if (!other) { return $q.reject('Open a revision to compare with first.'); }
                var key = other.fileName + '|' + (other.token || other.pageCount) + '|' + pageNumber;
                var hit = cache.filter(function (c) { return c.key === key; })[0];
                if (hit) { return hit.promise; }
                var compared = other;
                var promise = pdfService.getPageSize(pageNumber).then(function (size) {
                    var scale = Math.min(MAX_SCALE, MAX_SIDE_PX / Math.max(size.width, size.height));
                    var w = Math.round(size.width * scale), h = Math.round(size.height * scale);
                    var thisCanvas = blankCanvas(w, h), otherCanvas = blankCanvas(w, h);
                    var missing = pageNumber > compared.pageCount;
                    return $q.all([drawThisPage(pageNumber, thisCanvas), missing ? null : drawOtherPage(pageNumber, otherCanvas)]).then(function () {
                        if (other !== compared) { return $q.reject('The comparison was closed.'); }
                        var result = compareMasks(inkMask(thisCanvas), inkMask(otherCanvas), w, h);
                        var regions = regionsOf(result.addedCells, result.removedCells, result.cols, result.rows).map(function (r) {
                            var pad = 2;
                            return { x: Math.max(0, r.x / scale - pad), y: Math.max(0, r.y / scale - pad),
                                     width: r.width / scale + 2 * pad, height: r.height / scale + 2 * pad, kind: r.kind };
                        }).sort(function (a, b) { return a.y - b.y || a.x - b.x; });
                        return {
                            pageNumber: pageNumber,
                            diffUrl: toUrl(result.diff),
                            overlay: result.overlay,    // encoded on first use (overlayUrl)
                            other: missing ? null : otherCanvas,    // encoded on first use (otherUrl)
                            regions: regions,
                            added: result.added,
                            removed: result.removed,
                            missing: missing
                        };
                    });
                });
                cache.push({ key: key, promise: promise });
                if (cache.length > CACHE_PAGES) { cache.shift(); }
                promise.catch(function () { cache = cache.filter(function (c) { return c.promise !== promise; }); });
                return promise;
            }

            /** The overlay image of a comparison result (encoded once, when first shown). */
            function overlayUrl(result) {
                if (!result.overlayUrl) {
                    result.overlayUrl = toUrl(result.overlay);
                    result.overlay = null;
                }
                return result.overlayUrl;
            }

            /** The other revision's page image of a comparison result (null if it has no such page). */
            function otherUrl(result) {
                if (result.otherUrl === undefined) {
                    result.otherUrl = result.other ? result.other.toDataURL('image/png') : null;
                    result.other = null;
                }
                return result.otherUrl;
            }

            return {
                isOpen: function () { return !!other; },
                overlayUrl: overlayUrl,
                otherUrl: otherUrl,
                info: function () { return other; },
                openFile: openFile,
                openDesktop: openDesktop,
                close: closeOther,
                comparePage: comparePage
            };
        }]);
})();
