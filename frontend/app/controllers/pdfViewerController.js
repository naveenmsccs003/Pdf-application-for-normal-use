(function () {
    'use strict';

    /** Menu bar, toolbar and status bar state: open, recent files, navigate, zoom, fit and highlight commands. */
    angular.module('pdfViewerApp').controller('PdfViewerController', [
        '$scope', '$document', '$window', '$timeout', 'pdfService', 'highlightService', 'themeService', 'desktopService',
        'recentFilesService', 'VIEWER_CONFIG',
        function ($scope, $document, $window, $timeout, pdfService, highlightService, themeService, desktopService,
                  recentFilesService, VIEWER_CONFIG) {
            var vm = this;
            var zoomSteps = VIEWER_CONFIG.zoomSteps;
            var EPSILON = 0.001;

            vm.fileName = '';
            vm.docVersion = 0;          // increments for each opened document
            vm.pageCount = 0;
            vm.currentPage = 0;
            vm.pageInput = '';
            vm.scale = 1;
            vm.fitMode = null;          // 'page' | 'width' | null (manual zoom)
            vm.highlightMode = false;
            vm.highlights = highlightService.all;
            vm.selectedHighlightId = null;
            vm.busy = false;
            vm.error = '';
            vm.status = 'Open a PDF to get started.';
            vm.viewer = null;           // API exposed by the pdf-viewer directive
            vm.source = null;           // where the open document lives, for the PDF tools:
                                        // { kind: 'web', id } (upload id) or { kind: 'desktop' }
            vm.isDesktop = desktopService.isDesktop;
            vm.recentFiles = [];        // [{ id, name, detail, missing }], newest first
            vm.zoomInput = '100%';
            // Shortcut labels shown in the menus.
            vm.modKey = /Mac|iPhone|iPad/.test($window.navigator.platform || '') ? '\u2318' : 'Ctrl+';

            // Side panels start open on wide screens; on narrow screens they slide over the page when
            // opened, so they close when the window becomes narrow (keep in sync with the CSS breakpoint).
            var narrowQuery = $window.matchMedia('(max-width: 999px)');
            vm.showThumbnails = !narrowQuery.matches;
            vm.showMarkups = !narrowQuery.matches;
            function onWidthChange(event) {
                if (event.matches) {
                    $scope.$applyAsync(function () {
                        vm.showThumbnails = false;
                        vm.showMarkups = false;
                    });
                }
            }
            narrowQuery.addEventListener('change', onWidthChange);

            vm.hasDocument = function () { return vm.pageCount > 0; };

            // ----- Open -----
            /** Web: uploads the selected file. Desktop: asks the host to show the native open dialog. */
            vm.openFile = function (file) {
                if (vm.isDesktop) {
                    if (!vm.busy) {
                        desktopService.send('open');
                    }
                    return;
                }

                var validationError = pdfService.validateFile(file);
                if (validationError) {
                    showError(validationError);
                    return;
                }

                vm.busy = true;
                vm.error = '';
                vm.status = 'Uploading ' + file.name + '…';

                pdfService.upload(file).then(function (uploaded) {
                    vm.status = 'Opening ' + uploaded.fileName + '…';
                    return pdfService.load(VIEWER_CONFIG.apiBase + '/' + uploaded.id).then(function (pageCount) {
                        vm.source = { kind: 'web', id: uploaded.id };
                        recentFilesService.add(file).then(refreshWebRecent);
                        return showDocument(uploaded.fileName, pageCount);
                    });
                }).catch(openFailed).finally(function () {
                    vm.busy = false;
                });
            };

            /** File > Open: the native dialog on desktop, the browser's file picker on the web. */
            vm.chooseFile = function () {
                if (vm.busy) { return; }
                if (vm.isDesktop) {
                    vm.openFile();
                } else {
                    var input = $document[0].getElementById('menu-open-input');
                    if (input) { input.click(); }
                }
            };

            // ----- Recent files -----
            // Desktop: the host keeps file paths and reopens from disk. Web: the files themselves are kept in
            // this browser's storage (recentFilesService), because a page cannot reopen a file by path.
            function refreshWebRecent() {
                return recentFilesService.list().then(function (rows) {
                    vm.recentFiles = rows.map(function (r) {
                        return { id: r.id, name: r.name, detail: formatSize(r.size) + ' \u00b7 ' + new Date(r.openedAt).toLocaleDateString(), missing: false };
                    });
                });
            }

            vm.openRecent = function (item) {
                if (vm.busy || !item) { return; }
                if (vm.isDesktop) {
                    desktopService.send('open-recent', { path: item.id });
                    return;
                }
                recentFilesService.get(item.id).then(function (file) {
                    if (file) {
                        vm.openFile(file);
                    } else {
                        showError(item.name + ' is no longer stored in this browser. Open it again from your computer.');
                        refreshWebRecent();
                    }
                });
            };

            vm.clearRecent = function () {
                if (vm.isDesktop) {
                    desktopService.send('clear-recent');
                } else {
                    recentFilesService.clear().then(refreshWebRecent);
                }
            };

            function formatSize(bytes) {
                if (bytes < 1024 * 1024) { return Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
                return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            }

            if (!vm.isDesktop) {
                refreshWebRecent();
            }

            // Desktop host messages (the host opens the file from disk with PDFium).
            if (vm.isDesktop) {
                desktopService.on('opening', function (message) {
                    vm.busy = true;
                    vm.error = '';
                    vm.status = 'Opening ' + message.fileName + '\u2026';
                });
                desktopService.on('opened', function (message) {
                    pdfService.loadLocal(message).then(function (pageCount) {
                        vm.source = { kind: 'desktop' };
                        return showDocument(message.fileName, pageCount);
                    }).catch(openFailed).finally(function () {
                        vm.busy = false;
                    });
                });
                desktopService.on('open-error', function (message) {
                    vm.busy = false;
                    showError(message.message);
                });
                desktopService.on('open-cancelled', function () {
                    vm.busy = false;
                });
                desktopService.on('recent-files', function (message) {
                    vm.recentFiles = (message.files || []).map(function (f) {
                        return { id: f.path, name: f.fileName, detail: f.folder, missing: !f.exists };
                    });
                });
                // Tell the host once the viewer exists, so a file passed on the command line can be opened.
                var stopWatching = $scope.$watch(function () { return vm.viewer; }, function (viewer) {
                    if (viewer) {
                        stopWatching();
                        desktopService.send('ready');
                    }
                });
            }

            /** Closes the document tab and returns to the start screen. */
            vm.closeDocument = function () {
                if (!vm.hasDocument() || vm.busy) {
                    return;
                }
                pdfService.close();
                desktopService.send('close');
                highlightService.clear();
                vm.selectedHighlightId = null;
                vm.highlightMode = false;
                vm.source = null;
                vm.fileName = '';
                vm.pageCount = 0;
                vm.currentPage = 0;
                vm.pageInput = '';
                vm.fitMode = null;
                vm.scale = 1;
                vm.error = '';
                vm.docVersion++;
                vm.status = 'Open a PDF to get started.';
            };

            function showDocument(fileName, pageCount) {
                highlightService.clear();
                vm.selectedHighlightId = null;
                vm.highlightMode = false;
                vm.fileName = fileName;
                vm.pageCount = pageCount;
                setPage(1);
                vm.docVersion++;
                return showInitialPage();
            }

            function openFailed(message) {
                showError(typeof message === 'string' ? message : 'Unable to open this PDF.');
            }

            // Start at 100%, or fit the width if the page would not fit horizontally.
            function showInitialPage() {
                return pdfService.getPageSize(1).then(function (size) {
                    var available = vm.viewer.getAvailableSize();
                    if (size.width > available.width) {
                        vm.fitMode = 'width';
                        vm.scale = computeFitScale(size, 'width');
                    } else {
                        vm.fitMode = null;
                        vm.scale = 1;
                    }
                });
            }

            // ----- Page navigation -----
            vm.canGoPrevious = function () { return vm.hasDocument() && vm.currentPage > 1 && !vm.busy; };
            vm.canGoNext = function () { return vm.hasDocument() && vm.currentPage < vm.pageCount && !vm.busy; };
            vm.previousPage = function () { if (vm.canGoPrevious()) { goToPage(vm.currentPage - 1); } };
            vm.nextPage = function () { if (vm.canGoNext()) { goToPage(vm.currentPage + 1); } };
            vm.firstPage = function () { if (vm.canGoPrevious()) { goToPage(1); } };
            vm.lastPage = function () { if (vm.canGoNext()) { goToPage(vm.pageCount); } };

            /** From the thumbnails panel. */
            vm.goToPage = function (page) {
                if (vm.hasDocument() && !vm.busy && page !== vm.currentPage) {
                    goToPage(page);
                }
                if (narrowQuery.matches) {
                    vm.showThumbnails = false;   // the panel covers the page on narrow screens
                }
            };

            /** Find: shows the page of a match (keeping Fit Page / Fit Width). */
            vm.showPage = function (page) {
                if (vm.hasDocument() && !vm.busy && page !== vm.currentPage) {
                    goToPage(page);
                }
            };

            vm.submitPageInput = function () {
                if (!vm.hasDocument() || vm.busy) {
                    return;
                }
                var page = Number(vm.pageInput);
                if (!Number.isInteger(page) || page < 1 || page > vm.pageCount) {
                    showError('Please enter a page number between 1 and ' + vm.pageCount + '.');
                    vm.pageInput = vm.currentPage;
                    return;
                }
                if (page !== vm.currentPage) {
                    goToPage(page);
                }
            };

            function goToPage(page, selectHighlightId) {
                vm.selectedHighlightId = selectHighlightId || null;
                vm.error = '';
                if (vm.fitMode) {
                    // Pages can differ in size, so recompute the fit before showing the page.
                    pdfService.getPageSize(page).then(function (size) {
                        vm.scale = computeFitScale(size, vm.fitMode);
                        setPage(page);
                    }, renderError);
                } else {
                    setPage(page);
                }
            }

            function setPage(page) {
                vm.currentPage = page;
                vm.pageInput = page;
            }

            // ----- Zoom -----
            vm.zoomPercent = function () { return Math.round(vm.scale * 100) + '%'; };
            vm.canZoomIn = function () { return vm.hasDocument() && vm.scale < zoomSteps[zoomSteps.length - 1] - EPSILON; };
            vm.canZoomOut = function () { return vm.hasDocument() && vm.scale > zoomSteps[0] + EPSILON; };

            vm.zoomIn = function () {
                if (!vm.canZoomIn()) { return; }
                setManualZoom(zoomSteps.find(function (s) { return s > vm.scale + EPSILON; }));
            };

            vm.zoomOut = function () {
                if (!vm.canZoomOut()) { return; }
                var smaller = zoomSteps.filter(function (s) { return s < vm.scale - EPSILON; });
                setManualZoom(smaller[smaller.length - 1]);
            };

            /** Actual size: 100%. */
            vm.resetZoom = function () {
                if (vm.hasDocument()) { setManualZoom(1); }
            };

            // Custom zoom: the percentage in the status bar is an input. Accepts "135" or "135%";
            // values outside the zoom range are clamped to it.
            var minZoom = zoomSteps[0];
            var maxZoom = zoomSteps[zoomSteps.length - 1];
            $scope.$watch(function () { return vm.scale; }, function () { vm.revertZoomInput(); });

            vm.revertZoomInput = function () {
                vm.zoomInput = vm.zoomPercent();
            };

            vm.zoomRangeText = Math.round(minZoom * 100) + '% and ' + Math.round(maxZoom * 100) + '%';

            /** "135" or "135%" -> scale clamped to the zoom range; null if it is not a positive number. */
            function parseZoom(value) {
                var text = String(value == null ? '' : value).trim().replace(/%$/, '').trim();
                var percent = Number(text);
                if (text === '' || !isFinite(percent) || percent <= 0) { return null; }
                return Math.min(maxZoom, Math.max(minZoom, percent / 100));
            }

            function applyZoom(scale) {
                if (Math.abs(scale - vm.scale) > EPSILON || vm.fitMode) {
                    setManualZoom(scale);
                }
            }

            vm.applyZoomInput = function () {
                if (!vm.hasDocument()) { vm.revertZoomInput(); return; }
                var scale = parseZoom(vm.zoomInput);
                if (scale === null) {
                    showError('Enter a zoom between ' + vm.zoomRangeText + '.');
                } else {
                    applyZoom(scale);
                }
                vm.revertZoomInput();
            };

            // Zoom > Custom zoom: a small dialog asking for a percentage.
            vm.customZoom = null;   // { value, error } while the dialog is open

            vm.openCustomZoom = function () {
                if (!vm.hasDocument()) { return; }
                vm.customZoom = { value: String(Math.round(vm.scale * 100)), error: '' };
                $timeout(function () {
                    var input = $document[0].getElementById('custom-zoom-input');
                    if (input) { input.focus(); input.select(); }
                });
            };

            vm.closeCustomZoom = function () {
                vm.customZoom = null;
            };

            vm.applyCustomZoom = function () {
                if (!vm.customZoom) { return; }
                var scale = parseZoom(vm.customZoom.value);
                if (scale === null) {
                    vm.customZoom.error = 'Enter a number between ' + vm.zoomRangeText.replace(/%/g, '') + '.';
                    return;
                }
                applyZoom(scale);
                vm.closeCustomZoom();
            };

            // While the dialog is open, keys belong to it: Esc closes it, and the viewer's and find
            // shortcuts must not act on the page behind it. Capture phase, so this runs before them.
            function onCustomZoomKey(event) {
                if (!vm.customZoom) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') {
                    $scope.$apply(vm.closeCustomZoom);
                }
            }
            $document[0].addEventListener('keydown', onCustomZoomKey, true);

            function setManualZoom(scale) {
                vm.fitMode = null;
                vm.scale = scale;
            }

            // ----- Fit Page / Fit Width -----
            vm.fitPage = function () { applyFit('page'); };
            vm.fitWidth = function () { applyFit('width'); };

            function applyFit(mode) {
                if (!vm.hasDocument()) { return; }
                vm.fitMode = mode;
                pdfService.getPageSize(vm.currentPage).then(function (size) {
                    if (vm.fitMode === mode) {
                        vm.scale = computeFitScale(size, mode);
                    }
                }, renderError);
            }

            function computeFitScale(pageSize, mode) {
                var available = vm.viewer.getAvailableSize();
                var widthScale = available.width / pageSize.width;
                var scale = mode === 'page'
                    ? Math.min(widthScale, available.height / pageSize.height)
                    : widthScale;
                // Round down slightly so rounding never produces a scrollbar.
                return Math.floor(scale * 1000) / 1000;
            }

            vm.onViewerResize = function () {
                if (vm.fitMode) {
                    applyFit(vm.fitMode);
                }
            };

            // ----- Highlights -----
            vm.toggleHighlightMode = function () {
                if (!vm.hasDocument()) { return; }
                vm.highlightMode = !vm.highlightMode;
                vm.status = vm.highlightMode ? 'Highlight mode: drag over the page to highlight.' : pageStatus();
            };

            vm.addHighlight = function (pageNumber, rect) {
                var highlight = highlightService.add(pageNumber, rect);
                vm.selectedHighlightId = highlight.id;
            };

            vm.selectHighlight = function (id) {
                vm.selectedHighlightId = id;
            };

            /** From the markups list: shows the highlight's page and selects it. */
            vm.goToHighlight = function (highlight) {
                if (highlight.pageNumber === vm.currentPage) {
                    vm.selectedHighlightId = highlight.id;
                } else if (!vm.busy) {
                    goToPage(highlight.pageNumber, highlight.id);
                }
            };

            vm.removeHighlight = function (id) {
                highlightService.remove(id);
                if (vm.selectedHighlightId === id) {
                    vm.selectedHighlightId = null;
                }
            };

            vm.removeSelectedHighlight = function () {
                if (vm.selectedHighlightId !== null) {
                    vm.removeHighlight(vm.selectedHighlightId);
                }
            };

            vm.clearHighlights = function () {
                highlightService.clear();
                vm.selectedHighlightId = null;
            };

            // ----- Status and errors -----
            vm.onPageRendered = function () {
                if (!vm.highlightMode) {
                    vm.status = pageStatus();
                }
            };

            function pageStatus() {
                var count = vm.highlights.length;
                return vm.fileName + (count ? ' · ' + count + ' highlight' + (count === 1 ? '' : 's') : '');
            }

            function renderError() {
                showError('Unable to display this page.');
            }
            vm.onRenderError = renderError;

            function showError(message) {
                vm.error = message;
                vm.status = message;
            }

            vm.dismissError = function () {
                vm.error = '';
                vm.status = vm.hasDocument() ? pageStatus() : 'Open a PDF to get started.';
            };

            // ----- Theme -----
            vm.isDarkTheme = themeService.isDark;
            vm.toggleTheme = themeService.toggle;

            // ----- Keyboard shortcuts -----
            // Ctrl/Cmd shortcuts (shown in the menus) work everywhere, also while typing in a box.
            // Close has no shortcut: browsers reserve Ctrl+W for closing the tab.
            function onShortcut(event) {
                if (!(event.ctrlKey || event.metaKey) || event.altKey) { return false; }
                var key = event.key.toLowerCase();
                var command = null;
                if (key === 'o') {
                    command = vm.chooseFile;
                } else if (key === 's') {
                    command = function () { $scope.$broadcast('save-copy'); };
                } else if (vm.hasDocument() && (key === '=' || key === '+')) {
                    command = vm.zoomIn;
                } else if (vm.hasDocument() && key === '-') {
                    command = vm.zoomOut;
                } else if (vm.hasDocument() && key === '0') {
                    command = vm.resetZoom;
                }
                if (!command) { return false; }
                event.preventDefault();   // instead of the browser's own open / save / page zoom
                $scope.$apply(command);
                return true;
            }

            function onKeyDown(event) {
                if (onShortcut(event)) {
                    return;
                }
                var tag = event.target && event.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || !vm.hasDocument()) {
                    return;
                }
                $scope.$apply(function () {
                    if ((event.key === 'Delete' || event.key === 'Backspace') && vm.selectedHighlightId !== null) {
                        vm.removeSelectedHighlight();
                        event.preventDefault();
                    } else if (event.key === 'Escape') {
                        vm.selectedHighlightId = null;
                        if (vm.highlightMode) { vm.toggleHighlightMode(); }
                    } else if (event.key === 'ArrowRight') {
                        vm.nextPage();
                    } else if (event.key === 'ArrowLeft') {
                        vm.previousPage();
                    }
                });
            }

            $document.on('keydown', onKeyDown);
            $scope.$on('$destroy', function () {
                $document.off('keydown', onKeyDown);
                $document[0].removeEventListener('keydown', onCustomZoomKey, true);
                narrowQuery.removeEventListener('change', onWidthChange);
                pdfService.close();
            });
        }]);
})();
