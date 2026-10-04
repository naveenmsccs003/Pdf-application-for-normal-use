(function () {
    'use strict';

    /**
     * Hover labels for the icon buttons: the button's name (its aria-label, else its text) and its keyboard
     * shortcut (data-shortcut), in a small label under the button (above it near the bottom of the window).
     * Shown on hover and on keyboard focus. The button's own title is held back meanwhile, so the browser's
     * slower tooltip does not appear on top of it.
     */
    angular.module('pdfViewerApp').directive('toolTips', function () {
        var SELECTOR = '.toolbar .tool, .fullscreen-bar .tool, .status-bar .tool, .find-bar .tool';
        var SHOW_DELAY_MS = 300;
        var QUICK_MS = 600;     // moving to the next button within this time shows its label at once

        return {
            restrict: 'A',
            link: function (scope, element) {
                var root = element[0];
                var tip = document.createElement('div');
                tip.className = 'tool-tip';
                tip.setAttribute('role', 'tooltip');
                tip.id = 'tool-tip';
                tip.hidden = true;
                document.body.appendChild(tip);

                var current = null, timer = null, hiddenAt = 0;

                function nameOf(el) {
                    return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
                }

                function show(el) {
                    var name = nameOf(el);
                    if (!name) { return; }
                    var key = (el.getAttribute('data-shortcut') || '').trim();
                    tip.textContent = name;
                    if (key) {
                        var kbd = document.createElement('kbd');
                        kbd.textContent = key;
                        tip.appendChild(kbd);
                    }
                    if (el.hasAttribute('title')) {
                        el.setAttribute('data-title', el.getAttribute('title'));
                        el.removeAttribute('title');
                    }
                    el.setAttribute('aria-describedby', 'tool-tip');
                    tip.hidden = false;
                    var box = el.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
                    var top = box.bottom + 6;
                    if (top + height > window.innerHeight - 4) { top = box.top - height - 6; }
                    var left = Math.min(Math.max(4, box.left + box.width / 2 - width / 2), window.innerWidth - width - 4);
                    tip.style.top = Math.round(top) + 'px';
                    tip.style.left = Math.round(left) + 'px';
                }

                function hide() {
                    clearTimeout(timer);
                    if (current) {
                        if (current.hasAttribute('data-title') && !current.hasAttribute('title')) {
                            current.setAttribute('title', current.getAttribute('data-title'));
                        }
                        current.removeAttribute('aria-describedby');
                        current = null;
                    }
                    if (!tip.hidden) {
                        tip.hidden = true;
                        hiddenAt = Date.now();
                    }
                }

                function enter(el) {
                    if (el === current) { return; }
                    hide();
                    current = el;
                    var quick = Date.now() - hiddenAt < QUICK_MS;
                    timer = setTimeout(function () { if (current === el && el.isConnected) { show(el); } }, quick ? 0 : SHOW_DELAY_MS);
                }

                function onOver(event) {
                    var el = event.target.closest && event.target.closest(SELECTOR);
                    if (el && root.contains(el)) { enter(el); } else if (current) { hide(); }
                }

                function onOut(event) {
                    if (current && !(event.relatedTarget && current.contains(event.relatedTarget))) { hide(); }
                }

                function onFocus(event) {
                    var el = event.target.closest && event.target.closest(SELECTOR);
                    if (el && el.matches(':focus-visible')) { enter(el); }
                }

                root.addEventListener('mouseover', onOver);
                root.addEventListener('mouseout', onOut);
                root.addEventListener('focusin', onFocus);
                root.addEventListener('focusout', hide);
                root.addEventListener('pointerdown', hide, true);
                document.addEventListener('keydown', hide, true);
                window.addEventListener('scroll', hide, true);
                window.addEventListener('blur', hide);

                scope.$on('$destroy', function () {
                    hide();
                    tip.remove();
                    root.removeEventListener('mouseover', onOver);
                    root.removeEventListener('mouseout', onOut);
                    root.removeEventListener('focusin', onFocus);
                    root.removeEventListener('focusout', hide);
                    root.removeEventListener('pointerdown', hide, true);
                    document.removeEventListener('keydown', hide, true);
                    window.removeEventListener('scroll', hide, true);
                    window.removeEventListener('blur', hide);
                });
            }
        };
    });
})();
