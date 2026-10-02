(function () {
    'use strict';

    /** ng-change does not work on file inputs; this calls a handler with the selected file(s). */
    angular.module('pdfViewerApp').directive('onFileSelected', function () {
        return {
            restrict: 'A',
            scope: { onFileSelected: '&' },
            link: function (scope, element) {
                element.on('change', function () {
                    var files = Array.prototype.slice.call(element[0].files || []);
                    // Reset so choosing the same file again still triggers a change.
                    element[0].value = '';
                    if (files.length) {
                        scope.$apply(function () {
                            scope.onFileSelected({ file: files[0], files: files });
                        });
                    }
                });
            }
        };
    });
})();
