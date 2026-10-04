(function () {
    'use strict';

    /**
     * Drawing scale for measurements, per page (a drawing set often mixes scales), in memory for the open
     * document. A scale is the real length, in its unit, of one PDF point (1/72 inch on paper).
     * Until a scale is set, measurements are shown as paper sizes in millimetres (1:1).
     *
     * How values are shown is a separate, global setting (Measure > Units): the length unit (the scale's own unit,
     * or any other, converted), the area unit and the precision (decimals, or the fraction of an inch for feet-inches).
     */
    angular.module('pdfViewerApp').factory('scaleService', function () {
        var MM_PER_POINT = 25.4 / 72;
        var UNITS = {               // metres per unit
            mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144
        };
        var SCALE_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];
        var DECIMALS = { mm: 0, cm: 1, m: 2, km: 3, in: 2, ft: 2, yd: 2 };
        var IMPERIAL = { in: true, ft: true, yd: true, 'ft-in': true };
        var AREA_UNITS = {          // square metres per unit
            'mm²': 1e-6, 'cm²': 1e-4, 'm²': 1, 'ha': 1e4, 'km²': 1e6,
            'in²': 0.00064516, 'ft²': 0.09290304, 'yd²': 0.83612736, 'acre': 4046.8564224
        };
        var LENGTH_CHOICES = [
            { value: 'scale', label: 'As the scale' }, { value: 'mm', label: 'Millimetres (mm)' },
            { value: 'cm', label: 'Centimetres (cm)' }, { value: 'm', label: 'Metres (m)' }, { value: 'km', label: 'Kilometres (km)' },
            { value: 'in', label: 'Inches (in)' }, { value: 'ft', label: 'Feet (ft)' }, { value: 'yd', label: 'Yards (yd)' },
            { value: 'ft-in', label: 'Feet and inches (12\'-6 1/2")' }
        ];
        var AREA_CHOICES = [{ value: 'auto', label: 'Automatic (m² or ft²)' }].concat(Object.keys(AREA_UNITS).map(function (u) {
            return { value: u, label: u === 'ha' ? 'Hectares (ha)' : u === 'acre' ? 'Acres' : u };
        }));
        var display = { unit: 'scale', area: 'auto', decimals: 'auto', fraction: 16 };
        var PRESET_RATIOS = [1, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2500];
        var DEFAULT = { unitsPerPoint: MM_PER_POINT, unit: 'mm', label: '1:1 (not set)', isDefault: true };

        var pages = {};             // pageNumber -> scale
        var allPages = null;        // scale for pages without their own
        var service = { version: 0 };

        /** Scale of a 1:ratio drawing, measured in `unit`. */
        function fromRatio(ratio, unit) {
            return { unitsPerPoint: ratio * MM_PER_POINT * UNITS.mm / UNITS[unit], unit: unit, label: '1:' + ratio };
        }

        /**
         * A custom scale: `paper` (in `paperUnit`) on the drawing is `real` (in `realUnit`), e.g. 1/4 in = 1 ft or
         * 1 in = 20 ft. `label` is how it was typed.
         */
        function fromCustom(paper, paperUnit, real, realUnit, label) {
            var paperPoints = paper * UNITS[paperUnit] / UNITS.in * 72;
            return { unitsPerPoint: real / paperPoints, unit: realUnit, label: label };
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

        /** After a page edit: `map[i]` is the old page number of new page i + 1 (null for an added page). */
        function remap(map) {
            var old = pages;
            pages = {};
            map.forEach(function (from, i) {
                if (from && old[from]) { pages[i + 1] = old[from]; }
            });
            service.version++;
        }

        function format(value, decimals) {
            return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        }

        /** How values are shown: { unit, area, decimals ('auto' or 0-4), fraction (2-64, feet-inches) }. */
        function setDisplay(settings) {
            display = {
                unit: settings.unit === 'scale' || settings.unit === 'ft-in' || UNITS[settings.unit] ? settings.unit : 'scale',
                area: settings.area === 'auto' || AREA_UNITS[settings.area] ? settings.area : 'auto',
                decimals: settings.decimals === 'auto' ? 'auto' : Math.min(4, Math.max(0, Math.round(Number(settings.decimals)) || 0)),
                fraction: [1, 2, 4, 8, 16, 32, 64].indexOf(Number(settings.fraction)) >= 0 ? Number(settings.fraction) : 16
            };
            service.version++;
        }

        function getDisplay() { return angular.copy(display); }

        /** The unit lengths on a page are shown in. */
        function lengthUnit(pageNumber) {
            return display.unit === 'scale' ? forPage(pageNumber).unit : display.unit;
        }

        /** A length in PDF points on a page, in metres (through the page's scale). */
        function metres(points, pageNumber) {
            var scale = forPage(pageNumber);
            return points * scale.unitsPerPoint * UNITS[scale.unit];
        }

        /** 150.5 inches -> 12'-6 1/2" (to the nearest 1/fraction inch). */
        function feetInches(inches, fraction) {
            var sign = inches < 0 ? '-' : '';
            var total = Math.round(Math.abs(inches) * fraction);     // in 1/fraction inch
            var feet = Math.floor(total / (12 * fraction));
            total -= feet * 12 * fraction;
            var whole = Math.floor(total / fraction), part = total - whole * fraction, denominator = fraction;
            while (part && part % 2 === 0) { part /= 2; denominator /= 2; }
            return sign + feet.toLocaleString('en-US') + '\'-' + whole + (part ? ' ' + part + '/' + denominator : '') + '"';
        }

        /** A length in metres shown in `unit` ('ft-in' to the nearest 1/fraction inch) with `decimals` ('auto' or 0-4). */
        function formatMetres(value, unit, decimals, fraction) {
            if (unit === 'ft-in') { return feetInches(value / UNITS.in, fraction || 16); }
            return format(value / UNITS[unit], decimals === 'auto' ? DECIMALS[unit] : decimals) + ' ' + unit;
        }

        /** "3.25 m" (or 10'-8") for a length in PDF points on a page. */
        function formatLength(points, pageNumber) {
            return formatMetres(metres(points, pageNumber), lengthUnit(pageNumber), display.decimals, display.fraction);
        }

        /** "12.40 m²" for an area in square points: automatic is m² for metric units and ft² for imperial ones. */
        function formatArea(squarePoints, pageNumber) {
            var unit = display.area === 'auto' ? (IMPERIAL[lengthUnit(pageNumber)] ? 'ft²' : 'm²') : display.area;
            var perPoint = metres(1, pageNumber);
            var decimals = display.decimals === 'auto' ? 2 : display.decimals;
            return format(squarePoints * perPoint * perPoint / AREA_UNITS[unit], decimals) + ' ' + unit;
        }

        /**
         * A typed length in `unit`, or null: "6000", "1,250.5", "1/4", "1 1/2", or feet and inches such as 12'6",
         * 12'-6 1/2" or 6" (converted to `unit`).
         */
        function parseLength(text, unit) {
            var value = String(text == null ? '' : text).trim().replace(/,/g, '').replace(/[\u2019\u2032]/g, "'").replace(/[\u201d\u2033]/g, '"');
            var feetInches = /^(?:(\d+(?:\.\d+)?)\s*')?\s*-?\s*(?:(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*")?$/.exec(value);
            if (feetInches && (feetInches[1] || feetInches[2]) && /['"]/.test(value)) {
                var inches = (feetInches[1] ? Number(feetInches[1]) * 12 : 0) + (feetInches[2] ? amount(feetInches[2]) : 0);
                return inches > 0 && UNITS[unit] ? inches * UNITS.in / UNITS[unit] : null;
            }
            var n = amount(value);
            return n !== null && n > 0 ? n : null;
        }

        // "2", "2.5", "1/4", "1 1/2" -> number, else null.
        function amount(text) {
            var m = /^(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?$/.exec(String(text).trim());
            if (!m || (!m[1] && !m[2]) || (m[2] && Number(m[3]) === 0)) { return null; }
            return (m[1] ? Number(m[1]) : 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
        }

        return angular.extend(service, {
            UNITS: SCALE_UNITS,
            LENGTH_CHOICES: LENGTH_CHOICES,
            AREA_CHOICES: AREA_CHOICES,
            PRESET_RATIOS: PRESET_RATIOS,
            fromRatio: fromRatio,
            fromCustom: fromCustom,
            fromCalibration: fromCalibration,
            parseLength: parseLength,
            setDisplay: setDisplay,
            getDisplay: getDisplay,
            lengthUnit: lengthUnit,
            forPage: forPage,
            set: set,
            clear: clear,
            remap: remap,
            formatLength: formatLength,
            formatMetres: formatMetres,
            formatArea: formatArea
        });
    });
})();
