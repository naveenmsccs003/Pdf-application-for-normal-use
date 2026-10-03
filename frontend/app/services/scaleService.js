(function () {
    'use strict';

    /**
     * Drawing scale for measurements, per page (a drawing set often mixes scales), in memory for the open
     * document. A scale is the real length, in its unit, of one PDF point (1/72 inch on paper).
     * Until a scale is set, measurements are shown as paper sizes in millimetres (1:1).
     */
    angular.module('pdfViewerApp').factory('scaleService', function () {
        var MM_PER_POINT = 25.4 / 72;
        var UNITS = {               // metres per unit
            mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048
        };
        var DECIMALS = { mm: 0, cm: 1, m: 2, in: 2, ft: 2 };
        var PRESET_RATIOS = [1, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2500];
        var DEFAULT = { unitsPerPoint: MM_PER_POINT, unit: 'mm', label: '1:1 (not set)', isDefault: true };

        var pages = {};             // pageNumber -> scale
        var allPages = null;        // scale for pages without their own
        var service = { version: 0 };

        /** Scale of a 1:ratio drawing, measured in `unit`. */
        function fromRatio(ratio, unit) {
            return { unitsPerPoint: ratio * MM_PER_POINT * UNITS.mm / UNITS[unit], unit: unit, label: '1:' + ratio };
        }

        /** Scale from a calibration: `points` on the page are `length` in `unit`. */
        function fromCalibration(points, length, unit) {
            return { unitsPerPoint: length / points, unit: unit, label: 'Calibrated' };
        }

        function forPage(pageNumber) {
            return pages[pageNumber] || allPages || DEFAULT;
        }

        /** Sets the scale of one page, or of every page when pageNumber is null. */
        function set(pageNumber, scale) {
            if (pageNumber === null) {
                allPages = scale;
                pages = {};
            } else {
                pages[pageNumber] = scale;
            }
            service.version++;
        }

        function clear() {
            pages = {};
            allPages = null;
            service.version++;
        }

        function format(value, unit, decimals) {
            var d = decimals === undefined ? DECIMALS[unit] : decimals;
            return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
        }

        /** "3.25 m" for a length in PDF points on a page. */
        function formatLength(points, pageNumber) {
            var scale = forPage(pageNumber);
            return format(points * scale.unitsPerPoint, scale.unit) + ' ' + scale.unit;
        }

        /** "12.40 m²" for an area in square points: metric scales in m², imperial ones in ft². */
        function formatArea(squarePoints, pageNumber) {
            var scale = forPage(pageNumber);
            var metric = scale.unit === 'mm' || scale.unit === 'cm' || scale.unit === 'm';
            var areaUnit = metric ? 'm' : 'ft';
            var factor = scale.unitsPerPoint * UNITS[scale.unit] / UNITS[areaUnit];
            return format(squarePoints * factor * factor, areaUnit, 2) + ' ' + areaUnit + '²';
        }

        return angular.extend(service, {
            UNITS: Object.keys(UNITS),
            PRESET_RATIOS: PRESET_RATIOS,
            fromRatio: fromRatio,
            fromCalibration: fromCalibration,
            forPage: forPage,
            set: set,
            clear: clear,
            formatLength: formatLength,
            formatArea: formatArea
        });
    });
})();
