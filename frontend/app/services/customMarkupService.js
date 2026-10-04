(function () {
    'use strict';

    /**
     * My markups: markups saved for reuse (a rectangle in a house style, a standard note, a stamp, a count),
     * kept in this browser / app. Each is stored with its top-left corner at 0, 0; placing one copies it
     * centred where the page is clicked (pdfViewerController).
     */
    angular.module('pdfViewerApp').factory('customMarkupService', ['$window', 'markupGeometry', function ($window, markupGeometry) {
        var KEY = 'pdfViewer.customMarkups';
        var MAX = 50;
        var items = load();

        function load() {
            try {
                var list = JSON.parse($window.localStorage.getItem(KEY) || '[]');
                return Array.isArray(list) ? list.filter(function (i) { return i && i.id && i.name && i.markup && i.markup.type; }) : [];
            } catch (e) {
                return [];
            }
        }

        function save() {
            try { $window.localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* kept for this session only */ }
        }

        /** Saves a copy of `markup` as `name`. Returns the new item, or a message when it cannot be added. */
        function add(name, markup) {
            name = String(name || '').trim();
            if (!name) { return 'Give it a name.'; }
            if (name.length > 60) { return 'Keep the name under 60 characters.'; }
            if (items.length >= MAX) { return 'My markups holds up to ' + MAX + ' markups; delete one first.'; }
            var copy = angular.copy(markup);
            ['id', 'pageNumber', 'createdAt', 'revision'].forEach(function (k) { delete copy[k]; });
            var b = markupGeometry.bounds(copy);
            copy = markupGeometry.translate(copy, -b.x, -b.y);
            var item = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, markup: copy };
            items.push(item);
            save();
            return item;
        }

        function remove(id) {
            items = items.filter(function (i) { return i.id !== id; });
            save();
        }

        function find(id) {
            for (var i = 0; i < items.length; i++) { if (items[i].id === id) { return items[i]; } }
            return null;
        }

        return {
            list: function () { return items; },
            add: add,
            remove: remove,
            find: find
        };
    }]);
})();
