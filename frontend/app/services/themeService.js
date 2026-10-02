(function () {
    'use strict';

    /**
     * Light / dark theme. Follows the system setting until the user picks a theme,
     * which is remembered in this browser. The CSS reads data-theme on <html>.
     */
    angular.module('pdfViewerApp').factory('themeService', ['$window', '$rootScope', function ($window, $rootScope) {
        var STORAGE_KEY = 'pdfViewer.theme';
        var root = $window.document.documentElement;
        var systemDark = $window.matchMedia ? $window.matchMedia('(prefers-color-scheme: dark)') : null;

        function readSaved() {
            try {
                var value = $window.localStorage.getItem(STORAGE_KEY);
                return value === 'light' || value === 'dark' ? value : null;
            } catch (e) {
                return null; // storage blocked (private mode, disabled site data)
            }
        }

        function save(theme) {
            try {
                $window.localStorage.setItem(STORAGE_KEY, theme);
            } catch (e) {
                // Not critical: the theme still applies for this visit.
            }
        }

        var chosen = readSaved();

        function current() {
            return chosen || (systemDark && systemDark.matches ? 'dark' : 'light');
        }

        function apply() {
            if (chosen) {
                root.setAttribute('data-theme', chosen);
            } else {
                root.removeAttribute('data-theme');
            }
        }

        function toggle() {
            chosen = current() === 'dark' ? 'light' : 'dark';
            save(chosen);
            apply();
        }

        // Keep the toggle icon in sync when the system theme changes and no choice was made.
        if (systemDark && systemDark.addEventListener) {
            systemDark.addEventListener('change', function () {
                if (!chosen) {
                    $rootScope.$applyAsync();
                }
            });
        }

        apply();

        return {
            current: current,
            isDark: function () { return current() === 'dark'; },
            toggle: toggle
        };
    }]);
})();
