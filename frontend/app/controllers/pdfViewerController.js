(function () {
    'use strict';

    /** Menu bar, toolbar and status bar state: open, recent files, navigate, zoom, fit and highlight commands. */
    angular.module('pdfViewerApp').controller('PdfViewerController', [
        '$scope', '$document', '$window', '$timeout', 'pdfService', 'highlightService', 'themeService', 'desktopService',
        'recentFilesService', 'markupGeometry', 'scaleService', 'compareService', 'revisionService', 'reportService',
        'toolsService', 'pagesService', 'VIEWER_CONFIG', '$q',
        function ($scope, $document, $window, $timeout, pdfService, highlightService, themeService, desktopService,
                  recentFilesService, markupGeometry, scaleService, compareService, revisionService, reportService,
                  toolsService, pagesService, VIEWER_CONFIG, $q) {
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
            vm.tool = 'pan';            // 'pan' or the markup type being drawn (see markupGeometry)
            vm.markupColors = [
                { name: 'Red', value: '#e01b24' }, { name: 'Blue', value: '#1c71d8' },
                { name: 'Green', value: '#26a269' }, { name: 'Black', value: '#000000' }
            ];
            vm.markupColor = vm.markupColors[0].value;
            vm.highlights = highlightService.all;   // all markups
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
            vm.modified = false;        // page edits not saved yet, or a new document that was never saved
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
                if (vm.modified) {
                    guardUnsaved(function () { vm.openFile(file); });
                    return;
                }
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
                        return showDocument(uploaded.fileName, pageCount, uploaded.size);
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
                if (vm.modified) {
                    guardUnsaved(function () { vm.openRecent(item); });
                    return;
                }
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
                        return showDocument(message.fileName, pageCount, message.size, message.untitled);
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
                if (vm.modified) {
                    guardUnsaved(vm.closeDocument);
                    return;
                }
                pdfService.close();
                desktopService.send('close');
                highlightService.clear();
                vm.selectedHighlightId = null;
                vm.tool = 'pan';
                vm.noteDialog = null;
                vm.scaleDialog = null;
                vm.editDialog = null;
                scaleService.clear();
                closeRevisionWork();
                revisionService.useDocument(null);
                exitFullScreen();
                vm.source = null;
                vm.fileName = '';
                vm.modified = false;
                vm.pageCount = 0;
                vm.currentPage = 0;
                vm.pageInput = '';
                vm.fitMode = null;
                vm.scale = 1;
                vm.error = '';
                vm.docVersion++;
                vm.status = 'Open a PDF to get started.';
            };

            function showDocument(fileName, pageCount, size, untitled) {
                vm.modified = !!untitled;
                highlightService.clear();
                vm.selectedHighlightId = null;
                vm.tool = 'pan';
                vm.noteDialog = null;
                vm.scaleDialog = null;
                vm.editDialog = null;
                scaleService.clear();
                closeRevisionWork();
                revisionService.useDocument(fileName, size);
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

            // ----- View: single page or continuous scrolling; full screen -----
            var VIEW_MODE_KEY = 'pdfViewer.viewMode';
            vm.viewMode = (function () {
                try { return $window.localStorage.getItem(VIEW_MODE_KEY) === 'continuous' ? 'continuous' : 'single'; } catch (e) { return 'single'; }
            }());

            vm.setViewMode = function (mode) {
                vm.viewMode = mode === 'continuous' ? 'continuous' : 'single';
                try { $window.localStorage.setItem(VIEW_MODE_KEY, vm.viewMode); } catch (e) { /* not remembered */ }
            };

            /** Continuous view: the page scrolled into view (or clicked) becomes the current page. */
            vm.onPageScrolled = function (page) {
                if (!vm.hasDocument() || page < 1 || page > vm.pageCount || page === vm.currentPage) { return; }
                vm.selectedHighlightId = null;
                setPage(page);
            };

            // Full screen: only the page and a small bar. The browser's full screen on the web, the window on desktop;
            // Esc (or the bar's button, or Ctrl+L) leaves it; PageUp / PageDown turn pages.
            vm.fullScreen = false;

            vm.toggleFullScreen = function () {
                if (vm.fullScreen) { exitFullScreen(); } else { enterFullScreen(); }
            };

            function enterFullScreen() {
                if (!vm.hasDocument()) { return; }
                vm.fullScreen = true;
                if (vm.isDesktop) {
                    desktopService.send('full-screen', { on: true });
                } else if ($document[0].documentElement.requestFullscreen) {
                    // Without it (or if refused) the app still fills the window.
                    $q.when($document[0].documentElement.requestFullscreen()).catch(angular.noop);
                }
                vm.status = 'Full screen: Esc or ' + vm.modKey + 'L to leave.';
            }

            function exitFullScreen() {
                if (!vm.fullScreen) { return; }
                vm.fullScreen = false;
                if (vm.isDesktop) {
                    desktopService.send('full-screen', { on: false });
                } else if ($document[0].fullscreenElement && $document[0].exitFullscreen) {
                    $q.when($document[0].exitFullscreen()).catch(angular.noop);
                }
                vm.status = vm.hasDocument() ? pageStatus() : vm.status;
            }

            // The browser left full screen itself (its own Esc).
            function onFullscreenChange() {
                if (!$document[0].fullscreenElement && vm.fullScreen && !vm.isDesktop) { $scope.$apply(exitFullScreen); }
            }
            $document[0].addEventListener('fullscreenchange', onFullscreenChange);

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

            // While a dialog (custom zoom, note text) is open, keys belong to it: Esc closes it, and the
            // viewer's and find shortcuts must not act on the page behind it. Capture phase, so this runs first.
            function onCustomZoomKey(event) {
                if (!vm.customZoom && !vm.noteDialog && !vm.scaleDialog && !vm.editDialog && !vm.revisionsDialog && !vm.reportDialog &&
                    !vm.pagesDialog && !vm.newDialog && !vm.saveAsDialog && !vm.unsavedDialog) { return; }
                // The colour pop-up (Edit markup dialog) handles its own keys, Esc included.
                var popover = $document[0].querySelector('.color-popover');
                if (popover && popover.contains(event.target)) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') {
                    $scope.$apply(function () {
                        vm.closeCustomZoom(); vm.closeNoteDialog(); vm.closeScaleDialog(); vm.closeEditDialog();
                        vm.revisionsDialog = null; vm.reportDialog = null;
                        if (!vm.pagesDialog || !vm.pagesDialog.busy) { vm.pagesDialog = null; }
                        vm.newDialog = null; vm.saveAsDialog = null; vm.unsavedDialog = null;
                    });
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (vm.noteDialog || vm.editDialog)) {
                    event.preventDefault();
                    $scope.$apply(vm.noteDialog ? vm.applyNoteDialog : vm.applyEditDialog);
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

            // ----- New / Save / Save As -----
            vm.saving = false;
            vm.newDialog = null;        // { count, size, orientation, error } while open
            vm.saveAsDialog = null;     // web: { name, error } while open
            vm.unsavedDialog = null;    // { action } while asking what to do with unsaved page changes
            vm.pageSizes = pagesService.PAGE_SIZES;

            /** Asks before `action` would lose unsaved page changes: save first, discard them, or cancel. */
            function guardUnsaved(action) {
                if (!vm.modified || !vm.hasDocument()) { action(); return; }
                vm.unsavedDialog = { action: action };
            }

            vm.discardAndContinue = function () {
                var d = vm.unsavedDialog;
                vm.unsavedDialog = null;
                vm.modified = false;
                if (d) { d.action(); }
            };

            vm.saveAndContinue = function () {
                var d = vm.unsavedDialog;
                vm.unsavedDialog = null;
                // The action runs once saved (desktop: a new document asks where first).
                saveDocument(false, vm.fileName).then(function (saved) { if (saved && d) { d.action(); } });
            };

            vm.canSave = function () { return vm.hasDocument() && !vm.busy && !vm.saving; };

            /**
             * Save: the document with its page changes, to its file (desktop; a new document asks where) or as a
             * download (web). Save As asks for the file (desktop) or the name (web). Markups are not part of it:
             * Save copy with markups writes them into a copy.
             */
            vm.save = function (saveAs) {
                if (!vm.canSave()) { return; }
                if (!vm.isDesktop && saveAs) {
                    vm.saveAsDialog = { name: vm.fileName, error: '' };
                    $timeout(function () {
                        var input = $document[0].getElementById('save-as-input');
                        if (input) { input.focus(); input.setSelectionRange(0, Math.max(0, input.value.length - 4)); }
                    });
                    return;
                }
                saveDocument(saveAs, vm.fileName);
            };

            vm.applySaveAs = function () {
                var d = vm.saveAsDialog;
                if (!d) { return; }
                var name = String(d.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
                if (!name || /^\.pdf$/i.test(name)) { d.error = 'Type a file name.'; return; }
                if (!/\.pdf$/i.test(name)) { name += '.pdf'; }
                vm.saveAsDialog = null;
                saveDocument(true, name);
            };

            /** Resolves with true once saved, false if cancelled or failed. */
            function saveDocument(saveAs, name) {
                vm.saving = true;
                vm.error = '';
                vm.status = 'Saving…';
                return pagesService.save(vm.source, name, saveAs, toolsService.saveBlob).then(function (result) {
                    if (!result) {
                        vm.status = 'Not saved.';
                        return false;
                    }
                    vm.fileName = result.fileName;
                    vm.modified = false;
                    vm.status = result.message + (vm.highlights.length ? ' Markups are not in it: use Save copy with markups for those.' : '');
                    return true;
                }, function (message) {
                    showError(typeof message === 'string' ? message : 'Unable to save the PDF.');
                    return false;
                }).finally(function () { vm.saving = false; });
            }

            vm.openNewDialog = function () {
                if (vm.busy) { return; }
                guardUnsaved(function () {
                    vm.newDialog = { count: 1, size: 'a4', orientation: 'portrait', error: '' };
                    $timeout(function () {
                        var input = $document[0].getElementById('new-count-input');
                        if (input) { input.focus(); input.select(); }
                    });
                });
            };

            function pageSize(size, orientation) {
                var s = pagesService.PAGE_SIZES[size] || pagesService.PAGE_SIZES.a4;
                return orientation === 'landscape' ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
            }

            vm.applyNewDialog = function () {
                var d = vm.newDialog;
                if (!d) { return; }
                var count = Number(d.count);
                if (!Number.isInteger(count) || count < 1 || count > 1000) { d.error = 'Enter a number of pages from 1 to 1000.'; return; }
                var size = pageSize(d.size, d.orientation);
                vm.newDialog = null;
                vm.busy = true;
                vm.error = '';
                vm.status = 'Creating a new PDF…';
                pagesService.create(count, size.width, size.height).then(function (created) {
                    if (!created) { return; }      // desktop: the host answers with "opened"
                    return pdfService.load(VIEWER_CONFIG.apiBase + '/' + created.id).then(function (pageCount) {
                        vm.source = { kind: 'web', id: created.id };
                        return showDocument(created.fileName, pageCount, created.size, true);
                    });
                }).catch(openFailed).finally(function () {
                    if (!vm.isDesktop) { vm.busy = false; }
                });
            };

            // ----- Pages: insert, delete, extract, reorder, duplicate, rotate, replace -----
            vm.pagesDialog = null;      // { op, pages, at, position, degrees, count, size, orientation, file, filePages, error, busy }
            vm.pageOps = {
                blank: { title: 'Insert blank pages', button: 'Insert' },
                insert: { title: 'Insert pages from a file', button: 'Insert' },
                delete: { title: 'Delete pages', button: 'Delete' },
                extract: { title: 'Extract pages', button: 'Extract' },
                duplicate: { title: 'Duplicate pages', button: 'Duplicate' },
                move: { title: 'Move pages', button: 'Move' },
                rotate: { title: 'Rotate pages', button: 'Rotate' },
                replace: { title: 'Replace pages', button: 'Replace' }
            };

            vm.openPagesDialog = function (op, degrees) {
                if (!vm.hasDocument() || vm.busy || !vm.pageOps[op]) { return; }
                vm.pagesDialog = {
                    op: op, pages: String(vm.currentPage), at: vm.currentPage,
                    position: op === 'move' ? 'before' : 'after', degrees: String(degrees || 90),
                    count: 1, size: 'a4', orientation: 'portrait', file: null, filePages: '', error: '', busy: false
                };
                $timeout(function () {
                    var input = $document[0].getElementById(op === 'blank' || op === 'insert' ? 'pages-at-input' : 'pages-input');
                    if (input) { input.focus(); input.select(); }
                });
            };

            vm.closePagesDialog = function () {
                if (vm.pagesDialog && !vm.pagesDialog.busy) { vm.pagesDialog = null; }
            };

            /** The file to insert / replace with: a File on the web, a picked { id, name } on desktop. */
            vm.setPagesFile = function (file) {
                var d = vm.pagesDialog;
                if (!d) { return; }
                var problem = pdfService.validateFile(file);
                d.error = problem || '';
                d.file = problem ? null : file;
            };

            vm.pickPagesFile = function () {
                var d = vm.pagesDialog;
                toolsService.pickDesktopFiles().then(function (files) {
                    if (d === vm.pagesDialog && files.length) {
                        d.file = files[0];
                        d.error = '';
                    }
                });
            };

            /** Where pages go (blank, insert, move): before this page number; pageCount + 1 is the end. */
            function insertionPoint(d) {
                if (d.position === 'start') { return 1; }
                if (d.position === 'end') { return vm.pageCount + 1; }
                var at = Number(d.at);
                if (!Number.isInteger(at) || at < 1 || at > vm.pageCount) { return null; }
                return d.position === 'before' ? at : at + 1;
            }

            vm.applyPagesDialog = function () {
                var d = vm.pagesDialog;
                if (!d || d.busy) { return; }
                var op = d.op, o = { degrees: Number(d.degrees) };
                d.error = '';

                if (op !== 'blank' && op !== 'insert') {
                    var parsed = pagesService.parsePages(d.pages, vm.pageCount);
                    if (parsed.error) { d.error = parsed.error; return; }
                    o.pages = parsed.pages;
                }
                if (op === 'blank' || op === 'insert' || op === 'move') {
                    o.before = insertionPoint(d);
                    if (o.before === null) { d.error = 'Enter a page number from 1 to ' + vm.pageCount + '.'; return; }
                }
                if (op === 'blank') {
                    o.count = Number(d.count);
                    if (!Number.isInteger(o.count) || o.count < 1 || o.count > 1000) { d.error = 'Enter a number of pages from 1 to 1000.'; return; }
                    var size = pageSize(d.size, d.orientation);
                    o.width = size.width;
                    o.height = size.height;
                }
                if (op === 'insert' || op === 'replace') {
                    if (!d.file) { d.error = 'Choose the PDF to take the pages from.'; return; }
                    if (String(d.filePages || '').trim()) {
                        var fromFile = pagesService.parsePages(d.filePages, 100000);
                        if (fromFile.error) { d.error = fromFile.error.replace('outside pages 1 to 100000', 'not valid'); return; }
                        o.filePages = fromFile.pages;
                    }
                }

                var built = pagesService.layoutFor(op, vm.pageCount, o);
                if (built.error) { d.error = built.error; return; }

                if (op === 'extract') {
                    d.busy = true;
                    toolsService.extractPages(vm.source, vm.fileName, built.layout).then(function (message) {
                        vm.status = message || 'Not saved.';
                        vm.pagesDialog = null;
                    }, function (message) {
                        d.error = typeof message === 'string' ? message : 'Unable to extract the pages.';
                    }).finally(function () { d.busy = false; });
                    return;
                }
                editPages(d, op, o, built.layout);
            };

            var EDIT_DONE = {
                blank: function (n) { return 'Inserted ' + n + ' blank page' + (n === 1 ? '' : 's') + '.'; },
                insert: function (n) { return 'Inserted ' + n + ' page' + (n === 1 ? '' : 's') + '.'; },
                delete: function (n) { return 'Deleted ' + n + ' page' + (n === 1 ? '' : 's') + '.'; },
                duplicate: function (n) { return 'Duplicated ' + n + ' page' + (n === 1 ? '' : 's') + '.'; },
                move: function (n) { return 'Moved ' + n + ' page' + (n === 1 ? '' : 's') + '.'; },
                rotate: function (n) { return 'Rotated ' + n + ' page' + (n === 1 ? '' : 's') + '.'; },
                replace: function (n) { return 'Replaced ' + n + ' page' + (n === 1 ? '' : 's') + '.'; }
            };

            /** Runs a page edit, then shows the result with the markups and scales moved along with their pages. */
            function editPages(d, op, o, layout) {
                // Markups on pages that turn need the page size to turn with them.
                var sizes = {}, marked = {};
                vm.highlights.forEach(function (m) { marked[m.pageNumber] = true; });
                var turning = layout.filter(function (spec) { return spec.source === 0 && spec.rotate && marked[spec.page]; });
                var markupCount = vm.highlights.length;

                d.busy = true;
                vm.busy = true;
                vm.error = '';
                vm.status = 'Changing the pages…';
                $q.all(turning.map(function (spec) {
                    return pdfService.getPageSize(spec.page).then(function (size) { sizes[spec.page] = size; });
                })).then(function () {
                    return pagesService.apply(vm.source, vm.fileName, layout, d.file);
                }).then(function (result) {
                    var load = vm.isDesktop ? pdfService.loadLocal(result) : pdfService.load(VIEWER_CONFIG.apiBase + '/' + result.id);
                    return load.then(function (pageCount) {
                        if (!vm.isDesktop) { vm.source = { kind: 'web', id: result.id }; }
                        var map = pagesService.pageMap(layout, pageCount);
                        moveMarkups(map, sizes);
                        scaleService.remap(map.map(function (entry) { return entry.page; }));
                        if (compareService.isOpen()) { vm.closeCompare(); }
                        vm.pageCount = pageCount;
                        vm.modified = true;
                        vm.selectedHighlightId = null;
                        vm.docVersion++;
                        vm.pagesDialog = null;
                        goToPage(focusPage(op, o, map, pageCount));
                        var lost = markupCount - vm.highlights.length;
                        var changed = op === 'blank' ? o.count : op === 'insert' ? pageCount - countDocPages(layout) : o.pages.length;
                        vm.status = statusAfterRender = EDIT_DONE[op](changed) +
                            (lost > 0 ? ' ' + lost + ' markup' + (lost === 1 ? ' was' : 's were') + ' on deleted pages.' : '') +
                            ' Save to keep the changes.';
                    });
                }).catch(function (message) {
                    var text = typeof message === 'string' ? message : 'Unable to change the pages.';
                    if (vm.pagesDialog === d) { d.error = text; } else { showError(text); }
                    vm.status = text;
                }).finally(function () {
                    d.busy = false;
                    vm.busy = false;
                });
            }

            function countDocPages(layout) {
                return layout.filter(function (spec) { return spec.source === 0; }).length;
            }

            /** Markups follow their page; a duplicated page gets copies; a page that turns turns its markups. */
            function moveMarkups(map, sizes) {
                var byPage = {};
                vm.highlights.forEach(function (m) { (byPage[m.pageNumber] = byPage[m.pageNumber] || []).push(m); });
                var placements = [];
                map.forEach(function (entry, i) {
                    (entry.page ? byPage[entry.page] || [] : []).forEach(function (m) {
                        var size = sizes[entry.page];
                        placements.push({ from: m, pageNumber: i + 1,
                                          fields: entry.rotate && size ? markupGeometry.rotate(m, entry.rotate / 90, size.width, size.height) : {} });
                    });
                });
                highlightService.rearrange(placements);
            }

            /** The page to show after an edit: the first page added, moved, copied or turned. */
            function focusPage(op, o, map, pageCount) {
                var index = -1;
                if (op === 'blank' || op === 'insert' || op === 'replace') {
                    index = map.findIndex(function (entry) { return entry.page === null; });
                } else if (op === 'duplicate') {
                    index = map.findIndex(function (entry, i) { return entry.page === o.pages[0] && i > 0 && map[i - 1].page === o.pages[0]; });
                } else if (op === 'move' || op === 'rotate') {
                    index = map.findIndex(function (entry) { return entry.page === o.pages[0]; });
                } else if (op === 'delete') {
                    return Math.min(o.pages[0], pageCount);
                }
                return index >= 0 ? index + 1 : Math.min(vm.currentPage, pageCount);
            }

            // ----- Ribbon: tool categories in the toolbar -----
            vm.ribbonTabs = [
                { id: 'file', label: 'File' }, { id: 'pages', label: 'Pages' }, { id: 'zoom', label: 'Zoom' },
                { id: 'navigation', label: 'Navigation' }, { id: 'markup', label: 'Markup' },
                { id: 'measure', label: 'Measure' }, { id: 'review', label: 'Review' }, { id: 'revision', label: 'Revision' }
            ];
            vm.ribbonTab = 'file';

            vm.setRibbonTab = function (id) { vm.ribbonTab = id; };

            /** Tab list keys (WAI-ARIA tabs): arrows, Home and End move to another tab and show it. */
            vm.onRibbonTabKey = function (event, index) {
                var count = vm.ribbonTabs.length;
                var moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: count - 1 };
                if (!(event.key in moves)) { return; }
                event.preventDefault();
                event.stopPropagation();    // arrows here must not turn the page
                var tab = vm.ribbonTabs[(moves[event.key] + count) % count];
                vm.setRibbonTab(tab.id);
                $timeout(function () {
                    var button = $document[0].getElementById('ribbon-tab-' + tab.id);
                    if (button) { button.focus(); }
                });
            };

            // ----- Markup tools -----
            var TOOL_HINTS = {
                pan: null,
                highlight: 'Highlight mode: drag over the page to highlight.',
                rect: 'Rectangle: drag over the area. Shift draws a square.',
                ellipse: 'Ellipse: drag over the area. Shift draws a circle.',
                cloud: 'Cloud: drag around the area to mark.',
                line: 'Line: drag from start to end. Shift snaps to 45\u00b0.',
                arrow: 'Arrow: drag from the tail to the point. Shift snaps to 45\u00b0.',
                pen: 'Freehand: draw on the page.',
                text: 'Text note: click where the note goes.',
                callout: 'Callout: drag from the point to where the note goes.',
                distance: 'Distance: drag from one point to the other. Shift snaps to 45\u00b0.',
                hdistance: 'Horizontal distance: drag between the two points; only the horizontal part is measured.',
                vdistance: 'Vertical distance: drag between the two points; only the vertical part is measured.',
                area: 'Area: click each corner; double-click, Enter or click the first corner to finish. Backspace removes the last corner, Esc cancels.',
                perimeter: 'Perimeter: click each corner of the boundary; double-click, Enter or click the first corner to finish.',
                calibrate: 'Calibrate: drag along a dimension you know (e.g. a grid line distance), then enter its real length.',
                comment: 'Comment: click where the comment goes, then type it.',
                strikeout: 'Strikeout: drag over the incorrect text.',
                underline: 'Underline: drag over the important text.',
                replace: 'Replace text: drag over the text to replace, then type the correction.',
                revtag: 'Revision tag: click where the tag goes (it shows the current revision).'
            };

            /** Picks a tool; picking the active markup tool again goes back to Pan. Esc also returns to Pan. */
            vm.selectTool = function (tool) {
                if (!vm.hasDocument() || !(tool in TOOL_HINTS)) { return; }
                if (tool === 'revtag' && vm.tool !== 'revtag' && !revisionService.current()) {
                    vm.openRevisionsDialog('Add a revision first: the tag shows its label.');
                    return;
                }
                vm.tool = vm.tool === tool ? 'pan' : tool;
                vm.status = TOOL_HINTS[vm.tool] || pageStatus();
            };

            vm.isTool = function (tool) { return vm.hasDocument() && vm.tool === tool; };

            vm.toggleHighlightMode = function () { vm.selectTool('highlight'); };

            /** Pan tool (the default): drag the page to move around it. */
            vm.selectPanTool = function () {
                if (vm.tool !== 'pan') { vm.selectTool(vm.tool); }
            };

            vm.setMarkupColor = function (color) { vm.markupColor = color; };

            vm.addHighlight = function (pageNumber, rect) {
                vm.addMarkup(pageNumber, rect);
            };

            vm.addMarkup = function (pageNumber, markup) {
                var revision = revisionService.current();
                if (revision && !markup.revision) { markup = angular.extend({}, markup, { revision: revision.label }); }
                var added = highlightService.add(pageNumber, markup);
                vm.selectedHighlightId = added.id;
                if (markupGeometry.isMeasure(added)) {
                    vm.status = vm.markupLabel(added) + (scaleService.forPage(pageNumber).isDefault
                        ? ' (paper size: no scale set; use Calibrate or Scale on the Measure tab)' : '');
                }
                return added;
            };

            // Text note / callout: ask for the text, then place the box.
            vm.noteDialog = null;   // { pageNumber, at, tip, type, text, error } while open
            var MAX_NOTE_LENGTH = 1000;

            function focusNoteInput() {
                $timeout(function () {
                    var input = $document[0].getElementById('note-text-input');
                    if (input) { input.focus(); }
                });
            }

            // The dialog's wording for each kind of text.
            vm.textKinds = {
                text: { title: 'Text note', label: 'Note on page', button: 'Add note', empty: 'Type the note text.', placeholder: 'e.g. Check lap length of B12 bars' },
                callout: { title: 'Callout', label: 'Note on page', button: 'Add note', empty: 'Type the note text.', placeholder: 'e.g. Check column C3' },
                comment: { title: 'Comment', label: 'Review comment on page', button: 'Add comment', empty: 'Type the comment.', placeholder: 'e.g. Please confirm the slab thickness' },
                replace: { title: 'Replace text', label: 'Replace the marked text on page', button: 'Replace', empty: 'Type the replacement text.', placeholder: 'e.g. 250 mm' }
            };

            /** Text note / callout / comment / replace text: ask for the text (`box` is the text marked for replacing). */
            vm.requestNoteText = function (pageNumber, at, tip, box) {
                var type = vm.tool === 'comment' || vm.tool === 'replace' ? vm.tool : tip ? 'callout' : 'text';
                vm.noteDialog = { pageNumber: pageNumber, at: at, tip: tip, box: box || null, type: type, text: '', error: '' };
                focusNoteInput();
            };

            vm.closeNoteDialog = function () { vm.noteDialog = null; };

            vm.applyNoteDialog = function () {
                var note = vm.noteDialog;
                if (!note) { return; }
                var text = String(note.text || '').replace(/\s+$/, '').replace(/^\s*\n/, '');
                // On an error, put the cursor back in the text box (clicking Add note moved it to the button).
                if (!text.trim()) { note.error = vm.textKinds[note.type].empty; focusNoteInput(); return; }
                if (text.length > MAX_NOTE_LENGTH) {
                    note.error = 'Keep the note under ' + MAX_NOTE_LENGTH + ' characters.';
                    focusNoteInput();
                    return;
                }
                pdfService.getPageSize(note.pageNumber).then(function (size) {
                    if (vm.noteDialog !== note) { return; }
                    var sizes = markupGeometry.sizesFor(size.width, size.height);
                    if (note.type === 'comment' || note.type === 'replace') {
                        vm.addMarkup(note.pageNumber, reviewMarkup(note, text, sizes, size));
                        vm.noteDialog = null;
                        return;
                    }
                    var box = markupGeometry.textBox(text, sizes.fontSize);
                    var markup = { type: note.type, color: vm.markupColor, strokeWidth: sizes.strokeWidth,
                                   fontSize: sizes.fontSize, text: text, width: box.width, height: box.height };
                    var x = note.at.x, y = note.at.y;
                    if (note.type === 'callout') {
                        var tip = note.tip;
                        if (!tip.dragged) {
                            // A click: put the note up and to the right of the point.
                            x = tip.x + sizes.fontSize * 3;
                            y = tip.y - sizes.fontSize * 3 - box.height;
                        } else {
                            // The note sits beside where the drag ended, on the side away from the point.
                            x = note.at.x < tip.x ? note.at.x - box.width : note.at.x;
                            y = note.at.y - box.height / 2;
                        }
                        markup.tipX = tip.x;
                        markup.tipY = tip.y;
                    }
                    // Keep the box on the page.
                    markup.x = Math.min(Math.max(x, 0), Math.max(0, size.width - box.width));
                    markup.y = Math.min(Math.max(y, 0), Math.max(0, size.height - box.height));
                    vm.addMarkup(note.pageNumber, markup);
                    vm.noteDialog = null;
                }, function () {
                    note.error = 'Unable to add the note to this page.';
                });
            };

            function reviewMarkup(note, text, sizes, page) {
                if (note.type === 'replace') {
                    return angular.extend({}, note.box, { type: 'replace', color: vm.markupColor, text: text,
                                                          fontSize: Math.max(8, Math.round(sizes.fontSize * 0.8)) });
                }
                // Comment: an icon centred where the page was clicked, kept on the page.
                var icon = Math.round(sizes.fontSize * 1.6);
                return { type: 'comment', color: vm.markupColor, text: text, width: icon, height: icon,
                         x: Math.min(Math.max(note.at.x - icon / 2, 0), page.width - icon),
                         y: Math.min(Math.max(note.at.y - icon / 2, 0), page.height - icon) };
            }

            // ----- Edit / move / delete markups (Review tab, double-click, drag with Pan) -----
            vm.editDialog = null;   // { id, label, hasText, text, hasColor, color, error } while open

            vm.canEditSelected = function () { return vm.selectedHighlightId !== null && !!highlightService.find(vm.selectedHighlightId); };

            vm.openEditDialog = function (id) {
                var m = highlightService.find(id === undefined ? vm.selectedHighlightId : id);
                if (!m) { return; }
                vm.selectedHighlightId = m.id;
                vm.editDialog = {
                    id: m.id,
                    label: markupGeometry.label(m),
                    pageNumber: m.pageNumber,
                    hasText: markupGeometry.hasText(m),
                    text: m.text || '',
                    hasColor: m.type !== 'highlight',
                    color: m.color,
                    error: ''
                };
                $timeout(function () {
                    var input = $document[0].getElementById('edit-text-input');
                    if (input) { input.focus(); }
                });
            };

            vm.closeEditDialog = function () { vm.editDialog = null; };
            vm.setEditColor = function (color) { if (vm.editDialog) { vm.editDialog.color = color; } };

            vm.applyEditDialog = function () {
                var d = vm.editDialog;
                if (!d) { return; }
                var m = highlightService.find(d.id);
                if (!m) { vm.editDialog = null; return; }
                var changes = {};
                if (d.hasText) {
                    var text = String(d.text || '').replace(/\s+$/, '').replace(/^\s*\n/, '');
                    if (!text.trim()) { d.error = 'The text cannot be empty.'; return; }
                    if (text.length > MAX_NOTE_LENGTH) { d.error = 'Keep the text under ' + MAX_NOTE_LENGTH + ' characters.'; return; }
                    changes.text = text;
                    if (m.type === 'text' || m.type === 'callout') {
                        // The note box fits the new text.
                        var box = markupGeometry.textBox(text, m.fontSize);
                        changes.width = box.width;
                        changes.height = box.height;
                    }
                }
                if (d.hasColor) { changes.color = d.color; }
                var updated = highlightService.update(d.id, changes);
                vm.editDialog = null;
                vm.status = vm.markupLabel(updated) + ' changed.';
            };

            vm.moveMarkup = function (id, markup) { highlightService.update(id, markup); };

            // ----- Revision: compare / overlay with another revision -----
            vm.compare = { fileName: '', pageCount: 0, mode: 'diff', busy: false, result: null, active: -1 };
            vm.revisionView = null;     // what the viewer shows over the page: { page, mode, url, regions, active }

            vm.isComparing = function () { return compareService.isOpen(); };

            function closeRevisionWork() {
                compareService.close();
                vm.compare = { fileName: '', pageCount: 0, mode: 'diff', busy: false, result: null, active: -1 };
                vm.revisionView = null;
                vm.revisionsDialog = null;
                vm.reportDialog = null;
            }

            function compareOpened(info) {
                if (!info) { vm.status = pageStatus(); return; }
                vm.compare.fileName = info.fileName;
                vm.compare.pageCount = info.pageCount;
                vm.compare.mode = 'diff';
                refreshCompare();
            }

            /** Web: the file picked in the Revision tab; desktop: shows the open dialog. */
            vm.openCompare = function (file) {
                if (!vm.hasDocument()) { return; }
                vm.error = '';
                vm.status = 'Opening the revision to compare with\u2026';
                (file ? compareService.openFile(file) : compareService.openDesktop()).then(compareOpened, function (message) {
                    showError(typeof message === 'string' ? message : 'Unable to open that PDF.');
                });
            };

            vm.closeCompare = function () {
                closeRevisionWork();
                vm.status = pageStatus();
            };

            vm.setCompareMode = function (mode) {
                if (!compareService.isOpen()) { return; }
                vm.compare.mode = mode;
                refreshCompare();
            };

            function viewFor(result, active) {
                return { page: result.pageNumber, mode: vm.compare.mode, url: vm.compare.mode === 'overlay' ? compareService.overlayUrl(result) : result.diffUrl,
                         regions: result.regions, active: active };
            }

            var pendingActive = null;   // { page, index }: the change to show once that page is compared

            /** Compares the current page (cached per page) and shows the result. Resolves with it. */
            function refreshCompare() {
                if (!compareService.isOpen() || vm.compare.mode === 'off' || !vm.hasDocument()) {
                    vm.revisionView = null;
                    return null;
                }
                var page = vm.currentPage, mode = vm.compare.mode;
                vm.compare.busy = true;
                return compareService.comparePage(page).then(function (result) {
                    if (vm.currentPage !== page || vm.compare.mode !== mode) { return result; }
                    vm.compare.result = result;
                    vm.compare.active = pendingActive && pendingActive.page === page ? pendingActive.index : -1;
                    pendingActive = null;
                    vm.revisionView = viewFor(result, vm.compare.active);
                    vm.status = compareStatus(result);
                    return result;
                }, function (message) {
                    showError(typeof message === 'string' ? message : 'Unable to compare this page.');
                }).finally(function () { vm.compare.busy = false; });
            }

            function compareStatus(r) {
                var name = vm.compare.fileName;
                if (r.missing) { return 'Page ' + r.pageNumber + ' is not in ' + name + ': everything on it is new.'; }
                if (!r.regions.length) { return 'Page ' + r.pageNumber + ': no differences from ' + name + '.'; }
                return 'Page ' + r.pageNumber + ': ' + r.regions.length + ' changed area' + (r.regions.length === 1 ? '' : 's') +
                       (vm.compare.mode === 'diff' ? ' (green: added, red: removed in this revision)' : ' (blue: this revision, red: ' + name + ')');
            }

            $scope.$watch(function () { return vm.currentPage; }, function (page, old) {
                if (page !== old && compareService.isOpen()) { refreshCompare(); }
            });

            vm.changeCount = function () {
                return vm.compare.result && vm.compare.result.pageNumber === vm.currentPage ? vm.compare.result.regions.length : 0;
            };

            /** Previous / next changed area: on this page first, then on the pages before / after it. */
            vm.goToChange = function (step) {
                var r = vm.compare.result;
                if (!compareService.isOpen() || vm.compare.busy) { return; }
                if (vm.compare.mode === 'off') { vm.compare.mode = 'diff'; }
                if (r && r.pageNumber === vm.currentPage) {
                    var next = vm.compare.active + step;
                    if (vm.compare.active < 0 && step < 0) { next = r.regions.length - 1; }
                    if (next >= 0 && next < r.regions.length) {
                        vm.compare.active = next;
                        vm.revisionView = viewFor(r, next);
                        vm.status = 'Change ' + (next + 1) + ' of ' + r.regions.length + ' on page ' + r.pageNumber + '.';
                        return;
                    }
                }
                searchPages(vm.currentPage + step, step);
            };

            function searchPages(page, step) {
                if (page < 1 || page > vm.pageCount) {
                    vm.status = 'No more changes ' + (step > 0 ? 'after' : 'before') + ' page ' + vm.currentPage + '.';
                    return;
                }
                vm.compare.busy = true;
                vm.status = 'Looking for changes on page ' + page + '\u2026';
                compareService.comparePage(page).then(function (result) {
                    if (!result.regions.length) {
                        vm.compare.busy = false;
                        searchPages(page + step, step);
                        return;
                    }
                    vm.compare.busy = false;
                    // The page watcher compares the new page (from the cache) and shows this change.
                    pendingActive = { page: page, index: step > 0 ? 0 : result.regions.length - 1 };
                    goToPage(page);
                }, function (message) {
                    vm.compare.busy = false;
                    showError(typeof message === 'string' ? message : 'Unable to compare page ' + page + '.');
                });
            }

            /** Marks every changed area on this page with a revision cloud (in the current colour and revision). */
            vm.cloudChanges = function () {
                var r = vm.compare.result;
                if (!r || r.pageNumber !== vm.currentPage || !r.regions.length) { return; }
                pdfService.getPageSize(r.pageNumber).then(function (size) {
                    var sizes = markupGeometry.sizesFor(size.width, size.height);
                    r.regions.forEach(function (region) {
                        vm.addMarkup(r.pageNumber, angular.extend({ type: 'cloud', color: vm.markupColor, strokeWidth: sizes.strokeWidth }, region));
                    });
                    vm.selectedHighlightId = null;
                    vm.status = 'Added ' + r.regions.length + ' revision cloud' + (r.regions.length === 1 ? '' : 's') + ' on page ' + r.pageNumber + '.';
                });
            };

            // ----- Revision tracking -----
            vm.revisionsDialog = null;  // { list, form: { label, date, description, author }, message, error } while open
            var AUTHOR_KEY = 'pdfViewer.author';

            function rememberedAuthor() {
                try { return $window.localStorage.getItem(AUTHOR_KEY) || ''; } catch (e) { return ''; }
            }

            vm.currentRevision = function () { return revisionService.current(); };

            vm.openRevisionsDialog = function (message) {
                if (!vm.hasDocument()) { return; }
                vm.revisionsDialog = {
                    list: revisionService.list(),
                    current: revisionService.current() ? revisionService.current().id : '',
                    form: { label: revisionService.nextLabel(), date: revisionService.today(), description: '', author: rememberedAuthor() },
                    message: message || '',
                    error: ''
                };
                $timeout(function () {
                    var input = $document[0].getElementById('revision-description-input');
                    if (input) { input.focus(); }
                });
            };

            vm.addRevision = function () {
                var d = vm.revisionsDialog;
                if (!d) { return; }
                var added = revisionService.add(d.form);
                if (typeof added === 'string') { d.error = added; return; }
                try { $window.localStorage.setItem(AUTHOR_KEY, added.author); } catch (e) { /* not remembered */ }
                d.list = revisionService.list();
                d.current = added.id;
                d.error = '';
                d.message = 'Revision ' + added.label + ' added; new markups belong to it.';
                d.form = { label: revisionService.nextLabel(), date: revisionService.today(), description: '', author: added.author };
            };

            vm.setCurrentRevision = function (id) {
                revisionService.setCurrent(id);
                if (vm.revisionsDialog) { vm.revisionsDialog.current = id; }
            };

            vm.removeRevision = function (id) {
                revisionService.remove(id);
                if (vm.revisionsDialog) {
                    vm.revisionsDialog.list = revisionService.list();
                    vm.revisionsDialog.current = revisionService.current() ? revisionService.current().id : '';
                }
            };

            vm.revisionMarkupCount = function (label) {
                return vm.highlights.filter(function (m) { return m.revision === label; }).length;
            };

            /** Revision tag tool: a triangle with the current revision's label where the page was clicked. */
            vm.placeTag = function (pageNumber, at) {
                var revision = revisionService.current();
                if (!revision) { vm.openRevisionsDialog('Add a revision first: the tag shows its label.'); return; }
                pdfService.getPageSize(pageNumber).then(function (size) {
                    var sizes = markupGeometry.sizesFor(size.width, size.height);
                    var side = Math.round(sizes.fontSize * 2);
                    vm.addMarkup(pageNumber, {
                        type: 'revtag', color: vm.markupColor, strokeWidth: sizes.strokeWidth, text: revision.label,
                        fontSize: Math.max(8, Math.round(sizes.fontSize * 0.85)), width: side, height: side,
                        x: Math.min(Math.max(at.x - side / 2, 0), size.width - side),
                        y: Math.min(Math.max(at.y - side / 2, 0), size.height - side)
                    });
                });
            };

            // ----- Markup report -----
            vm.reportDialog = null;     // { revision, rows, summary, busy } while open

            vm.openReport = function () {
                if (!vm.hasDocument()) { return; }
                vm.reportDialog = { revision: '', rows: [], summary: null, busy: false };
                vm.updateReport();
            };

            vm.updateReport = function () {
                var d = vm.reportDialog;
                d.rows = reportService.rows(vm.highlights, d.revision);
                d.summary = reportService.summary(d.rows);
            };

            vm.reportRevisions = function () {
                var labels = [];
                vm.highlights.forEach(function (m) { if (m.revision && labels.indexOf(m.revision) < 0) { labels.push(m.revision); } });
                return labels.sort();
            };

            vm.exportReport = function (format) {
                var d = vm.reportDialog;
                if (!d || d.busy || !d.rows.length) { return; }
                var revision = d.revision === '-' ? 'No revision' : d.revision ? 'Revision ' + d.revision : '';
                var content = format === 'csv' ? reportService.toCsv(d.rows) : reportService.toHtml(d.rows, { fileName: vm.fileName, revision: revision });
                d.busy = true;
                toolsService.saveReport(vm.fileName, format, content).then(function (message) {
                    vm.status = message || 'Not saved.';
                }, function (message) {
                    showError(typeof message === 'string' ? message : 'Unable to save the report.');
                }).finally(function () { d.busy = false; });
            };

            // ----- Measurement scale -----
            vm.scaleUnits = scaleService.UNITS;
            vm.scaleRatios = scaleService.PRESET_RATIOS;
            vm.scaleDialog = null;  // { pageNumber, measured, mode, length, ratio, unit, allPages, error } while open

            /** Scale of the current page, as shown on the Measure tab. */
            vm.scaleLabel = function () {
                var scale = scaleService.forPage(vm.currentPage);
                return scale.label + (scale.isDefault ? '' : ' \u00b7 ' + scale.unit);
            };
            vm.isScaleSet = function () { return !scaleService.forPage(vm.currentPage).isDefault; };

            /** Opens the scale dialog: with `measured` (PDF points) from a calibration line, else to pick a ratio. */
            vm.openScaleDialog = function (pageNumber, measured) {
                if (!vm.hasDocument()) { return; }
                var current = scaleService.forPage(pageNumber || vm.currentPage);
                vm.scaleDialog = {
                    pageNumber: pageNumber || vm.currentPage,
                    measured: measured || null,
                    mode: measured ? 'known' : 'ratio',
                    length: '',
                    ratio: current.label.indexOf('1:') === 0 && !current.isDefault ? current.label.slice(2) : '100',
                    unit: current.isDefault ? 'mm' : current.unit,
                    allPages: true,
                    error: ''
                };
                $timeout(function () {
                    var input = $document[0].getElementById(measured ? 'scale-length-input' : 'scale-ratio-input');
                    if (input) { input.focus(); input.select(); }
                });
            };

            vm.closeScaleDialog = function () { vm.scaleDialog = null; };

            function parseNumber(text) {
                var value = parseFloat(String(text || '').replace(/,/g, '').trim());
                return isFinite(value) && value > 0 ? value : null;
            }

            vm.applyScaleDialog = function () {
                var d = vm.scaleDialog;
                if (!d) { return; }
                var scale;
                if (d.mode === 'known') {
                    var length = parseNumber(d.length);
                    if (!length || length > 1e7) { d.error = 'Enter the real length of the line you drew, e.g. 6000 (mm) or 6 (m).'; return; }
                    scale = scaleService.fromCalibration(d.measured, length, d.unit);
                } else {
                    var ratio = parseNumber(String(d.ratio || '').replace(/^\s*1\s*:/, ''));
                    if (!ratio || ratio > 100000) { d.error = 'Enter the scale as a number, e.g. 100 for 1:100.'; return; }
                    scale = scaleService.fromRatio(ratio, d.unit);
                }
                scaleService.set(d.allPages ? null : d.pageNumber, scale);
                vm.scaleDialog = null;
                if (vm.tool === 'calibrate') { vm.tool = 'pan'; }
                var where = d.allPages ? 'all pages' : 'page ' + d.pageNumber;
                vm.status = (d.mode === 'known'
                    ? 'Scale calibrated (the line is ' + d.length + ' ' + d.unit + ') for ' + where
                    : 'Scale ' + scale.label + ' (' + scale.unit + ') set for ' + where) + '. Measurements use it now.';
            };

            vm.onCalibrate = function (pageNumber, length) { vm.openScaleDialog(pageNumber, length); };

            vm.markupLabel = function (m) {
                var label = markupGeometry.label(m);
                if (markupGeometry.isMeasure(m)) { return label + ': ' + markupGeometry.measureText(m); }
                if (m.text) {
                    var first = m.text.split('\n')[0];
                    label += ': ' + (first.length > 40 ? first.slice(0, 40) + '\u2026' : first);
                }
                return label;
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
            var statusAfterRender = null;   // kept when the page renders (the result of a page edit)

            vm.onPageRendered = function () {
                if (statusAfterRender) {
                    vm.status = statusAfterRender;
                    statusAfterRender = null;
                } else if (vm.tool === 'pan') {
                    vm.status = pageStatus();
                }
            };

            function pageStatus() {
                var count = vm.highlights.length;
                return vm.fileName + (count ? ' · ' + count + ' markup' + (count === 1 ? '' : 's') : '');
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
                } else if (key === 'l' && vm.hasDocument()) {
                    command = vm.toggleFullScreen;
                } else if (key === 's' && event.shiftKey) {
                    command = function () { vm.save(true); };
                } else if (key === 's') {
                    // Save the page changes; without any, a copy with the markups as before.
                    command = vm.modified ? function () { vm.save(false); } : function () { $scope.$broadcast('save-copy'); };
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
                    } else if (event.key === 'Escape' && vm.fullScreen) {
                        exitFullScreen();
                    } else if (event.key === 'Escape') {
                        vm.selectedHighlightId = null;
                        if (vm.tool !== 'pan') { vm.selectPanTool(); }
                    } else if (event.key === 'ArrowRight' || (vm.fullScreen && event.key === 'PageDown')) {
                        vm.nextPage();
                        if (event.key !== 'ArrowRight') { event.preventDefault(); }
                    } else if (event.key === 'ArrowLeft' || (vm.fullScreen && event.key === 'PageUp')) {
                        vm.previousPage();
                        if (event.key !== 'ArrowLeft') { event.preventDefault(); }
                    }
                });
            }

            $document.on('keydown', onKeyDown);
            $scope.$on('$destroy', function () {
                $document.off('keydown', onKeyDown);
                $document[0].removeEventListener('keydown', onCustomZoomKey, true);
                $document[0].removeEventListener('fullscreenchange', onFullscreenChange);
                narrowQuery.removeEventListener('change', onWidthChange);
                pdfService.close();
            });
        }]);
})();
