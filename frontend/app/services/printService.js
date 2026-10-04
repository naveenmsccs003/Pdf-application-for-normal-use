(function () {
    'use strict';

    /**
     * Print: the PDF to print (the annotated, flattened copy from the host) is drawn page by page with pdf.js into
     * images that only the printout shows, then the browser's (or the desktop app's) print dialog opens.
     * Works the same on the web and in the desktop app, whatever the browser's own PDF support.
     */
    angular.module('pdfViewerApp').factory('printService', ['$q', '$window', function ($q, $window) {
        var MAX_PAGES = 300;
        var DPI = 150;
        var MAX_PIXELS = 8000000;   // per page; larger sheets (A0 at 150 dpi) are drawn a little coarser

        /**
         * Draws `blob` (a PDF) and prints it. onProgress(done, total) while drawing. Resolves with the number of
         * pages once the print dialog has been opened (and closed, where the browser waits); rejects with a message.
         */
        function print(blob, onProgress) {
            var task = null, container = null, urls = [];

            function cleanup() {
                if (container) { container.remove(); container = null; }
                $window.document.body.classList.remove('is-printing');
                urls.forEach(function (u) { URL.revokeObjectURL(u); });
                urls = [];
                if (task) { task.destroy(); task = null; }
            }

            return $q.when(blob.arrayBuffer()).then(function (data) {
                task = pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
                return $q.when(task.promise);
            }).then(function (doc) {
                if (doc.numPages > MAX_PAGES) {
                    return $q.reject('Print up to ' + MAX_PAGES + ' pages at a time (choose a page range).');
                }
                container = $window.document.createElement('div');
                container.className = 'print-sheets';
                container.setAttribute('aria-hidden', 'true');
                var chain = $q.when();
                for (var n = 1; n <= doc.numPages; n++) {
                    chain = chain.then(drawPage.bind(null, doc, n));
                }
                return chain.then(function () { return doc.numPages; });

                function drawPage(document, number) {
                    return $q.when(document.getPage(number)).then(function (page) {
                        var base = page.getViewport({ scale: 1 });
                        var scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
                        var viewport = page.getViewport({ scale: scale });
                        var canvas = $window.document.createElement('canvas');
                        canvas.width = Math.floor(viewport.width);
                        canvas.height = Math.floor(viewport.height);
                        var context = canvas.getContext('2d');
                        context.fillStyle = '#ffffff';
                        context.fillRect(0, 0, canvas.width, canvas.height);
                        return $q.when(page.render({ canvasContext: context, viewport: viewport }).promise).then(function () {
                            return $q(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
                        }).then(function (png) {
                            var url = URL.createObjectURL(png);
                            urls.push(url);
                            var img = $window.document.createElement('img');
                            img.className = 'print-sheet' + (base.width > base.height ? ' is-landscape' : '');
                            img.alt = '';
                            container.appendChild(img);
                            if (onProgress) { onProgress(number, document.numPages); }
                            return $q(function (resolve) {
                                img.onload = img.onerror = resolve;
                                img.src = url;
                            });
                        });
                    });
                }
            }).then(function (count) {
                $window.document.body.appendChild(container);
                $window.document.body.classList.add('is-printing');
                $window.print();
                // Most browsers wait in print() until the dialog closes; afterprint covers those that do not.
                return $q(function (resolve) {
                    var done = function () { $window.removeEventListener('afterprint', done); cleanup(); resolve(count); };
                    $window.addEventListener('afterprint', done);
                    setTimeout(done, 60000);   // a print preview that never says it closed
                });
            }, function (error) {
                cleanup();
                return $q.reject(typeof error === 'string' ? error : 'Unable to prepare the pages for printing.');
            });
        }

        return { print: print, MAX_PAGES: MAX_PAGES };
    }]);
})();
