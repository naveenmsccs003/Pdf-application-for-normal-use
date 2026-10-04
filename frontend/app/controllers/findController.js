(function () {
    'use strict';

    /**
     * Find bar (Ctrl+F): searches as you type, shows "3 of 12", steps through matches with Enter /
     * Shift+Enter (also F3 / Shift+F3, Ctrl+G / Ctrl+Shift+G) and marks them on the page. Lives inside the
     * viewer's scope, so it can read the open document from `vm`; the search itself is searchService.
     *
     * Find can also look for drawing numbers, beam marks or column marks (`kind`): a typed number or mark, or with
     * nothing typed all of them. The results list groups what was found by page (for drawing numbers: a sheet
     * index, the one nearest the title block corner first).
     */
    angular.module('pdfViewerApp').controller('FindController', ['$scope', '$document', '$timeout', 'searchService',
        function ($scope, $document, $timeout, searchService) {
            var find = this;
            var TYPING_DELAY_MS = 250;

            find.isOpen = false;
            find.query = '';
            find.matchCase = false;
            find.wholeWord = false;
            find.maxLength = searchService.MAX_QUERY_LENGTH;
            find.matches = [];          // [{ pageNumber, rects }], in page order
            find.current = null;        // the selected match
            find.searching = false;
            find.capped = false;        // stopped at searchService.MAX_MATCHES
            find.failed = false;
            find.searched = '';         // the query the matches are for
            find.kind = 'text';         // 'text' | 'drawing' | 'beam' | 'column'
            find.kinds = [{ value: 'text', label: 'Text' }].concat(['drawing', 'beam', 'column'].map(function (k) {
                return { value: k, label: searchService.KINDS[k].label };
            }));
            find.showList = false;      // the results list under the bar
            find.groups = [];           // [{ page, items: [{ text, count, match }] }]
            var PLACEHOLDERS = {
                text: 'Find in document',
                drawing: 'S-101, or empty for all',
                beam: 'B12 or 12, or empty for all',
                column: 'C3 or 3, or empty for all'
            };
            find.placeholder = function () { return PLACEHOLDERS[find.kind]; };

            var job = null;
            var typingTimer = null;
            var wrappedCount = 0;       // matches before the start page, kept at the front of the list

            function vm() { return $scope.vm; }

            /** Opens the bar; with `kind`, searching for that kind of mark (drawing, beam, column) with the list shown. */
            find.show = function (kind) {
                if (!vm().hasDocument()) { return; }
                if (typeof kind !== 'string' || !find.kinds.some(function (k) { return k.value === kind; })) { kind = null; }   // $apply passes the scope
                if (kind && kind !== find.kind) {
                    find.kind = kind;
                    find.query = '';
                    find.searched = '';
                }
                if (kind && kind !== 'text') { find.showList = true; }
                find.isOpen = true;
                $timeout(function () {
                    var input = $document[0].getElementById('find-input');
                    if (input) { input.focus(); input.select(); }
                });
                if ((find.query || find.kind !== 'text') && !find.searched) {
                    run();
                }
            };

            find.setKind = function () {
                if (find.kind !== 'text') { find.showList = true; }
                run();
                $timeout(function () {
                    var input = $document[0].getElementById('find-input');
                    if (input) { input.focus(); }
                });
            };

            find.close = function () {
                find.isOpen = false;
                stop();
                reset();   // the typed text stays for next time
                var active = $document[0].activeElement;
                if (active && active.id === 'find-input') { active.blur(); }
            };

            function stop() {
                if (job) { job.cancel(); job = null; }
                $timeout.cancel(typingTimer);
                typingTimer = null;
                find.searching = false;
            }

            function reset() {
                find.matches = [];
                find.current = null;
                find.capped = false;
                find.failed = false;
                find.searched = '';
                find.groups = [];
                wrappedCount = 0;
            }

            function searchKey() { return find.kind + ':' + searchService.normalizeQuery(find.query); }

            /** Searches again shortly after typing stops. */
            find.onQueryChange = function () {
                $timeout.cancel(typingTimer);
                typingTimer = $timeout(run, TYPING_DELAY_MS);
            };

            find.toggle = function (option) {
                find[option] = !find[option];
                run();
            };

            function run() {
                stop();
                reset();
                var text = searchService.normalizeQuery(find.query);
                if ((!text && find.kind === 'text') || !vm().hasDocument()) { return; }
                var options = find.kind === 'text' ? { matchCase: find.matchCase, wholeWord: find.wholeWord }
                    : { pattern: searchService.patternFor(find.kind, text) };
                find.searching = true;
                find.searched = searchKey();
                job = searchService.start(text, options, vm().pageCount, vm().currentPage, onUpdate);
            }

            function onUpdate(update) {
                var list = find.matches;
                if (update.wrapped) {
                    Array.prototype.splice.apply(list, [wrappedCount, 0].concat(update.matches));
                    wrappedCount += update.matches.length;
                } else {
                    Array.prototype.push.apply(list, update.matches);
                }
                // The first match from the current page on is shown as soon as it is found.
                if (!find.current && update.matches.length) {
                    select(update.matches[0]);
                }
                rebuildGroups();
                if (update.done) {
                    job = null;
                    find.searching = false;
                    find.capped = update.capped;
                    find.failed = !!update.failed;
                }
            }

            /** The matches by page, each different text once with its count (in page order: wrapped ones come first). */
            function rebuildGroups() {
                var byPage = {};
                find.matches.forEach(function (m) {
                    var group = byPage[m.pageNumber] || (byPage[m.pageNumber] = { page: m.pageNumber, items: [], index: {} });
                    var key = m.text || '';
                    var item = group.index[key];
                    if (item) { item.count++; } else { group.items.push(group.index[key] = { text: key, count: 1, match: m }); }
                });
                var corner = function (item) { var r = item.match.rects[0]; return r.x + r.y; };
                find.groups = Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; }).map(function (page) {
                    var items = byPage[page].items;
                    // Drawing numbers: the title block sits in the bottom-right corner, so its number comes first.
                    if (find.kind === 'drawing') { items.sort(function (a, b) { return corner(b) - corner(a); }); }
                    return { page: page, items: items };
                });
            }

            /** "3 beams on 2 pages", from the results list. */
            find.summary = function () {
                var texts = {};
                find.groups.forEach(function (g) { g.items.forEach(function (i) { texts[i.text] = true; }); });
                var n = Object.keys(texts).length, pages = find.groups.length;
                var noun = { text: 'different match', drawing: 'drawing number', beam: 'beam mark', column: 'column mark' }[find.kind];
                return n + ' ' + noun + (n === 1 ? '' : 's') + ' on ' + pages + ' page' + (pages === 1 ? '' : 's');
            };

            find.goTo = function (match) { select(match); };

            find.toggleList = function () { find.showList = !find.showList; };

            function select(match) {
                find.current = match;
                if (match.pageNumber !== vm().currentPage) {
                    vm().showPage(match.pageNumber);
                }
            }

            /** Enter / F3: the next match (wrapping around); also starts a search that is still waiting. */
            find.next = function () { step(1); };
            find.previous = function () { step(-1); };

            function step(direction) {
                if (typingTimer || searchKey() !== find.searched) {
                    run();   // first Enter after typing: show the first match
                    return;
                }
                var count = find.matches.length;
                if (!count) { return; }
                var i = find.matches.indexOf(find.current);
                select(find.matches[(i + direction + count) % count]);
            }

            find.countText = function () {
                if (!find.searched) { return ''; }
                if (find.failed) { return 'Search failed'; }
                var count = find.matches.length;
                if (!count) { return find.searching ? 'Searching…' : 'No matches'; }
                return (find.matches.indexOf(find.current) + 1) + ' of ' + count +
                    (find.capped ? '+' : '') + (find.searching ? '…' : '');
            };

            find.hasMatches = function () { return find.matches.length > 0; };

            // A new or closed document: old matches no longer apply; search the new one for the same text.
            $scope.$watch(function () { return vm().docVersion; }, function (version, old) {
                if (version === old) { return; }
                stop();
                reset();
                if (!vm().hasDocument()) {
                    find.isOpen = false;
                } else if (find.isOpen && (find.query || find.kind !== 'text')) {
                    // Wait until the new document's first page is set before searching from it.
                    $timeout(run);
                }
            });

            /** Keys in the find box: Enter / Shift+Enter step through matches, Esc closes the bar. */
            find.onInputKey = function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (event.shiftKey) { find.previous(); } else { find.next(); }
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    find.close();
                }
            };

            // Ctrl+F opens the bar instead of the browser's own find; F3 and Ctrl+G step through matches.
            // Registered after the tools dialog's capture-phase handler, which blocks these while it is open.
            function onKeyDown(event) {
                if (!vm().hasDocument() || event.altKey) { return; }
                var mod = event.ctrlKey || event.metaKey;
                var key = event.key.toLowerCase();
                if (mod && key === 'f') {
                    event.preventDefault();
                    $scope.$apply(find.show);
                } else if (event.key === 'F3' || (mod && key === 'g')) {
                    event.preventDefault();
                    $scope.$apply(function () {
                        if (!find.isOpen || (!find.query && find.kind === 'text')) {
                            find.show();
                        } else if (event.shiftKey) {
                            find.previous();
                        } else {
                            find.next();
                        }
                    });
                }
            }

            $document.on('keydown', onKeyDown);
            $scope.$on('$destroy', function () {
                $document.off('keydown', onKeyDown);
                stop();
            });
        }]);
})();
