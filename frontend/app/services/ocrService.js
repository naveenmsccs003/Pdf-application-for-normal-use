(function () {
    'use strict';

    /**
     * Text recognition (OCR) for scanned pages, with Tesseract (tesseract.js, bundled in lib/tesseract: the
     * engine runs in a web worker in the browser / app window, nothing is sent anywhere).
     *
     * A page is drawn at up to 300 dpi (at most 16.7 million pixels, so large sheets get less) and read with
     * Tesseract's automatic page layout, which also reads vertical text such as dimensions along a wall.
     * Words below MIN_CONFIDENCE (mostly linework read as dashes) are dropped. Pages that already have their
     * own text are skipped: they are searchable without OCR.
     *
     * The result of a page is kept for the open document: { words: [{ text, x, y, width, height, confidence,
     * vertical }], lines: [string], skipped } in PDF units at scale 1 (top-left origin, displayed orientation),
     * the same units as search matches and highlights. searchService searches recognised pages through
     * indexFor(), so Find, Drawing no., Beam, Column, Dimensions and Annotations work on scanned drawings.
     */
    angular.module('pdfViewerApp').factory('ocrService', ['$http', '$q', 'pdfService', function ($http, $q, pdfService) {
        var LIB = 'lib/tesseract';
        var DPI = 300;
        var MAX_PIXELS = 16777216;      // same limit as page renders (pdfService, desktop host)
        var MIN_CONFIDENCE = 50;        // Tesseract's 0-100 word confidence
        var MIN_PAGE_CHARS = 20;        // a page with this many characters of its own text is not scanned
        var HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

        var state = { doc: null, pages: {}, indexes: {} };
        var worker = null;              // promise of the Tesseract worker, created on first use
        var workerProgress = angular.noop;
        var ENGINE_FAILED = 'Text recognition could not start (lib/tesseract is missing or blocked).';
        var running = null;             // the job in progress: { cancelled }

        function current() {
            var doc = pdfService.currentDocument();
            if (state.doc !== doc) { state = { doc: doc, pages: {}, indexes: {} }; }
            return state;
        }

        function getWorker(onProgress) {
            workerProgress = onProgress;
            if (!worker) {
                worker = $q.when(Tesseract.createWorker('eng', 1 /* LSTM only */, {
                    workerPath: LIB + '/worker.min.js',
                    corePath: LIB,
                    langPath: LIB,
                    workerBlobURL: false,       // a worker from 'self' (Content-Security-Policy)
                    cacheMethod: 'none',        // the language file is local anyway
                    logger: function (m) { workerProgress(m); }
                })).then(function (w) {
                    return $q.when(w.setParameters({
                        tessedit_pageseg_mode: '3',     // automatic page layout (finds vertical text too)
                        user_defined_dpi: String(DPI),
                        preserve_interword_spaces: '1'
                    })).then(function () { return w; });
                });
                worker = worker.catch(function () {
                    worker = null;
                    return $q.reject(ENGINE_FAILED);
                });
            }
            return worker;
        }

        /** Stops the worker (the only way to stop Tesseract in the middle of a page). */
        function stopWorker() {
            var w = worker;
            worker = null;
            if (w) { w.then(function (instance) { instance.terminate(); }, angular.noop); }
        }

        /** The page's own text: pdf.js on the web, PDFium on desktop. */
        function nativeText(pageNumber) {
            if (pdfService.isLocal()) {
                return $http.get('api/local/' + pdfService.localToken() + '/pages/' + pageNumber + '/text')
                    .then(function (response) { return response.data.text || ''; });
            }
            return pdfService.getPageText(pageNumber).then(function (content) {
                return content.items.map(function (item) { return item.str + (item.hasEOL ? '\n' : ''); }).join('');
            });
        }

        function hasOwnText(text) {
            return text.replace(/\s+/g, '').length >= MIN_PAGE_CHARS;
        }

        /** The page drawn on white at up to DPI; resolves with { canvas, scale } (pixels per PDF unit). */
        function drawPage(pageNumber) {
            return pdfService.getPageSize(pageNumber).then(function (size) {
                var scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
                var w = Math.max(1, Math.floor(size.width * scale)), h = Math.max(1, Math.floor(size.height * scale));
                var dpr = window.devicePixelRatio || 1;
                return pdfService.renderThumbnail(pageNumber, w / dpr, h / dpr).then(function (rendered) {
                    if (!rendered) { return $q.reject('The document was closed.'); }
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(rendered, 0, 0, w, h);
                    return { canvas: canvas, scale: scale };
                });
            });
        }

        /** Tesseract's blocks as words (PDF units) and lines of text, without unsure words. */
        function readResult(data, scale) {
            var words = [], lines = [];
            (data.blocks || []).forEach(function (block) {
                (block.paragraphs || []).forEach(function (paragraph) {
                    (paragraph.lines || []).forEach(function (line) {
                        var kept = [], lineNumber = lines.length;
                        (line.words || []).forEach(function (w) {
                            var text = (w.text || '').trim();
                            if (!text || w.confidence < MIN_CONFIDENCE || !HAS_WORD_CHAR.test(text)) { return; }
                            var b = w.bbox;
                            var width = (b.x1 - b.x0) / scale, height = (b.y1 - b.y0) / scale;
                            words.push({
                                text: text, x: b.x0 / scale, y: b.y0 / scale, width: width, height: height,
                                confidence: Math.round(w.confidence), line: lineNumber,
                                vertical: text.length > 1 && height > width * 1.2   // read from bottom to top
                            });
                            kept.push(text);
                        });
                        if (kept.length) { lines.push(kept.join(' ')); }
                    });
                    if (lines.length && lines[lines.length - 1] !== '') { lines.push(''); }   // paragraphs apart
                });
            });
            while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
            return { words: words, lines: lines };
        }

        function recognizePage(pageNumber, job, onProgress) {
            var s = current();
            if (s.pages[pageNumber]) { return $q.when(s.pages[pageNumber]); }   // read before (or has its own text)
            return nativeText(pageNumber).then(function (text) {
                if (hasOwnText(text)) { return { skipped: true }; }
                return drawPage(pageNumber).then(function (drawn) {
                    if (job.cancelled) { return $q.reject('cancelled'); }
                    return getWorker(function (m) {
                        if (m.status === 'recognizing text') { onProgress(m.progress); }
                    }).then(function (w) {
                        return $q.when(w.recognize(drawn.canvas, {}, { blocks: true, text: false }));
                    }).then(function (result) {
                        return readResult(result.data, drawn.scale);
                    });
                });
            }).then(function (page) {
                if (job.cancelled) { return $q.reject('cancelled'); }
                if (s === state) {
                    s.pages[pageNumber] = page;
                    delete s.indexes[pageNumber];
                }
                return page;
            });
        }

        /**
         * Recognises the pages one after another. onProgress({ page, index, count, progress }) reports the page
         * being read and how far (0-1). Resolves with { recognized, skipped, words, failed } (page counts, words
         * found); rejects with 'cancelled' after cancel(). Pages read before stay recognised.
         */
        function recognize(pages, onProgress) {
            cancel();
            var job = { cancelled: false };
            running = job;
            var doc = pdfService.currentDocument();
            var summary = { recognized: 0, skipped: 0, words: 0, failed: 0 };
            var i = 0;
            function next() {
                if (job.cancelled || pdfService.currentDocument() !== doc) { return $q.reject('cancelled'); }
                if (i >= pages.length) { return $q.when(summary); }
                var pageNumber = pages[i];
                var report = function (progress) { onProgress({ page: pageNumber, index: i, count: pages.length, progress: progress || 0 }); };
                report(0);
                return recognizePage(pageNumber, job, report).then(function (page) {
                    if (page.skipped) { summary.skipped++; } else { summary.recognized++; summary.words += page.words.length; }
                }, function (error) {
                    if (error === 'cancelled' || job.cancelled) { return $q.reject('cancelled'); }
                    if (error === ENGINE_FAILED) { return $q.reject(error); }
                    summary.failed++;
                }).then(function () { i++; return next(); });
            }
            return next().finally(function () { if (running === job) { running = null; } });
        }

        function cancel() {
            if (!running) { return; }
            running.cancelled = true;
            running = null;
            stopWorker();
        }

        // ----- Search index of a recognised page (the shape searchService uses) -----
        // The words joined with a space, lines with '\n'; map[i] = [word, character] for each position (null between words).
        function buildIndex(page) {
            var chars = [], map = [];
            page.words.forEach(function (word, w) {
                if (chars.length) { chars.push(word.line === page.words[w - 1].line ? ' ' : '\n'); map.push(null); }
                for (var k = 0; k < word.text.length; k++) { chars.push(word.text[k]); map.push([w, k]); }
            });
            var text = chars.join('');
            return {
                text: text,
                lower: chars.map(function (c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; }).join(''),
                map: map,
                // Characters [start, end) of a word: an even share of its box each.
                rect: function (w, start, end) {
                    var word = page.words[w], n = word.text.length;
                    if (word.vertical) {
                        var bottom = word.y + word.height;
                        return { x: word.x, y: bottom - word.height * end / n, width: word.width, height: word.height * (end - start) / n };
                    }
                    return { x: word.x + word.width * start / n, y: word.y, width: word.width * (end - start) / n, height: word.height };
                }
            };
        }

        /** The search index of a recognised page, or null if it was not recognised (or had its own text). */
        function indexFor(pageNumber) {
            var s = current();
            var page = s.pages[pageNumber];
            if (!page || page.skipped) { return null; }
            return s.indexes[pageNumber] || (s.indexes[pageNumber] = buildIndex(page));
        }

        /** Page numbers recognised by OCR in the open document, in order. */
        function recognizedPages() {
            var s = current();
            return Object.keys(s.pages).map(Number).filter(function (n) { return !s.pages[n].skipped; }).sort(function (a, b) { return a - b; });
        }

        /** A recognised page's words, or null. */
        function wordsOf(pageNumber) {
            var page = current().pages[pageNumber];
            return page && !page.skipped ? page.words : null;
        }

        /** The page's text: recognised lines for a scanned page, otherwise its own text. */
        function pageText(pageNumber) {
            var page = current().pages[pageNumber];
            if (page && !page.skipped) { return $q.when({ text: page.lines.join('\n'), recognized: true }); }
            return nativeText(pageNumber).then(function (text) {
                return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\r\n?/g, '\n').trim(), recognized: false };
            });
        }

        return {
            DPI: DPI,
            recognize: recognize,
            cancel: cancel,
            isRunning: function () { return !!running; },
            indexFor: indexFor,
            recognizedPages: recognizedPages,
            wordsOf: wordsOf,
            isRecognized: function (pageNumber) { return !!wordsOf(pageNumber); },
            pageText: pageText
        };
    }]);
})();
