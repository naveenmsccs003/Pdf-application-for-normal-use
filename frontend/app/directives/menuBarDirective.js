(function () {
    'use strict';

    /**
     * Desktop-style menu bar (File, Zoom) following the WAI-ARIA menubar pattern:
     *   - click a menu button, or press Enter / Space / ArrowDown on it, to open its menu;
     *   - ArrowUp / ArrowDown move through the enabled items, Home / End jump to the ends;
     *   - ArrowLeft / ArrowRight switch to the neighbouring menu;
     *   - Escape closes the menu and returns focus to its button; Tab, a click outside, or choosing
     *     an item closes it.
     * Markup: <nav menu-bar role="menubar"> with buttons [data-menu-button] (aria-controls = menu id)
     * followed by their <div role="menu" hidden> containing [role=menuitem] buttons.
     */
    angular.module('pdfViewerApp').directive('menuBar', ['$document', function ($document) {
        return {
            restrict: 'A',
            link: function (scope, element) {
                var bar = element[0];
                var openButton = null;

                function buttons() { return Array.prototype.slice.call(bar.querySelectorAll('[data-menu-button]')); }
                function menuOf(button) { return bar.querySelector('#' + button.getAttribute('aria-controls')); }
                function items(menu) {
                    return Array.prototype.slice.call(menu.querySelectorAll('[role^="menuitem"]'))
                        .filter(function (item) { return !item.disabled; });
                }

                function open(button, focus) {
                    if (openButton && openButton !== button) { close(false); }
                    openButton = button;
                    button.setAttribute('aria-expanded', 'true');
                    menuOf(button).hidden = false;
                    var list = items(menuOf(button));
                    if (focus === 'first' && list.length) { list[0].focus(); }
                    if (focus === 'last' && list.length) { list[list.length - 1].focus(); }
                    $document.on('mousedown', onOutside);
                }

                function close(refocus) {
                    if (!openButton) { return; }
                    var button = openButton;
                    openButton = null;
                    button.setAttribute('aria-expanded', 'false');
                    menuOf(button).hidden = true;
                    $document.off('mousedown', onOutside);
                    if (refocus) { button.focus(); }
                }

                function onOutside(event) {
                    if (!bar.contains(event.target)) { close(false); }
                }

                function switchMenu(step) {
                    var list = buttons();
                    var current = openButton || document.activeElement;
                    var next = list[(list.indexOf(current) + step + list.length) % list.length];
                    if (openButton) { open(next, 'first'); } else { next.focus(); }
                }

                bar.addEventListener('click', function (event) {
                    var button = event.target.closest('[data-menu-button]');
                    if (button) {
                        if (openButton === button) { close(false); } else { open(button, null); }
                        return;
                    }
                    if (event.target.closest('[role^="menuitem"]')) {
                        close(false);   // the item's own ng-click has already run
                    }
                });

                // Hovering another menu button while a menu is open switches to it, like desktop apps.
                bar.addEventListener('mouseover', function (event) {
                    var button = event.target.closest('[data-menu-button]');
                    if (button && openButton && button !== openButton) { open(button, null); }
                });

                // Keys the menu bar handles never reach the page shortcuts (arrows change pages there).
                bar.addEventListener('keydown', function (event) {
                    handleKey(event);
                    if (event.defaultPrevented) { event.stopPropagation(); }
                });

                function handleKey(event) {
                    var button = event.target.closest('[data-menu-button]');
                    var item = event.target.closest('[role^="menuitem"]');

                    if (button) {
                        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            open(button, 'first');
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            open(button, 'last');
                        } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                            event.preventDefault();
                            switchMenu(event.key === 'ArrowRight' ? 1 : -1);
                        } else if (event.key === 'Escape' && openButton) {
                            event.preventDefault();
                            close(true);
                        }
                        return;
                    }
                    if (!item || !openButton) { return; }

                    var list = items(menuOf(openButton));
                    var index = list.indexOf(item);
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        var step = event.key === 'ArrowDown' ? 1 : -1;
                        list[(index + step + list.length) % list.length].focus();
                    } else if (event.key === 'Home' || event.key === 'End') {
                        event.preventDefault();
                        list[event.key === 'Home' ? 0 : list.length - 1].focus();
                    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                        event.preventDefault();
                        switchMenu(event.key === 'ArrowRight' ? 1 : -1);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();   // and so it doesn't also leave highlight mode
                        close(true);
                    } else if (event.key === 'Tab') {
                        close(false);
                    }
                }

                scope.$on('$destroy', function () { $document.off('mousedown', onOutside); });
            }
        };
    }]);
})();
