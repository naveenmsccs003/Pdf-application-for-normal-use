(function () {
    'use strict';

    /**
     * Page operations (Pages tab) and Save / Save As.
     *
     * Every page edit is a layout: the new document's pages in order, each { source, page, rotate } where
     * source 0 is the open document, 1 the file being inserted (page 0 = all its pages) and -1 a blank page
     * ({ width, height }). The host rebuilds the PDF from it and the viewer shows the result as a new version
     * of the document; the file on disk (desktop) or the download (web) is only written by Save.
     *   web:     /api/pages/* store the result like an upload; Save downloads it
     *   desktop: the host keeps the result as a working copy; Save writes it to the file
     * Rejections carry a user-friendly message.
     */
    angular.module('pdfViewerApp').factory('pagesService', ['$http', '$q', 'desktopService',
        function ($http, $q, desktopService) {
            var PAGE_SIZES = {          // points, portrait
                a4: { label: 'A4', width: 595, height: 842 },
                a3: { label: 'A3', width: 842, height: 1191 },
                letter: { label: 'Letter', width: 612, height: 792 },
                legal: { label: 'Legal', width: 612, height: 1008 }
            };

            // ----- Page lists and layouts (no I/O) -----

            /** "1-3, 5" or "all" -> { pages: [1, 2, 3, 5] } (sorted, no repeats), or { error }. */
            function parsePages(text, pageCount) {
                var value = String(text == null ? '' : text).trim().toLowerCase();
                if (value === 'all') { return { pages: range(1, pageCount) }; }
                var seen = {}, pages = [];
                var parts = value.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
                if (!parts.length) { return { error: 'Enter the pages, for example: 1-3, 5' }; }
                for (var i = 0; i < parts.length; i++) {
                    var m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(parts[i]);
                    if (!m) { return { error: '"' + parts[i] + '" is not a page or range. Use for example: 1-3, 5' }; }
                    var first = Number(m[1]), last = m[2] ? Number(m[2]) : first;
                    if (first < 1 || last > pageCount || first > last) {
                        return { error: 'Pages "' + parts[i] + '" are outside pages 1 to ' + pageCount + '.' };
                    }
                    for (var p = first; p <= last; p++) {
                        if (!seen[p]) { seen[p] = true; pages.push(p); }
                    }
                }
                return { pages: pages.sort(function (a, b) { return a - b; }) };
            }

            /** "1-3, 5" for a sorted page list. */
            function formatPages(pages) {
                var parts = [];
                for (var i = 0; i < pages.length; i++) {
                    var start = pages[i];
                    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) { i++; }
                    parts.push(start === pages[i] ? String(start) : start + '-' + pages[i]);
                }
                return parts.join(', ');
            }

            function range(first, last) {
                var list = [];
                for (var p = first; p <= last; p++) { list.push(p); }
                return list;
            }

            function doc(page, rotate) { return { source: 0, page: page, rotate: rotate || 0 }; }
            function setOf(pages) {
                var set = {};
                pages.forEach(function (p) { set[p] = true; });
                return set;
            }

            /**
             * The layout for an operation on a document of `pageCount` pages. Options by operation:
             *   delete, extract, duplicate  pages
             *   rotate                      pages, degrees (90 clockwise, 270 anticlockwise, 180)
             *   move                        pages, before (they go before this page; pageCount + 1 = the end)
             *   blank                       count, width, height, before
             *   insert                      filePages (null = all), before
             *   replace                     pages, filePages (null = all): the file's pages take their place
             * Returns { layout } or { error }.
             */
            function layoutFor(op, pageCount, o) {
                var all = range(1, pageCount);
                var selected = setOf(o.pages || []);
                var filePages = o.filePages && o.filePages.length ? o.filePages : [0];
                var fromFile = filePages.map(function (p) { return { source: 1, page: p, rotate: 0 }; });
                var layout;
                switch (op) {
                    case 'delete':
                        if (o.pages.length >= pageCount) { return { error: 'A PDF needs at least one page: you cannot delete them all.' }; }
                        return { layout: all.filter(function (p) { return !selected[p]; }).map(function (p) { return doc(p); }) };
                    case 'extract':
                        return { layout: o.pages.map(function (p) { return doc(p); }) };
                    case 'duplicate':
                        layout = [];
                        all.forEach(function (p) {
                            layout.push(doc(p));
                            if (selected[p]) { layout.push(doc(p)); }
                        });
                        return { layout: layout };
                    case 'rotate':
                        return { layout: all.map(function (p) { return doc(p, selected[p] ? o.degrees : 0); }) };
                    case 'move':
                        var rest = all.filter(function (p) { return !selected[p]; });
                        var at = rest.filter(function (p) { return p < o.before; }).length;
                        layout = rest.map(function (p) { return doc(p); });
                        Array.prototype.splice.apply(layout, [at, 0].concat(o.pages.map(function (p) { return doc(p); })));
                        return { layout: layout };
                    case 'blank':
                        var blanks = range(1, o.count).map(function () { return { source: -1, page: 0, rotate: 0, width: o.width, height: o.height }; });
                        return { layout: insertAt(all, o.before, blanks) };
                    case 'insert':
                        return { layout: insertAt(all, o.before, fromFile) };
                    case 'replace':
                        layout = [];
                        all.forEach(function (p) {
                            if (p === o.pages[0]) { layout = layout.concat(fromFile); }
                            if (!selected[p]) { layout.push(doc(p)); }
                        });
                        return { layout: layout };
                    default:
                        return { error: 'Unknown page operation.' };
                }
            }

            function insertAt(all, before, added) {
                return all.filter(function (p) { return p < before; }).map(function (p) { return doc(p); })
                    .concat(added)
                    .concat(all.filter(function (p) { return p >= before; }).map(function (p) { return doc(p); }));
            }

            /**
             * For each page of the result: { page, rotate } where page is the open document's page it came from,
             * or null for a page that was added. `pageCount` is the result's page count (inserting "all pages" of
             * a file adds as many pages as the file has).
             */
            function pageMap(layout, pageCount) {
                var map = [];
                layout.forEach(function (spec) {
                    if (spec.source === 0) {
                        map.push({ page: spec.page, rotate: spec.rotate || 0 });
                    } else {
                        var count = spec.source > 0 && spec.page === 0 ? pageCount - layout.length + 1 : 1;
                        for (var i = 0; i < count; i++) { map.push({ page: null, rotate: 0 }); }
                    }
                });
                return map;
            }

            // ----- Host calls -----

            var pending = {};   // desktop: deferreds waiting for the host's answer, by kind

            function wait(kind) {
                if (pending[kind]) { pending[kind].reject('Another page operation is still running.'); }
                pending[kind] = $q.defer();
                return pending[kind].promise;
            }

            function settle(kind, action) {
                var deferred = pending[kind];
                if (deferred) {
                    pending[kind] = null;
                    action(deferred);
                }
            }

            if (desktopService.isDesktop) {
                desktopService.on('pages-edited', function (m) { settle('edit', function (d) { d.resolve(m); }); });
                desktopService.on('edit-error', function (m) { settle('edit', function (d) { d.reject(m.message); }); });
                desktopService.on('saved', function (m) { settle('save', function (d) { d.resolve(m); }); });
                desktopService.on('save-error', function (m) { settle('save', function (d) { d.reject(m.message); }); });
                desktopService.on('save-cancelled', function () { settle('save', function (d) { d.resolve(null); }); });
            }

            function failed(response, fallback) {
                if (response.status <= 0) {
                    return $q.reject('Unable to reach the server. Please check that the application is running.');
                }
                if (response.status === 413) { return $q.reject('The selected file is too large.'); }
                return $q.reject((response.data && response.data.error) || fallback);
            }

            /**
             * Rebuilds the open document with `layout`; `file` is the file inserted as source 1 (a File on the
             * web, a picked { id } on desktop). Resolves with { id (web) | token (desktop), fileName, size, pageCount }.
             */
            function apply(source, fileName, layout, file) {
                if (desktopService.isDesktop) {
                    var result = wait('edit');
                    desktopService.send('edit-pages', { layout: layout, inputs: file ? [file.id] : [] });
                    return result;
                }
                var form = new FormData();
                form.append('id', source.id);
                form.append('name', fileName);
                form.append('layout', JSON.stringify(layout));
                if (file) { form.append('files', file); }
                return $http.post('api/pages/rearrange', form, {
                    transformRequest: angular.identity,
                    headers: { 'Content-Type': undefined }
                }).then(function (response) { return response.data; }, function (response) {
                    return failed(response, 'Unable to change the pages.');
                });
            }

            /**
             * A new PDF with blank pages. Web: resolves with { id, fileName, size, pageCount }. Desktop: the host
             * answers with "opened" like any opened file, so this resolves with nothing.
             */
            function create(count, width, height) {
                if (desktopService.isDesktop) {
                    desktopService.send('new-document', { count: count, width: width, height: height });
                    return $q.when(null);
                }
                return $http.post('api/pages/new', { count: count, width: width, height: height, name: 'Untitled.pdf' })
                    .then(function (response) { return response.data; }, function (response) {
                        return failed(response, 'Unable to create the PDF.');
                    });
            }

            /**
             * Save (`saveAs` false) or Save As. Desktop: writes the file (asking where for Save As or a new
             * document); resolves with { fileName, message }, or null if cancelled. Web: downloads the document as
             * `fileName`; resolves with { fileName, message }.
             */
            function save(source, fileName, saveAs, download) {
                if (desktopService.isDesktop) {
                    var result = wait('save');
                    desktopService.send('save', { saveAs: !!saveAs });
                    return result;
                }
                return $http.get('api/pdf/' + source.id, { responseType: 'blob' }).then(function (response) {
                    download(response.data, fileName);
                    return { fileName: fileName, message: 'Downloaded ' + fileName + '.' };
                }, function (response) {
                    return response.status === 404
                        ? $q.reject('The document is no longer available on the server. Open it again.')
                        : failed(response, 'Unable to save the PDF.');
                });
            }

            return {
                PAGE_SIZES: PAGE_SIZES,
                parsePages: parsePages,
                formatPages: formatPages,
                layoutFor: layoutFor,
                pageMap: pageMap,
                apply: apply,
                create: create,
                save: save
            };
        }]);
})();
