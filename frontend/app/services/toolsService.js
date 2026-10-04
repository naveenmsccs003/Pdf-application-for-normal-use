(function () {
    'use strict';

    /**
     * PDF tools: merge, split, compress, convert; protect, remove a password, sign.
     *   web:     posts to /api/tools/* and downloads the result
     *   desktop: asks the host, which shows native save dialogs and writes to disk
     * Every operation resolves with a message for the user, or null if the user cancelled.
     * Rejections carry a user-friendly message.
     */
    angular.module('pdfViewerApp').factory('toolsService', ['$http', '$q', 'desktopService', 'pdfService', 'markupGeometry',
        function ($http, $q, desktopService, pdfService, markupGeometry) {
            var pendingTool = null;      // desktop: deferred waiting for the host's answer
            var pendingPick = null;

            if (desktopService.isDesktop) {
                desktopService.on('tool-done', function (message) { settle(function (d) { d.resolve(message.message); }); });
                desktopService.on('tool-cancelled', function () { settle(function (d) { d.resolve(null); }); });
                desktopService.on('tool-error', function (message) { settle(function (d) { d.reject(message.message); }); });
                desktopService.on('picked-pdfs', function (message) {
                    if (pendingPick) {
                        pendingPick.resolve(message.files || []);
                        pendingPick = null;
                    }
                });
            }

            function settle(action) {
                if (pendingTool) {
                    var deferred = pendingTool;
                    pendingTool = null;
                    action(deferred);
                }
            }

            /** Desktop: native multi-select dialog; resolves with [{ id, name, size }]. */
            function pickDesktopFiles() {
                pendingPick = $q.defer();
                desktopService.send('pick-pdfs');
                return pendingPick.promise;
            }

            function runDesktop(tool, inputs, options) {
                pendingTool = $q.defer();
                desktopService.send('run-tool', { tool: tool, inputs: inputs, options: options });
                return pendingTool.promise;
            }

            // ----- web -----

            /** Adds the input document: the open document (by upload id) or a file to upload. */
            function appendSource(form, source, fileName) {
                form.append('id', source.id);
                form.append('name', fileName);
            }

            /** Posts FormData (multipart) or a plain object (JSON) to api/tools/{endpoint} (or a full api/ path) and downloads the response. */
            function post(endpoint, body) {
                var config = { responseType: 'blob' };
                if (body instanceof FormData) {
                    // Let the browser send multipart with its boundary; JSON uses $http's defaults.
                    // (Setting these to undefined for JSON would replace the defaults, not keep them.)
                    config.transformRequest = angular.identity;
                    config.headers = { 'Content-Type': undefined };
                }
                return $http.post(endpoint.indexOf('api/') === 0 ? endpoint : 'api/tools/' + endpoint, body, config).then(function (response) {
                    var name = downloadName(response.headers('Content-Disposition')) || 'download';
                    saveBlob(response.data, name);
                    return { name: name, headers: response.headers };
                }, function (response) {
                    if (response.status <= 0) {
                        return $q.reject('Unable to reach the server. Please check that the application is running.');
                    }
                    if (response.status === 413) {
                        return $q.reject('The selected files are too large.');
                    }
                    // Error bodies arrive as a Blob because of responseType 'blob'.
                    return readError(response.data).then($q.reject);
                });
            }

            function readError(blob) {
                var fallback = 'Something went wrong. Please try again.';
                if (!blob || typeof blob.text !== 'function') {
                    return $q.when(fallback);
                }
                return $q.when(blob.text()).then(function (text) {
                    try {
                        return JSON.parse(text).error || fallback;
                    } catch (e) {
                        return fallback;
                    }
                }, function () { return fallback; });
            }

            function downloadName(header) {
                if (!header) { return null; }
                var utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
                if (utf8) { return decodeURIComponent(utf8[1]); }
                var plain = /filename="?([^";]+)"?/i.exec(header);
                return plain ? plain[1] : null;
            }

            function saveBlob(blob, name) {
                var url = URL.createObjectURL(blob);
                var link = document.createElement('a');
                link.href = url;
                link.download = name;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
            }

            function formatSize(bytes) {
                if (bytes >= 1048576) { return (bytes / 1048576).toFixed(1) + ' MB'; }
                return Math.max(1, Math.round(bytes / 1024)) + ' KB';
            }

            // ----- operations -----

            /**
             * items: [{ current: true } | { file: File } | { id } (desktop picked file)] in merge order.
             */
            function merge(items, source) {
                if (desktopService.isDesktop) {
                    return runDesktop('merge', items.map(function (item) { return item.current ? 'current' : item.id; }), {});
                }
                var form = new FormData();
                var fileIndex = 0;
                items.forEach(function (item) {
                    if (item.current) {
                        form.append('items', 'id:' + source.id);
                    } else {
                        form.append('items', 'file:' + fileIndex++);
                        form.append('files', item.file);
                    }
                });
                return post('merge', form).then(function (result) {
                    return 'Merged ' + items.length + ' files (' + result.headers('X-Page-Count') + ' pages) and downloaded ' + result.name + '.';
                });
            }

            function split(source, fileName, options) {
                if (desktopService.isDesktop) {
                    return runDesktop('split', ['current'], options);
                }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('mode', options.mode);
                form.append('pagesPerFile', options.pagesPerFile || 0);
                form.append('ranges', options.ranges || '');
                return post('split', form).then(function (result) {
                    return 'Created ' + result.headers('X-File-Count') + ' PDF files and downloaded ' + result.name + '.';
                });
            }

            function compress(source, fileName, options) {
                if (desktopService.isDesktop) {
                    return runDesktop('compress', ['current'], options);
                }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('level', options.level);
                return post('compress', form).then(function (result) {
                    var before = Number(result.headers('X-Original-Size'));
                    var after = Number(result.headers('X-Result-Size'));
                    if (after >= before) {
                        return 'This PDF is already compact; downloaded an unchanged copy as ' + result.name + '.';
                    }
                    var saved = Math.round(100 * (before - after) / before);
                    return 'Downloaded ' + result.name + ': ' + formatSize(before) + ' → ' + formatSize(after) + ' (' + saved + '% smaller).';
                });
            }

            function convert(source, fileName, options) {
                if (desktopService.isDesktop) {
                    return runDesktop('convert', ['current'], options);
                }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('format', options.format);
                form.append('dpi', options.dpi || 150);
                return post('convert', form).then(function (result) {
                    return 'Downloaded ' + result.name + (options.format === 'png' ? '.' : ' (text only).');
                });
            }

            /**
             * Saves a copy of the open document with the markups as PDF annotations. `options`: { flatten (make every
             * annotation and form field part of the page), pages ([1-based page numbers] to keep, in order) }.
             */
            function saveHighlights(source, fileName, highlights, options) {
                options = options || {};
                var payload = highlights.map(markupGeometry.toSaved);
                var extra = { flatten: !!options.flatten, pages: options.pages || null };
                if (desktopService.isDesktop) {
                    return runDesktop('save-highlights', ['current'], angular.extend({ highlights: payload }, extra));
                }
                return post('save-highlights', angular.extend({ id: source.id, name: fileName, highlights: payload }, extra)).then(function (result) {
                    var count = result.headers('X-Highlight-Count');
                    return 'Downloaded ' + result.name + ' with ' + count + ' markup' + (count === '1' ? '' : 's') +
                        (options.flatten ? ' (flattened)' : '') + '.';
                });
            }

            /** The annotated copy as a Blob (for printing), without saving it anywhere. Same options as saveHighlights. */
            function annotatedPdf(source, highlights, options) {
                options = options || {};
                var body = { highlights: highlights.map(markupGeometry.toSaved), flatten: !!options.flatten, pages: options.pages || null };
                var url = desktopService.isDesktop ? 'api/local/' + pdfService.localToken() + '/annotated' : 'api/tools/save-highlights';
                if (!desktopService.isDesktop) { body.id = source.id; body.name = 'print.pdf'; }
                return $http.post(url, body, { responseType: 'blob' }).then(function (response) { return response.data; }, function (response) {
                    if (response.status <= 0) { return $q.reject('Unable to reach the server. Please check that the application is running.'); }
                    return readError(response.data).then($q.reject);
                });
            }

            /** Pages > Extract: the pages of `layout` as a new PDF (download / save dialog); the document stays as it is. */
            function extractPages(source, fileName, layout) {
                if (desktopService.isDesktop) {
                    return runDesktop('extract', ['current'], { layout: layout });
                }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('layout', JSON.stringify(layout));
                return post('api/pages/extract', form).then(function (result) {
                    var count = result.headers('X-Page-Count');
                    return 'Downloaded ' + result.name + ' (' + count + ' page' + (count === '1' ? '' : 's') + ').';
                });
            }

            /**
             * Saves a report: 'csv', 'html' or 'txt' (`content`, made here), 'pdf' or 'xlsx' (`table`, written by the host;
             * reportService.toHost). A download on the web, the save dialog on desktop. CSV gets a byte order mark so
             * Excel reads it as UTF-8. `suffix` ends the file name (default "markups").
             */
            function saveReport(fileName, format, content, table, suffix) {
                var base = String(fileName || 'document').replace(/\.pdf$/i, '') + '-' + (suffix || 'markups');
                if (format === 'pdf' || format === 'xlsx') {
                    if (desktopService.isDesktop) {
                        return runDesktop('save-report', ['current'], { format: format, report: table, name: base });
                    }
                    return post('report', { format: format, name: base, report: table }).then(function (result) {
                        return 'Downloaded ' + result.name + '.';
                    });
                }
                if (desktopService.isDesktop) {
                    return runDesktop('save-report', ['current'], { format: format, content: content, name: base });
                }
                var name = base + '.' + format;
                var blob = format === 'csv'
                    ? new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8' })
                    : new Blob([content], { type: (format === 'txt' ? 'text/plain' : 'text/html') + ';charset=utf-8' });
                saveBlob(blob, name);
                return $q.when('Downloaded ' + name + '.');
            }

            // ----- security: password protection and digital signatures -----

            /**
             * A protected copy: options { userPassword, ownerPassword, allowPrint, allowCopy, allowModify, allowAnnotate,
             * allowForms, allowAssemble }. The open document's own password (if any) goes along to read it.
             */
            function protect(source, fileName, options) {
                if (desktopService.isDesktop) { return runDesktop('protect', ['current'], options); }
                var form = new FormData();
                appendSource(form, source, fileName);
                if (pdfService.password()) { form.append('password', pdfService.password()); }
                Object.keys(options).forEach(function (key) { form.append(key, options[key]); });
                return post('protect', form).then(function (result) { return 'Downloaded ' + result.name + ' (protected with AES-256).'; });
            }

            /** A copy without the password (`password`: the owner password, or empty to use the document's own). */
            function unprotect(source, fileName, password) {
                var value = password || pdfService.password() || '';
                if (desktopService.isDesktop) { return runDesktop('unprotect', ['current'], { password: password || '' }); }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('password', value);
                return post('unprotect', form).then(function (result) { return 'Downloaded ' + result.name + ' without a password.'; });
            }

            /**
             * A signed copy: options { certificatePassword, reason, location, contact, page (0: invisible), corner }.
             * Web: `certificate` is the .pfx / .p12 file; desktop: the host asks for it.
             */
            function sign(source, fileName, options, certificate) {
                if (desktopService.isDesktop) { return runDesktop('sign', ['current'], options); }
                var form = new FormData();
                appendSource(form, source, fileName);
                form.append('certificate', certificate, certificate.name);
                Object.keys(options).forEach(function (key) { form.append(key, options[key]); });
                return post('sign', form).then(function (result) {
                    var signer = decodeURIComponent(result.headers('X-Signer') || '');
                    var invisible = options.page > 0 && result.headers('X-Signature-Visible') === 'false';
                    return 'Signed by ' + signer + ': downloaded ' + result.name +
                        (invisible ? ' (invisible: no font to draw the signature was found on the server).' : '.');
                });
            }

            return {
                isDesktop: desktopService.isDesktop,
                protect: protect,
                unprotect: unprotect,
                sign: sign,
                saveHighlights: saveHighlights,
                saveReport: saveReport,
                annotatedPdf: annotatedPdf,
                extractPages: extractPages,
                saveBlob: saveBlob,
                validateFile: pdfService.validateFile,
                pickDesktopFiles: pickDesktopFiles,
                merge: merge,
                split: split,
                compress: compress,
                convert: convert
            };
        }]);
})();
