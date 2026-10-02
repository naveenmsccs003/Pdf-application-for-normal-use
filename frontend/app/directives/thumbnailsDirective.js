(function () {
    'use strict';

    /**
     * Page thumbnails panel. Virtualized: only thumbnails in (or near) view exist in the DOM and are
     * rendered, so documents with many thousands of pages stay fast.
     */
    angular.module('pdfViewerApp').directive('pageThumbnails', ['pdfService', function (pdfService) {
        var ITEM_HEIGHT = 172;      // px per thumbnail row, keep in sync with .thumb in CSS
        var THUMB_WIDTH = 112;
        var THUMB_HEIGHT = 140;
        var OVERSCAN = 2;           // extra rows rendered above/below the visible area
        var MAX_PARALLEL = 2;
        var CACHE_SIZE = 150;

        return {
            restrict: 'E',
            scope: {
                docVersion: '<',
                pageCount: '<',
                currentPage: '<',
                highlights: '<',
                onSelect: '&'
            },
            template:
                '<div class="thumbs-scroll">' +
                '  <div class="thumbs-spacer" ng-style="{height: pageCount * itemHeight + \'px\'}">' +
                '    <button type="button" class="thumb" ng-repeat="page in visiblePages track by page"' +
                '            ng-style="{top: (page - 1) * itemHeight + \'px\'}"' +
                '            ng-class="{\'is-current\': page === currentPage}"' +
                '            ng-click="onSelect({page: page})" aria-label="Go to page {{ page }}"' +
                '            ng-attr-aria-current="{{ page === currentPage ? \'page\' : undefined }}">' +
                '      <span class="thumb-frame" data-page="{{ page }}"></span>' +
                '      <span class="thumb-label">{{ page }}<span class="thumb-marks" ng-if="markCount(page)" title="{{ markCount(page) }} highlight(s)">{{ markCount(page) }}</span></span>' +
                '    </button>' +
                '  </div>' +
                '</div>',
            link: function (scope, element) {
                var scrollEl = element[0].querySelector('.thumbs-scroll');
                var cache = new Map();          // page -> canvas (insertion order = LRU order)
                var queue = [];
                var inFlight = 0;
                var generation = 0;             // bumps on document change to drop stale results
                var frame = null;

                scope.itemHeight = ITEM_HEIGHT;
                scope.visiblePages = [];

                scope.markCount = function (page) {
                    var count = 0;
                    var list = scope.highlights || [];
                    for (var i = 0; i < list.length; i++) {
                        if (list[i].pageNumber === page) { count++; }
                    }
                    return count;
                };

                function updateVisible() {
                    frame = null;
                    if (!scope.pageCount) {
                        scope.visiblePages = [];
                        return;
                    }
                    var first = Math.max(1, Math.floor(scrollEl.scrollTop / ITEM_HEIGHT) + 1 - OVERSCAN);
                    var last = Math.min(scope.pageCount, Math.ceil((scrollEl.scrollTop + scrollEl.clientHeight) / ITEM_HEIGHT) + OVERSCAN);
                    var pages = [];
                    for (var p = first; p <= last; p++) { pages.push(p); }
                    scope.visiblePages = pages;
                    queue = pages.filter(function (page) { return !cache.has(page); });
                    pump();
                }

                function scheduleUpdate() {
                    if (!frame) {
                        frame = requestAnimationFrame(function () { scope.$apply(updateVisible); });
                    }
                }

                function pump() {
                    while (inFlight < MAX_PARALLEL && queue.length) {
                        render(queue.shift(), generation);
                    }
                }

                function render(page, gen) {
                    inFlight++;
                    pdfService.renderThumbnail(page, THUMB_WIDTH, THUMB_HEIGHT).then(function (canvas) {
                        if (canvas && gen === generation) {
                            remember(page, canvas);
                            attach(page);
                        }
                    }).catch(angular.noop).finally(function () {
                        inFlight--;
                        if (gen === generation) { pump(); }
                    });
                }

                function remember(page, canvas) {
                    cache.delete(page);
                    cache.set(page, canvas);
                    while (cache.size > CACHE_SIZE) {
                        var oldest = cache.keys().next().value;
                        if (scope.visiblePages.indexOf(oldest) >= 0) { break; }
                        cache.delete(oldest);
                    }
                }

                // Places cached canvases into their frames once the rows exist in the DOM.
                function attach(page) {
                    var frames = page ? element[0].querySelectorAll('.thumb-frame[data-page="' + page + '"]')
                                      : element[0].querySelectorAll('.thumb-frame');
                    Array.prototype.forEach.call(frames, function (frameEl) {
                        var canvas = cache.get(Number(frameEl.getAttribute('data-page')));
                        if (canvas && canvas.parentNode !== frameEl) {
                            frameEl.innerHTML = '';
                            frameEl.appendChild(canvas);
                        }
                    });
                }

                scope.$watchCollection('visiblePages', function () {
                    scope.$$postDigest(function () { attach(); });
                });

                scope.$watch('docVersion', function () {
                    generation++;
                    cache.clear();
                    queue = [];
                    scrollEl.scrollTop = 0;
                    scheduleUpdate();
                });

                scope.$watch('pageCount', scheduleUpdate);

                // Keep the current page's thumbnail in view.
                function revealCurrent() {
                    var page = scope.currentPage;
                    if (!page || !scrollEl.clientHeight) { return; }   // hidden panel: done when shown
                    var top = (page - 1) * ITEM_HEIGHT;
                    if (top < scrollEl.scrollTop || top + ITEM_HEIGHT > scrollEl.scrollTop + scrollEl.clientHeight) {
                        scrollEl.scrollTop = Math.max(0, top - (scrollEl.clientHeight - ITEM_HEIGHT) / 2);
                    }
                    scheduleUpdate();
                }

                scope.$watch('currentPage', revealCurrent);

                scrollEl.addEventListener('scroll', scheduleUpdate, { passive: true });
                var wasHidden = !scrollEl.clientHeight;
                var resizeObserver = new ResizeObserver(function () {
                    var hidden = !scrollEl.clientHeight;
                    if (wasHidden && !hidden) {
                        revealCurrent();      // panel was just reopened
                    } else {
                        scheduleUpdate();
                    }
                    wasHidden = hidden;
                });
                resizeObserver.observe(scrollEl);

                scope.$on('$destroy', function () {
                    resizeObserver.disconnect();
                    if (frame) { cancelAnimationFrame(frame); }
                    generation++;
                });
            }
        };
    }]);
})();
