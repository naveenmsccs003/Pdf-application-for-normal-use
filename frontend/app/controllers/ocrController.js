(function () {
    'use strict';

    /**
     * OCR tab: recognises the text of scanned pages (ocrService), shows the recognised words on the page, and
     * the Extract dialog: the document's text (recognised or the page's own) and what was detected on each page:
     * drawing numbers (the sheet's own one first), dimensions and annotations, to copy or save.
     * Finding text, drawing numbers, dimensions and annotations is the find bar (FindController); recognised pages
     * are part of every search once they are read.
     */
    angular.module('pdfViewerApp').controller('OcrController', ['$scope', '$document', '$q', '$timeout', 'ocrService', 'searchService',
        'reportService', 'toolsService', 'pagesService',
        function ($scope, $document, $q, $timeout, ocrService, searchService, reportService, toolsService, pagesService) {
            var ocr = this;
            var MAX_EXTRACT_PAGES = 500;
            var DETECT_KINDS = ['drawing', 'dimension', 'note'];

            ocr.busy = null;            // { page, index, count, progress } while recognising
            ocr.showWords = false;      // recognised words boxed on the page
            ocr.words = {};             // page number -> recognised words (for the page overlay)
            ocr.dialog = null;          // Extract: { view, scope, pages, busy, progress, text, rows, error }

            function vm() { return $scope.vm; }

            function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

            function refreshWords() {
                var words = {};
                ocrService.recognizedPages().forEach(function (n) { words[n] = ocrService.wordsOf(n); });
                ocr.words = words;
            }

            /** Recognises the current page ('current') or every page ('all'). */
            ocr.recognize = function (scope) {
                var view = vm();
                if (!view.hasDocument() || ocr.busy) { return; }
                var pages = scope === 'all' ? pagesService.parsePages('all', view.pageCount).pages : [view.currentPage];
                ocr.busy = { page: pages[0], index: 0, count: pages.length, progress: 0 };
                view.status = 'Reading the text of page ' + pages[0] + '…';
                ocrService.recognize(pages, function (p) {
                    $scope.$applyAsync(function () { if (ocr.busy) { ocr.busy = p; } });
                }).then(function (summary) {
                    refreshWords();
                    view.status = summaryText(summary, pages);
                    if (summary.recognized) {
                        ocr.showWords = true;
                        if ($scope.find) { $scope.find.refresh(); }
                    }
                }, function (error) {
                    if (error === 'cancelled') {
                        refreshWords();
                        if (view.hasDocument()) { view.status = 'Text recognition stopped. Pages already read stay searchable.'; }
                    } else {
                        view.error = view.status = typeof error === 'string' ? error : 'Text recognition failed.';
                    }
                }).finally(function () { ocr.busy = null; });
            };

            function summaryText(s, pages) {
                if (!s.recognized && s.skipped && pages.length === 1) {
                    return 'Page ' + pages[0] + ' already has text: it can be searched without OCR.';
                }
                var parts = [];
                if (s.recognized) { parts.push('Read ' + plural(s.recognized, 'page') + ': ' + plural(s.words, 'word') + ' recognised.'); }
                if (!s.recognized && !s.failed) { parts.push('No scanned pages: every page already has text.'); }
                else if (s.skipped) { parts.push(plural(s.skipped, 'page') + ' already had text.'); }
                if (s.failed) { parts.push(plural(s.failed, 'page') + ' could not be read.'); }
                if (s.recognized) { parts.push('Find, Drawing no., Dimensions and Annotations now search them.'); }
                return parts.join(' ');
            }

            ocr.cancel = function () { ocrService.cancel(); };

            ocr.progressText = function () {
                var b = ocr.busy;
                if (!b) { return ''; }
                return 'Page ' + b.page + (b.count > 1 ? ' (' + (b.index + 1) + ' of ' + b.count + ')' : '') + ' · ' + Math.round(b.progress * 100) + '%';
            };

            ocr.hasWords = function () { return Object.keys(ocr.words).length > 0; };

            ocr.toggleWords = function () {
                ocr.showWords = !ocr.showWords;
                if (ocr.showWords && !ocr.words[vm().currentPage]) {
                    vm().status = ocr.hasWords() ? 'This page was not read with OCR: Recognize page reads it.' : 'No page has been read yet: use Recognize page.';
                }
            };

            /** The recognised words for the viewer's overlay, or null when hidden. */
            ocr.viewerWords = function () { return ocr.showWords ? ocr.words : null; };

            // ----- Extract: text and detections -----
            ocr.openExtract = function (view) {
                if (!vm().hasDocument()) { return; }
                ocr.dialog = { view: view || 'text', scope: 'current', pages: String(vm().currentPage), busy: false, progress: '',
                               text: '', rows: [], error: '', run: 0 };
                ocr.runExtract();
            };

            ocr.closeExtract = function () { if (ocr.dialog) { ocr.dialog.run++; } ocr.dialog = null; };

            function extractPages(d) {
                var count = vm().pageCount;
                if (d.scope === 'current') { return { pages: [vm().currentPage] }; }
                var parsed = pagesService.parsePages(d.scope === 'all' ? 'all' : d.pages, count);
                if (parsed.error) { return parsed; }
                var pages = parsed.pages.slice().sort(function (a, b) { return a - b; });
                return { pages: pages.slice(0, MAX_EXTRACT_PAGES), capped: pages.length > MAX_EXTRACT_PAGES };
            }

            /** Reads the chosen pages' text and detections again (scope changed, or after recognising). */
            ocr.runExtract = function () {
                var d = ocr.dialog;
                if (!d) { return; }
                var chosen = extractPages(d);
                d.error = chosen.error || '';
                d.text = '';
                d.rows = [];
                if (chosen.error) { return; }
                var run = ++d.run;
                var pages = chosen.pages;
                d.busy = true;
                var texts = [];
                function live() { return ocr.dialog === d && d.run === run; }

                var i = 0;
                function nextText() {
                    if (!live()) { return $q.reject('cancelled'); }
                    if (i >= pages.length) { return $q.when(); }
                    var n = pages[i++];
                    d.progress = 'Reading page ' + n + '…';
                    return ocrService.pageText(n).then(function (t) {
                        texts.push('--- Page ' + n + (t.recognized ? ' (OCR)' : '') + ' ---\n' + (t.text || '(no text: Recognize page reads a scanned page)'));
                    }, function () {
                        texts.push('--- Page ' + n + ' ---\n(could not be read)');
                    }).then(nextText);
                }

                nextText().then(function () {
                    d.text = texts.join('\n\n');
                    return detect(pages, live, function (text) { d.progress = text; });
                }).then(function (rows) {
                    d.rows = rows;
                    d.progress = (chosen.capped ? 'The first ' + MAX_EXTRACT_PAGES + ' pages. ' : '') + plural(pages.length, 'page') + ', ' + plural(rows.length, 'item') + ' detected.';
                }, function (error) {
                    if (error !== 'cancelled' && live()) { d.error = 'Unable to read the pages.'; d.progress = ''; }
                }).finally(function () { if (live()) { d.busy = false; } });
            };

            /** Drawing numbers, dimensions and annotations on the pages: rows of { page, kind, text, count, match }. */
            function detect(pages, live, progress) {
                var wanted = {};
                pages.forEach(function (n) { wanted[n] = true; });
                var found = {};     // kind -> matches
                var chain = $q.when();
                DETECT_KINDS.forEach(function (kind) {
                    chain = chain.then(function () {
                        if (!live()) { return $q.reject('cancelled'); }
                        progress('Finding ' + searchService.KINDS[kind].label.toLowerCase() + 's…');
                        return searchAll(kind, pages[0], pages[pages.length - 1]).then(function (matches) {
                            found[kind] = matches.filter(function (m) { return wanted[m.pageNumber]; });
                        });
                    });
                });
                return chain.then(function () {
                    var rows = [];
                    pages.forEach(function (n) {
                        DETECT_KINDS.forEach(function (kind) {
                            var items = [], byText = {};
                            found[kind].forEach(function (m) {
                                if (m.pageNumber !== n) { return; }
                                var text = searchService.normalizeQuery(m.text);
                                if (byText[text]) { byText[text].count++; return; }
                                items.push(byText[text] = { page: n, kind: kind, text: text, count: 1, match: m,
                                                            source: ocrService.isRecognized(n) ? 'OCR' : 'Text' });
                            });
                            if (kind === 'drawing') {
                                // The sheet's own number is the one nearest the title block (bottom right).
                                var corner = function (item) { var r = item.match.rects[0]; return r.x + r.y; };
                                items.sort(function (a, b) { return corner(b) - corner(a); });
                                items.forEach(function (item, k) { item.label = k === 0 ? 'Drawing no.' : 'Drawing reference'; });
                            } else {
                                items.forEach(function (item) { item.label = searchService.KINDS[kind].label; });
                            }
                            rows = rows.concat(items);
                        });
                    });
                    return rows;
                });
            }

            function searchAll(kind, from, to) {
                var deferred = $q.defer(), matches = [];
                searchService.start('', { pattern: searchService.patternFor(kind, ''), pages: { from: from, to: to } }, to, from, function (update) {
                    matches = matches.concat(update.matches);
                    if (update.done) { deferred.resolve(matches); }
                });
                return deferred.promise;
            }

            ocr.goToRow = function (row) {
                vm().showPage(row.page);
                ocr.closeExtract();
            };

            ocr.copyText = function () {
                var d = ocr.dialog;
                if (!d || !d.text) { return; }
                function fallback() {
                    var area = $document[0].getElementById('ocr-text');
                    if (!area) { return false; }
                    area.focus();
                    area.select();
                    try { return $document[0].execCommand('copy'); } catch (e) { return false; }
                }
                var copied = navigator.clipboard && navigator.clipboard.writeText
                    ? $q.when(navigator.clipboard.writeText(d.text)).then(function () { return true; }, fallback)
                    : $q.when(fallback());
                copied.then(function (ok) { d.progress = ok ? 'Text copied.' : 'Select the text and copy it (' + vm().modKey + 'C).'; });
            };

            ocr.saveText = function () {
                var d = ocr.dialog;
                if (!d || !d.text) { return; }
                save('txt', d.text.replace(/\n/g, '\r\n') + '\r\n', 'text');
            };

            ocr.saveDetections = function () {
                var d = ocr.dialog;
                if (!d || !d.rows.length) { return; }
                var table = {
                    columns: [{ key: 'page', label: 'Page' }, { key: 'label', label: 'Found' }, { key: 'text', label: 'Text' },
                              { key: 'count', label: 'Count' }, { key: 'source', label: 'From' }],
                    rows: d.rows
                };
                save('csv', reportService.toCsv(table), 'detected');
            };

            function save(format, content, suffix) {
                var d = ocr.dialog;
                d.saving = true;
                toolsService.saveReport(vm().fileName, format, content, null, suffix).then(function (message) {
                    vm().status = message || 'Not saved.';
                    if (ocr.dialog === d) { d.progress = message || 'Not saved.'; }
                }, function (message) {
                    if (ocr.dialog === d) { d.error = typeof message === 'string' ? message : 'Unable to save.'; }
                }).finally(function () { d.saving = false; });
            }

            // A new or closed document: its recognised text is gone.
            $scope.$watch(function () { return vm().docVersion; }, function (version, old) {
                if (version === old) { return; }
                ocrService.cancel();
                ocr.words = {};
                ocr.closeExtract();
            });

            // While the Extract dialog is open, keys belong to it (Esc closes it). Capture phase, before the viewer's keys.
            function onKeyDown(event) {
                if (!ocr.dialog) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') { $scope.$apply(ocr.closeExtract); }
            }
            $document[0].addEventListener('keydown', onKeyDown, true);
            $scope.$on('$destroy', function () {
                $document[0].removeEventListener('keydown', onKeyDown, true);
                ocrService.cancel();
            });
        }]);
})();
