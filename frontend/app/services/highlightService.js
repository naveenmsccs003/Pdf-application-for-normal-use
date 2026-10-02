(function () {
    'use strict';

    /**
     * Highlight manager. Highlights live in memory only and never modify the PDF.
     * Coordinates are in PDF units (page at scale 1), so they stay correct at any zoom level.
     */
    angular.module('pdfViewerApp').factory('highlightService', function () {
        var highlights = [];
        var nextId = 1;

        function add(pageNumber, rect) {
            var highlight = {
                id: nextId++,
                pageNumber: pageNumber,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                createdAt: new Date()
            };
            highlights.push(highlight);
            return highlight;
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
