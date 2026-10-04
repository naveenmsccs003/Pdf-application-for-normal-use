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
        var pendingCleanup = null;  // the previous printout's pages, kept until its print job has surely read them

        /**
         * Draws `blob` (a PDF) and prints it. onProgress(done, total) while drawing; isCancelled() is checked between
         * pages and stops before the print dialog opens. Resolves with the number of pages once print() has returned
         * (null when cancelled); rejects with a message.
         */
        function print(blob, onProgress, isCancelled) {
            var task = null, container = null, urls = [];
            var cancelled = function () { return !!(isCancelled && isCancelled()); };
            if (pendingCleanup) { pendingCleanup(); }

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
                    if (cancelled()) { return $q.reject(null); }
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
                if (cancelled()) { cleanup(); return null; }
                $window.document.body.appendChild(container);
                $window.document.body.classList.add('is-printing');
                $window.print();
                // print() returns once the dialog closes in most browsers, but the job may still read the pages, and
                // some (WebKitGTK in the desktop app) never fire afterprint: the pages stay (hidden) until afterprint,
                // the next print, or a minute later, while the caller carries on straight away.
                var timer = null;
                var done = function () {
                    $window.removeEventListener('afterprint', done);
                    clearTimeout(timer);
                    if (pendingCleanup === done) { pendingCleanup = null; }
                    cleanup();
                };
                $window.addEventListener('afterprint', done);
                timer = setTimeout(done, 60000);
                pendingCleanup = done;
                return count;
            }, function (error) {
                cleanup();
                if (error === null) { return null; }   // cancelled while drawing
                return $q.reject(typeof error === 'string' ? error : 'Unable to prepare the pages for printing.');
            });
        }

        return { print: print, MAX_PAGES: MAX_PAGES };
    }]);
})();
