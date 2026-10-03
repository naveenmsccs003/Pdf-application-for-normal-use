(function () {
    'use strict';

    /**
     * Markup store (highlights, shapes, lines, notes). Markups live in memory only and never modify the PDF.
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

        // Mutate in place so views bound to the array stay in sync.
        function clear() {
            highlights.length = 0;
        }

        return {
            all: highlights,
            add: add,
            remove: remove,
            clear: clear
        };
    });
})();
