(function () {
    'use strict';

    /**
     * Find text. Searches the whole document page by page in the background and reports matches as
     * they are found, so the first ones show quickly even in very long documents.
     *   - web:     matches pdf.js text content in the browser
     *   - desktop: PDFium searches on the host (pdfService.searchLocal), a batch of pages per request
     * A match is { pageNumber, rects: [{ x, y, width, height }] } in PDF units at scale 1 (top-left origin,
     * displayed orientation), the same units as highlights, so it lines up at any zoom.
     * Spaces and line breaks in the text and the query all count as a single space, so a phrase is
     * found across a line break.
     *
     * Besides plain text, drawing numbers, beam marks and column marks are found by pattern (patternFor): all of
     * them, or one number however it is written (B12, B-12, FB12 for "12"). Each match has the `text` found.
     * Dimensions (6000, 1,250, 3.5 m, 12'-6", R250, Ø20) and annotations (notes, references such as SEE DWG S-201,
     * TYP., U.N.O.) are found the same way.
     *
     * Scanned pages recognised with OCR (ocrService) are searched in their recognised words, on the web and on
     * desktop alike (the host's PDFium has no text for them).
     */
    angular.module('pdfViewerApp').factory('searchService', ['$q', 'pdfService', 'ocrService', function ($q, pdfService, ocrService) {
        var MAX_MATCHES = 1000;
        var WEB_BATCH_MS = 60;          // web: report found matches at least this often
        var MAX_QUERY_LENGTH = 200;     // keep in sync with LocalSearchController.MaxQueryLength
        var cache = { doc: null, pages: {} };   // web: indexed page text of the open document

        function normalizeQuery(text) {
            return String(text || '').replace(/\s+/g, ' ').trim();
        }

        function lower(c) {
            var l = c.toLowerCase();
            return l.length === 1 ? l : c;   // keep positions 1:1 (e.g. 'İ' lowercases to 2 characters)
        }

        // Patterns for engineering drawings, valid both as JavaScript and .NET regular expressions.
        //   drawing  S-101, A-201.1, STR-DR-001, M/101A (letters, a separator, 3-5 digits)
        // Marks are capitals on drawings, so these searches match case (what is typed is made capitals).
        //   beam     B1, B12, B-12, FB3, GB12A, RB4 (up to two letters before the B)
        //   column   C1, C12, C-3, SC3, RC12
        //   dimension  12'-6 1/2", 12', 6", R250, Ø20, 1,250, 3.5 m, 2400mm, and plain numbers of 2-5 digits (6000) that
        //            are not part of a mark (B12), a drawing number (S-101), a scale (1:100) or a date
        //   note     NOTE(S) with up to 8 words after it, SEE / REFER TO ... (a drawing, detail, section), DETAIL 3, SECTION A-A, TYP., U.N.O., N.T.S.,
        //            TBC, TBD, HOLD, VERIFY / CONFIRM ON SITE
        var KINDS = {
            drawing: { label: 'Drawing no.', all: '\\b[A-Z]{1,5}(?:[-_/][A-Z0-9]{1,5}){0,3}[-_/]\\d{3,5}(?:\\.\\d{1,3})?[A-Z]?\\b',
                       number: '[A-Z]{1,5}(?:[-_/][A-Z0-9]{1,5}){0,3}[-_/ ]?' },
            beam: { label: 'Beam', all: '\\b[A-Z]{0,2}B[- ]?\\d{1,4}[A-Z]?\\b', number: '[A-Z]{0,2}B[- ]?' },
            column: { label: 'Column', all: '\\b[A-Z]{0,2}C[- ]?\\d{1,4}[A-Z]?\\b', number: '[A-Z]{0,2}C[- ]?' },
            dimension: { label: 'Dimension', all: '(?<![\\w.,/:-])(?:' + [
                '\\d{1,4}[\'\u2032\u2019]\\s?-?\\s?\\d{1,2}(?:\\s\\d{1,2}/\\d{1,2})?["\u2033\u201d]',   // 12'-6 1/2"
                '\\d{1,4}[\'\u2032\u2019](?!\\w)',                                       // 12'
                '\\d{1,2}(?:\\s\\d{1,2}/\\d{1,2})?["\u2033\u201d]',                       // 6", 6 1/2"
                '[R\u00d8\u2300]\\s?\\d{1,5}(?:\\.\\d{1,2})?(?![\\w.])',               // R250, Ø20
                '\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?(?:\\s?(?:mm|cm|m)\\b)?',             // 1,250
                '\\d{1,6}(?:\\.\\d{1,3})?\\s?(?:mm|cm|m)\\b',                          // 3.5 m, 2400mm
                '\\d{2,5}(?:\\.\\d{1,2})?(?![\\w.,/:\'"%\u2032\u2033\u2019\u201d-])'                 // 6000
            ].join('|') + ')' },
            note: { label: 'Annotation', all: '\\b(?:' + [
                'NOTES?\\b:?(?:\\s*\\d{1,2}[.)])?(?:[^\\S\\r\\n]+[A-Z0-9(][^\\s]*){0,8}',   // the note's words (capitals) on its line
                '(?:SEE|REFER\\s+TO)\\s+(?:(?:DWG|DRG|DRAWING|SHEET|DETAIL|SECTION|NOTE|SPEC|SCHEDULE)S?\\.?\\s*)?[A-Z0-9]+(?:[-/.][A-Z0-9]+)*',
                '(?:DETAIL|SECTION|ELEVATION)\\s+[A-Z0-9]{1,4}(?:\\s?[-/]\\s?[A-Z0-9]{1,6}){0,2}',
                'TYP(?:ICAL)?\\b\\.?', 'U\\.?N\\.?O\\b\\.?', 'N\\.T\\.S\\b\\.?', 'NTS\\b', 'TB[CD]\\b', 'HOLD\\b',
                '(?:VERIFY|CONFIRM)\\s+ON\\s+SITE'
            ].join('|') + ')' }
        };

        function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }

        /**
         * The pattern for a kind of mark and what was typed: nothing finds all of them; a number ("12") finds that
         * number with any prefix of the kind (B12, B-12, FB12); a whole mark ("S-101", "FB3") finds it however it is
         * separated (S101, S-101, S 101).
         */
        function patternFor(kind, input) {
            var k = KINDS[kind];
            var text = normalizeQuery(input).toUpperCase();
            if (!k) { return null; }
            if (!text || kind === 'note') { return k.all; }   // annotations: what is typed narrows the list (contains)
            if (kind === 'dimension') {
                // A value however it is grouped: 6000 also finds 6,000.
                var digits = /^\d+$/.test(text.replace(/,/g, '')) ? text.replace(/,/g, '') : null;
                var value = digits ? digits.replace(/\B(?=(\d{3})+$)/g, ',?') : escapeRegex(text);
                return '(?<![\\w.,/:-])' + value + '(?![\\d.,]?\\d)';
            }
            var number = /^0*(\d{1,5})([A-Za-z]?)$/.exec(text);
            if (number) {
                return '\\b' + k.number + '0*' + number[1] + (number[2] ? escapeRegex(number[2]) : '') + '\\b';
            }
            var parts = text.match(/[A-Za-z]+|\d+/g);
            if (!parts) { return '\\b' + escapeRegex(text) + '\\b'; }
            return '\\b' + parts.map(function (part) { return /^\d/.test(part) ? '0*' + part.replace(/^0+(?=\d)/, '') : part; })
                .join('[-_/ .]?') + '\\b';
        }

        var WORD_CHAR = /[\p{L}\p{N}_]/u;
        function isWordChar(c) { return !!c && WORD_CHAR.test(c); }

        // ----- Web: page text index -----
        // The page's text runs joined into one string, with whitespace collapsed; map[i] says which
        // run and character each position came from (null for a line break added between runs).
        // Line ends are kept as '\n' (so a pattern can stop at the end of a line); plain text search
        // treats them as spaces.
        function indexPage(text) {
            var chars = [];
            var map = [];
            var lastSpace = true;
            text.items.forEach(function (item, i) {
                for (var k = 0; k < item.str.length; k++) {
                    var c = item.str[k];
                    if (/\s/.test(c)) {
                        if (!lastSpace) { chars.push(' '); map.push([i, k]); lastSpace = true; }
                        continue;
                    }
                    chars.push(c);
                    map.push([i, k]);
                    lastSpace = false;
                }
                if (item.hasEOL && !lastSpace) { chars.push('\n'); map.push(null); lastSpace = true; }
            });
            return {
                text: chars.join(''),
                lower: chars.map(lower).join(''),
                map: map,
                rect: function (item, start, end) { return runRect(text.items[item], start, end, text.toView); }
            };
        }

        /** Web: the page's text, or its recognised words when it was read with OCR. */
        function pageIndex(pageNumber) {
            var recognized = ocrService.indexFor(pageNumber);
            if (recognized) { return $q.when(recognized); }
            var doc = pdfService.currentDocument();
            if (cache.doc !== doc) {
                cache = { doc: doc, pages: {} };
            }
            if (cache.pages[pageNumber]) {
                return $q.when(cache.pages[pageNumber]);
            }
            return pdfService.getPageText(pageNumber).then(function (text) {
                var index = indexPage(text);
                if (cache.doc === doc) {
                    cache.pages[pageNumber] = index;
                }
                return index;
            });
        }

        // Character positions inside a run are estimated from a generic font's widths: pdf.js only
        // gives the width of the whole run.
        var measureContext = null;
        function textWidth(str) {
            if (!measureContext) {
                measureContext = document.createElement('canvas').getContext('2d');
                measureContext.font = '100px sans-serif';
            }
            return measureContext.measureText(str).width;
        }

        /** Box around characters [start, end) of a text run, in displayed page units. */
        function runRect(item, start, end, toView) {
            var t = item.transform;
            var along = Math.hypot(t[0], t[1]);    // text direction
            var size = Math.hypot(t[2], t[3]);     // font height
            if (!along || !size || !item.width) {
                return null;
            }
            var ux = t[0] / along, uy = t[1] / along, vx = t[2] / size, vy = t[3] / size;
            var total = textWidth(item.str);
            var f0 = total ? textWidth(item.str.slice(0, start)) / total : start / item.str.length;
            var f1 = total ? textWidth(item.str.slice(0, end)) / total : end / item.str.length;
            var x0 = t[4] + ux * item.width * f0, y0 = t[5] + uy * item.width * f0;
            var x1 = t[4] + ux * item.width * f1, y1 = t[5] + uy * item.width * f1;
            var below = -0.25 * size, above = 0.95 * size;   // descenders to the top of capitals
            var corners = [
                toView(x0 + vx * below, y0 + vy * below), toView(x0 + vx * above, y0 + vy * above),
                toView(x1 + vx * below, y1 + vy * below), toView(x1 + vx * above, y1 + vy * above)
            ];
            var xs = corners.map(function (p) { return p[0]; });
            var ys = corners.map(function (p) { return p[1]; });
            var left = Math.min.apply(null, xs), top = Math.min.apply(null, ys);
            return { x: left, y: top, width: Math.max.apply(null, xs) - left, height: Math.max.apply(null, ys) - top };
        }

        /** One rectangle per text run the match touches. */
        function matchRects(index, from, to) {
            var rects = [];
            var run = null;
            function flush() {
                if (run) {
                    var r = index.rect(run.item, run.start, run.end);
                    if (r) { rects.push(r); }
                }
                run = null;
            }
            for (var i = from; i < to; i++) {
                var at = index.map[i];
                if (!at) { continue; }
                if (run && run.item === at[0]) {
                    run.end = at[1] + 1;
                } else {
                    flush();
                    run = { item: at[0], start: at[1], end: at[1] + 1 };
                }
            }
            flush();
            return rects;
        }

        function findInPage(index, query, options, pageNumber, limit) {
            var hay = (options.matchCase ? index.text : index.lower).replace(/\n/g, ' ');
            var needle = options.matchCase ? query : query.split('').map(lower).join('');
            var checkStart = options.wholeWord && isWordChar(needle[0]);
            var checkEnd = options.wholeWord && isWordChar(needle[needle.length - 1]);
            var found = [];
            var pos = hay.indexOf(needle);
            while (pos !== -1 && found.length < limit) {
                var end = pos + needle.length;
                if ((checkStart && isWordChar(hay[pos - 1])) || (checkEnd && isWordChar(hay[end]))) {
                    pos = hay.indexOf(needle, pos + 1);
                    continue;
                }
                var rects = matchRects(index, pos, end);
                if (rects.length) {
                    found.push({ pageNumber: pageNumber, rects: rects, text: index.text.slice(pos, end) });
                }
                pos = hay.indexOf(needle, end);
            }
            return found;
        }

        /** Pattern search (drawing / beam / column numbers) in the page's text. */
        function findPatternInPage(index, regex, pageNumber, limit) {
            var found = [], m;
            regex.lastIndex = 0;
            while (found.length < limit && (m = regex.exec(index.text)) !== null) {
                if (!m[0].length) { regex.lastIndex++; continue; }
                var rects = matchRects(index, m.index, m.index + m[0].length);
                if (rects.length) { found.push({ pageNumber: pageNumber, rects: rects, text: m[0] }); }
            }
            return found;
        }

        /**
         * Starts a search of the open document from startPage to the end, then from page 1 up to startPage,
         * like a browser's find. onUpdate({ matches, wrapped, done, capped, failed }) is called with each
         * batch of new matches, in page order within its part; `wrapped` matches lie before startPage.
         * Returns { cancel }; a cancelled search, or one whose document was closed meanwhile, reports nothing more.
         * Options besides matchCase, wholeWord and pattern: `pages` { from, to } searches only those pages (no wrapping);
         * `contains` keeps only matches whose text contains it (any case).
         */
        function start(query, options, pageCount, startPage, onUpdate) {
            var text = normalizeQuery(query);
            var doc = pdfService.currentDocument();
            var regex = options && options.pattern ? new RegExp(options.pattern, 'g') : null;
            if (!regex && !text) {
                // Nothing to look for (an empty needle would match everywhere).
                onUpdate({ matches: [], wrapped: false, done: true });
                return { cancel: angular.noop };
            }
            if (regex) { options = angular.extend({}, options, { matchCase: true }); }   // the host matches case too
            var cancelled = false;
            var total = 0;
            options = options || {};
            var parts = [{ from: startPage, to: pageCount, wrapped: false }];
            if (options.pages) {
                parts = [{ from: options.pages.from, to: options.pages.to, wrapped: false }];
            } else if (startPage > 1) {
                parts.push({ from: 1, to: startPage - 1, wrapped: true });
            }
            var contains = options.contains ? normalizeQuery(options.contains).toLowerCase() : '';

            function current() { return !cancelled && pdfService.currentDocument() === doc; }

            // Stops at MAX_MATCHES ("1000+ matches"). Returns true when the whole search is over.
            function report(part, matches, partDone) {
                if (contains) {
                    matches = matches.filter(function (m) { return normalizeQuery(m.text).toLowerCase().indexOf(contains) >= 0; });
                }
                var reachedEnd = partDone && part === parts[parts.length - 1];
                var room = MAX_MATCHES - total;
                var capped = matches.length > room || (matches.length === room && !reachedEnd);
                matches = matches.slice(0, room);
                total += matches.length;
                onUpdate({ matches: matches, wrapped: part.wrapped, done: reachedEnd || capped, capped: capped });
                if (reachedEnd || capped) { return true; }
                if (partDone) { searchPart(parts[parts.indexOf(part) + 1]); }
                return partDone;
            }

            function failed() {
                if (current()) { onUpdate({ matches: [], wrapped: false, done: true, failed: true }); }
            }

            function findIn(index, pageNumber, limit) {
                return regex ? findPatternInPage(index, regex, pageNumber, limit) : findInPage(index, text, options, pageNumber, limit);
            }

            // Desktop: the host searches a batch of pages per request and says where to continue. Pages read with
            // OCR are searched here instead, in their recognised words.
            function searchLocalPart(part, from) {
                pdfService.searchLocal(text, options, from, part.to).then(function (result) {
                    if (!current()) { return; }
                    var partDone = result.next === null || result.next === undefined || result.next > part.to;
                    var last = partDone ? part.to : result.next - 1;
                    var matches = [];
                    (result.matches || []).forEach(function (m) {
                        if (!ocrService.isRecognized(m.page)) { matches.push({ pageNumber: m.page, rects: m.rects, text: m.text }); }
                    });
                    ocrService.recognizedPages().forEach(function (pageNumber) {
                        var index = pageNumber >= from && pageNumber <= last && ocrService.indexFor(pageNumber);
                        if (index) { matches = matches.concat(findIn(index, pageNumber, MAX_MATCHES + 1)); }
                    });
                    matches.sort(function (a, b) { return a.pageNumber - b.pageNumber; });   // stable: page order, then as found
                    if (!report(part, matches, partDone)) {
                        searchLocalPart(part, result.next);
                    }
                }, failed);
            }

            // Web: pages are searched one after another; found matches are reported every WEB_BATCH_MS.
            function searchWebPart(part, first) {
                var batch = [];
                var started = Date.now();
                (function next(pageNumber) {
                    if (!current()) { return; }
                    if (pageNumber > part.to || total + batch.length >= MAX_MATCHES || Date.now() - started > WEB_BATCH_MS) {
                        if (!report(part, batch, pageNumber > part.to)) {
                            setTimeout(function () { searchWebPart(part, pageNumber); });   // let the page repaint
                        }
                        return;
                    }
                    pageIndex(pageNumber).then(function (index) {
                        var limit = MAX_MATCHES - total - batch.length + 1;   // one extra tells "1000+" from exactly 1000
                        batch = batch.concat(findIn(index, pageNumber, limit));
                    }, angular.noop /* a damaged page is skipped, like a page without text */).then(function () {
                        next(pageNumber + 1);
                    });
                })(first);
            }

            function searchPart(part) {
                if (pdfService.isLocal()) {
                    searchLocalPart(part, part.from);
                } else {
                    searchWebPart(part, part.from);
                }
            }

            searchPart(parts[0]);
            return { cancel: function () { cancelled = true; } };
        }

        return {
            MAX_MATCHES: MAX_MATCHES,
            MAX_QUERY_LENGTH: MAX_QUERY_LENGTH,
            KINDS: KINDS,
            patternFor: patternFor,
            normalizeQuery: normalizeQuery,
            start: start
        };
    }]);
})();
