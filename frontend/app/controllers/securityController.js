(function () {
    'use strict';

    /**
     * Security tab: password protection (Protect, Remove password), digital signatures (Sign, Signatures) and the
     * password prompt for opening protected PDFs (securityService). The work is done by the host / server
     * (toolsService, PdfSecurity.cs, PdfSignatures.cs). A signed document gets a badge on its tab; the Signatures
     * dialog lists every signature with what was checked.
     */
    angular.module('pdfViewerApp').controller('SecurityController', ['$scope', '$document', '$timeout', 'securityService', 'pdfService',
        'toolsService',
        function ($scope, $document, $timeout, securityService, pdfService, toolsService) {
            var sec = this;
            var MAX_PASSWORD = 127;

            sec.isDesktop = toolsService.isDesktop;
            sec.maxPassword = MAX_PASSWORD;
            sec.protectDialog = null;
            sec.unprotectDialog = null;
            sec.signDialog = null;
            sec.signaturesDialog = null;
            sec.signatures = null;      // the open document's checked signatures (null until checked)
            sec.CORNERS = [{ value: 'bottom-right', label: 'Bottom right' }, { value: 'bottom-left', label: 'Bottom left' },
                           { value: 'top-right', label: 'Top right' }, { value: 'top-left', label: 'Top left' }];

            function vm() { return $scope.vm; }

            function focus(id) {
                $timeout(function () { var el = $document[0].getElementById(id); if (el) { el.focus(); } });
            }

            // ----- Password prompt (opening a protected PDF) -----
            sec.prompt = securityService.prompt;
            sec.submitPassword = function () { securityService.submit(); };
            sec.cancelPassword = function () { securityService.cancel(); };
            $scope.$watch(function () { return securityService.prompt(); }, function (p) { if (p) { focus('open-password'); } });

            // ----- Protect -----
            sec.openProtect = function () {
                if (!vm().hasDocument()) { return; }
                sec.protectDialog = { userPassword: '', userConfirm: '', ownerPassword: '', allowPrint: true, allowCopy: true,
                                      allowAnnotate: true, allowForms: true, allowModify: false, allowAssemble: false, busy: false, error: '' };
                focus('protect-user');
            };

            sec.runProtect = function () {
                var d = sec.protectDialog;
                if (!d || d.busy) { return; }
                d.error = !d.userPassword && !d.ownerPassword ? 'Enter a password to open the PDF, a password for its permissions, or both.'
                    : d.userPassword !== d.userConfirm ? 'The two open passwords are not the same.'
                    : d.ownerPassword && d.ownerPassword === d.userPassword ? 'The permissions password must differ from the open password.'
                    : '';
                if (d.error) { return; }
                d.busy = true;
                var options = { userPassword: d.userPassword, ownerPassword: d.ownerPassword, allowPrint: d.allowPrint, allowCopy: d.allowCopy,
                                allowModify: d.allowModify, allowAnnotate: d.allowAnnotate, allowForms: d.allowForms, allowAssemble: d.allowAssemble };
                finish(d, toolsService.protect(vm().source, vm().fileName, options), function () { sec.protectDialog = null; });
            };

            // ----- Remove password -----
            sec.openUnprotect = function () {
                if (!vm().hasDocument()) { return; }
                sec.unprotectDialog = { password: '', openedWithPassword: !!pdfService.password() || vm().openedWithPassword, busy: false, error: '' };
                focus('unprotect-password');
            };

            sec.runUnprotect = function () {
                var d = sec.unprotectDialog;
                if (!d || d.busy) { return; }
                d.busy = true;
                d.error = '';
                finish(d, toolsService.unprotect(vm().source, vm().fileName, d.password), function () { sec.unprotectDialog = null; });
            };

            // ----- Sign -----
            sec.openSign = function () {
                if (!vm().hasDocument()) { return; }
                sec.signDialog = { certificate: null, certificatePassword: '', reason: '', location: '', contact: '', visible: true,
                                   page: vm().currentPage, corner: 'bottom-right', busy: false, error: '' };
            };

            sec.setCertificate = function (file) {
                var d = sec.signDialog;
                if (!d) { return; }
                d.error = '';
                if (file && !/\.(pfx|p12)$/i.test(file.name)) {
                    d.error = 'Choose a .pfx or .p12 certificate file.';
                    d.certificate = null;
                    return;
                }
                d.certificate = file || null;
            };

            sec.runSign = function () {
                var d = sec.signDialog;
                if (!d || d.busy) { return; }
                var page = Number(d.page);
                d.error = !sec.isDesktop && !d.certificate ? 'Choose your certificate file (.pfx or .p12).'
                    : d.visible && !(page >= 1 && page <= vm().pageCount && page === Math.floor(page)) ? 'Enter a page between 1 and ' + vm().pageCount + '.'
                    : '';
                if (d.error) { return; }
                d.busy = true;
                var options = { certificatePassword: d.certificatePassword, reason: d.reason, location: d.location, contact: d.contact,
                                page: d.visible ? page : 0, corner: d.corner };
                finish(d, toolsService.sign(vm().source, vm().fileName, options, d.certificate), function () { sec.signDialog = null; });
            };

            /** Shows the result in the status bar and closes the dialog; errors stay in the dialog. Cancelled (null): stays open. */
            function finish(d, promise, close) {
                promise.then(function (message) {
                    if (message) {
                        vm().status = message;
                        close();
                    }
                }, function (message) {
                    d.error = typeof message === 'string' ? message : 'Something went wrong. Please try again.';
                }).finally(function () { d.busy = false; });
            }

            // ----- Signatures: checked when a document opens; the badge and dialog show the result -----
            function checkSignatures() {
                var version = vm().docVersion;
                sec.signatures = null;
                if (!vm().hasDocument()) { return; }
                pdfService.getSignatures(vm().source).then(function (list) {
                    if (vm().docVersion === version) { sec.signatures = list || []; }
                }, function () {
                    if (vm().docVersion === version) { sec.signatures = []; }
                });
            }
            $scope.$watch(function () { return vm().docVersion + ':' + vm().pageCount; }, function () { checkSignatures(); });

            /** 'valid' | 'warning' | 'invalid' for the badge (the worst signature), or null when unsigned. */
            sec.badge = function () {
                var list = sec.signatures;
                if (!list || !list.length) { return null; }
                if (list.some(function (s) { return s.status === 'invalid'; })) { return 'invalid'; }
                return list.every(function (s) { return s.status === 'valid'; }) ? 'valid' : 'warning';
            };

            sec.badgeText = function () {
                var b = sec.badge(), n = sec.signatures ? sec.signatures.length : 0;
                if (!b) { return ''; }
                var what = n === 1 ? 'Signed' : n + ' signatures';
                return b === 'valid' ? what : b === 'invalid' ? what + ': invalid' : what + ': check';
            };

            sec.openSignatures = function () {
                if (!vm().hasDocument()) { return; }
                var d = sec.signaturesDialog = { loading: true, list: [], error: '' };
                pdfService.getSignatures(vm().source).then(function (list) {
                    if (sec.signaturesDialog !== d) { return; }
                    d.list = list || [];
                    sec.signatures = d.list;
                }, function (message) {
                    if (sec.signaturesDialog !== d) { return; }
                    d.error = typeof message === 'string' ? message : 'Unable to check the signatures.';
                }).finally(function () { d.loading = false; });
            };

            sec.formatDate = function (value) { return value ? new Date(value).toLocaleString() : '—'; };

            function anyDialog() {
                return sec.protectDialog || sec.unprotectDialog || sec.signDialog || sec.signaturesDialog || securityService.prompt();
            }

            sec.closeAll = function () {
                if (sec.protectDialog && sec.protectDialog.busy || sec.unprotectDialog && sec.unprotectDialog.busy ||
                    sec.signDialog && sec.signDialog.busy) { return; }
                sec.protectDialog = sec.unprotectDialog = sec.signDialog = sec.signaturesDialog = null;
                securityService.cancel();
            };

            // While a dialog is open, keys belong to it (Esc closes it). Capture phase, before the viewer's keys.
            function onKeyDown(event) {
                if (!anyDialog()) { return; }
                event.stopImmediatePropagation();
                if (event.key === 'Escape') { $scope.$apply(sec.closeAll); }
            }
            $document[0].addEventListener('keydown', onKeyDown, true);
            $scope.$on('$destroy', function () { $document[0].removeEventListener('keydown', onKeyDown, true); });
        }]);
})();
