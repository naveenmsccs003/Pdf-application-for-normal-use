(function () {
    'use strict';

    /**
     * PDF rendering layer: file validation, upload, loading with pdf.js and page rendering.
     * Knows nothing about highlights.
     */
    angular.module('pdfViewerApp').factory('pdfService', ['$http', '$q', 'VIEWER_CONFIG',
        function ($http, $q, VIEWER_CONFIG) {
            // Browsers struggle with very large canvases; this matches pdf.js' own default limit.
            var MAX_CANVAS_PIXELS = 16777216;

            var loadingTask = null;
            var pdfDocument = null;
            var renderTask = null;

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

            function close() {
                var task = loadingTask;
                var pendingRender = renderTask;
                cancelRender();
                loadingTask = null;
                pdfDocument = null;
                if (!task) {
                    return;
                }
                // Destroying while a cancelled render is still unwinding throws inside pdf.js,
                // so wait for that render to finish first.
                var destroy = function () { task.destroy(); };
                if (pendingRender) {
                    pendingRender.promise.then(destroy, destroy);
                } else {
                    destroy();
                }
            }

            function getPage(pageNumber) {
                if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) {
                    return $q.reject(new Error('Invalid page'));
                }
                return $q.when(pdfDocument.getPage(pageNumber));
            }

            /** Page size in PDF units (scale 1), taking page rotation into account. */
            function getPageSize(pageNumber) {
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
            }

            /**
             * Renders one page into a new canvas sized for the given scale.
             * Resolves with { canvas, width, height } (CSS pixels), or null if it was superseded
             * by a newer render request.
             */
            function renderPage(pageNumber, scale) {
                cancelRender();

                return getPage(pageNumber).then(function (page) {
                    var viewport = page.getViewport({ scale: scale });

                    // Render sharply on high-DPI screens, but never exceed the canvas pixel limit.
                    var outputScale = Math.min(
                        window.devicePixelRatio || 1,
                        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));

                    var canvas = document.createElement('canvas');
                    canvas.width = Math.floor(viewport.width * outputScale);
                    canvas.height = Math.floor(viewport.height * outputScale);
                    canvas.style.width = Math.floor(viewport.width) + 'px';
                    canvas.style.height = Math.floor(viewport.height) + 'px';

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

            return {
                validateFile: validateFile,
                upload: upload,
                load: load,
                close: close,
                getPageSize: getPageSize,
                renderPage: renderPage
            };
        }]);
})();
