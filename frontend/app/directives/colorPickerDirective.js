(function () {
    'use strict';

    /**
     * "More colours" button and its pop-up: any colour (saturation/brightness square, hue slider, hex code),
     * a preset grid and the recently used custom colours. The colour applies as soon as it is picked;
     * Esc or a click outside closes the pop-up. Recent colours are remembered in this browser only.
     */
    angular.module('pdfViewerApp').directive('markupColorPicker', ['$window', '$timeout', '$document',
        function ($window, $timeout, $document) {
            var STORAGE_KEY = 'pdfViewer.recentColors';
            var MAX_RECENT = 10;
            var POPOVER_WIDTH = 260;    // keep in sync with .color-popover in CSS
            var HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

            // ----- Colour maths (h 0-360, s and v 0-100) -----
            function hsvToHex(h, s, v) {
                s /= 100; v /= 100;
                var f = function (n) {
                    var k = (n + h / 60) % 6;
                    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
                };
                return '#' + [f(5), f(3), f(1)].map(function (c) { return (c < 16 ? '0' : '') + c.toString(16); }).join('');
            }

            function hexToHsv(hex) {
                var n = parseInt(hex.slice(1), 16);
                var r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
                var max = Math.max(r, g, b), d = max - Math.min(r, g, b);
                var h = 0;
                if (d) {
                    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
                    h = (h * 60 + 360) % 360;
                }
                return { h: Math.round(h), s: Math.round(max ? d / max * 100 : 0), v: Math.round(max * 100) };
            }

            /** "#abc", "aabbcc" and similar to "#aabbcc"; null if it is not a colour. */
            function normalizeHex(text) {
                var m = HEX.exec(String(text || '').trim());
                if (!m) { return null; }
                var digits = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
                return '#' + digits.toLowerCase();
            }

            // Presets: 12 hues in 5 shades, then 12 greys from black to white.
            var PRESETS = [];
            [[100, 35], [100, 60], [85, 85], [55, 95], [25, 100]].forEach(function (sv) {
                for (var h = 0; h < 360; h += 30) { PRESETS.push(hsvToHex(h, sv[0], sv[1])); }
            });
            for (var i = 0; i < 12; i++) { PRESETS.push(hsvToHex(0, 0, Math.round(i * 100 / 11))); }

            function loadRecent() {
                try {
                    var list = JSON.parse($window.localStorage.getItem(STORAGE_KEY) || '[]');
                    return Array.isArray(list) ? list.map(normalizeHex).filter(Boolean).slice(0, MAX_RECENT) : [];
                } catch (e) {
                    return [];
                }
            }

            function saveRecent(list) {
                try { $window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
            }

            return {
                restrict: 'E',
                scope: {
                    color: '<',
                    basics: '<',        // the quick swatches, never added to the recent list
                    disabled: '<',
                    onPick: '&'
                },
                template:
                    '<button type="button" class="tool color-more" ng-click="toggle()" ng-disabled="disabled"' +
                    '        ng-class="{\'is-active\': isCustom()}" aria-haspopup="dialog" aria-expanded="{{ !!open }}"' +
                    '        aria-label="More colours" title="More colours: pick any colour">' +
                    '  <span class="color-more-ring"><span class="color-more-dot" ng-if="isCustom()" ng-attr-style="--swatch: {{ color }}"></span></span>' +
                    '</button>' +
                    '<div class="color-popover" role="dialog" aria-label="Choose a colour" ng-if="open" ng-style="position"' +
                    '     ng-keydown="onKey($event)">' +
                    '  <div class="color-sv" role="slider" tabindex="0" aria-label="Saturation and brightness"' +
                    '       aria-valuetext="Saturation {{ hsv.s }}%, brightness {{ hsv.v }}%"' +
                    '       title="Drag to pick; arrow keys adjust (Shift: faster)"' +
                    '       ng-attr-style="background-color: {{ hueColor() }}" ng-keydown="onSvKey($event)">' +
                    '    <span class="color-sv-thumb" ng-attr-style="left: {{ hsv.s }}%; top: {{ 100 - hsv.v }}%; --swatch: {{ hex }}"></span>' +
                    '  </div>' +
                    '  <input type="range" class="color-hue" min="0" max="359" step="1" aria-label="Hue"' +
                    '         ng-model="hsv.h" ng-change="fromHsv()">' +
                    '  <div class="color-code">' +
                    '    <span class="color-preview" ng-attr-style="--swatch: {{ hex }}"></span>' +
                    '    <label class="color-hex-label">Hex' +
                    '      <input type="text" class="color-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex colour code"' +
                    '             ng-model="edit.hex" ng-change="fromHexInput()" ng-blur="edit.hex = hex" ng-class="{\'is-invalid\': edit.invalid}">' +
                    '    </label>' +
                    '  </div>' +
                    '  <div class="color-heading">Presets</div>' +
                    '  <div class="color-grid" role="group" aria-label="Preset colours">' +
                    '    <button type="button" class="color-cell" ng-repeat="c in presets track by $index" ng-click="pick(c)"' +
                    '            ng-class="{\'is-active\': c === hex}" aria-label="{{ c }}" title="{{ c }}" ng-attr-style="--swatch: {{ c }}"></button>' +
                    '  </div>' +
                    '  <div class="color-heading" ng-if="recent.length">Recent</div>' +
                    '  <div class="color-grid" role="group" aria-label="Recent colours" ng-if="recent.length">' +
                    '    <button type="button" class="color-cell" ng-repeat="c in recent track by c" ng-click="pick(c)"' +
                    '            ng-class="{\'is-active\': c === hex}" aria-label="Recent {{ c }}" title="{{ c }}" ng-attr-style="--swatch: {{ c }}"></button>' +
                    '  </div>' +
                    '</div>',
                link: function (scope, element) {
                    var button = element[0].querySelector('.color-more');
                    scope.presets = PRESETS;
                    scope.recent = loadRecent();
                    scope.open = false;
                    scope.hsv = { h: 0, s: 100, v: 100 };
                    scope.hex = '#ff0000';
                    scope.edit = { hex: '', invalid: false };

                    function isBasic(color) {
                        return (scope.basics || []).some(function (b) { return b.value === color; });
                    }

                    scope.isCustom = function () { return !!scope.color && !isBasic(scope.color); };
                    scope.hueColor = function () { return hsvToHex(scope.hsv.h, 100, 100); };

                    function apply(hex) {
                        scope.hex = hex;
                        scope.edit.hex = hex;
                        scope.edit.invalid = false;
                        scope.onPick({ color: hex });
                    }

                    scope.fromHsv = function () {
                        scope.hsv.h = Math.min(359, Math.max(0, parseFloat(scope.hsv.h) || 0));
                        apply(hsvToHex(scope.hsv.h, scope.hsv.s, scope.hsv.v));
                    };

                    scope.fromHexInput = function () {
                        var hex = normalizeHex(scope.edit.hex);
                        scope.edit.invalid = !hex;
                        if (!hex) { return; }
                        var typed = scope.edit.hex;
                        scope.hsv = hexToHsv(hex);
                        apply(hex);
                        scope.edit.hex = typed;     // keep what is being typed (e.g. "#abc")
                    };

                    scope.pick = function (hex) {
                        scope.hsv = hexToHsv(hex);
                        apply(hex);
                    };

                    function rememberColor() {
                        var hex = scope.hex;
                        if (!hex || isBasic(hex)) { return; }
                        scope.recent = [hex].concat(scope.recent.filter(function (c) { return c !== hex; })).slice(0, MAX_RECENT);
                        saveRecent(scope.recent);
                    }

                    // ----- Open / close -----
                    function onOutside(event) {
                        var popover = element[0].querySelector('.color-popover');
                        if ((popover && popover.contains(event.target)) || button.contains(event.target)) { return; }
                        scope.$apply(close);
                    }

                    function onResize() { scope.$apply(close); }

                    function show() {
                        var start = normalizeHex(scope.color) || '#e01b24';
                        scope.hsv = hexToHsv(start);
                        scope.hex = start;
                        scope.edit = { hex: start, invalid: false };
                        // Fixed position: the ribbon panel scrolls sideways and would clip the pop-up.
                        var rect = button.getBoundingClientRect();
                        scope.position = {
                            top: rect.bottom + 6 + 'px',
                            left: Math.max(8, Math.min(rect.left, $window.innerWidth - POPOVER_WIDTH - 8)) + 'px'
                        };
                        scope.open = true;
                        $document[0].addEventListener('pointerdown', onOutside, true);
                        $window.addEventListener('resize', onResize);
                        $timeout(function () {
                            var sv = element[0].querySelector('.color-sv');
                            if (sv) { sv.focus(); }
                        });
                    }

                    function close(returnFocus) {
                        if (!scope.open) { return; }
                        scope.open = false;
                        rememberColor();
                        $document[0].removeEventListener('pointerdown', onOutside, true);
                        $window.removeEventListener('resize', onResize);
                        if (returnFocus) { button.focus(); }
                    }

                    scope.toggle = function () {
                        if (scope.open) { close(); } else { show(); }
                    };

                    // Keys inside the pop-up belong to it: arrows must not turn pages, Esc must not leave the tool.
                    scope.onKey = function (event) {
                        event.stopPropagation();
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            close(true);
                        } else if (event.key === 'Enter' && event.target.classList.contains('color-hex')) {
                            event.preventDefault();
                            close(true);
                        }
                    };

                    scope.onSvKey = function (event) {
                        var step = event.shiftKey ? 10 : 1;
                        var moves = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowDown: ['v', -step], ArrowUp: ['v', step] };
                        var move = moves[event.key];
                        if (!move) { return; }
                        event.preventDefault();
                        scope.hsv[move[0]] = Math.min(100, Math.max(0, scope.hsv[move[0]] + move[1]));
                        scope.fromHsv();
                    };

                    // ----- Saturation / brightness square: drag with mouse, pen or finger -----
                    var dragging = false;
                    function svFromEvent(event) {
                        var rect = event.currentTarget.getBoundingClientRect();
                        scope.hsv.s = Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 100);
                        scope.hsv.v = Math.round((1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))) * 100);
                        scope.fromHsv();
                    }

                    element.on('pointerdown', function (event) {
                        if (!event.target.classList.contains('color-sv') && !event.target.classList.contains('color-sv-thumb')) { return; }
                        var sv = element[0].querySelector('.color-sv');
                        dragging = true;
                        sv.setPointerCapture(event.pointerId);
                        event.preventDefault();
                        sv.focus();
                        scope.$apply(function () { svFromEvent({ currentTarget: sv, clientX: event.clientX, clientY: event.clientY }); });
                    });
                    element.on('pointermove', function (event) {
                        if (!dragging) { return; }
                        var sv = element[0].querySelector('.color-sv');
                        scope.$apply(function () { svFromEvent({ currentTarget: sv, clientX: event.clientX, clientY: event.clientY }); });
                    });
                    element.on('pointerup pointercancel', function () { dragging = false; });

                    scope.$on('$destroy', function () { close(); });
                }
            };
        }]);
})();
