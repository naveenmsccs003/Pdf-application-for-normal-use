(function () {
    'use strict';

    /** Toolbar and status bar state: open, navigate, zoom, fit and highlight commands. */
    angular.module('pdfViewerApp').controller('PdfViewerController', [
        '$scope', '$document', '$window', 'pdfService', 'highlightService', 'themeService', 'desktopService', 'VIEWER_CONFIG',
        function ($scope, $document, $window, pdfService, highlightService, themeService, desktopService, VIEWER_CONFIG) {
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
                        return showDocument(uploaded.fileName, pageCount);
                    });
                }).catch(openFailed).finally(function () {
                    vm.busy = false;
                });
            };

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

            vm.resetZoom = function () {
                if (vm.hasDocument()) { setManualZoom(1); }
            };

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
            function onKeyDown(event) {
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
                narrowQuery.removeEventListener('change', onWidthChange);
                pdfService.close();
            });
        }]);
})();
