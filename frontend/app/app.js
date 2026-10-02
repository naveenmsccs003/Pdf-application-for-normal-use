(function () {
    'use strict';

    angular.module('pdfViewerApp', [])
        .constant('VIEWER_CONFIG', {
            apiBase: 'api/pdf',
            maxFileSizeMB: 50,                       // keep in sync with backend appsettings.json
            zoomSteps: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3],
            pagePadding: 16                          // px around the page inside the viewer
        })
        .config(['$compileProvider', function ($compileProvider) {
            $compileProvider.debugInfoEnabled(false);
        }])
        .run(function () {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
        });
})();
