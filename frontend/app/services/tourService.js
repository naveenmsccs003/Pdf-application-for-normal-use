(function () {
    'use strict';

    /**
     * Guided tour for new users: the steps, and whether it has been seen. The desktop app starts it
     * once on first run; Help > Take the tour starts it again any time. The overlay is drawn by
     * tourDirective.js.
     *
     * A step points at an element (target, a CSS selector) and may first show a ribbon tab (tab).
     * Steps without a target are shown in the middle of the window.
     */
    angular.module('pdfViewerApp').factory('tourService', ['$window', function ($window) {
        var STORAGE_KEY = 'pdfViewer.tourSeen';

        var steps = [
            {
                title: 'Welcome to Naveen PDF Editor',
                text: 'This short tour shows where everything is. Use Next and Back, or the arrow keys; Esc ends the tour.'
            },
            {
                target: '.menubar',
                title: 'Menus',
                text: 'File opens, saves and creates PDFs and lists your recent files. Edit finds text, and Zoom changes the page size.'
            },
            {
                target: '.ribbon-tablist',
                title: 'Tool tabs',
                text: 'The tools are grouped by task. Pick a tab to see its tools in the ribbon below.'
            },
            {
                target: '#ribbon-file', tab: 'file',
                title: 'The ribbon',
                text: 'Each tab shows its tools in labelled groups. Hover over a tool to see its name and keyboard shortcut.'
            },
            {
                target: '#ribbon-pages', tab: 'pages',
                title: 'Pages',
                text: 'Insert, delete, move, rotate, extract and replace pages. Save the file afterwards to keep the changes.'
            },
            {
                target: '#ribbon-markup', tab: 'markup',
                title: 'Markup',
                text: 'Highlight text, draw shapes and arrows, add notes, callouts and stamps, and pick a colour.'
            },
            {
                target: '#ribbon-measure', tab: 'measure',
                title: 'Measure',
                text: 'Set the drawing scale first, then measure lengths, areas and perimeters, or count items.'
            },
            {
                target: '#ribbon-output', tab: 'output',
                title: 'Output',
                text: 'Save a copy with your markups, print, export, and create markup and review reports.'
            },
            {
                target: '.toolbar .tool-group-end',
                title: 'Side panels',
                text: 'Show page thumbnails on the left and the list of markups on the right.'
            },
            {
                target: '.document-area',
                title: 'Your document',
                text: 'The open PDF appears here. With no document open, use Open PDF (Ctrl+O) or pick one of your recent files.'
            },
            {
                target: '.status-bar',
                title: 'Status bar',
                text: 'Move between pages and change the zoom. The middle shows what the app is doing.'
            },
            {
                target: '.theme-toggle',
                title: 'Light or dark',
                text: 'Switch between the light and dark theme.'
            },
            {
                target: '#menu-help-button',
                title: 'That’s it',
                text: 'You can take this tour again any time from Help › Take the tour.'
            }
        ];

        var state = { active: false, index: 0 };

        function hasSeen() {
            try {
                return $window.localStorage.getItem(STORAGE_KEY) === '1';
            } catch (e) {
                return true;  // storage blocked: don't show the tour on every start
            }
        }

        function markSeen() {
            try {
                $window.localStorage.setItem(STORAGE_KEY, '1');
            } catch (e) {
                // Not critical.
            }
        }

        return {
            steps: steps,
            state: state,
            hasSeen: hasSeen,
            start: function () {
                state.index = 0;
                state.active = true;
            },
            /** Ends the tour (finished or skipped); it won't start by itself again. */
            end: function () {
                state.active = false;
                markSeen();
            }
        };
    }]);
})();
