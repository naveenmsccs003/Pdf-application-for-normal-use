(function () {
    'use strict';

    /** ng-change does not work on file inputs; this calls a handler with the selected file. */
    angular.module('pdfViewerApp').directive('onFileSelected', function () {
        return {
            restrict: 'A',
            scope: { onFileSelected: '&' },
            link: function (scope, element) {
                element.on('change', function () {
                    var file = element[0].files && element[0].files[0];
                    // Reset so choosing the same file again still triggers a change.
                    element[0].value = '';
                    if (file) {
                        scope.$apply(function () {
                            scope.onFileSelected({ file: file });
                        });
                    }
                });
            }
        };
    });
})();
