(function () {
    'use strict';

    /** Menu bar, toolbar and status bar state: open, recent files, navigate, zoom, fit and highlight commands. */
    angular.module('pdfViewerApp').controller('PdfViewerController', [
        '$scope', '$document', '$window', '$timeout', 'pdfService', 'highlightService', 'themeService', 'desktopService',
        'recentFilesService', 'markupGeometry', 'scaleService', 'compareService', 'revisionService', 'reportService',
        'toolsService', 'pagesService', 'customMarkupService', 'printService', 'securityService', 'tourService', 'VIEWER_CONFIG', '$q',
        function ($scope, $document, $window, $timeout, pdfService, highlightService, themeService, desktopService,
                  recentFilesService, markupGeometry, scaleService, compareService, revisionService, reportService,
                  toolsService, pagesService, customMarkupService, printService, securityService, tourService, VIEWER_CONFIG, $q) {
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
            vm.selectedHighlightId = null;    // the markup clicked last (the one Edit and the pop-ups show)
            vm.selectedIds = [];              // every selected markup: its group, or several picked with Ctrl / Shift
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
                    var askPassword = function (wrong) {
                        vm.status = (wrong ? 'Wrong password. ' : '') + 'Enter the password of ' + uploaded.fileName + '.';
                        return securityService.askPassword(uploaded.fileName, wrong);
                    };
                    return pdfService.load(VIEWER_CONFIG.apiBase + '/' + uploaded.id, askPassword).then(function (pageCount) {
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
                desktopService.on('password-required', function (message) {
                    vm.busy = false;    // not opening while the prompt waits; the host sends "opening" again with the password
                    vm.status = (message.wrong ? 'Wrong password. ' : '') + 'Enter the password of ' + message.fileName + '.';
                    securityService.askPassword(message.fileName, message.wrong).then(function (password) {
                        desktopService.send('open-password', { password: password });
                    }, function () {
                        desktopService.send('open-password-cancelled');
                        vm.status = vm.hasDocument() ? pageStatus() : 'Not opened: the PDF needs its password.';
                    });
                });
                desktopService.on('opened', function (message) {
                    vm.openedWithPassword = !!message.encrypted;
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
                vm.propertiesDialog = null;
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
                vm.fileSize = size || 0;
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
                if (message === 'cancelled') {     // the password prompt was cancelled
                    vm.status = vm.hasDocument() ? pageStatus() : 'Not opened: the PDF needs its password.';
                    return;
                }
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

            // ----- Document properties; the current page's size -----
            vm.fileSize = 0;
            vm.propertiesDialog = null; // { loading, error, general, description, application, sizes } while open
            vm.pageSize = null;         // the current page's size, for the status bar (pagesService.describeSize)

            $scope.$watchGroup([function () { return vm.currentPage; }, function () { return vm.docVersion; }], function () {
                var page = vm.currentPage, version = vm.docVersion;
                if (!vm.hasDocument() || !page) { vm.pageSize = null; return; }
                pdfService.getPageSize(page).then(function (size) {
                    if (vm.currentPage === page && vm.docVersion === version) { vm.pageSize = pagesService.describeSize(size.width, size.height); }
                }, function () { vm.pageSize = null; });
            });

            /** "D:20240115093000+05'30'" (a PDF date) for people; the text as it is when it is not one. */
            function pdfDate(value) {
                var m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Z+-])(\d{2})?'?(\d{2})?'?)?/.exec(value || '');
                if (!m) { return value || ''; }
                var utc = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
                if (m[7] === '+' || m[7] === '-') { utc -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000; }
                return new Date(utc).toLocaleString();
            }

            vm.openProperties = function () {
                if (!vm.hasDocument()) { return; }
                var d = vm.propertiesDialog = { loading: true, error: '', general: [], description: [], application: [], sizes: [],
                                                fonts: null, fontsNote: '', fontsLoading: true };
                pdfService.getFonts(vm.source).then(function (result) {
                    if (vm.propertiesDialog !== d) { return; }
                    d.fonts = result.fonts || [];
                    d.fontsNote = result.pagesScanned < result.pageCount
                        ? 'Fonts on the first ' + result.pagesScanned.toLocaleString('en-US') + ' of ' + result.pageCount.toLocaleString('en-US') + ' pages.' : '';
                }, function (message) {
                    if (vm.propertiesDialog !== d) { return; }
                    d.fonts = [];
                    d.fontsNote = typeof message === 'string' ? message : 'Unable to read the fonts.';
                }).finally(function () { d.fontsLoading = false; });
                pdfService.getInfo(vm.source).then(function (info) {
                    if (vm.propertiesDialog !== d) { return; }
                    var meta = info.metadata || {};
                    var none = '\u2014';
                    d.general = [
                        ['File name', vm.fileName + (vm.modified ? ' (page changes not saved)' : '')],
                        ['File size', vm.fileSize ? formatSize(vm.fileSize) + ' (' + vm.fileSize.toLocaleString('en-US') + ' bytes)' : none],
                        ['Pages', info.pageCount.toLocaleString('en-US')],
                        ['PDF version', info.version || none],
                        ['Security', info.encrypted ? 'Encrypted' + (info.restrictions.length ? '; not allowed: ' + info.restrictions.join(', ').toLowerCase() : '') : 'None'],
                        ['Tagged (accessible)', info.tagged ? 'Yes' : 'No'],
                        ['Bookmarks', info.hasBookmarks ? 'Yes' : 'No']
                    ];
                    d.description = [['Title', meta.Title], ['Author', meta.Author], ['Subject', meta.Subject], ['Keywords', meta.Keywords]]
                        .map(function (row) { return [row[0], row[1] || none]; });
                    d.application = [['Created', pdfDate(meta.CreationDate)], ['Modified', pdfDate(meta.ModDate)],
                                     ['Application', meta.Creator], ['PDF producer', meta.Producer]]
                        .map(function (row) { return [row[0], row[1] || none]; });
                    d.sizes = (info.pageSizes || []).map(function (g) {
                        var size = pagesService.describeSize(g.width, g.height);
                        return angular.extend(size, { count: g.count, pages: pagesService.formatPages(g.pages) + (g.count > g.pages.length ? ', \u2026' : '') });
                    });
                    d.loading = false;
                }, function (message) {
                    if (vm.propertiesDialog !== d) { return; }
                    d.loading = false;
                    d.error = typeof message === 'string' ? message : 'Unable to read the document properties.';
                });
            };

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
                    !vm.pagesDialog && !vm.newDialog && !vm.saveAsDialog && !vm.unsavedDialog && !vm.unitsDialog &&
                    !vm.stampDialog && !vm.customDialog && !vm.customSaveDialog && !vm.propertiesDialog &&
                    !vm.saveAnnotatedDialog && !vm.printDialog) { return; }
                // The colour pop-up (Edit markup dialog) handles its own keys, Esc included.
                var popover = $document[0].querySelector('.color-popover');
                if (popover && popover.contains(event.target)) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') {
                    $scope.$apply(function () {
                        vm.closeCustomZoom(); vm.closeNoteDialog(); vm.closeScaleDialog(); vm.closeEditDialog();
                        vm.revisionsDialog = null; vm.reportDialog = null;
                        if (!vm.pagesDialog || !vm.pagesDialog.busy) { vm.pagesDialog = null; }
                        vm.newDialog = null; vm.saveAsDialog = null; vm.unsavedDialog = null; vm.unitsDialog = null;
                        vm.stampDialog = null; vm.customDialog = null; vm.customSaveDialog = null; vm.propertiesDialog = null;
                        if (!vm.saveAnnotatedDialog || !vm.saveAnnotatedDialog.busy) { vm.saveAnnotatedDialog = null; }
                        vm.printDialog = null;
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
                    count: 1, size: 'a4', orientation: 'portrait', file: null, filePages: '', error: '', busy: false,
                    withMarkups: vm.highlights.length > 0
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
                    // With markups: an annotated copy of just those pages; without: the pages as they are.
                    var extracted = d.withMarkups && vm.highlights.length
                        ? toolsService.saveHighlights(vm.source, vm.fileName, vm.highlights, { pages: o.pages })
                        : toolsService.extractPages(vm.source, vm.fileName, built.layout);
                    extracted.then(function (message) {
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
                        vm.fileSize = result.size || vm.fileSize;
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
                { id: 'file', label: 'File' }, { id: 'pages', label: 'Pages' }, { id: 'output', label: 'Output' }, { id: 'zoom', label: 'Zoom' },
                { id: 'navigation', label: 'Navigation' }, { id: 'markup', label: 'Markup' },
                { id: 'measure', label: 'Measure' }, { id: 'review', label: 'Review' }, { id: 'revision', label: 'Revision' },
                { id: 'ocr', label: 'OCR' }, { id: 'security', label: 'Security' }
            ];
            vm.ribbonTab = 'file';

            vm.setRibbonTab = function (id) { vm.ribbonTab = id; };

            /** Tab list keys (WAI-ARIA tabs): arrows, Home and End move to another tab and show it. */
            vm.onRibbonTabKey = function (event) {
                var count = vm.ribbonTabs.length;
                // From the selected tab, not the one the key came from: fast key presses can arrive before focus moves.
                var index = vm.ribbonTabs.findIndex(function (t) { return t.id === vm.ribbonTab; });
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
                polyline: 'Polyline: click each point; double-click or Enter finishes. Shift keeps 45\u00b0 steps; Backspace removes the last point.',
                stamp: 'Stamp: click where the stamp goes.',
                custom: 'My markup: click where it goes.',
                text: 'Text note: click where the note goes.',
                callout: 'Callout: drag from the point to where the note goes.',
                distance: 'Distance: drag from one point to the other. Shift snaps to 45\u00b0.',
                hdistance: 'Horizontal distance: drag between the two points; only the horizontal part is measured.',
                vdistance: 'Vertical distance: drag between the two points; only the vertical part is measured.',
                area: 'Area: click each corner; double-click, Enter or click the first corner to finish. Backspace removes the last corner, Esc cancels.',
                perimeter: 'Perimeter: click each corner of the boundary; double-click, Enter or click the first corner to finish.',
                calibrate: 'Calibrate: drag along a dimension you know (e.g. a grid line distance), then enter its real length.',
                count: 'Count: click each item to count. Enter starts a new count; Backspace removes the last marker.',
                perpendicular: 'Perpendicular distance: drag along the reference line (e.g. a grid line), then click the point to measure from.',
                comment: 'Comment: click where the comment goes, then type it.',
                strikeout: 'Strikeout: drag over the incorrect text.',
                underline: 'Underline: drag over the important text.',
                replace: 'Replace text: drag over the text to replace, then type the correction.',
                revtag: 'Revision tag: click where the tag goes (it shows the current revision).'
            };

            // One key per tool (no Ctrl), shown on hover. Pressing the active tool's key again goes back to Pan.
            var TOOL_KEYS = {
                pan: 'V', highlight: 'H', rect: 'R', ellipse: 'E', cloud: 'C', line: 'L', arrow: 'A', pen: 'F',
                text: 'T', callout: 'Q', distance: 'D', hdistance: 'X', vdistance: 'Y', perpendicular: 'N',
                area: 'G', perimeter: 'O', count: 'K', calibrate: 'B', comment: 'M', strikeout: 'S', underline: 'U',
                replace: 'Shift+T', revtag: 'Shift+R', polyline: 'P', stamp: 'Shift+S', custom: 'Shift+C'
            };
            var TOOL_BY_KEY = {};
            Object.keys(TOOL_KEYS).forEach(function (tool) { TOOL_BY_KEY[TOOL_KEYS[tool]] = tool; });

            vm.toolKey = function (tool) { return TOOL_KEYS[tool] || ''; };

            /** The tool for a key press (letters, with or without Shift), or null. */
            function toolForKey(event) {
                if (event.ctrlKey || event.metaKey || event.altKey || !/^[a-z]$/i.test(event.key)) { return null; }
                return TOOL_BY_KEY[(event.shiftKey ? 'Shift+' : '') + event.key.toUpperCase()] || null;
            }

            /** Picks a tool; picking the active markup tool again goes back to Pan. Esc also returns to Pan. */
            vm.selectTool = function (tool) {
                if (!vm.hasDocument() || !(tool in TOOL_HINTS)) { return; }
                if (tool === 'revtag' && vm.tool !== 'revtag' && !revisionService.current()) {
                    vm.openRevisionsDialog('Add a revision first: the tag shows its label.');
                    return;
                }
                // Stamp and My markups: pick which one first.
                if (tool === 'stamp' && vm.tool !== 'stamp') { vm.openStampDialog(); return; }
                if (tool === 'custom' && vm.tool !== 'custom') { vm.openCustomDialog(); return; }
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
                if (added.type === 'count') {
                    vm.status = vm.markupLabel(added) + '. Click the next item; Enter starts a new count.';
                } else if (markupGeometry.isMeasure(added)) {
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

            // ----- Markup management: select, properties, move / resize, copy / paste, lock, group, delete -----
            // Selecting a grouped markup selects its whole group. Code that sets selectedHighlightId directly (a new
            // markup, a page change) gets the selection from here.
            $scope.$watch(function () { return vm.selectedHighlightId; }, function (id) {
                if (id === null || id === undefined) { vm.selectedIds = []; return; }
                if (vm.selectedIds.indexOf(id) < 0) {
                    var m = highlightService.find(id);
                    vm.selectedIds = m ? highlightService.groupOf(m).map(function (g) { return g.id; }) : [id];
                }
            });

            /** The selected markups that still exist. */
            vm.selectedMarkups = function () {
                return vm.selectedIds.map(highlightService.find).filter(Boolean);
            };

            function setSelection(markups) {
                vm.selectedIds = markups.map(function (m) { return m.id; });
                vm.selectedHighlightId = markups.length ? markups[markups.length - 1].id : null;
            }

            function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

            vm.canEditSelected = function () { return vm.selectedMarkups().length > 0; };

            /** Whether every selected markup is locked (the Lock button then unlocks). */
            vm.selectionLocked = function () {
                var list = vm.selectedMarkups();
                return list.length > 0 && list.every(function (m) { return m.locked; });
            };

            vm.canGroup = function () {
                var list = vm.selectedMarkups();
                if (list.length < 2) { return false; }
                var groups = {};
                list.forEach(function (m) { groups[m.groupId || ('#' + m.id)] = true; });
                return Object.keys(groups).length > 1 && list.every(function (m) { return m.pageNumber === list[0].pageNumber; });
            };

            vm.canUngroup = function () { return vm.selectedMarkups().some(function (m) { return !!m.groupId; }); };

            /** Ctrl+A: every markup on the current page. */
            vm.selectAllMarkups = function () {
                var list = vm.highlights.filter(function (m) { return m.pageNumber === vm.currentPage; });
                setSelection(list);
                vm.status = list.length ? plural(list.length, 'markup') + ' selected.' : 'No markups on this page.';
            };

            vm.toggleLock = function () {
                var list = vm.selectedMarkups();
                if (!list.length) { return; }
                var lock = !vm.selectionLocked();
                list.forEach(function (m) { highlightService.update(m.id, { locked: lock }); });
                vm.status = plural(list.length, 'markup') + (lock ? ' locked: they cannot be moved, resized, changed or deleted.' : ' unlocked.');
            };

            vm.groupMarkups = function () {
                if (!vm.canGroup()) { return; }
                var groupId = highlightService.newGroupId();
                var list = vm.selectedMarkups().map(function (m) { return highlightService.update(m.id, { groupId: groupId }); });
                setSelection(list);
                vm.status = plural(list.length, 'markup') + ' grouped: they are selected, moved, copied and deleted together.';
            };

            vm.ungroupMarkups = function () {
                var list = vm.selectedMarkups();
                if (!vm.canUngroup()) { return; }
                list = list.map(function (m) { return highlightService.update(m.id, { groupId: undefined }); });
                setSelection(list);
                vm.status = plural(list.length, 'markup') + ' ungrouped.';
            };

            // Copy / paste: the copies keep their look, text and groups (as new groups); they are unlocked and
            // belong to the current revision. A paste on the page they came from is offset so it can be seen.
            var clipboard = null;   // { pageNumber, markups, pastes: { page: count } }

            function copiesOf(list) {
                return list.map(function (m) {
                    var copy = angular.copy(m);
                    ['id', 'pageNumber', 'createdAt', 'revision', 'locked'].forEach(function (k) { delete copy[k]; });
                    return copy;
                });
            }

            /** Adds `copies` to the page, moved `steps` offsets down and right (kept on the page), and selects them. */
            function placeCopies(copies, pageNumber, steps) {
                return pdfService.getPageSize(pageNumber).then(function (size) {
                    var step = markupGeometry.sizesFor(size.width, size.height).fontSize * steps;
                    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    copies.forEach(function (c) {
                        var b = markupGeometry.bounds(c);
                        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
                        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
                    });
                    var dx = Math.max(Math.min(step, size.width - maxX), -minX);
                    var dy = Math.max(Math.min(step, size.height - maxY), -minY);
                    var groups = {};
                    var added = copies.map(function (c) {
                        var m = markupGeometry.translate(c, dx, dy);
                        if (m.groupId) { m.groupId = groups[m.groupId] || (groups[m.groupId] = highlightService.newGroupId()); }
                        return vm.addMarkup(pageNumber, m);
                    });
                    setSelection(added);
                    return added;
                });
            }

            vm.copyMarkups = function () {
                var list = vm.selectedMarkups();
                if (!list.length) { return; }
                clipboard = { pageNumber: list[0].pageNumber, markups: copiesOf(list), pastes: {} };
                vm.status = plural(list.length, 'markup') + ' copied. Paste (' + vm.modKey + 'V) puts them on the current page.';
            };

            vm.cutMarkups = function () {
                var list = vm.selectedMarkups();
                if (!list.length) { return; }
                vm.copyMarkups();
                clipboard.pastes[clipboard.pageNumber] = -1;   // the first paste goes back where they were
                var kept = removeMarkups(list);
                vm.status = plural(list.length - kept, 'markup') + ' cut' + (kept ? '; ' + plural(kept, 'locked markup') + ' copied only' : '') + '.';
            };

            vm.canPaste = function () { return !!clipboard && vm.hasDocument(); };

            vm.pasteMarkups = function () {
                if (!vm.canPaste()) { return; }
                var page = vm.currentPage, c = clipboard;
                var count = (c.pastes[page] || 0) + 1;
                c.pastes[page] = count;
                var steps = page === c.pageNumber ? count : count - 1;
                placeCopies(angular.copy(c.markups), page, steps).then(function (added) {
                    vm.status = plural(added.length, 'markup') + ' pasted on page ' + page + '.';
                }, function () {
                    vm.status = 'Unable to paste on this page.';
                });
            };

            vm.duplicateMarkups = function () {
                var list = vm.selectedMarkups();
                if (!list.length) { return; }
                placeCopies(copiesOf(list), list[0].pageNumber, 1).then(function (added) {
                    vm.status = plural(added.length, 'markup') + ' duplicated.';
                });
            };

            /** Removes the markups that are not locked; returns how many were kept. */
            function removeMarkups(list) {
                var kept = 0;
                list.forEach(function (m) {
                    if (m.locked) { kept++; return; }
                    highlightService.remove(m.id);
                });
                var left = vm.selectedMarkups();
                setSelection(left);
                return kept;
            }

            // Properties (Edit): text, colour, opacity, line thickness, font and lock of the selected markups.
            // With several selected, only the settings changed in the dialog are applied, each to the markups it fits.
            vm.editDialog = null;   // { ids, label, values, initial, has*, ... , error } while open
            vm.FONTS = markupGeometry.FONTS;
            vm.FONT_SIZE = markupGeometry.FONT_SIZE;
            vm.STROKE_WIDTH = markupGeometry.STROKE_WIDTH;

            vm.openEditDialog = function (id) {
                var list;
                if (id !== undefined) {
                    var one = highlightService.find(id);
                    if (!one) { return; }
                    if (vm.selectedIds.indexOf(one.id) < 0) { vm.selectedHighlightId = one.id; }
                    list = [one];
                } else {
                    list = vm.selectedMarkups();
                    // The markup clicked last first: its settings fill the dialog.
                    list.sort(function (a, b) { return (b.id === vm.selectedHighlightId) - (a.id === vm.selectedHighlightId); });
                }
                if (!list.length) { return; }
                var m = list[0], single = list.length === 1;
                var withColor = list.filter(function (x) { return x.type !== 'highlight'; });
                var withStroke = list.filter(markupGeometry.hasStroke);
                var withFont = list.filter(markupGeometry.hasFont);
                var font = withFont[0] || {};
                var values = {
                    text: m.text || '',
                    color: (withColor[0] || {}).color || vm.markupColor,
                    opacity: Math.round((typeof m.opacity === 'number' ? m.opacity : 1) * 100),
                    strokeWidth: (withStroke[0] || {}).strokeWidth,
                    fontFamily: font.fontFamily || 'helvetica',
                    fontSize: font.fontSize,
                    bold: !!font.bold,
                    italic: !!font.italic,
                    locked: list.every(function (x) { return x.locked; })
                };
                vm.editDialog = angular.extend({
                    ids: list.map(function (x) { return x.id; }),
                    label: single ? markupGeometry.label(m) : plural(list.length, 'markup'),
                    single: single,
                    pageNumber: m.pageNumber,
                    createdAt: single ? m.createdAt : null,
                    grouped: list.some(function (x) { return !!x.groupId; }),
                    someLocked: list.some(function (x) { return x.locked; }),
                    hasText: single && markupGeometry.hasText(m),
                    hasColor: withColor.length > 0,
                    hasStroke: withStroke.length > 0,
                    hasFont: withFont.length > 0,
                    initial: angular.copy(values),
                    error: ''
                }, values);
                $timeout(function () {
                    var input = $document[0].getElementById('edit-text-input');
                    if (input) { input.focus(); }
                });
            };

            vm.closeEditDialog = function () { vm.editDialog = null; };
            vm.setEditColor = function (color) { if (vm.editDialog && !vm.editDialog.locked) { vm.editDialog.color = color; } };

            vm.applyEditDialog = function () {
                var d = vm.editDialog;
                if (!d) { return; }
                var changed = function (key) { return d[key] !== d.initial[key]; };
                var text = null;
                if (d.hasText && changed('text')) {
                    text = String(d.text || '').replace(/\s+$/, '').replace(/^\s*\n/, '');
                    if (!text.trim()) { d.error = 'The text cannot be empty.'; return; }
                    if (text.length > MAX_NOTE_LENGTH) { d.error = 'Keep the text under ' + MAX_NOTE_LENGTH + ' characters.'; return; }
                }
                var opacity = Number(d.opacity), strokeWidth = Number(d.strokeWidth), fontSize = Number(d.fontSize);
                if (changed('opacity') && !(opacity >= 10 && opacity <= 100)) { d.error = 'Opacity goes from 10 to 100 %.'; return; }
                if (d.hasStroke && changed('strokeWidth') && !(strokeWidth >= vm.STROKE_WIDTH.min && strokeWidth <= vm.STROKE_WIDTH.max)) {
                    d.error = 'Line thickness goes from ' + vm.STROKE_WIDTH.min + ' to ' + vm.STROKE_WIDTH.max + ' pt.';
                    return;
                }
                if (d.hasFont && changed('fontSize') && !(fontSize >= vm.FONT_SIZE.min && fontSize <= vm.FONT_SIZE.max)) {
                    d.error = 'Font size goes from ' + vm.FONT_SIZE.min + ' to ' + vm.FONT_SIZE.max + ' pt.';
                    return;
                }
                var updated = 0;
                d.ids.forEach(function (id) {
                    var m = highlightService.find(id);
                    if (!m) { return; }
                    var changes = {};
                    if (changed('locked')) { changes.locked = d.locked; }
                    if (!d.locked) {
                        if (text !== null) { changes.text = m.type === 'stamp' ? text.replace(/\s*\n\s*/g, ' ') : text; }
                        if (changed('color') && m.type !== 'highlight') { changes.color = d.color; }
                        if (changed('opacity')) { changes.opacity = opacity < 100 ? opacity / 100 : undefined; }
                        if (changed('strokeWidth') && markupGeometry.hasStroke(m)) { changes.strokeWidth = Math.round(strokeWidth * 100) / 100; }
                        if (markupGeometry.hasFont(m)) {
                            if (changed('fontFamily')) { changes.fontFamily = d.fontFamily === 'helvetica' ? undefined : d.fontFamily; }
                            if (changed('fontSize')) { changes.fontSize = Math.round(fontSize * 10) / 10; }
                            if (changed('bold')) { changes.bold = d.bold || undefined; }
                            if (changed('italic')) { changes.italic = d.italic || undefined; }
                        }
                        if ('text' in changes || 'fontFamily' in changes || 'fontSize' in changes || 'bold' in changes || 'italic' in changes) {
                            // The box fits the new text or font.
                            angular.extend(changes, markupGeometry.refit(angular.extend({}, m, changes)));
                        }
                    }
                    if (Object.keys(changes).length) {
                        highlightService.update(id, changes);
                        updated++;
                    }
                });
                vm.editDialog = null;
                if (d.single) {
                    var after = highlightService.find(d.ids[0]);
                    vm.status = after ? vm.markupLabel(after) + (updated ? ' changed.' : ': nothing changed.') : vm.status;
                } else {
                    vm.status = updated ? plural(updated, 'markup') + ' changed.' : 'Nothing changed.';
                }
            };

            vm.moveMarkup = function (id, markup) {
                var current = highlightService.find(id);
                if (current && current.locked) { return; }
                var updated = highlightService.update(id, markup);
                if (updated && updated.type === 'count') { vm.status = vm.markupLabel(updated) + '.'; }
            };

            // ----- Revision: compare / overlay with another revision -----
            // show: the kinds of change listed, boxed, stepped through and clouded (the ribbon's Added / Removed / Changed).
            function newCompare() {
                return { fileName: '', pageCount: 0, mode: 'diff', busy: false, result: null, active: -1,
                         show: { added: true, removed: true, changed: true } };
            }
            vm.compare = newCompare();
            vm.revisionView = null;     // what the viewer shows over the page: { page, mode, url, regions, active }
            vm.CHANGE_KINDS = [
                { key: 'added', label: 'Added', title: 'Added: only in this revision (green)' },
                { key: 'removed', label: 'Removed', title: 'Removed: only in the compared revision (red)' },
                { key: 'changed', label: 'Changed', title: 'Changed: moved, resized or rewritten (both added and removed ink)' }
            ];

            /** The changed areas of a comparison result that are shown (their kind is ticked). */
            function visibleRegions(result) {
                return result ? result.regions.filter(function (r) { return vm.compare.show[r.kind]; }) : [];
            }

            function currentResult() {
                var r = vm.compare.result;
                return r && r.pageNumber === vm.currentPage ? r : null;
            }

            /** How many changed areas of `kind` this page has (shown or not). */
            vm.kindCount = function (kind) {
                var r = currentResult();
                return r ? r.regions.filter(function (g) { return g.kind === kind; }).length : 0;
            };

            /** Shows or hides one kind of change. */
            vm.toggleChangeKind = function (kind) {
                if (!compareService.isOpen()) { return; }
                vm.compare.show[kind] = !vm.compare.show[kind];
                vm.compare.active = -1;
                var r = currentResult();
                if (r && vm.compare.mode !== 'off') {
                    vm.revisionView = viewFor(r, -1);
                    vm.status = compareStatus(r);
                }
            };

            vm.isComparing = function () { return compareService.isOpen(); };

            function closeRevisionWork() {
                compareService.close();
                vm.compare = newCompare();
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
                var wasSide = vm.isSideBySide();
                closeRevisionWork();
                if (wasSide && vm.fitMode) { applyFit(vm.fitMode); }
                vm.status = pageStatus();
            };

            vm.setCompareMode = function (mode) {
                if (!compareService.isOpen()) { return; }
                var sideChanged = (mode === 'side') !== (vm.compare.mode === 'side');
                vm.compare.mode = mode;
                $q.when(refreshCompare()).then(function () {
                    // Side by side halves the width each page gets: fit again.
                    if (sideChanged && vm.fitMode) { applyFit(vm.fitMode); }
                });
            };

            /** Side by side shows the pages one at a time, also when the view scrolls continuously. */
            vm.isSideBySide = function () { return compareService.isOpen() && vm.compare.mode === 'side'; };

            function viewFor(result, active) {
                var mode = vm.compare.mode;
                return { page: result.pageNumber, mode: mode,
                         url: mode === 'overlay' ? compareService.overlayUrl(result) : mode === 'diff' ? result.diffUrl : null,
                         otherUrl: mode === 'side' ? compareService.otherUrl(result) : null, otherName: vm.compare.fileName,
                         regions: visibleRegions(result), active: active };
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
                var kinds = vm.CHANGE_KINDS.map(function (k) {
                    var n = r.regions.filter(function (g) { return g.kind === k.key; }).length;
                    return n ? n + ' ' + k.label.toLowerCase() : '';
                }).filter(Boolean).join(', ');
                var shown = visibleRegions(r).length;
                return 'Page ' + r.pageNumber + ': ' + r.regions.length + ' changed area' + (r.regions.length === 1 ? '' : 's') + ': ' + kinds +
                       (shown < r.regions.length ? ' (' + shown + ' shown)' : '') +
                       (vm.compare.mode === 'diff' ? '. Green: added, red: removed in this revision.'
                        : vm.compare.mode === 'side' ? '. ' + name + ' on the left, this revision on the right.'
                        : '. Blue: this revision, red: ' + name + '.');
            }

            $scope.$watch(function () { return vm.currentPage; }, function (page, old) {
                if (page !== old && compareService.isOpen()) { refreshCompare(); }
            });

            /** The changed areas shown on this page. */
            vm.changeCount = function () { return visibleRegions(currentResult()).length; };

            /** Previous / next changed area: on this page first, then on the pages before / after it. */
            vm.goToChange = function (step) {
                var r = vm.compare.result;
                if (!compareService.isOpen() || vm.compare.busy) { return; }
                if (vm.compare.mode === 'off') { vm.compare.mode = 'diff'; }
                if (r && r.pageNumber === vm.currentPage) {
                    var regions = visibleRegions(r);
                    var next = vm.compare.active + step;
                    if (vm.compare.active < 0 && step < 0) { next = regions.length - 1; }
                    if (next >= 0 && next < regions.length) {
                        vm.compare.active = next;
                        vm.revisionView = viewFor(r, next);
                        var kind = vm.CHANGE_KINDS.filter(function (k) { return k.key === regions[next].kind; })[0];
                        vm.status = 'Change ' + (next + 1) + ' of ' + regions.length + ' on page ' + r.pageNumber + ': ' + kind.label.toLowerCase() + '.';
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
                    var count = visibleRegions(result).length;
                    if (!count) {
                        vm.compare.busy = false;
                        searchPages(page + step, step);
                        return;
                    }
                    vm.compare.busy = false;
                    // The page watcher compares the new page (from the cache) and shows this change.
                    pendingActive = { page: page, index: step > 0 ? 0 : count - 1 };
                    goToPage(page);
                }, function (message) {
                    vm.compare.busy = false;
                    showError(typeof message === 'string' ? message : 'Unable to compare page ' + page + '.');
                });
            }

            /**
             * Revision highlighting: marks every changed area shown on this page with a revision cloud (in the current
             * colour and revision) and, when there is a current revision, its tag (a triangle with the label) at the
             * cloud's top-right corner.
             */
            vm.cloudChanges = function () {
                var r = currentResult(), regions = visibleRegions(r);
                if (!regions.length) { return; }
                var revision = revisionService.current();
                pdfService.getPageSize(r.pageNumber).then(function (size) {
                    var sizes = markupGeometry.sizesFor(size.width, size.height);
                    var side = Math.round(sizes.fontSize * 2);
                    regions.forEach(function (region) {
                        vm.addMarkup(r.pageNumber, { type: 'cloud', color: vm.markupColor, strokeWidth: sizes.strokeWidth,
                                                     x: region.x, y: region.y, width: region.width, height: region.height });
                        if (!revision) { return; }
                        vm.addMarkup(r.pageNumber, {
                            type: 'revtag', color: vm.markupColor, strokeWidth: sizes.strokeWidth, text: revision.label,
                            fontSize: Math.max(8, Math.round(sizes.fontSize * 0.85)), width: side, height: side,
                            x: Math.min(Math.max(region.x + region.width - side / 3, 0), size.width - side),
                            y: Math.min(Math.max(region.y - side * 2 / 3, 0), size.height - side)
                        });
                    });
                    vm.selectedHighlightId = null;
                    vm.status = 'Added ' + regions.length + ' revision cloud' + (regions.length === 1 ? '' : 's') +
                        (revision ? ' with Rev ' + revision.label + ' tags' : '') + ' on page ' + r.pageNumber + '.';
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

            // ----- Stamps -----
            vm.STAMPS = [
                { text: 'APPROVED', color: '#26a269' }, { text: 'APPROVED AS NOTED', color: '#26a269' },
                { text: 'REVIEWED', color: '#1c71d8' }, { text: 'REVISE AND RESUBMIT', color: '#c64600' },
                { text: 'REJECTED', color: '#e01b24' }, { text: 'FOR CONSTRUCTION', color: '#26a269' },
                { text: 'NOT FOR CONSTRUCTION', color: '#e01b24' }, { text: 'PRELIMINARY', color: '#1c71d8' },
                { text: 'DRAFT', color: '#1c71d8' }, { text: 'FOR INFORMATION', color: '#1c71d8' },
                { text: 'AS BUILT', color: '#813d9c' }, { text: 'FINAL', color: '#26a269' },
                { text: 'CONFIDENTIAL', color: '#e01b24' }, { text: 'VOID', color: '#e01b24' },
                { text: 'RECEIVED', color: '#1c71d8' }, { text: 'COMPLETED', color: '#26a269' }
            ];
            vm.stampChoice = null;      // { text, color, withName, name } once picked
            vm.stampDialog = null;      // { selected (index or 'custom'), custom, withName, name, error } while open
            var MAX_STAMP_LENGTH = 40;

            vm.openStampDialog = function () {
                if (!vm.hasDocument()) { return; }
                var last = vm.stampChoice;
                var index = last ? vm.STAMPS.findIndex(function (st) { return st.text === last.text && st.color === last.color; }) : 0;
                vm.stampDialog = { selected: index >= 0 ? index : 'custom', custom: last && index < 0 ? last.text : '',
                                   withName: last ? last.withName : true, name: last ? last.name : rememberedAuthor(), error: '' };
            };

            vm.applyStampDialog = function () {
                var d = vm.stampDialog;
                if (!d) { return; }
                var choice;
                if (d.selected === 'custom') {
                    var text = String(d.custom || '').replace(/\s+/g, ' ').trim().toUpperCase();
                    if (!text) { d.error = 'Type the stamp text.'; return; }
                    if (text.length > MAX_STAMP_LENGTH) { d.error = 'Keep the stamp under ' + MAX_STAMP_LENGTH + ' characters.'; return; }
                    choice = { text: text, color: null };
                } else {
                    choice = angular.copy(vm.STAMPS[Number(d.selected)]);
                }
                var name = String(d.name || '').trim();
                if (d.withName && name.length > 60) { d.error = 'Keep the name under 60 characters.'; return; }
                if (d.withName && name) {
                    try { $window.localStorage.setItem(AUTHOR_KEY, name); } catch (e) { /* not remembered */ }
                }
                choice.withName = !!d.withName;
                choice.name = name;
                vm.stampChoice = choice;
                vm.stampDialog = null;
                vm.tool = 'stamp';
                vm.status = 'Stamp ' + choice.text + ': click where it goes.';
            };

            function placeStamp(pageNumber, at) {
                var choice = vm.stampChoice;
                if (!choice) { vm.openStampDialog(); return; }
                pdfService.getPageSize(pageNumber).then(function (size) {
                    var sizes = markupGeometry.sizesFor(size.width, size.height);
                    var fontSize = Math.round(sizes.fontSize * 1.5);
                    var sub = choice.withName ? [choice.name, revisionService.today()].filter(Boolean).join(' \u00b7 ') : '';
                    var box = markupGeometry.stampSize(choice.text, sub, fontSize);
                    var markup = { type: 'stamp', color: choice.color || vm.markupColor, strokeWidth: Math.round(sizes.strokeWidth * 1.2 * 10) / 10,
                                   text: choice.text, fontSize: fontSize, width: box.width, height: box.height,
                                   x: Math.min(Math.max(at.x - box.width / 2, 0), Math.max(0, size.width - box.width)),
                                   y: Math.min(Math.max(at.y - box.height / 2, 0), Math.max(0, size.height - box.height)) };
                    if (sub) { markup.sub = sub; }
                    vm.addMarkup(pageNumber, markup);
                });
            }

            // ----- My markups: markups saved for reuse -----
            vm.customMarkups = customMarkupService.list;
            vm.customChoice = null;     // the item clicks place
            vm.customDialog = null;     // { message } while picking
            vm.customSaveDialog = null; // { id, name, error } while naming the selected markup

            vm.openCustomDialog = function (message) {
                if (!vm.hasDocument()) { return; }
                vm.customDialog = { message: message || '' };
            };

            vm.pickCustom = function (item) {
                vm.customChoice = item;
                vm.customDialog = null;
                vm.tool = 'custom';
                vm.status = 'My markup "' + item.name + '": click where it goes.';
            };

            vm.removeCustom = function (item) {
                customMarkupService.remove(item.id);
                if (vm.customChoice && vm.customChoice.id === item.id) {
                    vm.customChoice = null;
                    if (vm.tool === 'custom') { vm.tool = 'pan'; }
                }
            };

            vm.customLabel = function (item) { return markupGeometry.label(item.markup); };

            /** Adds the selected markup to My markups (asks for a name). */
            vm.openCustomSaveDialog = function () {
                var m = highlightService.find(vm.selectedHighlightId);
                if (!m) { return; }
                vm.customSaveDialog = { id: m.id, name: vm.markupLabel(m).slice(0, 60), error: '' };
                $timeout(function () {
                    var input = $document[0].getElementById('custom-name-input');
                    if (input) { input.focus(); input.select(); }
                });
            };

            vm.applyCustomSaveDialog = function () {
                var d = vm.customSaveDialog;
                var m = d && highlightService.find(d.id);
                if (!m) { vm.customSaveDialog = null; return; }
                var added = customMarkupService.add(d.name, m);
                if (typeof added === 'string') { d.error = added; return; }
                vm.customSaveDialog = null;
                vm.status = '"' + added.name + '" added to My markups: pick it with My markups (Shift+C) and click to place copies.';
            };

            function placeCustom(pageNumber, at) {
                var item = vm.customChoice && customMarkupService.find(vm.customChoice.id);
                if (!item) { vm.openCustomDialog(); return; }
                pdfService.getPageSize(pageNumber).then(function (size) {
                    var copy = angular.copy(item.markup);
                    var b = markupGeometry.bounds(copy);
                    // Centred on the click, kept on the page.
                    var dx = Math.min(Math.max(at.x - b.width / 2, 0), Math.max(0, size.width - b.width)) - b.x;
                    var dy = Math.min(Math.max(at.y - b.height / 2, 0), Math.max(0, size.height - b.height)) - b.y;
                    vm.addMarkup(pageNumber, markupGeometry.translate(copy, dx, dy));
                });
            }

            /** Revision tag, stamp or My markup: placed where the page was clicked (the active tool says which). */
            vm.placeTag = function (pageNumber, at) {
                if (vm.tool === 'stamp') { placeStamp(pageNumber, at); return; }
                if (vm.tool === 'custom') { placeCustom(pageNumber, at); return; }
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

            // ----- Reports: markup list, review report, change report -----
            vm.reportDialog = null;     // { kind, revision, table, totalText, busy, progress, error } while open
            vm.reportKinds = [
                { value: 'markups', label: 'Markup list' }, { value: 'review', label: 'Review report' }, { value: 'changes', label: 'Change report' }
            ];
            var REPORT_SUFFIX = { markups: 'markups', review: 'review', changes: 'changes' };
            var MAX_COMPARE_PAGES = 500;

            vm.openReport = function (kind) {
                if (!vm.hasDocument()) { return; }
                vm.reportDialog = { kind: kind || 'markups', revision: '', table: null, totalText: '', busy: false, progress: '', error: '' };
                vm.updateReport();
            };

            function reportInfo(d) {
                var revision = d.revision === '-' ? 'No revision' : d.revision ? 'Revision ' + d.revision : '';
                return { fileName: vm.fileName, revision: revision, revisionFilter: d.revision, compareName: vm.compare.fileName };
            }

            vm.updateReport = function () {
                var d = vm.reportDialog;
                if (!d) { return; }
                d.error = '';
                if (d.kind === 'changes') { buildChangeReport(d); return; }
                d.table = d.kind === 'review' ? reportService.reviewTable(vm.highlights, reportInfo(d))
                                              : reportService.markupTable(vm.highlights, reportInfo(d));
                var noun = d.kind === 'review' ? 'review item' : 'markup';
                var byType = d.table.summaries[0].items;
                d.totalText = d.table.rows.length + ' ' + noun + (d.table.rows.length === 1 ? '' : 's') +
                    byType.map(function (t) { return ' · ' + t.count + ' ' + t.name; }).join('');
            };

            /** Compares every page with the open comparison (cached per page), then lists the changed areas. */
            function buildChangeReport(d) {
                d.table = null;
                d.totalText = '';
                if (!compareService.isOpen()) {
                    d.error = 'Open the revision to compare with first: Revision tab > Compare.';
                    return;
                }
                var count = Math.min(vm.pageCount, MAX_COMPARE_PAGES), pages = [];
                d.busy = true;
                var chain = $q.when();
                for (var n = 1; n <= count; n++) {
                    chain = chain.then(comparePage.bind(null, n));
                }
                chain.then(function () {
                    if (vm.reportDialog !== d) { return; }
                    d.table = reportService.changeTable(pages, vm.highlights, reportInfo(d));
                    var changed = d.table.summaries[0].items[1].count;
                    d.totalText = d.table.rows.length + ' change' + (d.table.rows.length === 1 ? '' : 's') + ' on ' + changed +
                        ' of ' + count + ' page' + (count === 1 ? '' : 's') + (vm.pageCount > count ? ' (first ' + count + ' pages compared)' : '') +
                        d.table.summaries[2].items.map(function (k) { return ' · ' + k.count + ' ' + k.name.toLowerCase(); }).join('');
                }, function (message) {
                    if (vm.reportDialog === d) { d.error = typeof message === 'string' ? message : 'Unable to compare the pages.'; }
                }).finally(function () {
                    d.busy = false;
                    d.progress = '';
                });

                function comparePage(n) {
                    if (vm.reportDialog !== d) { return $q.reject('cancelled'); }
                    d.progress = 'Comparing page ' + n + ' of ' + count + '…';
                    return $q.all([compareService.comparePage(n), pdfService.getPageSize(n)]).then(function (both) {
                        pages.push({ pageNumber: n, size: both[1], regions: both[0].regions || [], missing: !!both[0].missing });
                    });
                }
            }

            vm.reportRevisions = function () {
                var labels = [];
                vm.highlights.forEach(function (m) { if (m.revision && labels.indexOf(m.revision) < 0) { labels.push(m.revision); } });
                return labels.sort();
            };

            /** Saves the report: 'csv', 'html' (printable), 'pdf' or 'xlsx' (Excel). */
            vm.exportReport = function (format) {
                var d = vm.reportDialog;
                if (!d || d.busy || !d.table || !d.table.rows.length) { return; }
                var content = format === 'csv' ? reportService.toCsv(d.table) : format === 'html' ? reportService.toHtml(d.table) : null;
                var table = format === 'pdf' || format === 'xlsx' ? reportService.toHost(d.table) : null;
                d.busy = true;
                toolsService.saveReport(vm.fileName, format, content, table, REPORT_SUFFIX[d.kind]).then(function (message) {
                    vm.status = message || 'Not saved.';
                }, function (message) {
                    showError(typeof message === 'string' ? message : 'Unable to save the report.');
                }).finally(function () { d.busy = false; });
            };

            // ----- Output: save annotated / flattened PDF, print -----
            vm.saveAnnotatedDialog = null;  // { flatten, scope, pages, withMarkups, busy, error } while open
            vm.printDialog = null;          // { scope, pages, withMarkups, busy, progress, error } while open

            vm.openSaveAnnotated = function (flatten) {
                if (!vm.hasDocument()) { return; }
                vm.saveAnnotatedDialog = { flatten: !!flatten, scope: 'all', pages: String(vm.currentPage), withMarkups: true, busy: false, error: '' };
            };

            /** The pages chosen in an output dialog: null for all of them; { error } when the range is wrong. */
            function outputPages(d) {
                if (d.scope === 'all') { return null; }
                if (d.scope === 'current') { return [vm.currentPage]; }
                var parsed = pagesService.parsePages(d.pages, vm.pageCount);
                return parsed.error ? { error: parsed.error } : parsed.pages;
            }

            vm.applySaveAnnotated = function () {
                var d = vm.saveAnnotatedDialog;
                if (!d || d.busy) { return; }
                var pages = outputPages(d);
                if (pages && pages.error) { d.error = pages.error; return; }
                var markups = d.withMarkups ? vm.highlights : [];
                if (!markups.length && !d.flatten && !pages) { d.error = 'There are no markups to save; choose Flatten or some pages.'; return; }
                d.busy = true;
                d.error = '';
                vm.status = d.flatten ? 'Saving a flattened copy…' : 'Saving a copy with markups…';
                toolsService.saveHighlights(vm.source, vm.fileName, markups, { flatten: d.flatten, pages: pages }).then(function (message) {
                    vm.status = message || 'Not saved.';
                    if (vm.saveAnnotatedDialog === d) { vm.saveAnnotatedDialog = null; }
                }, function (message) {
                    d.error = typeof message === 'string' ? message : 'Unable to save the copy.';
                    vm.status = d.error;
                }).finally(function () { d.busy = false; });
            };

            vm.openPrintDialog = function () {
                if (!vm.hasDocument()) { return; }
                vm.printDialog = { scope: vm.pageCount > printService.MAX_PAGES ? 'current' : 'all', pages: String(vm.currentPage),
                                   withMarkups: true, busy: false, progress: '', error: '' };
            };

            vm.applyPrint = function () {
                var d = vm.printDialog;
                if (!d || d.busy) { return; }
                var pages = outputPages(d);
                if (pages && pages.error) { d.error = pages.error; return; }
                var count = pages ? pages.length : vm.pageCount;
                if (count > printService.MAX_PAGES) { d.error = 'Print up to ' + printService.MAX_PAGES + ' pages at a time: choose a page range.'; return; }
                d.busy = true;
                d.error = '';
                d.progress = 'Preparing the pages…';
                // The printout is the annotated copy, flattened, so it looks exactly like the screen.
                // Closing the dialog (Close, Cancel, Esc) while the pages are prepared cancels the print.
                var cancelled = function () { return vm.printDialog !== d; };
                toolsService.annotatedPdf(vm.source, d.withMarkups ? vm.highlights : [], { flatten: true, pages: pages }).then(function (blob) {
                    if (cancelled()) { return null; }
                    return printService.print(blob, function (done, total) { d.progress = 'Preparing page ' + done + ' of ' + total + '…'; }, cancelled);
                }).then(function (printed) {
                    if (printed === null) { vm.status = 'Print cancelled.'; return; }
                    vm.status = 'Sent ' + printed + ' page' + (printed === 1 ? '' : 's') + ' to the print dialog.';
                    if (vm.printDialog === d) { vm.printDialog = null; }
                }, function (message) {
                    if (cancelled()) { return; }
                    d.error = typeof message === 'string' ? message : 'Unable to print.';
                }).finally(function () {
                    d.busy = false;
                    d.progress = '';
                });
            };

            // ----- Measurement scale -----
            vm.scaleUnits = scaleService.UNITS;
            vm.scaleRatios = scaleService.PRESET_RATIOS;
            // Common architectural and engineering scales for the Custom mode.
            vm.customScales = [
                ['1/16', 'in', '1', 'ft'], ['3/32', 'in', '1', 'ft'], ['1/8', 'in', '1', 'ft'], ['3/16', 'in', '1', 'ft'],
                ['1/4', 'in', '1', 'ft'], ['3/8', 'in', '1', 'ft'], ['1/2', 'in', '1', 'ft'], ['3/4', 'in', '1', 'ft'],
                ['1', 'in', '1', 'ft'], ['1 1/2', 'in', '1', 'ft'], ['3', 'in', '1', 'ft'],
                ['1', 'in', '10', 'ft'], ['1', 'in', '20', 'ft'], ['1', 'in', '30', 'ft'], ['1', 'in', '40', 'ft'],
                ['1', 'in', '50', 'ft'], ['1', 'in', '60', 'ft'], ['1', 'in', '100', 'ft'],
                ['1', 'cm', '1', 'm'], ['1', 'cm', '5', 'm']
            ].map(function (c) {
                var name = c[1] === 'in' && c[3] === 'ft' && c[2] === '1' ? c[0] + '" = 1\'-0"'
                    : c[0] + (c[1] === 'in' ? '"' : ' ' + c[1]) + ' = ' + c[2] + (c[3] === 'ft' ? '\'' : ' ' + c[3]);
                return { label: name, paper: c[0], paperUnit: c[1], real: c[2], realUnit: c[3] };
            });
            vm.paperUnits = ['in', 'mm', 'cm'];
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
                    paper: '1/4', paperUnit: 'in', real: '1', realUnit: 'ft', preset: '',
                    allPages: true,
                    error: ''
                };
                $timeout(function () {
                    var input = $document[0].getElementById(measured ? 'scale-length-input' : 'scale-ratio-input');
                    if (input) { input.focus(); input.select(); }
                });
            };

            vm.closeScaleDialog = function () { vm.scaleDialog = null; };

            /** Custom mode: a common scale picked from the list fills in both sides. */
            vm.applyCustomPreset = function () {
                var d = vm.scaleDialog, preset = d && vm.customScales[Number(d.preset)];
                if (!preset) { return; }
                d.mode = 'custom';
                d.paper = preset.paper; d.paperUnit = preset.paperUnit; d.real = preset.real; d.realUnit = preset.realUnit;
                d.error = '';
            };

            function parseNumber(text) {
                var value = parseFloat(String(text || '').replace(/,/g, '').trim());
                return isFinite(value) && value > 0 ? value : null;
            }

            vm.applyScaleDialog = function () {
                var d = vm.scaleDialog;
                if (!d) { return; }
                var scale;
                if (d.mode === 'known') {
                    var length = scaleService.parseLength(d.length, d.unit);
                    if (!length || length > 1e7) { d.error = 'Enter the real length of the line you drew, e.g. 6000 (mm), 6 (m) or 12\'6" (feet and inches).'; return; }
                    scale = scaleService.fromCalibration(d.measured, length, d.unit);
                } else if (d.mode === 'custom') {
                    var paper = scaleService.parseLength(d.paper, d.paperUnit), real = scaleService.parseLength(d.real, d.realUnit);
                    if (!paper || paper > 1e5) { d.error = 'Enter the length on the drawing, e.g. 1/4 (in) or 10 (mm).'; return; }
                    if (!real || real > 1e7) { d.error = 'Enter the real length it stands for, e.g. 1 (ft) or 20 (ft).'; return; }
                    var label = String(d.paper).trim() + (d.paperUnit === 'in' ? '"' : ' ' + d.paperUnit) + ' = ' +
                                String(d.real).trim() + (d.realUnit === 'ft' ? (/^\d+$/.test(String(d.real).trim()) ? '\'-0"' : '\'')
                                                                             : d.realUnit === 'in' ? '"' : ' ' + d.realUnit);
                    scale = scaleService.fromCustom(paper, d.paperUnit, real, d.realUnit, label);
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

            // ----- Units and precision of measurements (global, remembered) -----
            var UNITS_KEY = 'pdfViewer.measureUnits';
            vm.lengthChoices = scaleService.LENGTH_CHOICES;
            vm.areaChoices = scaleService.AREA_CHOICES;
            vm.fractionChoices = [1, 2, 4, 8, 16, 32, 64];
            vm.unitsDialog = null;      // { unit, area, decimals, fraction } while open
            (function () {
                try {
                    var saved = JSON.parse($window.localStorage.getItem(UNITS_KEY) || 'null');
                    if (saved) { scaleService.setDisplay(saved); }
                } catch (e) { /* defaults */ }
            }());

            /** "m · 0.00", "ft-in · 1/16"" or "As scale" for the Measure tab. */
            vm.unitsLabel = function () {
                var d = scaleService.getDisplay();
                var unit = d.unit === 'scale' ? 'Scale unit' : d.unit;
                var precision = d.unit === 'ft-in' ? (d.fraction === 1 ? '1"' : '1/' + d.fraction + '"')
                    : d.decimals === 'auto' ? 'auto' : d.decimals === 0 ? '0' : '0.' + new Array(d.decimals + 1).join('0');
                return unit + ' \u00b7 ' + precision;
            };

            vm.openUnitsDialog = function () {
                var d = scaleService.getDisplay();
                vm.unitsDialog = { unit: d.unit, area: d.area, decimals: String(d.decimals), fraction: d.fraction };
            };

            vm.applyUnitsDialog = function () {
                var d = vm.unitsDialog;
                if (!d) { return; }
                var settings = { unit: d.unit, area: d.area, decimals: d.decimals === 'auto' ? 'auto' : Number(d.decimals), fraction: Number(d.fraction) };
                scaleService.setDisplay(settings);
                try { $window.localStorage.setItem(UNITS_KEY, JSON.stringify(scaleService.getDisplay())); } catch (e) { /* not remembered */ }
                vm.unitsDialog = null;
                vm.status = 'Measurements are shown in ' + vm.unitsLabel().replace(' \u00b7 ', ', precision ') + '.';
            };

            /** How 3.5 m looks with the dialog's settings. */
            vm.unitsSample = function () {
                var d = vm.unitsDialog;
                if (!d) { return ''; }
                var unit = d.unit === 'scale' ? scaleService.forPage(vm.currentPage).unit : d.unit;
                return scaleService.formatMetres(3.5, unit, d.decimals === 'auto' ? 'auto' : Number(d.decimals), Number(d.fraction));
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

            /** A click on the page: selects the markup (and its group); with Ctrl / Shift adds it or takes it away. */
            vm.selectHighlight = function (id, additive) {
                var m = id === null || id === undefined ? null : highlightService.find(id);
                if (!additive) {
                    setSelection(m ? highlightService.groupOf(m) : []);
                    if (m) { vm.selectedHighlightId = m.id; }
                    return;
                }
                if (!m) { return; }
                var group = highlightService.groupOf(m);
                var list = vm.selectedMarkups();
                if (vm.selectedIds.indexOf(m.id) >= 0) {
                    list = list.filter(function (x) { return group.indexOf(x) < 0; });
                } else {
                    list = list.filter(function (x) { return group.indexOf(x) < 0; }).concat(group);
                }
                setSelection(list);
                if (list.length > 1) { vm.status = plural(list.length, 'markup') + ' selected.'; }
            };

            /** From the markups list: shows the highlight's page and selects it. */
            vm.goToHighlight = function (highlight) {
                if (highlight.pageNumber === vm.currentPage) {
                    vm.selectHighlight(highlight.id, false);
                } else if (!vm.busy) {
                    goToPage(highlight.pageNumber, highlight.id);
                }
            };

            vm.removeHighlight = function (id) {
                var m = highlightService.find(id);
                if (m && m.locked) {
                    vm.status = vm.markupLabel(m) + ' is locked; unlock it to delete it.';
                    return;
                }
                highlightService.remove(id);
                if (vm.selectedIds.indexOf(id) >= 0 || vm.selectedHighlightId === id) {
                    setSelection(vm.selectedMarkups());
                }
            };

            /** Deletes the selected markups (Delete key); locked ones stay. */
            vm.removeSelectedHighlight = function () {
                var list = vm.selectedMarkups();
                if (!list.length) { return; }
                var kept = removeMarkups(list);
                if (list.length > 1 || kept) {
                    vm.status = plural(list.length - kept, 'markup') + ' deleted' + (kept ? '; ' + plural(kept, 'locked markup') + ' kept' : '') + '.';
                }
            };

            /** Clear all: every markup that is not locked. */
            vm.clearHighlights = function () {
                var locked = vm.highlights.filter(function (m) { return m.locked; });
                if (!locked.length) {
                    highlightService.clear();
                    vm.selectedHighlightId = null;
                    return;
                }
                removeMarkups(vm.highlights.slice());
                vm.status = 'Markups cleared; ' + plural(locked.length, 'locked markup') + ' kept.';
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

            // ----- Guided tour (Help > Take the tour); the desktop app shows it once on first run -----
            vm.startTour = tourService.start;
            if (vm.isDesktop && !tourService.hasSeen()) {
                $timeout(function () {
                    if (!tourService.state.active) { tourService.start(); }
                }, 600);
            }

            // ----- Keyboard shortcuts -----
            // Ctrl/Cmd shortcuts (shown in the menus) work everywhere, also while typing in a box.
            // Close has no shortcut: browsers reserve Ctrl+W for closing the tab.
            function onShortcut(event) {
                if (!(event.ctrlKey || event.metaKey) || event.altKey) { return false; }
                var key = event.key.toLowerCase();
                var command = markupShortcut(event, key);
                if (command) {
                    // handled below
                } else if (key === 'o') {
                    command = vm.chooseFile;
                } else if (key === 'p' && vm.hasDocument()) {
                    command = vm.openPrintDialog;   // the browser would print the app, not the document
                } else if (key === 'd' && vm.hasDocument()) {
                    command = vm.openProperties;
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

            // Markup management keys; not while typing in a box or with text selected (the browser copies that).
            function markupShortcut(event, key) {
                var target = event.target, tag = target && target.tagName;
                if (!vm.hasDocument() || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) { return null; }
                if (vm.editDialog || vm.noteDialog) { return null; }
                var textSelected = String($window.getSelection ? $window.getSelection() : '').length > 0;
                var selected = vm.selectedMarkups().length > 0;
                if (key === 'c' && !event.shiftKey && selected && !textSelected) { return vm.copyMarkups; }
                if (key === 'x' && !event.shiftKey && selected && !textSelected) { return vm.cutMarkups; }
                if (key === 'v' && !event.shiftKey && vm.canPaste()) { return vm.pasteMarkups; }
                if (key === 'd' && event.shiftKey && selected) { return vm.duplicateMarkups; }
                if (key === 'g' && !event.shiftKey && vm.canGroup()) { return vm.groupMarkups; }
                if (key === 'g' && event.shiftKey && vm.canUngroup()) { return vm.ungroupMarkups; }
                if (key === 'l' && event.shiftKey && selected) { return vm.toggleLock; }
                if (key === 'e' && !event.shiftKey && selected) { return function () { vm.openEditDialog(); }; }
                if (key === 'a' && !event.shiftKey && !textSelected) { return vm.selectAllMarkups; }
                return null;
            }

            function onKeyDown(event) {
                if (onShortcut(event)) {
                    return;
                }
                var tag = event.target && event.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || !vm.hasDocument()) {
                    return;
                }
                var keyTool = toolForKey(event);
                if (keyTool) {
                    event.preventDefault();
                    $scope.$apply(function () {
                        if (keyTool === 'pan') { vm.selectPanTool(); } else { vm.selectTool(keyTool); }
                    });
                    return;
                }
                $scope.$apply(function () {
                    if ((event.key === 'Delete' || event.key === 'Backspace') && vm.selectedIds.length) {
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
                    } else if (event.key === 'Home') {
                        vm.firstPage();
                        event.preventDefault();
                    } else if (event.key === 'End') {
                        vm.lastPage();
                        event.preventDefault();
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
