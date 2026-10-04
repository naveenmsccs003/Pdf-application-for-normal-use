(function () {
    'use strict';

    // SVG of one markup (inside a <g ng-repeat="m in ..."> in PDF units); shared by the page and the continuous view.
    var MARKUP_SHAPE =
        '        <path ng-if="shape(m).area" class="markup-area" ng-attr-d="{{ shape(m).area }}" ng-attr-fill="{{ m.color }}" stroke="none"></path>' +
        '        <path ng-attr-d="{{ shape(m).outline }}" ng-attr-fill="{{ shape(m).fill }}"></path>' +
        '        <path ng-if="shape(m).iconLines" ng-attr-d="{{ shape(m).iconLines }}" stroke="#ffffff" fill="none"' +
        '              ng-attr-stroke-width="{{ m.width / 12 }}"></path>' +
        '        <path ng-if="shape(m).leader" ng-attr-d="{{ shape(m).leader }}" fill="none"></path>' +
        '        <rect ng-if="shape(m).label" class="markup-label" ng-attr-x="{{ shape(m).label.x }}" ng-attr-y="{{ shape(m).label.y }}"' +
        '              ng-attr-width="{{ shape(m).label.width }}" ng-attr-height="{{ shape(m).label.height }}" stroke="none"></rect>' +
        '        <text ng-if="shape(m).lines" ng-attr-font-size="{{ m.fontSize }}" ng-attr-fill="{{ m.color }}" stroke="none">' +
        '          <tspan ng-repeat="l in shape(m).lines track by $index" ng-attr-x="{{ l.x }}" ng-attr-y="{{ l.y }}">{{ l.text }}</tspan>' +
        '        </text>';

    /**
     * Displays the current PDF page using stacked layers:
     *   1. canvas layer       - PDF rendering (pdfService), never modified
     *   2. search layer       - find matches (FindController), positioned from PDF-unit coordinates
     *   3. interaction layer  - mouse/touch input: pan (drag the page), draw and select markups
     *   4. highlight layer    - transparent highlight overlay, positioned from PDF-unit coordinates
     *   5. markup layer       - SVG shapes, lines, notes and measurements (markupGeometry), drawn in PDF units
     *
     * View modes: 'single' shows one page at a time. 'continuous' stacks the pages one below the other: the current
     * page (the one filling most of the view) is the full page above; the others are images with their markups,
     * rendered as they scroll into view, and a click makes one current. Only a window of pages around the current
     * one is laid out, so huge documents stay within the browser's size limits.
     */
    angular.module('pdfViewerApp').directive('pdfViewer', ['pdfService', 'markupGeometry', 'scaleService', 'VIEWER_CONFIG',
        function (pdfService, markupGeometry, scaleService, VIEWER_CONFIG) {
            var MIN_HIGHLIGHT_PX = 4;       // smaller drags count as a click
            var MIN_PEN_STEP_PX = 1.5;      // freehand: points closer than this are skipped
            var MAX_PEN_POINTS = 5000;
            var SELECT_TOLERANCE_PX = 6;    // how close a click must be to a line to select it
            var CLOSE_POLYGON_PX = 8;       // area / perimeter: a click this close to the first corner finishes
            var MIN_CORNER_STEP_PX = 3;     // area / perimeter: clicks closer than this to the last corner are ignored
            var MAX_CORNERS = 500;
            var LINE_TOOLS = { line: true, arrow: true, distance: true, hdistance: true, vdistance: true, calibrate: true, perpendicular: true };
            var MAX_COUNT = 200;            // items in one count
            var POLYGON_TOOLS = { area: true, perimeter: true };
            var TEXT_MARK_TOOLS = { strikeout: true, underline: true, replace: true };   // drawn over text like a highlight
            var MIN_PAN_PX = 3;             // smaller mouse movements while panning count as a click
            var RESIZE_DEBOUNCE_MS = 150;
            var PAGE_GAP = 12;              // continuous view: px between pages
            var WINDOW_PAGES = 100;         // continuous view: pages laid out before and after the current one
            var OVERSCAN_PX = 800;          // continuous view: pages this far outside the view are drawn too
            var MAX_SLOT_PIXELS = 8000000;  // continuous view: device pixels of one page image; larger ones are stretched
            var KEEP_IMAGES = 24;           // continuous view: page images kept for scrolling back

            return {
                restrict: 'E',
                scope: {
                    docVersion: '<',
                    pageCount: '<',
                    viewMode: '<',          // 'single' | 'continuous'
                    page: '<',
                    scale: '<',
                    tool: '<',              // 'pan', or a markup type to draw
                    markupColor: '<',
                    highlights: '<',        // all markups
                    selectedId: '<',
                    searchMatches: '<',
                    activeMatch: '<',
                    api: '=',
                    onCreateMarkup: '&',
                    onRequestText: '&',     // text note / callout: the host asks for the text
                    onCalibrate: '&',       // scale calibration: a line of known length was drawn
                    onMoveMarkup: '&',      // the selected markup was dragged: (id, markup) is the moved copy
                    onEditMarkup: '&',      // a markup was double-clicked
                    onPlaceTag: '&',        // revision tag tool: (pageNumber, at) where the page was clicked
                    revision: '<',          // revision compare: { page, mode: 'diff' | 'overlay', url, regions, active }
                    onSelectHighlight: '&',
                    onRemoveHighlight: '&',
                    onResize: '&',
                    onRendered: '&',
                    onPageChange: '&',      // continuous view: (page) now fills most of the view, or was clicked
                    onRenderError: '&'
                },
                template:
                    '<div class="viewer-scroll" ng-class="{\'is-rendering\': rendering, \'is-continuous\': continuous}">' +
                    ' <div class="page-stack">' +
                    '  <div class="page-slot" ng-repeat="slot in slots track by slot.page" data-page="{{ slot.page }}"' +
                    '       ng-style="{top: slot.top + \'px\', left: slot.left + \'px\', width: slot.width + \'px\', height: slot.height + \'px\'}">' +
                    '    <div class="slot-canvas"></div>' +
                    '    <div class="slot-highlight" ng-repeat="h in highlights | filter:{pageNumber: slot.page, type: \'highlight\'}:true track by h.id"' +
                    '         ng-style="{left: h.x / slot.pw * 100 + \'%\', top: h.y / slot.ph * 100 + \'%\',' +
                    '                    width: h.width / slot.pw * 100 + \'%\', height: h.height / slot.ph * 100 + \'%\'}"></div>' +
                    '    <svg class="slot-markups" ng-attr-view_box="0 0 {{ slot.pw }} {{ slot.ph }}" preserveAspectRatio="none">' +
                    '      <g class="markup" ng-repeat="m in highlights | filter:{pageNumber: slot.page}:true track by m.id" ng-if="m.type !== \'highlight\'"' +
                    '         ng-attr-stroke="{{ m.color }}" ng-attr-stroke-width="{{ m.strokeWidth }}">' + MARKUP_SHAPE + '</g>' +
                    '    </svg>' +
                    '  </div>' +
                    '  <div class="pdf-page" ng-show="rendered.page && (!continuous || pagePlace())" ng-style="pageStyle()"' +
                    '       ng-class="{\'is-comparing\': revisionOn() && revision.mode === \'diff\'}">' +
                    '    <div class="canvas-layer"></div>' +
                    '    <img class="revision-image" ng-if="revisionOn()" ng-src="{{ revision.url }}" alt=""' +
                    '         ng-class="{\'is-overlay\': revision.mode === \'overlay\'}">' +
                    '    <div class="revision-regions" ng-if="revisionOn() && revision.mode === \'diff\'">' +
                    '      <div class="revision-region" ng-repeat="r in revision.regions track by $index" ng-class="{\'is-active\': $index === revision.active}"' +
                    '           ng-style="{left: r.x * rendered.scale + \'px\', top: r.y * rendered.scale + \'px\',' +
                    '                      width: r.width * rendered.scale + \'px\', height: r.height * rendered.scale + \'px\'}"></div>' +
                    '    </div>' +
                    '    <div class="search-layer">' +
                    '      <div class="search-hit" ng-repeat="r in pageHits track by $index" ng-class="{\'is-current\': r.current}"' +
                    '           ng-style="{left: r.x * rendered.scale + \'px\', top: r.y * rendered.scale + \'px\',' +
                    '                      width: r.width * rendered.scale + \'px\', height: r.height * rendered.scale + \'px\'}"></div>' +
                    '    </div>' +
                    '    <div class="interaction-layer" ng-class="{\'is-drawing\': drawing() && !spacePan, \'is-text\': (tool === \'text\') && !spacePan, \'is-pan\': !drawing() || spacePan}"></div>' +
                    '    <div class="highlight-layer">' +
                    '      <div class="highlight" ng-repeat="h in highlights | filter:{pageNumber: rendered.page, type: \'highlight\'}:true track by h.id"' +
                    '           ng-class="{\'is-selected\': h.id === selectedId}"' +
                    '           ng-style="{left: h.x * rendered.scale + \'px\', top: h.y * rendered.scale + \'px\',' +
                    '                      width: h.width * rendered.scale + \'px\', height: h.height * rendered.scale + \'px\'}">' +
                    '        <button type="button" class="highlight-remove" ng-if="h.id === selectedId"' +
                    '                title="Remove highlight" aria-label="Remove highlight"' +
                    '                ng-click="onRemoveHighlight({id: h.id})">&times;</button>' +
                    '      </div>' +
                    '      <div class="highlight is-draft ng-hide"></div>' +
                    '    </div>' +
                    '    <svg class="markup-layer" ng-attr-width="{{ rendered.width }}" ng-attr-height="{{ rendered.height }}"' +
                    '         ng-attr-view_box="0 0 {{ rendered.width / rendered.scale }} {{ rendered.height / rendered.scale }}">' +
                    '      <g class="markup" ng-repeat="m in highlights | filter:isShapeOnPage track by m.id" data-type="{{ m.type }}"' +
                    '         ng-attr-stroke="{{ m.color }}" ng-attr-stroke-width="{{ m.strokeWidth }}">' + MARKUP_SHAPE +
                    '      </g>' +
                    '      <path class="markup-draft" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>' +
                    '      <g class="markup-draft-label" display="none"><rect class="markup-label" stroke="none"></rect><text stroke="none"></text></g>' +
                    '    </svg>' +
                    '    <div class="comment-popup" ng-if="commentPopup()" ng-style="commentPopup().style">{{ commentPopup().text }}</div>' +
                    '    <div class="markup-selection" ng-if="selectedBox()" ng-style="selectedBox()">' +
                    '      <button type="button" class="highlight-remove" title="Remove markup" aria-label="Remove markup"' +
                    '              ng-click="onRemoveHighlight({id: selectedId})">&times;</button>' +
                    '    </div>' +
                    '  </div>' +
                    ' </div>' +
                    '</div>' +
                    '<div class="render-indicator" ng-show="rendering"><span class="spinner"></span></div>',
                link: function (scope, element) {
                    var scrollEl = element[0].querySelector('.viewer-scroll');
                    var canvasLayer = element[0].querySelector('.canvas-layer');
                    var interactionLayer = element[0].querySelector('.interaction-layer');
                    var draftEl = element[0].querySelector('.is-draft');

                    // What is currently on screen. Highlights use this (not the requested scale)
                    // so they never drift from the canvas while a new render is in progress.
                    scope.rendered = { page: 0, scale: 1, width: 0, height: 0 };

                    var renderSeq = 0;

                    function render() {
                        if (!scope.page || !scope.scale || !scope.docVersion) {
                            return;
                        }
                        var seq = ++renderSeq;
                        var page = scope.page;
                        var scale = scope.scale;
                        var pageChanged = page !== scope.rendered.page;
                        scope.rendering = true;

                        pdfService.renderPage(page, scale).then(function (result) {
                            if (!result || seq !== renderSeq) {
                                return; // superseded by a newer render
                            }
                            scope.rendering = false;
                            canvasLayer.innerHTML = '';
                            canvasLayer.appendChild(result.canvas);
                            scope.rendered = { page: page, scale: scale, width: result.width, height: result.height };
                            if (pageChanged && !scope.continuous) {
                                scrollEl.scrollTop = 0;
                            }
                            scope.onRendered({ page: page });
                        }, function () {
                            if (seq === renderSeq) {
                                scope.rendering = false;
                                scope.onRenderError();
                            }
                        });
                    }

                    scope.$watchGroup(['docVersion', 'page', 'scale'], function (newValues, oldValues) {
                        if (newValues[0] !== oldValues[0]) {
                            // New document: forget the previous one's page.
                            scope.rendered = { page: 0, scale: 1, width: 0, height: 0 };
                            scope.rendering = false;
                            canvasLayer.innerHTML = '';
                        }
                        render();
                    });

                    // ----- Continuous view -----
                    var stackEl = element[0].querySelector('.page-stack');
                    var pad = VIEWER_CONFIG.pagePadding;
                    var sizes = {};             // page -> { width, height } in PDF units, for the open document
                    var knownSize = null;       // used for pages whose size is not known yet
                    var images = {};            // page -> { scale, canvas }: pages drawn as images
                    var imageSeq = 0;
                    var drawing = {};           // page -> true while its image is being drawn
                    var reported = 0;           // the page this view made current (scrolling or a click)
                    var attachQueued = false;
                    var layout = null;          // { first, last, scale, slots: [...], width, height }
                    scope.continuous = false;
                    scope.slots = [];           // the laid-out pages near the view (in the DOM)

                    function slotOf(page) {
                        return layout && page >= layout.first && page <= layout.last ? layout.slots[page - layout.first] : null;
                    }

                    /** Where the full current page sits: on its slot (continuous view), else nothing (normal flow). */
                    scope.pagePlace = function () { return slotOf(scope.rendered.page); };

                    scope.pageStyle = function () {
                        var style = { width: scope.rendered.width + 'px', height: scope.rendered.height + 'px' };
                        var slot = scope.continuous && slotOf(scope.rendered.page);
                        if (slot) {
                            style.position = 'absolute';
                            style.top = slot.top + 'px';
                            style.left = Math.round(slot.left + (slot.width - scope.rendered.width) / 2) + 'px';
                        }
                        return style;
                    };

                    function sizeOf(page) { return sizes[page] || knownSize || { width: 612, height: 792 }; }

                    /** Lays out the pages around `center`. Keeps what is at the top of the view where it is. */
                    function relayout(center) {
                        var anchor = topAnchor();
                        var count = scope.pageCount || 0;
                        var scale = scope.scale || 1;
                        var first = Math.max(1, center - WINDOW_PAGES), last = Math.min(count, center + WINDOW_PAGES);
                        var slots = [], top = 0, widest = 0;
                        for (var p = first; p <= last; p++) {
                            var size = sizeOf(p);
                            var slot = { page: p, top: top, width: Math.floor(size.width * scale), height: Math.floor(size.height * scale),
                                         pw: size.width, ph: size.height };
                            slots.push(slot);
                            top += slot.height + PAGE_GAP;
                            widest = Math.max(widest, slot.width);
                        }
                        var width = Math.max(widest, scrollEl.clientWidth - 2 * pad);
                        slots.forEach(function (slot) { slot.left = Math.floor((width - slot.width) / 2); });
                        var oldWidth = layout ? layout.width : width;
                        layout = { first: first, last: last, scale: scale, slots: slots, width: width, height: Math.max(0, top - PAGE_GAP) };
                        // The size is set now, not in the next digest, so the scroll position below is not cut short.
                        stackEl.style.width = width + 'px';
                        stackEl.style.height = layout.height + 'px';
                        var centerX = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
                        scrollEl.scrollLeft = centerX * width / oldWidth - scrollEl.clientWidth / 2;
                        var slotAt = anchor && slotOf(anchor.page);
                        if (slotAt) {
                            scrollEl.scrollTop = pad + slotAt.top + anchor.offset * scale;
                        } else {
                            scrollToPage(center);
                        }
                        showVisible();
                    }

                    /** The page at the top of the view and how far into it (PDF units), to keep it there. */
                    function topAnchor() {
                        if (!layout) { return null; }
                        var y = scrollEl.scrollTop - pad;
                        for (var i = 0; i < layout.slots.length; i++) {
                            var slot = layout.slots[i];
                            if (y < slot.top + slot.height + PAGE_GAP) {
                                return { page: slot.page, offset: Math.max(-PAGE_GAP, y - slot.top) / layout.scale };
                            }
                        }
                        return null;
                    }

                    function scrollToPage(page) {
                        var slot = slotOf(page);
                        if (slot) { scrollEl.scrollTop = pad + slot.top - Math.min(pad, PAGE_GAP); }
                    }

                    /** Puts the pages near the view in the DOM, makes the page filling most of it current, draws images. */
                    function showVisible() {
                        if (!layout) { return; }
                        var top = scrollEl.scrollTop - pad, bottom = top + scrollEl.clientHeight;
                        var near = [], best = null, bestSeen = -1;
                        layout.slots.forEach(function (slot) {
                            if (slot.top + slot.height < top - OVERSCAN_PX || slot.top > bottom + OVERSCAN_PX) { return; }
                            near.push(slot);
                            var seen = Math.min(bottom, slot.top + slot.height) - Math.max(top, slot.top);
                            if (seen > bestSeen + 1) { best = slot; bestSeen = seen; }
                        });
                        if (near.length !== scope.slots.length || near[0] !== scope.slots[0]) { scope.slots = near; }
                        loadSizes(near);
                        if (best && best.page !== scope.page) {
                            reported = best.page;
                            scope.onPageChange({ page: best.page });
                        }
                        // Near the end of the laid-out window: lay out the pages further on.
                        var current = best ? best.page : scope.page;
                        if ((current - layout.first < WINDOW_PAGES / 4 && layout.first > 1) ||
                            (layout.last - current < WINDOW_PAGES / 4 && layout.last < scope.pageCount)) {
                            relayout(current);
                            return;
                        }
                        if (!attachQueued) {
                            attachQueued = true;
                            scope.$$postDigest(function () { attachQueued = false; attachImages(); });
                        }
                        drawImages();
                    }

                    // Sizes of pages coming into view (until then a page is laid out with a guessed size).
                    var loadingSizes = {};
                    function loadSizes(slots) {
                        var docAtStart = scope.docVersion;
                        slots.forEach(function (slot) {
                            if (sizes[slot.page] || loadingSizes[slot.page]) { return; }
                            loadingSizes[slot.page] = true;
                            pdfService.getPageSize(slot.page).then(function (size) {
                                delete loadingSizes[slot.page];
                                if (scope.docVersion !== docAtStart) { return; }
                                sizes[slot.page] = size;
                                knownSize = knownSize || size;
                                // Lay out again (a different size than guessed) and draw the page, now that its size is known.
                                if (scope.continuous) { scheduleRelayout(); }
                            }, function () { delete loadingSizes[slot.page]; });
                        });
                    }

                    var relayoutPending = false;
                    function scheduleRelayout() {
                        if (relayoutPending) { return; }
                        relayoutPending = true;
                        setTimeout(function () {
                            relayoutPending = false;
                            if (scope.continuous && layout) { scope.$apply(function () { relayout(scope.page); }); }
                        }, 30);
                    }

                    /** Draws the nearby pages as images, nearest to the current page first, one at a time. */
                    function drawImages() {
                        var seq = ++imageSeq, docAtStart = scope.docVersion, scale = layout.scale;
                        var todo = scope.slots.filter(function (slot) {
                            var image = images[slot.page];
                            return sizes[slot.page] && !drawing[slot.page] && !(image && image.scale === scale);
                        }).sort(function (a, b) { return Math.abs(a.page - scope.page) - Math.abs(b.page - scope.page); });
                        var dpr = window.devicePixelRatio || 1;
                        (function next() {
                            if (seq !== imageSeq || !todo.length) { return; }
                            var slot = todo.shift();
                            var pixels = slot.width * slot.height * dpr * dpr;
                            var shrink = pixels > MAX_SLOT_PIXELS ? Math.sqrt(MAX_SLOT_PIXELS / pixels) : 1;
                            drawing[slot.page] = true;
                            pdfService.renderThumbnail(slot.page, slot.width * shrink, slot.height * shrink).then(function (canvas) {
                                delete drawing[slot.page];
                                if (!canvas || scope.docVersion !== docAtStart) { return; }
                                images[slot.page] = { scale: scale, canvas: canvas };
                                attachImages();
                                next();
                            }, function () {
                                delete drawing[slot.page];
                                next();
                            });
                        })();
                    }

                    /** Puts each drawn image into its page's slot; forgets images far from the view. */
                    function attachImages() {
                        var shown = {};
                        Array.prototype.forEach.call(stackEl.querySelectorAll('.page-slot'), function (el) {
                            var page = Number(el.getAttribute('data-page'));
                            var image = images[page];
                            shown[page] = true;
                            var holder = el.firstElementChild;
                            if (image && holder.firstChild !== image.canvas) {
                                holder.innerHTML = '';
                                holder.appendChild(image.canvas);
                            }
                        });
                        var pages = Object.keys(images).map(Number);
                        if (pages.length > KEEP_IMAGES) {
                            pages.filter(function (p) { return !shown[p]; })
                                .sort(function (a, b) { return Math.abs(b - scope.page) - Math.abs(a - scope.page); })
                                .slice(0, pages.length - KEEP_IMAGES)
                                .forEach(function (p) { delete images[p]; });
                        }
                    }

                    var scrollFrame = 0;
                    scrollEl.addEventListener('scroll', function () {
                        if (!scope.continuous || scrollFrame) { return; }
                        scrollFrame = requestAnimationFrame(function () {
                            scrollFrame = 0;
                            scope.$apply(showVisible);
                        });
                    });

                    function enterContinuous() {
                        var page = scope.page;
                        // Keep the place on the page.
                        var into = scope.rendered.page === page ? Math.max(0, scrollEl.scrollTop - pad) / (scope.rendered.scale || 1) : 0;
                        scope.continuous = true;
                        reported = page;
                        pdfService.getPageSize(page).then(function (size) {
                            if (!scope.continuous) { return; }
                            sizes[page] = size;
                            knownSize = knownSize || size;
                            layout = null;
                            relayout(page);
                            var slot = slotOf(page);
                            if (slot && into > 0) {
                                scrollEl.scrollTop = pad + slot.top + into * layout.scale;
                                showVisible();
                            }
                        });
                    }

                    function leaveContinuous() {
                        var anchor = topAnchor();
                        scope.continuous = false;
                        layout = null;
                        scope.slots = [];
                        stackEl.style.width = stackEl.style.height = '';
                        imageSeq++;
                        // The same place on the page.
                        setTimeout(function () {
                            scrollEl.scrollTop = anchor && anchor.page === scope.rendered.page ? Math.max(0, anchor.offset * scope.rendered.scale) : 0;
                        });
                    }

                    function resetContinuous() {
                        sizes = {};
                        knownSize = null;
                        images = {};
                        drawing = {};
                        loadingSizes = {};
                        imageSeq++;
                        layout = null;
                        scope.slots = [];
                        reported = 0;
                    }

                    scope.$watch('viewMode', function (mode) {
                        if (mode === 'continuous' && !scope.continuous && scope.docVersion && scope.page) {
                            enterContinuous();
                        } else if (mode !== 'continuous' && scope.continuous) {
                            leaveContinuous();
                        }
                    });

                    // New document: start over; page turned elsewhere (buttons, keys, thumbnails): scroll to it;
                    // new zoom: keep the place in view.
                    scope.$watchGroup(['docVersion', 'page', 'scale', 'pageCount'], function (now, before) {
                        if (now[0] !== before[0]) {
                            resetContinuous();
                            if (scope.continuous) { scope.continuous = false; }
                            if (scope.viewMode === 'continuous' && now[1]) { enterContinuous(); }
                            return;
                        }
                        if (!scope.continuous || !layout) { return; }
                        if (now[1] !== before[1] && now[1] !== reported) {
                            // Turned to a page: show its top (a fit mode may have changed the zoom with it).
                            reported = now[1];
                            layout = null;
                            relayout(now[1]);
                        } else if (now[2] !== before[2] || now[3] !== before[3]) {
                            relayout(scope.page);
                        }
                    });

                    // A click on a page drawn as an image makes it the current page; a drag pans.
                    var slotPan = null;
                    stackEl.addEventListener('pointerdown', function (event) {
                        var slotEl = event.target.closest && event.target.closest('.page-slot');
                        if (!slotEl || !(event.button === 0 || event.button === 1) || event.pointerType === 'touch') { return; }
                        slotPan = { page: Number(slotEl.getAttribute('data-page')), x: event.clientX, y: event.clientY,
                                    left: scrollEl.scrollLeft, top: scrollEl.scrollTop, moved: false, el: slotEl };
                        slotEl.setPointerCapture(event.pointerId);
                        slotEl.classList.add('is-panning');
                        event.preventDefault();
                    });
                    stackEl.addEventListener('pointermove', function (event) {
                        if (!slotPan) { return; }
                        var dx = event.clientX - slotPan.x, dy = event.clientY - slotPan.y;
                        if (!slotPan.moved && Math.abs(dx) < MIN_PAN_PX && Math.abs(dy) < MIN_PAN_PX) { return; }
                        slotPan.moved = true;
                        scrollEl.scrollLeft = slotPan.left - dx;
                        scrollEl.scrollTop = slotPan.top - dy;
                    });
                    function endSlotPan(event, cancelled) {
                        if (!slotPan) { return; }
                        var p = slotPan;
                        slotPan = null;
                        p.el.classList.remove('is-panning');
                        if (!cancelled && !p.moved && p.page !== scope.page) {
                            reported = p.page;
                            scope.$apply(function () { scope.onPageChange({ page: p.page }); });
                        }
                    }
                    stackEl.addEventListener('pointerup', function (event) { endSlotPan(event, false); });
                    stackEl.addEventListener('pointercancel', function (event) { endSlotPan(event, true); });

                    // ----- Find matches -----
                    // The rectangles of the matches on the page on screen; the current match is scrolled into view.
                    scope.pageHits = [];

                    function updateHits() {
                        var hits = [];
                        (scope.searchMatches || []).forEach(function (match) {
                            if (match.pageNumber !== scope.rendered.page) { return; }
                            match.rects.forEach(function (r) {
                                hits.push({ x: r.x, y: r.y, width: r.width, height: r.height, current: match === scope.activeMatch });
                            });
                        });
                        scope.pageHits = hits;
                    }

                    function scrollToActiveMatch() {
                        var match = scope.activeMatch;
                        if (!match || match.pageNumber !== scope.rendered.page) { return; }
                        scrollIntoView(match.rects);
                    }

                    /** Scrolls the area around the rects (PDF units) into view, if it is not already. */
                    function scrollIntoView(rects) {
                        // After the page's new size is in the DOM.
                        setTimeout(function () {
                            var pageEl = element[0].querySelector('.pdf-page');
                            var s = scope.rendered.scale;
                            var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
                            rects.forEach(function (r) {
                                x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
                                x2 = Math.max(x2, r.x + r.width); y2 = Math.max(y2, r.y + r.height);
                            });
                            var pageBox = pageEl.getBoundingClientRect();
                            var scrollBox = scrollEl.getBoundingClientRect();
                            var top = pageBox.top - scrollBox.top + scrollEl.scrollTop + y1 * s;
                            var left = pageBox.left - scrollBox.left + scrollEl.scrollLeft + x1 * s;
                            var margin = 40;
                            if (top < scrollEl.scrollTop + margin || top + (y2 - y1) * s > scrollEl.scrollTop + scrollEl.clientHeight - margin) {
                                scrollEl.scrollTop = top - scrollEl.clientHeight / 3;
                            }
                            if (left < scrollEl.scrollLeft + margin || left + (x2 - x1) * s > scrollEl.scrollLeft + scrollEl.clientWidth - margin) {
                                scrollEl.scrollLeft = left - scrollEl.clientWidth / 3;
                            }
                        });
                    }

                    // Revision compare: scroll to the change picked with Previous / Next change.
                    scope.revisionOn = function () {
                        return !!(scope.revision && scope.revision.url && scope.revision.page === scope.rendered.page);
                    };
                    scope.$watchGroup(['revision.active', 'revision.page', 'rendered.page'], function () {
                        var r = scope.revision;
                        if (scope.revisionOn() && r.active >= 0 && r.regions[r.active]) { scrollIntoView([r.regions[r.active]]); }
                    });

                    scope.$watchCollection('searchMatches', updateHits);
                    scope.$watchGroup(['activeMatch', 'rendered.page'], function () {
                        updateHits();
                        scrollToActiveMatch();
                    });

                    // ----- API used by the controller for Fit Page / Fit Width -----
                    scope.api = {
                        getAvailableSize: function () {
                            var padding = VIEWER_CONFIG.pagePadding * 2;
                            return {
                                width: Math.max(scrollEl.clientWidth - padding, 50),
                                height: Math.max(scrollEl.clientHeight - padding, 50)
                            };
                        }
                    };

                    // ----- Resize handling (window resize, toolbar wrapping, device rotation) -----
                    var resizeTimer = null;
                    var lastSize = { width: scrollEl.clientWidth, height: scrollEl.clientHeight };
                    var resizeObserver = new ResizeObserver(function () {
                        if (scrollEl.clientWidth === lastSize.width && scrollEl.clientHeight === lastSize.height) {
                            return;
                        }
                        lastSize = { width: scrollEl.clientWidth, height: scrollEl.clientHeight };
                        clearTimeout(resizeTimer);
                        resizeTimer = setTimeout(function () {
                            scope.$apply(function () {
                                scope.onResize();
                                if (scope.continuous && layout) { relayout(scope.page); }
                            });
                        }, RESIZE_DEBOUNCE_MS);
                    });
                    resizeObserver.observe(scrollEl);

                    // ----- Markups on the page -----
                    var svgDraft = element[0].querySelector('.markup-draft');
                    var start = null;       // { point, markup } while drawing

                    scope.drawing = function () { return !!scope.tool && scope.tool !== 'pan'; };

                    scope.isShapeOnPage = function (m) {
                        return m.pageNumber === scope.rendered.page && m.type !== 'highlight';
                    };

                    // Markups do not change once drawn, so their SVG is computed once (measurements again
                    // when a scale changes, as their values do).
                    var shapes = {};
                    scope.shape = function (m) {
                        var cached = shapes[m.id];
                        if (cached && cached.markup === m && cached.scaleVersion === scaleService.version) { return cached; }
                        if (markupGeometry.isMeasure(m)) {
                            var label = markupGeometry.measureLabel(m);
                            cached = {
                                markup: m,
                                scaleVersion: scaleService.version,
                                outline: markupGeometry.path(m),
                                fill: 'none',
                                area: m.type === 'area' ? polylinePath(m.points) + 'Z' : null,
                                label: label,
                                lines: label.lines
                            };
                            shapes[m.id] = cached;
                            return cached;
                        }
                        if (m.type === 'revtag') {
                            cached = { markup: m, scaleVersion: scaleService.version, outline: markupGeometry.path(m), fill: '#ffffff',
                                       lines: markupGeometry.revtagLines(m) };
                            shapes[m.id] = cached;
                            return cached;
                        }
                        if (m.type === 'comment' || m.type === 'replace') {
                            var icon = m.type === 'comment' ? markupGeometry.commentIcon(m) : null;
                            var correction = m.type === 'replace' ? markupGeometry.replaceLabel(m) : null;
                            cached = {
                                markup: m,
                                scaleVersion: scaleService.version,
                                outline: icon ? icon.bubble : markupGeometry.path(m),
                                fill: icon ? m.color : 'none',
                                iconLines: icon ? icon.lines : null,
                                label: correction,
                                lines: correction ? correction.lines : null
                            };
                            shapes[m.id] = cached;
                            return cached;
                        }
                        var isNote = m.type === 'text' || m.type === 'callout';
                        cached = {
                            markup: m,
                            scaleVersion: scaleService.version,
                            outline: isNote ? markupGeometry.path({ type: 'rect', x: m.x, y: m.y, width: m.width, height: m.height }) : markupGeometry.path(m),
                            fill: isNote ? '#ffffff' : 'none',
                            leader: m.type === 'callout' ? markupGeometry.strokes(m).map(function (p) {
                                return p.reduce(function (d, v, k) { return d + (k % 2 ? ' ' + v : (k ? 'L' : 'M') + v); }, '');
                            }).join('') : null,
                            lines: isNote ? markupGeometry.textLayout(m) : null
                        };
                        shapes[m.id] = cached;
                        return cached;
                    };

                    // Dashed box around the selected markup (highlights show their own). The same object is
                    // returned while the box is unchanged: watchers compare by reference.
                    var lastBox = null;
                    scope.selectedBox = function () {
                        var m = selectedMarkup();
                        if (!m || m.type === 'highlight') { lastBox = null; return null; }
                        var b = markupGeometry.bounds(m), s = scope.rendered.scale, pad = 4;
                        var box = { left: b.x * s - pad + 'px', top: b.y * s - pad + 'px',
                                    width: b.width * s + 2 * pad + 'px', height: b.height * s + 2 * pad + 'px' };
                        if (!lastBox || lastBox.left !== box.left || lastBox.top !== box.top ||
                            lastBox.width !== box.width || lastBox.height !== box.height) {
                            lastBox = box;
                        }
                        return lastBox;
                    };

                    function polylinePath(p) {
                        return p.reduce(function (d, v, k) { return d + (k % 2 ? ' ' + v : (k ? 'L' : 'M') + v); }, '');
                    }

                    // The selected comment's text, next to its icon. Same object while unchanged (see selectedBox).
                    var lastPopup = null;
                    scope.commentPopup = function () {
                        var m = selectedMarkup();
                        if (!m || m.type !== 'comment') { lastPopup = null; return null; }
                        var s = scope.rendered.scale;
                        var left = (m.x + m.width) * s + 8 + 'px', top = m.y * s + 'px';
                        if (!lastPopup || lastPopup.text !== m.text || lastPopup.style.left !== left || lastPopup.style.top !== top) {
                            lastPopup = { text: m.text, style: { left: left, top: top } };
                        }
                        return lastPopup;
                    };

                    function selectedMarkup() {
                        var list = scope.highlights || [];
                        for (var i = 0; i < list.length; i++) {
                            if (list[i].id === scope.selectedId && list[i].pageNumber === scope.rendered.page) { return list[i]; }
                        }
                        return null;
                    }

                    function pointFromEvent(event) {
                        var rect = interactionLayer.getBoundingClientRect();
                        return {
                            x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
                            y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height)
                        };
                    }

                    function rectBetween(a, b) {
                        return {
                            x: Math.min(a.x, b.x),
                            y: Math.min(a.y, b.y),
                            width: Math.abs(a.x - b.x),
                            height: Math.abs(a.y - b.y)
                        };
                    }

                    var draftLabel = element[0].querySelector('.markup-draft-label');
                    function hideDraft() {
                        draftEl.classList.add('ng-hide');
                        svgDraft.removeAttribute('d');
                        draftLabel.setAttribute('display', 'none');
                    }

                    function pageSizes() {
                        var s = scope.rendered.scale;
                        return markupGeometry.sizesFor(scope.rendered.width / s, scope.rendered.height / s);
                    }

                    // Returns the topmost markup under a screen point on the current page.
                    function highlightAt(point) {
                        var s = scope.rendered.scale;
                        var list = scope.highlights || [];
                        for (var i = list.length - 1; i >= 0; i--) {
                            var m = list[i];
                            if (m.pageNumber === scope.rendered.page && markupGeometry.hits(m, point.x / s, point.y / s, SELECT_TOLERANCE_PX / s)) {
                                return m;
                            }
                        }
                        return null;
                    }

                    // ----- Pan: drag the page with the mouse to move around a zoomed-in drawing -----
                    // Pan is the default tool. With a markup tool, hold Space or use the middle button.
                    // Touch keeps the browser's own finger scrolling.
                    var pan = null;
                    scope.spacePan = false;

                    function wantsPan(event) {
                        if (event.button === 1) { return true; }
                        return event.button === 0 && event.pointerType !== 'touch' && (!scope.drawing() || scope.spacePan);
                    }

                    function onSpace(event) {
                        if (event.key !== ' ' && event.code !== 'Space') { return; }
                        var tag = event.target && event.target.tagName;
                        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') { return; }
                        var down = event.type === 'keydown';
                        if (down && scope.drawing()) { event.preventDefault(); }   // do not scroll the page instead
                        if (scope.spacePan !== down) {
                            scope.$evalAsync(function () { scope.spacePan = down; });
                        }
                    }
                    function onBlur() {
                        if (scope.spacePan) { scope.$evalAsync(function () { scope.spacePan = false; }); }
                    }
                    document.addEventListener('keydown', onSpace);
                    document.addEventListener('keyup', onSpace);
                    window.addEventListener('blur', onBlur);

                    // ----- Move: drag the selected markup with the Pan tool -----
                    var move = null;    // { id, origin, x, y, moved } while dragging a markup

                    function selectedUnder(event) {
                        if (scope.selectedId === null || scope.selectedId === undefined || scope.drawing()) { return null; }
                        var hit = highlightAt(pointFromEvent(event));
                        return hit && hit.id === scope.selectedId ? hit : null;
                    }

                    interactionLayer.addEventListener('pointerdown', function (event) {
                        if (!scope.rendered.page || event.button !== 0 || scope.spacePan) { return; }
                        var hit = selectedUnder(event);
                        if (!hit) { return; }
                        move = { id: hit.id, origin: hit, x: event.clientX, y: event.clientY, moved: false };
                        interactionLayer.setPointerCapture(event.pointerId);
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    });

                    interactionLayer.addEventListener('pointermove', function (event) {
                        if (!move) {
                            // Show that the selected markup can be dragged.
                            if (!pan && !start) { interactionLayer.classList.toggle('is-over-selected', !!selectedUnder(event)); }
                            return;
                        }
                        var dx = event.clientX - move.x, dy = event.clientY - move.y;
                        event.stopImmediatePropagation();
                        if (!move.moved && Math.abs(dx) < MIN_PAN_PX && Math.abs(dy) < MIN_PAN_PX) { return; }
                        move.moved = true;
                        var s = scope.rendered.scale, m = move;
                        scope.$apply(function () {
                            scope.onMoveMarkup({ id: m.id, markup: markupGeometry.translate(m.origin, dx / s, dy / s) });
                        });
                    });

                    function endMove(event) {
                        move = null;
                        event.stopImmediatePropagation();
                    }
                    interactionLayer.addEventListener('pointerup', function (event) { if (move) { endMove(event); } });
                    interactionLayer.addEventListener('pointercancel', function (event) { if (move) { endMove(event); } });

                    interactionLayer.addEventListener('pointerdown', function (event) {
                        if (!scope.rendered.page || !wantsPan(event)) { return; }
                        pan = { x: event.clientX, y: event.clientY, left: scrollEl.scrollLeft, top: scrollEl.scrollTop,
                                moved: false, click: event.button === 0 };
                        interactionLayer.setPointerCapture(event.pointerId);
                        interactionLayer.classList.add('is-panning');
                        event.preventDefault();     // no text selection, no middle-button autoscroll
                        if (document.activeElement && document.activeElement !== document.body) {
                            document.activeElement.blur();
                        }
                        event.stopImmediatePropagation();
                    });

                    interactionLayer.addEventListener('pointermove', function (event) {
                        if (!pan) { return; }
                        var dx = event.clientX - pan.x, dy = event.clientY - pan.y;
                        if (!pan.moved && Math.abs(dx) < MIN_PAN_PX && Math.abs(dy) < MIN_PAN_PX) { return; }
                        pan.moved = true;
                        scrollEl.scrollLeft = pan.left - dx;
                        scrollEl.scrollTop = pan.top - dy;
                        event.stopImmediatePropagation();
                    });

                    function endPan(event, cancelled) {
                        var p = pan;
                        pan = null;
                        interactionLayer.classList.remove('is-panning');
                        event.stopImmediatePropagation();
                        if (!cancelled && p.click && !p.moved) {
                            // A click without moving still selects a markup (or clears the selection).
                            var hit = highlightAt(pointFromEvent(event));
                            scope.$apply(function () { scope.onSelectHighlight({ id: hit ? hit.id : null }); });
                        }
                    }
                    interactionLayer.addEventListener('pointerup', function (event) { if (pan) { endPan(event, false); } });
                    interactionLayer.addEventListener('pointercancel', function (event) { if (pan) { endPan(event, true); } });
                    // Middle-button clicks must not open links or paste (Linux) on the page.
                    interactionLayer.addEventListener('auxclick', function (event) { if (event.button === 1) { event.preventDefault(); } });

                    // ----- Draw / select markups -----
                    // The markup being drawn, in PDF units, from the drag so far; null if too small yet.
                    function draftMarkup(from, to, event) {
                        var s = scope.rendered.scale;
                        var a = { x: from.x / s, y: from.y / s }, b = { x: to.x / s, y: to.y / s };
                        var sizes = markupGeometry.sizesFor(scope.rendered.width / s, scope.rendered.height / s);
                        var m = { type: scope.tool, color: scope.markupColor, strokeWidth: sizes.strokeWidth };
                        var minSize = MIN_HIGHLIGHT_PX / s;
                        switch (scope.tool) {
                            case 'highlight':
                            case 'rect':
                            case 'ellipse':
                            case 'cloud':
                                if (event && event.shiftKey && scope.tool !== 'highlight') {
                                    // Shift: square / circle.
                                    var side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
                                    b = { x: a.x + (b.x >= a.x ? side : -side), y: a.y + (b.y >= a.y ? side : -side) };
                                }
                                var r = rectBetween(a, b);
                                if (r.width < minSize || r.height < minSize) { return null; }
                                return angular.extend(m, r);
                            case 'strikeout':
                            case 'underline':
                            case 'replace':
                                var t = rectBetween(a, b);
                                if (t.width < minSize || t.height < minSize) { return null; }
                                // The line is a little thinner for small text.
                                return angular.extend(m, t, { strokeWidth: round2(Math.max(0.8, Math.min(t.height * 0.08, sizes.strokeWidth))) });
                            case 'line':
                            case 'arrow':
                            case 'distance':
                            case 'hdistance':
                            case 'vdistance':
                            case 'calibrate':
                            case 'perpendicular':
                                if (event && event.shiftKey && scope.tool !== 'hdistance' && scope.tool !== 'vdistance') {
                                    // Shift: snap to 45° steps (horizontal / vertical dimension lines).
                                    var angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
                                    var length = Math.hypot(b.x - a.x, b.y - a.y);
                                    b = { x: a.x + length * Math.cos(angle), y: a.y + length * Math.sin(angle) };
                                }
                                if (Math.hypot(b.x - a.x, b.y - a.y) < minSize) { return null; }
                                if (scope.tool === 'line' || scope.tool === 'arrow') {
                                    return angular.extend(m, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
                                }
                                if (scope.tool === 'perpendicular') {
                                    // The reference line; the point comes next (see perpendicular below).
                                    return angular.extend(m, { type: 'line', x1: round2(a.x), y1: round2(a.y), x2: round2(b.x), y2: round2(b.y) });
                                }
                                // Measurements (the calibration line is drawn as a distance).
                                if (scope.tool === 'hdistance' && Math.abs(b.x - a.x) < minSize) { return null; }
                                if (scope.tool === 'vdistance' && Math.abs(b.y - a.y) < minSize) { return null; }
                                return angular.extend(m, {
                                    type: scope.tool === 'calibrate' ? 'distance' : scope.tool,
                                    pageNumber: scope.rendered.page,
                                    fontSize: measureFontSize(sizes),
                                    points: [a.x, a.y, b.x, b.y].map(round2)
                                });
                            case 'callout':
                                // Drawn from the point to the place for the note; the leader is the draft.
                                if (Math.hypot(b.x - a.x, b.y - a.y) < minSize) { return null; }
                                return angular.extend(m, { type: 'arrow', x1: b.x, y1: b.y, x2: a.x, y2: a.y });
                            default:
                                return null;
                        }
                    }

                    function round2(v) { return Math.round(v * 100) / 100; }

                    function measureFontSize(sizes) { return Math.max(8, Math.round(sizes.fontSize * 0.8)); }

                    function showDraft(m) {
                        if (!m) { hideDraft(); return; }
                        var s = scope.rendered.scale;
                        if (m.type === 'highlight') {
                            draftEl.style.left = m.x * s + 'px';
                            draftEl.style.top = m.y * s + 'px';
                            draftEl.style.width = m.width * s + 'px';
                            draftEl.style.height = m.height * s + 'px';
                            draftEl.classList.remove('ng-hide');
                            return;
                        }
                        var d = markupGeometry.path(m);
                        if (TEXT_MARK_TOOLS[m.type]) {
                            // The box being marked, and where its line goes.
                            d += markupGeometry.path({ type: 'rect', x: m.x, y: m.y, width: m.width, height: m.height });
                        }
                        svgDraft.setAttribute('d', d);
                        svgDraft.setAttribute('stroke', m.color);
                        svgDraft.setAttribute('stroke-width', m.strokeWidth);
                        if (!markupGeometry.isMeasure(m)) {
                            draftLabel.setAttribute('display', 'none');
                            return;
                        }
                        // The value while drawing, e.g. "3.25 m".
                        var label = markupGeometry.measureLabel(m);
                        var rect = draftLabel.firstChild, text = draftLabel.lastChild;
                        rect.setAttribute('x', label.x); rect.setAttribute('y', label.y);
                        rect.setAttribute('width', label.width); rect.setAttribute('height', label.height);
                        text.setAttribute('x', label.lines[0].x); text.setAttribute('y', label.lines[0].y);
                        text.setAttribute('font-size', m.fontSize);
                        text.setAttribute('fill', m.color);
                        text.textContent = label.text;
                        draftLabel.removeAttribute('display');
                    }

                    // ----- Area / perimeter: click the corners; double-click, Enter or the first corner finishes -----
                    var polygon = null;     // { page, points: [x0, y0, ...] in PDF units } while placing corners

                    function polygonDraft(hover) {
                        var sizes = pageSizes();
                        var points = polygon.points.slice();
                        if (hover) { points.push(hover.x, hover.y); }
                        return { type: scope.tool, pageNumber: polygon.page, color: scope.markupColor, strokeWidth: sizes.strokeWidth,
                                 fontSize: measureFontSize(sizes), points: points };
                    }

                    function addCorner(point) {
                        var s = scope.rendered.scale;
                        var x = round2(point.x / s), y = round2(point.y / s);
                        if (!polygon) {
                            polygon = { page: scope.rendered.page, points: [x, y] };
                        } else {
                            var p = polygon.points, n = p.length;
                            if (n >= 6 && Math.hypot(x - p[0], y - p[1]) * s <= CLOSE_POLYGON_PX) { finishPolygon(); return; }
                            if (Math.hypot(x - p[n - 2], y - p[n - 1]) * s < MIN_CORNER_STEP_PX) { return; }
                            if (n / 2 < MAX_CORNERS) { p.push(x, y); }
                        }
                        showDraft(polygonDraft(null));
                    }

                    /** Adds the area / perimeter if it has at least three corners. */
                    function finishPolygon() {
                        if (!polygon) { return; }
                        var page = polygon.page;
                        var markup = polygon.points.length >= 6 ? polygonDraft(null) : null;
                        cancelPolygon();
                        if (!markup) { return; }
                        delete markup.pageNumber;
                        scope.$evalAsync(function () { scope.onCreateMarkup({ pageNumber: page, markup: markup }); });
                    }

                    function cancelPolygon() {
                        polygon = null;
                        hideDraft();
                    }

                    // ----- Count: each click adds a marker to the count; Enter starts a new count -----
                    var counting = null;    // { id, page } of the count that clicks add to

                    function findMarkup(id) {
                        var list = scope.highlights || [];
                        for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
                        return null;
                    }

                    function addCount(point) {
                        var s = scope.rendered.scale, page = scope.rendered.page;
                        var x = round2(point.x / s), y = round2(point.y / s);
                        var current = counting && counting.page === page ? findMarkup(counting.id) : null;
                        scope.$apply(function () {
                            if (current) {
                                if (current.points.length / 2 >= MAX_COUNT) { return; }
                                scope.onMoveMarkup({ id: current.id, markup: angular.extend({}, current, { points: current.points.concat([x, y]) }) });
                                return;
                            }
                            var sizes = pageSizes();
                            var added = scope.onCreateMarkup({ pageNumber: page, markup: {
                                type: 'count', color: scope.markupColor, strokeWidth: sizes.strokeWidth,
                                fontSize: measureFontSize(sizes), points: [x, y] } });
                            counting = added ? { id: added.id, page: page } : null;
                        });
                    }

                    function removeLastCount() {
                        var current = findMarkup(counting.id);
                        if (!current) { counting = null; return; }
                        if (current.points.length <= 2) {
                            counting = null;
                            scope.onRemoveHighlight({ id: current.id });
                        } else {
                            scope.onMoveMarkup({ id: current.id, markup: angular.extend({}, current, { points: current.points.slice(0, -2) }) });
                        }
                    }

                    // ----- Perpendicular distance: drag the reference line, then click the point -----
                    var perpendicular = null;   // { page, line: [ax, ay, bx, by] } once the line is drawn

                    function perpendicularDraft(point) {
                        var s = scope.rendered.scale, sizes = pageSizes();
                        return { type: 'perpendicular', pageNumber: perpendicular.page, color: scope.markupColor, strokeWidth: sizes.strokeWidth,
                                 fontSize: measureFontSize(sizes), points: perpendicular.line.concat([round2(point.x / s), round2(point.y / s)]) };
                    }

                    function cancelPerpendicular() {
                        perpendicular = null;
                        hideDraft();
                    }

                    function onMeasureKey(event) {
                        if (!polygon && !counting && !perpendicular) { return; }
                        var tag = event.target && event.target.tagName;
                        if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
                        if (perpendicular && !polygon) {
                            if (event.key !== 'Escape') { return; }
                            cancelPerpendicular();      // Esc drops the line; the tool stays
                            event.preventDefault();
                            event.stopImmediatePropagation();
                            return;
                        }
                        if (counting && !polygon) {
                            if (event.key === 'Enter') {
                                counting = null;        // the next click starts a new count
                            } else if (event.key === 'Backspace' || event.key === 'Delete') {
                                scope.$apply(removeLastCount);
                            } else {
                                if (event.key === 'Escape') { counting = null; }   // and the viewer goes back to Pan
                                return;
                            }
                            event.preventDefault();
                            event.stopImmediatePropagation();
                            return;
                        }
                        onPolygonKey(event);
                    }

                    function onPolygonKey(event) {
                        if (!polygon) { return; }
                        var tag = event.target && event.target.tagName;
                        if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
                        if (event.key === 'Enter') {
                            finishPolygon();
                        } else if (event.key === 'Escape') {
                            cancelPolygon();
                        } else if (event.key === 'Backspace' || event.key === 'Delete') {
                            polygon.points.splice(-2, 2);
                            if (polygon.points.length) { showDraft(polygonDraft(null)); } else { cancelPolygon(); }
                        } else {
                            return;
                        }
                        // These keys belong to the polygon: Esc must not leave the tool, Delete must not remove a markup.
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    }
                    document.addEventListener('keydown', onMeasureKey, true);
                    interactionLayer.addEventListener('dblclick', function (event) {
                        if (polygon) { finishPolygon(); return; }
                        if (scope.drawing()) { return; }
                        var hit = highlightAt(pointFromEvent(event));
                        if (hit) { scope.$apply(function () { scope.onEditMarkup({ id: hit.id }); }); }
                    });
                    scope.$watch('tool', function () {
                        if (polygon) { cancelPolygon(); }
                        if (perpendicular) { cancelPerpendicular(); }
                        counting = null;
                    });
                    scope.$watch('rendered.page', function () {
                        if (polygon) { cancelPolygon(); }
                        if (perpendicular) { cancelPerpendicular(); }
                        counting = null;
                    });

                    interactionLayer.addEventListener('pointerdown', function (event) {
                        if (event.button !== 0 || !scope.rendered.page) {
                            return;
                        }
                        var point = pointFromEvent(event);
                        start = { point: point, pen: scope.tool === 'pen' ? [point.x, point.y] : null };
                        interactionLayer.setPointerCapture(event.pointerId);
                        // preventDefault stops text selection but also keeps focus where it was
                        // (e.g. the page input), which would swallow keyboard shortcuts.
                        event.preventDefault();
                        if (document.activeElement && document.activeElement !== document.body) {
                            document.activeElement.blur();
                        }
                    });

                    interactionLayer.addEventListener('pointermove', function (event) {
                        if (polygon && !start && POLYGON_TOOLS[scope.tool]) {
                            var hover = pointFromEvent(event), hs = scope.rendered.scale;
                            showDraft(polygonDraft({ x: round2(hover.x / hs), y: round2(hover.y / hs) }));
                            return;
                        }
                        if (perpendicular && scope.tool === 'perpendicular' && !scope.spacePan) {
                            showDraft(perpendicularDraft(pointFromEvent(event)));
                            return;
                        }
                        if (!start || !scope.drawing() || POLYGON_TOOLS[scope.tool] || scope.tool === 'count') {
                            return;
                        }
                        var point = pointFromEvent(event);
                        if (start.pen) {
                            var p = start.pen;
                            if (p.length < MAX_PEN_POINTS * 2 &&
                                Math.hypot(point.x - p[p.length - 2], point.y - p[p.length - 1]) >= MIN_PEN_STEP_PX) {
                                p.push(point.x, point.y);
                                var s = scope.rendered.scale;
                                var sizes = markupGeometry.sizesFor(scope.rendered.width / s, scope.rendered.height / s);
                                showDraft({ type: 'pen', color: scope.markupColor, strokeWidth: sizes.strokeWidth,
                                            points: p.map(function (v) { return v / s; }) });
                            }
                            return;
                        }
                        showDraft(draftMarkup(start.point, point, event));
                    });

                    interactionLayer.addEventListener('pointerup', function (event) {
                        if (!start) {
                            return;
                        }
                        var begin = start;
                        var end = pointFromEvent(event);
                        start = null;
                        if (POLYGON_TOOLS[scope.tool] && !scope.spacePan) {
                            addCorner(end);
                            return;
                        }
                        if (scope.tool === 'count' && !scope.spacePan) {
                            addCount(end);
                            return;
                        }
                        if (scope.tool === 'perpendicular' && !scope.spacePan) {
                            if (perpendicular) {
                                // The point: the measurement is done.
                                var done = perpendicularDraft(end), donePage = perpendicular.page;
                                delete done.pageNumber;
                                cancelPerpendicular();
                                scope.$apply(function () { scope.onCreateMarkup({ pageNumber: donePage, markup: done }); });
                                return;
                            }
                            var reference = draftMarkup(begin.point, end, event);
                            if (reference) {
                                perpendicular = { page: scope.rendered.page, line: [reference.x1, reference.y1, reference.x2, reference.y2] };
                                showDraft(perpendicularDraft(end));
                            } else {
                                hideDraft();
                            }
                            return;
                        }
                        hideDraft();
                        var s = scope.rendered.scale;
                        var page = scope.rendered.page;

                        scope.$apply(function () {
                            var tool = scope.drawing() ? scope.tool : null;
                            if (tool === 'revtag') {
                                scope.onPlaceTag({ pageNumber: page, at: { x: end.x / s, y: end.y / s } });
                                return;
                            }
                            if (tool === 'comment') {
                                scope.onRequestText({ pageNumber: page, at: { x: end.x / s, y: end.y / s }, tip: null, box: null });
                                return;
                            }
                            if (tool === 'replace') {
                                // Mark the text to replace, then the host asks for the correction.
                                var marked = draftMarkup(begin.point, end, event);
                                if (marked) {
                                    scope.onRequestText({ pageNumber: page, at: null, tip: null, box: marked });
                                } else {
                                    var picked = highlightAt(end);
                                    scope.onSelectHighlight({ id: picked ? picked.id : null });
                                }
                                return;
                            }
                            if (tool === 'text' || tool === 'callout') {
                                // The note goes where the button was released; a callout points at where the drag began.
                                var dragged = Math.hypot(end.x - begin.point.x, end.y - begin.point.y) >= MIN_HIGHLIGHT_PX;
                                scope.onRequestText({
                                    pageNumber: page,
                                    at: { x: end.x / s, y: end.y / s },
                                    tip: tool === 'callout' ? { x: begin.point.x / s, y: begin.point.y / s, dragged: dragged } : null
                                });
                                return;
                            }
                            if (tool === 'calibrate') {
                                var line = draftMarkup(begin.point, end, event);
                                if (line) {
                                    var p0 = line.points;
                                    scope.onCalibrate({ pageNumber: page, length: Math.hypot(p0[2] - p0[0], p0[3] - p0[1]) });
                                }
                                return;
                            }
                            var markup = null;
                            if (tool === 'pen') {
                                var p = begin.pen;
                                if (p.length >= 4) {
                                    var sizes = markupGeometry.sizesFor(scope.rendered.width / s, scope.rendered.height / s);
                                    markup = { type: 'pen', color: scope.markupColor, strokeWidth: sizes.strokeWidth,
                                               points: p.map(function (v) { return Math.round(v / s * 100) / 100; }) };
                                }
                            } else if (tool) {
                                markup = draftMarkup(begin.point, end, event);
                            }
                            if (markup) {
                                delete markup.pageNumber;
                                if (markup.type === 'highlight') {
                                    // Highlights keep their own colour.
                                    delete markup.color;
                                    delete markup.strokeWidth;
                                }
                                scope.onCreateMarkup({ pageNumber: page, markup: markup });
                            } else {
                                var hit = highlightAt(end);
                                scope.onSelectHighlight({ id: hit ? hit.id : null });
                            }
                        });
                    });

                    interactionLayer.addEventListener('pointercancel', function () {
                        start = null;
                        hideDraft();
                    });

                    scope.$on('$destroy', function () {
                        resizeObserver.disconnect();
                        clearTimeout(resizeTimer);
                        cancelAnimationFrame(scrollFrame);
                        imageSeq++;
                        document.removeEventListener('keydown', onSpace);
                        document.removeEventListener('keydown', onMeasureKey, true);
                        document.removeEventListener('keyup', onSpace);
                        window.removeEventListener('blur', onBlur);
                    });
                }
            };
        }]);
})();
