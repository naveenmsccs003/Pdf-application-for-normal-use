(function () {
    'use strict';

    /**
     * The tools dialog (merge, split, compress, convert). Lives inside the viewer's scope,
     * so it can read the open document from `vm`.
     */
    angular.module('pdfViewerApp').controller('ToolsController', ['$scope', '$document', 'toolsService',
        function ($scope, $document, toolsService) {
            var tools = this;
            var MAX_MERGE_FILES = 20;

            tools.isDesktop = toolsService.isDesktop;
            tools.active = null;        // 'merge' | 'split' | 'compress' | 'convert'
            tools.busy = false;
            tools.result = '';
            tools.error = '';

            tools.titles = {
                merge: 'Merge PDFs',
                split: 'Split PDF',
                compress: 'Compress PDF',
                convert: 'Convert PDF'
            };

            function vm() { return $scope.vm; }

            tools.open = function (name) {
                tools.active = name;
                tools.result = '';
                tools.error = '';
                tools.split = { mode: 'pages', pagesPerFile: 2, ranges: '' };
                tools.compress = { level: 'medium' };
                tools.convert = { format: 'docx', dpi: 150 };
                tools.mergeItems = vm().hasDocument() ? [{ current: true, name: vm().fileName }] : [];
            };

            tools.close = function () {
                if (!tools.busy) {
                    tools.active = null;
                }
            };

            // ----- Merge list -----
            tools.addWebFiles = function (files) {
                tools.error = '';
                files.forEach(function (file) {
                    var problem = toolsService.validateFile(file);
                    if (problem) {
                        tools.error = file.name + ': ' + problem;
                    } else if (tools.mergeItems.length < MAX_MERGE_FILES) {
                        tools.mergeItems.push({ file: file, name: file.name, size: file.size });
                    } else {
                        tools.error = 'You can merge up to ' + MAX_MERGE_FILES + ' files at a time.';
                    }
                });
            };

            tools.addDesktopFiles = function () {
                tools.error = '';
                toolsService.pickDesktopFiles().then(function (files) {
                    files.forEach(function (file) {
                        if (tools.mergeItems.length < MAX_MERGE_FILES) {
                            tools.mergeItems.push({ id: file.id, name: file.name, size: file.size });
                        }
                    });
                });
            };

            tools.move = function (index, delta) {
                var target = index + delta;
                if (target < 0 || target >= tools.mergeItems.length) { return; }
                var item = tools.mergeItems.splice(index, 1)[0];
                tools.mergeItems.splice(target, 0, item);
            };

            tools.remove = function (index) {
                tools.mergeItems.splice(index, 1);
            };

            // ----- Run -----
            tools.canRun = function () {
                if (tools.busy) { return false; }
                switch (tools.active) {
                    case 'merge': return tools.mergeItems.length >= 2;
                    case 'split':
                        return tools.split.mode !== 'chunks' || tools.split.pagesPerFile >= 1;
                    default: return vm().hasDocument();
                }
            };

            tools.run = function () {
                if (!tools.canRun()) { return; }
                var source = vm().source;
                var fileName = vm().fileName;
                var operation;

                switch (tools.active) {
                    case 'merge': operation = toolsService.merge(tools.mergeItems, source); break;
                    case 'split': operation = toolsService.split(source, fileName, tools.split); break;
                    case 'compress': operation = toolsService.compress(source, fileName, tools.compress); break;
                    case 'convert': operation = toolsService.convert(source, fileName, tools.convert); break;
                    default: return;
                }

                tools.busy = true;
                tools.error = '';
                tools.result = '';
                operation.then(function (message) {
                    if (message) {
                        tools.result = message;
                        vm().status = message;
                    }
                }, function (message) {
                    tools.error = typeof message === 'string' ? message : 'Something went wrong. Please try again.';
                }).finally(function () {
                    tools.busy = false;
                });
            };

            // ----- Save highlights into a copy of the PDF (no dialog on the web; save dialog on desktop) -----
            tools.saving = false;

            tools.canSaveHighlights = function () {
                return vm().hasDocument() && vm().highlights.length > 0 && !vm().busy && !tools.saving;
            };

            tools.saveHighlights = function () {
                if (!tools.canSaveHighlights()) { return; }
                var view = vm();
                tools.saving = true;
                view.error = '';
                view.status = 'Saving a copy with highlights\u2026';
                toolsService.saveHighlights(view.source, view.fileName, view.highlights).then(function (message) {
                    view.status = message || 'Not saved.';
                }, function (message) {
                    var text = typeof message === 'string' ? message : 'Unable to save the highlights.';
                    view.error = text;
                    view.status = text;
                }).finally(function () {
                    tools.saving = false;
                });
            };

            // Ctrl+S / File > Save copy with highlights. There is no plain "Save": the original PDF is never changed.
            $scope.$on('save-copy', function () {
                var view = vm();
                if (tools.canSaveHighlights()) {
                    tools.saveHighlights();
                } else if (view.hasDocument() && !view.highlights.length && !tools.saving) {
                    view.status = 'Nothing to save yet: add a highlight first. Saving always makes a copy; the original is not changed.';
                }
            });

            tools.formatSize = function (bytes) {
                if (!bytes) { return ''; }
                if (bytes >= 1073741824) { return (bytes / 1073741824).toFixed(1) + ' GB'; }
                if (bytes >= 1048576) { return (bytes / 1048576).toFixed(1) + ' MB'; }
                return Math.max(1, Math.round(bytes / 1024)) + ' KB';
            };

            // While the dialog is open, keys belong to it: Esc closes it and the viewer's
            // shortcuts (arrows, Delete) must not act on the page behind it.
            function onKeyDown(event) {
                if (!tools.active) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') {
                    $scope.$apply(tools.close);
                }
            }

            // Capture phase, so this runs before the viewer's keyboard handler.
            $document[0].addEventListener('keydown', onKeyDown, true);
            $scope.$on('$destroy', function () {
                $document[0].removeEventListener('keydown', onKeyDown, true);
            });
        }]);
})();
