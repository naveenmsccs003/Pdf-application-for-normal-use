(function () {
    'use strict';

    /**
     * Displays one PDF page using three stacked layers:
     *   1. canvas layer       - PDF rendering (pdfService), never modified
     *   2. interaction layer  - mouse/touch input for drawing and selecting highlights
     *   3. highlight layer    - transparent overlay, positioned from PDF-unit coordinates
     */
    angular.module('pdfViewerApp').directive('pdfViewer', ['pdfService', 'VIEWER_CONFIG',
        function (pdfService, VIEWER_CONFIG) {
            var MIN_HIGHLIGHT_PX = 4;       // smaller drags count as a click
            var RESIZE_DEBOUNCE_MS = 150;

            return {
                restrict: 'E',
                scope: {
                    docVersion: '<',
                    page: '<',
                    scale: '<',
                    highlightMode: '<',
                    highlights: '<',
                    selectedId: '<',
                    api: '=',
                    onCreateHighlight: '&',
                    onSelectHighlight: '&',
                    onRemoveHighlight: '&',
                    onResize: '&',
                    onRendered: '&',
                    onRenderError: '&'
                },
                template:
                    '<div class="viewer-scroll" ng-class="{\'is-rendering\': rendering}">' +
                    '  <div class="pdf-page" ng-show="rendered.page" ng-style="{width: rendered.width + \'px\', height: rendered.height + \'px\'}">' +
                    '    <div class="canvas-layer"></div>' +
                    '    <div class="interaction-layer" ng-class="{\'is-drawing\': highlightMode}"></div>' +
                    '    <div class="highlight-layer">' +
                    '      <div class="highlight" ng-repeat="h in highlights | filter:{pageNumber: rendered.page}:true track by h.id"' +
                    '           ng-class="{\'is-selected\': h.id === selectedId}"' +
                    '           ng-style="{left: h.x * rendered.scale + \'px\', top: h.y * rendered.scale + \'px\',' +
                    '                      width: h.width * rendered.scale + \'px\', height: h.height * rendered.scale + \'px\'}">' +
                    '        <button type="button" class="highlight-remove" ng-if="h.id === selectedId"' +
                    '                title="Remove highlight" aria-label="Remove highlight"' +
                    '                ng-click="onRemoveHighlight({id: h.id})">&times;</button>' +
                    '      </div>' +
                    '      <div class="highlight is-draft ng-hide"></div>' +
                    '    </div>' +
                    '  </div>' +
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
                            if (pageChanged) {
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
                            scope.$apply(function () { scope.onResize(); });
                        }, RESIZE_DEBOUNCE_MS);
                    });
                    resizeObserver.observe(scrollEl);

                    // ----- Highlight drawing and selection -----
                    var start = null;

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

                    function hideDraft() {
                        draftEl.classList.add('ng-hide');
                    }

                    // Returns the topmost highlight under a screen point on the current page.
                    function highlightAt(point) {
                        var x = point.x / scope.rendered.scale;
                        var y = point.y / scope.rendered.scale;
                        var list = scope.highlights || [];
                        for (var i = list.length - 1; i >= 0; i--) {
                            var h = list[i];
                            if (h.pageNumber === scope.rendered.page &&
                                x >= h.x && x <= h.x + h.width && y >= h.y && y <= h.y + h.height) {
                                return h;
                            }
                        }
                        return null;
                    }

                    interactionLayer.addEventListener('pointerdown', function (event) {
                        if (event.button !== 0 || !scope.rendered.page) {
                            return;
                        }
                        start = pointFromEvent(event);
                        interactionLayer.setPointerCapture(event.pointerId);
                        // preventDefault stops text selection but also keeps focus where it was
                        // (e.g. the page input), which would swallow keyboard shortcuts.
                        event.preventDefault();
                        if (document.activeElement && document.activeElement !== document.body) {
                            document.activeElement.blur();
                        }
                    });

                    interactionLayer.addEventListener('pointermove', function (event) {
                        if (!start || !scope.highlightMode) {
                            return;
                        }
                        var r = rectBetween(start, pointFromEvent(event));
                        draftEl.style.left = r.x + 'px';
                        draftEl.style.top = r.y + 'px';
                        draftEl.style.width = r.width + 'px';
                        draftEl.style.height = r.height + 'px';
                        draftEl.classList.remove('ng-hide');
                    });

                    interactionLayer.addEventListener('pointerup', function (event) {
                        if (!start) {
                            return;
                        }
                        var end = pointFromEvent(event);
                        var r = rectBetween(start, end);
                        start = null;
                        hideDraft();

                        scope.$apply(function () {
                            if (scope.highlightMode && r.width >= MIN_HIGHLIGHT_PX && r.height >= MIN_HIGHLIGHT_PX) {
                                // Store in PDF units so the highlight is independent of zoom.
                                var s = scope.rendered.scale;
                                scope.onCreateHighlight({
                                    pageNumber: scope.rendered.page,
                                    rect: { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s }
                                });
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
                    });
                }
            };
        }]);
})();
