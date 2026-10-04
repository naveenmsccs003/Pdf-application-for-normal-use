(function () {
    'use strict';

    /**
     * Revision tracking: the document's revisions (label, date, description, author) and the current one,
     * which new markups and revision tags belong to. Remembered per file (name and size) in this
     * browser / app, so reopening the drawing brings its revision list back.
     */
    angular.module('pdfViewerApp').factory('revisionService', ['$window', function ($window) {
        var STORAGE_PREFIX = 'pdfViewer.revisions:';
        var MAX_REVISIONS = 100;

        var key = null;
        var state = { list: [], current: null };    // list: [{ id, label, date, description, author }]

        function today() {
            var d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        function save() {
            if (!key) { return; }
            try { $window.localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* private mode: kept for this session */ }
        }

        /** Switches to the revisions of a file (null when no document is open). */
        function useDocument(fileName, size) {
            key = fileName ? STORAGE_PREFIX + fileName + ':' + (size || 0) : null;
            state = { list: [], current: null };
            if (!key) { return; }
            try {
                var stored = JSON.parse($window.localStorage.getItem(key) || 'null');
                if (stored && Array.isArray(stored.list)) {
                    state.list = stored.list.filter(function (r) { return r && typeof r.label === 'string'; }).slice(0, MAX_REVISIONS);
                    state.current = state.list.some(function (r) { return r.id === stored.current; }) ? stored.current : null;
                }
            } catch (e) { /* unreadable: start empty */ }
        }

        /** The label after the last one: B after A, 3 after 2, else A. */
        function nextLabel() {
            var last = state.list.length ? state.list[state.list.length - 1].label : '';
            if (/^\d+$/.test(last)) { return String(parseInt(last, 10) + 1); }
            if (/^[A-Y]$/i.test(last)) { return String.fromCharCode(last.toUpperCase().charCodeAt(0) + 1); }
            return last ? last + "'" : 'A';
        }

        /** Adds a revision and makes it current. Returns it, or an error message string. */
        function add(fields) {
            var label = String(fields.label || '').trim();
            if (!label || label.length > 10) { return 'Give the revision a short label, such as A or 2.'; }
            if (state.list.some(function (r) { return r.label.toLowerCase() === label.toLowerCase(); })) { return 'Revision ' + label + ' already exists.'; }
            if (state.list.length >= MAX_REVISIONS) { return 'Too many revisions.'; }
            var revision = {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                label: label,
                date: String(fields.date || today()).slice(0, 20),
                description: String(fields.description || '').trim().slice(0, 300),
                author: String(fields.author || '').trim().slice(0, 60)
            };
            state.list.push(revision);
            state.current = revision.id;
            save();
            return revision;
        }

        function remove(id) {
            state.list = state.list.filter(function (r) { return r.id !== id; });
            if (state.current === id) { state.current = state.list.length ? state.list[state.list.length - 1].id : null; }
            save();
        }

        function setCurrent(id) {
            state.current = state.list.some(function (r) { return r.id === id; }) ? id : null;
            save();
        }

        function current() {
            for (var i = 0; i < state.list.length; i++) {
                if (state.list[i].id === state.current) { return state.list[i]; }
            }
            return null;
        }

        return {
            useDocument: useDocument,
            list: function () { return state.list; },
            current: current,
            nextLabel: nextLabel,
            today: today,
            add: add,
            remove: remove,
            setCurrent: setCurrent
        };
    }]);
})();
