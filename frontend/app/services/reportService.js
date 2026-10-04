(function () {
    'use strict';

    /**
     * Markup report: one row per markup (page, type, content, colour, revision, time) with a summary by
     * type and by page, as CSV (for Excel) or a self-contained printable HTML page.
     */
    angular.module('pdfViewerApp').factory('reportService', ['markupGeometry', function (markupGeometry) {
        function pad(n) { return String(n).padStart(2, '0'); }

        function formatTime(date) {
            var d = new Date(date);
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                   pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        /** What the markup says: its text, or its measured value. */
        function content(m) {
            if (markupGeometry.isMeasure(m)) { return markupGeometry.measureText(m); }
            if (m.type === 'revtag') { return 'Revision ' + m.text; }
            return m.text ? m.text.replace(/\s*\n\s*/g, ' / ') : '';
        }

        /** Rows in page order, optionally only one revision ('' = all, '-' = markups without a revision). */
        function rows(markups, revision) {
            return markups.filter(function (m) {
                return !revision || (revision === '-' ? !m.revision : m.revision === revision);
            }).slice().sort(function (a, b) { return a.pageNumber - b.pageNumber || a.id - b.id; }).map(function (m, i) {
                return {
                    number: i + 1,
                    page: m.pageNumber,
                    type: markupGeometry.label(m),
                    content: content(m),
                    color: m.type === 'highlight' ? 'Yellow' : (m.color || ''),
                    revision: m.revision || '',
                    created: formatTime(m.createdAt)
                };
            });
        }

        /** Counts by type and by page, largest first. */
        function summary(list) {
            function count(key) {
                var counts = {};
                list.forEach(function (r) { counts[r[key]] = (counts[r[key]] || 0) + 1; });
                return Object.keys(counts).map(function (k) { return { name: k, count: counts[k] }; })
                    .sort(function (a, b) { return b.count - a.count || (a.name > b.name ? 1 : -1); });
            }
            return { total: list.length, byType: count('type'), byPage: count('page') };
        }

        var COLUMNS = [['number', 'No.'], ['page', 'Page'], ['type', 'Type'], ['content', 'Content'],
                       ['color', 'Colour'], ['revision', 'Revision'], ['created', 'Created']];

        function csvCell(value) {
            var text = String(value === undefined || value === null ? '' : value);
            // Cells starting with = + - @ would be formulas in Excel.
            if (/^[=+\-@]/.test(text)) { text = "'" + text; }
            return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
        }

        function toCsv(list) {
            var lines = [COLUMNS.map(function (c) { return c[1]; }).join(',')];
            list.forEach(function (r) { lines.push(COLUMNS.map(function (c) { return csvCell(r[c[0]]); }).join(',')); });
            return lines.join('\r\n') + '\r\n';
        }

        function esc(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function toHtml(list, info) {
            var s = summary(list);
            var swatch = function (c) {
                var color = c === 'Yellow' ? '#ffdd00' : /^#[0-9a-f]{6}$/i.test(c) ? c : 'transparent';
                return '<span class="sw" style="background:' + color + '"></span>' + esc(c);
            };
            var table = '<table><thead><tr>' + COLUMNS.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
                list.map(function (r) {
                    return '<tr>' + COLUMNS.map(function (c) {
                        return '<td' + (c[0] === 'number' || c[0] === 'page' ? ' class="num"' : '') + '>' +
                               (c[0] === 'color' ? swatch(r.color) : esc(r[c[0]])) + '</td>';
                    }).join('') + '</tr>';
                }).join('') + '</tbody></table>';
            var counts = function (items, label) {
                return '<table class="counts"><thead><tr><th>' + label + '</th><th>Count</th></tr></thead><tbody>' +
                    items.map(function (i) { return '<tr><td>' + esc(label === 'Page' ? 'Page ' + i.name : i.name) + '</td><td class="num">' + i.count + '</td></tr>'; }).join('') +
                    '</tbody></table>';
            };
            return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
                '<title>Markup report - ' + esc(info.fileName) + '</title><style>' +
                'body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2933;margin:24px;}' +
                'h1{font-size:18px;margin:0 0 4px;}p.meta{color:#616e7c;margin:0 0 16px;}' +
                'table{border-collapse:collapse;width:100%;margin:0 0 18px;}th,td{border:1px solid #d5d9e0;padding:4px 6px;text-align:left;vertical-align:top;}' +
                'th{background:#eef0f3;}td.num{text-align:right;font-variant-numeric:tabular-nums;}' +
                '.counts{width:auto;min-width:220px;display:inline-table;margin-right:18px;vertical-align:top;}' +
                '.sw{display:inline-block;width:10px;height:10px;border:1px solid #999;margin-right:5px;vertical-align:-1px;}' +
                '@media print{body{margin:0;}th{background:#eee !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
                '</style></head><body>' +
                '<h1>Markup report</h1><p class="meta">' + esc(info.fileName) + ' &middot; ' + s.total + ' markup' + (s.total === 1 ? '' : 's') +
                (info.revision ? ' &middot; ' + esc(info.revision) : '') + ' &middot; generated ' + esc(formatTime(new Date())) + '</p>' +
                (s.total ? counts(s.byType, 'Type') + counts(s.byPage, 'Page') + table : '<p>No markups.</p>') +
                '</body></html>\n';
        }

        return {
            rows: rows,
            summary: summary,
            toCsv: toCsv,
            toHtml: toHtml,
            formatTime: formatTime
        };
    }]);
})();
