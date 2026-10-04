(function () {
    'use strict';

    /**
     * Markup store (highlights, shapes, lines, notes, measurements, review marks). Markups live in memory only and never modify the PDF.
     * Coordinates are in PDF units (page at scale 1), so they stay correct at any zoom level;
     * the fields of each type are listed in markupGeometry.
     */
    angular.module('pdfViewerApp').factory('highlightService', function () {
        var highlights = [];
        var nextId = 1;

        /** Adds a markup; `fields` holds its shape (a plain rectangle is a highlight). */
        function add(pageNumber, fields) {
            var markup = angular.extend({ type: 'highlight' }, fields, {
                id: nextId++,
                pageNumber: pageNumber,
                createdAt: new Date()
            });
            highlights.push(markup);
            return markup;
        }

        function remove(id) {
            for (var i = 0; i < highlights.length; i++) {
                if (highlights[i].id === id) {
                    highlights.splice(i, 1);
                    return true;
                }
            }
            return false;
        }

        /**
         * Replaces a markup with a changed copy (edit or move), keeping its id, page and time. A new object,
         * so views that cache a markup's drawing see the change. Returns the new markup, or null.
         */
        function update(id, fields) {
            for (var i = 0; i < highlights.length; i++) {
                if (highlights[i].id === id) {
                    var old = highlights[i];
                    highlights[i] = angular.extend({}, old, fields, { id: old.id, pageNumber: old.pageNumber, createdAt: old.createdAt });
                    return highlights[i];
                }
            }
            return null;
        }

        function find(id) {
            for (var i = 0; i < highlights.length; i++) {
                if (highlights[i].id === id) { return highlights[i]; }
            }
            return null;
        }

        // Mutate in place so views bound to the array stay in sync.
        function clear() {
            highlights.length = 0;
        }

        return {
            all: highlights,
            add: add,
            remove: remove,
            update: update,
            find: find,
            clear: clear
        };
    });
})();
