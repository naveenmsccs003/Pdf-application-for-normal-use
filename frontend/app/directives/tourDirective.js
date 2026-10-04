(function () {
    'use strict';

    /**
     * Draws the guided tour (tourService): a dimmed window with a spotlight on the step's element and
     * a card next to it. The rest of the app can't be clicked while it is open.
     * Keys: ArrowRight / Enter next, ArrowLeft back, Escape ends the tour.
     * Usage: <div guided-tour current-tab="vm.ribbonTab" on-tab="vm.setRibbonTab(tab)"></div>
     */
    angular.module('pdfViewerApp').directive('guidedTour', ['$window', '$document', '$timeout', 'tourService',
        function ($window, $document, $timeout, tourService) {
            var GAP = 10;      // between the spotlight and the card
            var MARGIN = 12;   // between the card and the window edge
            var PAD = 4;       // spotlight around the element

            return {
                restrict: 'A',
                scope: { currentTab: '<', onTab: '&' },
                template:
                    '<div class="tour" ng-if="state.active">' +
                    '  <div class="tour-blocker"></div>' +
                    '  <div class="tour-spotlight" ng-style="spot" ng-class="{\'is-hidden\': !spot}"></div>' +
                    '  <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text"' +
                    '       ng-style="card" ng-class="{\'is-centered\': !spot}">' +
                    '    <p class="tour-progress">{{ state.index + 1 }} of {{ steps.length }}</p>' +
                    '    <h2 id="tour-title">{{ step().title }}</h2>' +
                    '    <p id="tour-text">{{ step().text }}</p>' +
                    '    <div class="tour-actions">' +
                    '      <button type="button" class="tool tool-labelled tour-skip" ng-click="end()" ng-if="!isLast()">Skip tour</button>' +
                    '      <button type="button" class="tool tool-labelled tool-outline" ng-click="back()" ng-if="state.index > 0">Back</button>' +
                    '      <button type="button" class="tool tool-labelled tool-primary tour-next" ng-click="next()">{{ isLast() ? \'Finish\' : \'Next\' }}</button>' +
                    '    </div>' +
                    '  </div>' +
                    '</div>',
                link: function (scope, element) {
                    var savedTab = null;
                    var returnFocus = null;

                    scope.state = tourService.state;
                    scope.steps = tourService.steps;
                    scope.step = function () { return scope.steps[scope.state.index]; };
                    scope.isLast = function () { return scope.state.index === scope.steps.length - 1; };

                    scope.next = function () {
                        if (scope.isLast()) { scope.end(); } else { show(scope.state.index + 1); }
                    };
                    scope.back = function () {
                        if (scope.state.index > 0) { show(scope.state.index - 1); }
                    };
                    scope.end = function () { tourService.end(); };

                    function show(index) {
                        scope.state.index = index;
                        var tab = scope.steps[index].tab;
                        if (tab) { scope.onTab({ tab: tab }); }
                        scope.spot = null;
                        scope.card = { visibility: 'hidden' };
                        // After the tab's panel and the card have been drawn: measure, then place. Focus
                        // Next once the card is shown (a hidden button can't take focus).
                        $timeout(place);
                        $timeout(function () {
                            var button = element[0].querySelector('.tour-next');
                            if (button) { button.focus(); }
                        }, 0, false);
                    }

                    function visibleTarget(selector) {
                        var el = selector && $document[0].querySelector(selector);
                        if (!el) { return null; }
                        var rect = el.getBoundingClientRect();
                        return rect.width && rect.height ? rect : null;
                    }

                    function place() {
                        var card = element[0].querySelector('.tour-card');
                        if (!card || !scope.state.active) { return; }
                        var rect = visibleTarget(scope.step().target);
                        if (!rect) {
                            scope.spot = null;
                            scope.card = {};
                            return;
                        }
                        var vw = $window.innerWidth, vh = $window.innerHeight;
                        var spot = {
                            left: Math.max(rect.left - PAD, 0), top: Math.max(rect.top - PAD, 0),
                            right: Math.min(rect.right + PAD, vw), bottom: Math.min(rect.bottom + PAD, vh)
                        };
                        scope.spot = {
                            left: spot.left + 'px', top: spot.top + 'px',
                            width: (spot.right - spot.left) + 'px', height: (spot.bottom - spot.top) + 'px'
                        };

                        var w = card.offsetWidth, h = card.offsetHeight;
                        var top;
                        if (spot.bottom + GAP + h + MARGIN <= vh) {
                            top = spot.bottom + GAP;                   // below
                        } else if (spot.top - GAP - h >= MARGIN) {
                            top = spot.top - GAP - h;                  // above
                        } else {
                            top = (vh - h) / 2;                        // large target: over it, in the middle
                        }
                        var left = Math.min(Math.max(spot.left, MARGIN), vw - w - MARGIN);
                        scope.card = { left: Math.max(left, MARGIN) + 'px', top: Math.max(top, MARGIN) + 'px' };
                    }

                    // Keys go to the tour only, never to the page or its shortcuts: caught on the window,
                    // before the app's own listeners on the document.
                    function onKey(event) {
                        if (!scope.state.active) { return; }
                        var onButton = event.target && event.target.tagName === 'BUTTON' && element[0].contains(event.target);
                        if (event.key === 'Tab') {
                            trapFocus(event);
                            return;
                        }
                        if ((event.key === 'Enter' || event.key === ' ') && onButton) { return; }   // the focused button handles it
                        event.preventDefault();
                        event.stopPropagation();
                        scope.$apply(function () {
                            if (event.key === 'Escape') { scope.end(); }
                            else if (event.key === 'ArrowRight' || event.key === 'Enter') { scope.next(); }
                            else if (event.key === 'ArrowLeft') { scope.back(); }
                        });
                    }

                    function trapFocus(event) {
                        var buttons = element[0].querySelectorAll('.tour-card button');
                        if (!buttons.length) { return; }
                        var first = buttons[0], last = buttons[buttons.length - 1];
                        var inside = element[0].contains($document[0].activeElement);
                        if (!inside || (event.shiftKey && $document[0].activeElement === first)) {
                            event.preventDefault();
                            (event.shiftKey ? last : first).focus();
                        } else if (!event.shiftKey && $document[0].activeElement === last) {
                            event.preventDefault();
                            first.focus();
                        }
                    }

                    function onResize() {
                        if (scope.state.active) { scope.$apply(place); }
                    }

                    scope.$watch('state.active', function (active, was) {
                        if (active) {
                            savedTab = scope.currentTab;
                            returnFocus = $document[0].activeElement;
                            $window.addEventListener('keydown', onKey, true);
                            $window.addEventListener('resize', onResize);
                            show(scope.state.index);
                        } else if (was) {
                            $window.removeEventListener('keydown', onKey, true);
                            $window.removeEventListener('resize', onResize);
                            if (savedTab) { scope.onTab({ tab: savedTab }); }
                            if (returnFocus && returnFocus.focus && $document[0].contains(returnFocus)) { returnFocus.focus(); }
                        }
                    });

                    scope.$on('$destroy', function () {
                        $window.removeEventListener('keydown', onKey, true);
                        $window.removeEventListener('resize', onResize);
                    });
                }
            };
        }]);
})();
