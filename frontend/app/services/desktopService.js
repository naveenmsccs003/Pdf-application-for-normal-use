(function () {
    'use strict';

    /**
     * Bridge to the desktop host (Photino). In the desktop app, files are opened with the native
     * dialog and read straight from disk; in a normal browser this service is inactive.
     */
    angular.module('pdfViewerApp').factory('desktopService', ['$window', '$rootScope', function ($window, $rootScope) {
        var external = $window.external;
        var isDesktop = !!(external && typeof external.sendMessage === 'function' && typeof external.receiveMessage === 'function');
        var handlers = {};

        if (isDesktop) {
            external.receiveMessage(function (raw) {
                var message;
                try {
                    message = JSON.parse(raw);
                } catch (e) {
                    return;
                }
                var handler = handlers[message.type];
                if (handler) {
                    $rootScope.$apply(function () { handler(message); });
                }
            });
        }

        return {
            isDesktop: isDesktop,
            /** Registers the handler for a host message type (one per type). */
            on: function (type, handler) { handlers[type] = handler; },
            send: function (type) {
                if (isDesktop) {
                    external.sendMessage(JSON.stringify({ type: type }));
                }
            }
        };
    }]);
})();
