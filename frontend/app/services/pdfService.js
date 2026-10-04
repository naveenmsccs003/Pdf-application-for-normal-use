(function () {
    'use strict';

    /**
     * PDF rendering layer: file validation, upload, loading and page rendering.
     * Knows nothing about highlights. Also gives access to page text for searching (searchService).
     *
     * Two sources:
     *   - web:     the PDF is uploaded and rendered in the browser with pdf.js
     *   - desktop: the PDF is opened from disk by the desktop host and pages arrive as images
     *              rendered by PDFium (works for files far larger than a browser can hold)
     */
    angular.module('pdfViewerApp').factory('pdfService', ['$http', '$q', 'VIEWER_CONFIG',
        function ($http, $q, VIEWER_CONFIG) {
            // Browsers struggle with very large canvases; this matches pdf.js' own default limit.
            var MAX_CANVAS_PIXELS = 16777216;

            var loadingTask = null;
            var pdfDocument = null;
            var renderTask = null;

            var localDocument = null;   // desktop: { token, pageCount, sizes }
            var pendingImage = null;    // desktop: page image being loaded
            var thumbnailTasks = [];    // pdf.js thumbnail renders in progress

            /** Returns a user-friendly error message, or null when the file looks fine. */
            function validateFile(file) {
                if (!file) {
                    return 'Please select a PDF file.';
                }
                var isPdfName = /\.pdf$/i.test(file.name || '');
                var isPdfType = !file.type || file.type === 'application/pdf';
                if (!isPdfName || !isPdfType) {
                    return 'Please select a PDF file.';
                }
                if (file.size === 0) {
                    return 'The selected file is empty.';
                }
                if (file.size > VIEWER_CONFIG.maxFileSizeMB * 1024 * 1024) {
                    return 'The selected file is too large. Maximum size is ' + VIEWER_CONFIG.maxFileSizeMB + ' MB.';
                }
                return null;
            }

            /** Uploads the file; resolves with { id, fileName, size }. Rejects with a message. */
            function upload(file) {
                var form = new FormData();
                form.append('file', file);

                return $http.post(VIEWER_CONFIG.apiBase + '/upload', form, {
                    transformRequest: angular.identity,
                    headers: { 'Content-Type': undefined }
                }).then(function (response) {
                    return response.data;
                }, function (response) {
                    if (response.status <= 0) {
                        return $q.reject('Unable to reach the server. Please check that the application is running.');
                    }
                    return $q.reject((response.data && response.data.error) || 'Unable to upload this PDF.');
                });
            }

            /**
             * Loads a PDF from a URL; resolves with the page count. Rejects with a message.
             * The current document stays open until the new one has loaded, so a failed
             * open leaves the viewer as it was.
             */
            function load(url) {
                var task = pdfjsLib.getDocument({ url: url, isEvalSupported: false });

                return $q.when(task.promise).then(function (doc) {
                    close();
                    loadingTask = task;
                    pdfDocument = doc;
                    return doc.numPages;
                }, function (error) {
                    task.destroy();
                    var name = error && error.name;
                    if (name === 'PasswordException') {
                        return $q.reject('This PDF is password-protected and cannot be opened.');
                    }
                    if (name === 'InvalidPDFException') {
                        return $q.reject('The selected file is not a valid PDF.');
                    }
                    if (name === 'MissingPDFException') {
                        return $q.reject('The PDF could not be found. Please open it again.');
                    }
                    return $q.reject('Unable to open this PDF.');
                });
            }

            /** Desktop: switches to a PDF the host opened from disk; resolves with the page count. */
            function loadLocal(info) {
                close();
                localDocument = { token: info.token, pageCount: info.pageCount, sizes: {} };
                return $q.when(info.pageCount);
            }

            function close() {
                localDocument = null;
                var task = loadingTask;
                var pendingRender = renderTask;
                cancelRender();
                loadingTask = null;
                pdfDocument = null;
                if (!task) {
                    return;
                }
                // Destroying while a cancelled render is still unwinding throws inside pdf.js,
                // so wait for those renders to finish first.
                var unwinding = thumbnailTasks.map(function (t) { t.cancel(); return t.promise; });
                thumbnailTasks = [];
                if (pendingRender) {
                    unwinding.push(pendingRender.promise);
                }
                var settled = unwinding.map(function (p) { return p.then(angular.noop, angular.noop); });
                Promise.all(settled).then(function () { task.destroy(); });
            }

            function getPage(pageNumber) {
                if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) {
                    return $q.reject(new Error('Invalid page'));
                }
                return $q.when(pdfDocument.getPage(pageNumber));
            }

            function localPageUrl(pageNumber) {
                return 'api/local/' + localDocument.token + '/pages/' + pageNumber;
            }

            /** Page size in PDF units (scale 1), taking page rotation into account. */
            function getPageSize(pageNumber) {
                if (localDocument) {
                    if (pageNumber < 1 || pageNumber > localDocument.pageCount) {
                        return $q.reject(new Error('Invalid page'));
                    }
                    var sizes = localDocument.sizes;
                    if (sizes[pageNumber]) {
                        return $q.when(sizes[pageNumber]);
                    }
                    return $http.get(localPageUrl(pageNumber) + '/size').then(function (response) {
                        sizes[pageNumber] = { width: response.data.width, height: response.data.height };
                        return sizes[pageNumber];
                    });
                }
                return getPage(pageNumber).then(function (page) {
                    var viewport = page.getViewport({ scale: 1 });
                    return { width: viewport.width, height: viewport.height };
                });
            }

            function cancelRender() {
                if (renderTask) {
                    renderTask.cancel();
                    renderTask = null;
                }
                if (pendingImage) {
                    pendingImage.image.onload = pendingImage.image.onerror = null;
                    pendingImage.image.src = '';   // aborts the request
                    pendingImage.deferred.resolve(null);
                    pendingImage = null;
                }
            }

            // Render sharply on high-DPI screens, but never exceed the canvas pixel limit.
            function outputScaleFor(width, height) {
                return Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
            }

            function createCanvas(pixelWidth, pixelHeight, cssWidth, cssHeight) {
                var canvas = document.createElement('canvas');
                canvas.width = pixelWidth;
                canvas.height = pixelHeight;
                canvas.style.width = cssWidth + 'px';
                canvas.style.height = cssHeight + 'px';
                return canvas;
            }

            /** Desktop: fetches the page rendered by PDFium and draws it into a canvas. */
            function renderLocalPage(pageNumber, scale) {
                return getPageSize(pageNumber).then(function (size) {
                    var cssWidth = Math.floor(size.width * scale);
                    var cssHeight = Math.floor(size.height * scale);
                    var outputScale = outputScaleFor(size.width * scale, size.height * scale);

                    var deferred = $q.defer();
                    var image = new Image();
                    var request = { image: image, deferred: deferred };
                    pendingImage = request;

                    image.onload = function () {
                        if (pendingImage === request) {
                            pendingImage = null;
                        }
                        var canvas = createCanvas(image.naturalWidth, image.naturalHeight, cssWidth, cssHeight);
                        canvas.getContext('2d').drawImage(image, 0, 0);
                        deferred.resolve({ canvas: canvas, width: cssWidth, height: cssHeight });
                    };
                    image.onerror = function () {
                        if (pendingImage === request) {
                            pendingImage = null;
                        }
                        deferred.reject(new Error('Page image failed to load'));
                    };
                    image.src = localPageUrl(pageNumber) + '?scale=' + (scale * outputScale).toFixed(4);
                    return deferred.promise;
                });
            }

            /**
             * Renders one page into a new canvas sized for the given scale.
             * Resolves with { canvas, width, height } (CSS pixels), or null if it was superseded
             * by a newer render request.
             */
            function renderPage(pageNumber, scale) {
                cancelRender();
                if (localDocument) {
                    return renderLocalPage(pageNumber, scale);
                }

                return getPage(pageNumber).then(function (page) {
                    var viewport = page.getViewport({ scale: scale });
                    var outputScale = outputScaleFor(viewport.width, viewport.height);
                    var canvas = createCanvas(
                        Math.floor(viewport.width * outputScale), Math.floor(viewport.height * outputScale),
                        Math.floor(viewport.width), Math.floor(viewport.height));

                    var task = page.render({
                        canvasContext: canvas.getContext('2d'),
                        viewport: viewport,
                        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
                    });
                    renderTask = task;

                    return $q.when(task.promise).then(function () {
                        if (renderTask === task) {
                            renderTask = null;
                        }
                        return { canvas: canvas, width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
                    }, function (error) {
                        if (error && error.name === 'RenderingCancelledException') {
                            return null;
                        }
                        return $q.reject(error);
                    });
                });
            }

            /**
             * Renders a small preview of a page that fits in maxWidth x maxHeight (CSS pixels).
             * Independent of the main page render, so it never cancels it.
             * Resolves with a canvas, or null if the document changed meanwhile.
             */
            function renderThumbnail(pageNumber, maxWidth, maxHeight) {
                var docAtStart = localDocument || pdfDocument;

                return getPageSize(pageNumber).then(function (size) {
                    var scale = Math.min(maxWidth / size.width, maxHeight / size.height);
                    var cssWidth = Math.max(1, Math.floor(size.width * scale));
                    var cssHeight = Math.max(1, Math.floor(size.height * scale));
                    var dpr = window.devicePixelRatio || 1;

                    if (localDocument) {
                        var deferred = $q.defer();
                        var image = new Image();
                        image.onload = function () {
                            var canvas = createCanvas(image.naturalWidth, image.naturalHeight, cssWidth, cssHeight);
                            canvas.getContext('2d').drawImage(image, 0, 0);
                            deferred.resolve(canvas);
                        };
                        image.onerror = function () { deferred.reject(new Error('Thumbnail failed to load')); };
                        image.src = localPageUrl(pageNumber) + '?scale=' + (scale * dpr).toFixed(4);
                        return deferred.promise;
                    }

                    return getPage(pageNumber).then(function (page) {
                        if (pdfDocument !== docAtStart) {
                            return null;
                        }
                        var viewport = page.getViewport({ scale: scale * dpr });
                        var canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height), cssWidth, cssHeight);
                        var task = page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport });
                        thumbnailTasks.push(task);
                        var done = function () { thumbnailTasks = thumbnailTasks.filter(function (t) { return t !== task; }); };
                        return $q.when(task.promise).then(function () {
                            done();
                            return canvas;
                        }, function (error) {
                            done();
                            return error && error.name === 'RenderingCancelledException' ? null : $q.reject(error);
                        });
                    });
                });
            }

            /** The open document (either kind), so callers can tell whether it changed meanwhile. */
            function currentDocument() {
                return localDocument || pdfDocument;
            }

            /**
             * Web: the page's text runs from pdf.js and a function that maps a point in PDF user space to
             * the displayed page at scale 1 (top-left origin, after /Rotate), the units highlights use.
             */
            function getPageText(pageNumber) {
                return getPage(pageNumber).then(function (page) {
                    var viewport = page.getViewport({ scale: 1 });
                    return $q.when(page.getTextContent()).then(function (content) {
                        return {
                            items: content.items.filter(function (item) { return typeof item.str === 'string'; }),
                            toView: function (x, y) { return viewport.convertToViewportPoint(x, y); }
                        };
                    });
                });
            }

            /**
             * Desktop: finds text with PDFium on pages `from` to `to`; the host searches for a short time.
             * Resolves with { matches: [{ page, rects: [{ x, y, width, height }] }], next } (next: null at the end).
             */
            function searchLocal(query, options, from, to) {
                return $http.get('api/local/' + localDocument.token + '/search', {
                    params: { q: query, from: from, to: to, matchCase: !!options.matchCase, wholeWord: !!options.wholeWord,
                              pattern: options.pattern || undefined }
                }).then(function (response) { return response.data; });
            }

            /**
             * Document properties from the host (PDFium): { version, pageCount, metadata, encrypted, restrictions,
             * tagged, hasBookmarks, pageSizes: [{ width, height, count, pages }] }. `source` is the viewer's
             * { kind: 'web', id } on the web.
             */
            function getInfo(source) {
                var url = localDocument ? 'api/local/' + localDocument.token + '/info' : VIEWER_CONFIG.apiBase + '/' + source.id + '/info';
                return $http.get(url).then(function (response) { return response.data; }, function (response) {
                    return $q.reject((response.data && response.data.error) || 'Unable to read the document properties.');
                });
            }

            return {
                getInfo: getInfo,
                validateFile: validateFile,
                upload: upload,
                load: load,
                loadLocal: loadLocal,
                close: close,
                getPageSize: getPageSize,
                renderPage: renderPage,
                renderThumbnail: renderThumbnail,
                currentDocument: currentDocument,
                isLocal: function () { return !!localDocument; },
                getPageText: getPageText,
                searchLocal: searchLocal
            };
        }]);
})();
