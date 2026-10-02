(function () {
    'use strict';

    /**
     * Web app's Recent Files. A browser cannot reopen a file by its path, and uploads are deleted from
     * the server after an hour, so the last few PDFs are kept in this browser's own storage (IndexedDB)
     * and reopened from there. Nothing leaves the computer; "Clear recent files" deletes them.
     * If storage is unavailable (private window, blocked site data) the list is simply empty.
     * The desktop app keeps its own list of file paths instead (see desktop/Services/RecentFiles.cs).
     */
    angular.module('pdfViewerApp').factory('recentFilesService', ['$q', '$window', function ($q, $window) {
        var DB_NAME = 'pdf-viewer';
        var STORE = 'recent-files';
        var MAX_ENTRIES = 5;
        var dbPromise = null;

        function openDb() {
            if (!dbPromise) {
                dbPromise = $q(function (resolve, reject) {
                    try {
                        var request = $window.indexedDB.open(DB_NAME, 1);
                        request.onupgradeneeded = function () {
                            request.result.createObjectStore(STORE, { keyPath: 'id' });
                        };
                        request.onsuccess = function () { resolve(request.result); };
                        request.onerror = function () { reject(request.error); };
                    } catch (e) {
                        reject(e);
                    }
                });
                dbPromise.catch(function () { dbPromise = null; });
            }
            return dbPromise;
        }

        /** Runs fn(store) in one transaction; resolves with fn's request result once it commits. */
        function withStore(mode, fn) {
            return openDb().then(function (db) {
                return $q(function (resolve, reject) {
                    var tx = db.transaction(STORE, mode);
                    var request = fn(tx.objectStore(STORE));
                    tx.oncomplete = function () { resolve(request ? request.result : undefined); };
                    tx.onerror = tx.onabort = function () { reject(tx.error); };
                });
            });
        }

        function getAll() {
            return withStore('readonly', function (store) { return store.getAll(); }).then(function (rows) {
                return (rows || []).sort(function (a, b) { return b.openedAt - a.openedAt; });
            });
        }

        function summary(row) {
            return { id: row.id, name: row.name, size: row.size, openedAt: row.openedAt };
        }

        return {
            /** Newest first, without the file data. */
            list: function () {
                return getAll().then(function (rows) { return rows.map(summary); }, function () { return []; });
            },

            /** Stores (or refreshes) a file at the top of the list and trims the oldest beyond the limit. */
            add: function (file) {
                var row = { id: file.name + '|' + file.size, name: file.name, size: file.size, openedAt: Date.now(), blob: file };
                return withStore('readwrite', function (store) { return store.put(row); })
                    .then(getAll)
                    .then(function (rows) {
                        var extra = rows.slice(MAX_ENTRIES);
                        if (!extra.length) { return; }
                        return withStore('readwrite', function (store) {
                            extra.forEach(function (r) { store.delete(r.id); });
                            return null;
                        });
                    })
                    .catch(function () { /* storage full or unavailable: recent files are a convenience */ });
            },

            /** The stored file as a File, or null if it is gone. */
            get: function (id) {
                return withStore('readonly', function (store) { return store.get(id); }).then(function (row) {
                    if (!row || !row.blob) { return null; }
                    return new $window.File([row.blob], row.name, { type: 'application/pdf' });
                }, function () { return null; });
            },

            clear: function () {
                return withStore('readwrite', function (store) { return store.clear(); }).catch(angular.noop);
            }
        };
    }]);
})();
