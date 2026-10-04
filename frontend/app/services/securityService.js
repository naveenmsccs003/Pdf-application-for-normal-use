(function () {
    'use strict';

    /**
     * The password prompt for opening a protected PDF (web: asked by pdf.js; desktop: by the host). askPassword()
     * shows the prompt (SecurityController draws it) and resolves with what was typed, or rejects when cancelled.
     * Passwords are kept in memory only, never stored.
     */
    angular.module('pdfViewerApp').factory('securityService', ['$q', function ($q) {
        var prompt = null;      // { fileName, wrong, value, deferred } while the prompt is shown

        function askPassword(fileName, wrong) {
            if (prompt) { prompt.deferred.reject('cancelled'); }
            var deferred = $q.defer();
            prompt = { fileName: fileName, wrong: !!wrong, value: '', deferred: deferred };
            return deferred.promise;
        }

        function submit() {
            if (!prompt || !prompt.value) { return; }
            var p = prompt;
            prompt = null;
            p.deferred.resolve(p.value);
        }

        function cancel() {
            if (!prompt) { return; }
            var p = prompt;
            prompt = null;
            p.deferred.reject('cancelled');
        }

        return {
            askPassword: askPassword,
            prompt: function () { return prompt; },
            submit: submit,
            cancel: cancel
        };
    }]);
})();
