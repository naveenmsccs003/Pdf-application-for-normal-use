(function () {
    'use strict';

    /**
     * Reports as tables: { title, subtitle, columns: [{ key, label, width, number }], rows: [{ key: value }],
     * summaries: [{ label, items: [{ name, count }] }] }, written as CSV (for Excel), a self-contained printable HTML
     * page, or (by the host) a PDF or an Excel workbook.
     *   markups  every markup: page, type, content, colour, revision, time
     *   review   the review marks (comments, notes, strikeouts, replacements, stamps …) and what they say
     *   changes  the changed areas found by comparing every page with another revision
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
            if (m.type === 'stamp') { return m.text + (m.sub ? ' (' + m.sub + ')' : ''); }
            return m.text ? m.text.replace(/\s*\n\s*/g, ' / ') : '';
        }

        function byRevision(markups, revision) {
            return markups.filter(function (m) {
                return !revision || (revision === '-' ? !m.revision : m.revision === revision);
            }).slice().sort(function (a, b) { return a.pageNumber - b.pageNumber || a.id - b.id; });
        }

        /** Counts of one column, largest first. */
        function countBy(rows, key, label, name) {
            var counts = {};
            rows.forEach(function (r) { counts[r[key]] = (counts[r[key]] || 0) + 1; });
            return {
                label: label,
                items: Object.keys(counts).map(function (k) { return { name: name ? name(k) : k, count: counts[k] }; })
                    .sort(function (a, b) { return b.count - a.count || (a.name > b.name ? 1 : -1); })
            };
        }

        function subtitle(info, count, noun) {
            return [info.fileName, count + ' ' + noun + (count === 1 ? '' : 's'), info.revision, 'generated ' + formatTime(new Date())]
                .filter(Boolean).join(' · ');
        }

        // ----- Markup list -----
        var MARKUP_COLUMNS = [
            { key: 'number', label: 'No.', width: 0.5, number: true }, { key: 'page', label: 'Page', width: 0.5, number: true },
            { key: 'type', label: 'Type', width: 1.3 }, { key: 'content', label: 'Content', width: 3.5 },
            { key: 'color', label: 'Colour', width: 0.9 }, { key: 'revision', label: 'Revision', width: 0.7 },
            { key: 'created', label: 'Created', width: 1.4 }
        ];

        /** Rows in page order, optionally only one revision ('' = all, '-' = markups without a revision). */
        function rows(markups, revision) {
            return byRevision(markups, revision).map(function (m, i) {
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

        /** Counts by type and by page, largest first (the markup report dialog's summary line). */
        function summary(list) {
            return { total: list.length, byType: countBy(list, 'type', 'Type').items, byPage: countBy(list, 'page', 'Page').items };
        }

        function markupTable(markups, info) {
            var list = rows(markups, info.revisionFilter);
            return {
                kind: 'markups', title: 'Markup report', subtitle: subtitle(info, list.length, 'markup'),
                columns: MARKUP_COLUMNS, rows: list,
                summaries: [countBy(list, 'type', 'By type'), countBy(list, 'page', 'By page', function (p) { return 'Page ' + p; })]
            };
        }

        // ----- Review report -----
        var REVIEW_TYPES = { comment: true, text: true, callout: true, replace: true, strikeout: true, underline: true, stamp: true, revtag: true };

        /** What a review mark asks for, in words. */
        function reviewNote(m) {
            switch (m.type) {
                case 'replace': return 'Replace with: ' + content(m);
                case 'strikeout': return 'Delete the struck-out text';
                case 'underline': return 'Underlined text';
                case 'stamp': return 'Stamp: ' + content(m);
                case 'revtag': return 'Revision tag ' + m.text;
                default: return content(m);
            }
        }

        function reviewTable(markups, info) {
            var list = byRevision(markups, info.revisionFilter).filter(function (m) { return REVIEW_TYPES[m.type]; }).map(function (m, i) {
                return { number: i + 1, page: m.pageNumber, type: markupGeometry.label(m), note: reviewNote(m),
                         revision: m.revision || '', created: formatTime(m.createdAt) };
            });
            return {
                kind: 'review', title: 'Review report', subtitle: subtitle(info, list.length, 'review item'),
                columns: [
                    { key: 'number', label: 'No.', width: 0.5, number: true }, { key: 'page', label: 'Page', width: 0.5, number: true },
                    { key: 'type', label: 'Type', width: 1.2 }, { key: 'note', label: 'Comment', width: 4.5 },
                    { key: 'revision', label: 'Revision', width: 0.7 }, { key: 'created', label: 'Created', width: 1.4 }
                ],
                rows: list,
                summaries: [countBy(list, 'type', 'By type'), countBy(list, 'page', 'By page', function (p) { return 'Page ' + p; })]
            };
        }

        // ----- Change report -----
        var MM = 25.4 / 72;

        /** "top left", "middle", "bottom right" … for a box on a page. */
        function placeOn(region, size) {
            var cx = (region.x + region.width / 2) / size.width, cy = (region.y + region.height / 2) / size.height;
            var v = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle';
            var h = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'centre';
            return v === 'middle' && h === 'centre' ? 'middle' : v + ' ' + h;
        }

        function overlaps(a, b) {
            return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        }

        /**
         * `pages`: [{ pageNumber, size: { width, height }, regions, missing }] from comparing each page with
         * `info.compareName`. A changed area marked with a revision cloud says so (and which revision).
         */
        var CHANGE_KINDS = { added: 'Added', removed: 'Removed', changed: 'Changed' };
        var CHANGE_TEXT = { added: 'Added: only in this revision', removed: 'Removed: only in the compared revision',
                            changed: 'Changed: moved, resized or rewritten' };

        function changeTable(pages, markups, info) {
            var list = [], changed = 0, added = 0;
            pages.forEach(function (p) {
                if (p.missing) {
                    added++;
                    list.push({ number: list.length + 1, page: p.pageNumber, place: 'whole page', area: '', kind: 'Added',
                                change: 'New page (not in ' + info.compareName + ')', cloud: '' });
                    return;
                }
                if (p.regions.length) { changed++; }
                p.regions.forEach(function (r) {
                    var cloud = markups.find(function (m) { return m.type === 'cloud' && m.pageNumber === p.pageNumber && overlaps(m, r); });
                    list.push({
                        number: list.length + 1, page: p.pageNumber, place: placeOn(r, p.size),
                        area: Math.round(r.width * MM) + ' × ' + Math.round(r.height * MM) + ' mm at ' +
                              Math.round(r.x * MM) + ', ' + Math.round(r.y * MM) + ' mm',
                        kind: CHANGE_KINDS[r.kind] || 'Changed', change: CHANGE_TEXT[r.kind] || CHANGE_TEXT.changed,
                        cloud: cloud ? 'Yes' + (cloud.revision ? ' (rev ' + cloud.revision + ')' : '') : 'No'
                    });
                });
            });
            return {
                kind: 'changes', title: 'Change report',
                subtitle: [info.fileName, 'compared with ' + info.compareName, list.length + ' change' + (list.length === 1 ? '' : 's'),
                           'generated ' + formatTime(new Date())].join(' · '),
                columns: [
                    { key: 'number', label: 'No.', width: 0.5, number: true }, { key: 'page', label: 'Page', width: 0.5, number: true },
                    { key: 'kind', label: 'Kind', width: 0.8 }, { key: 'change', label: 'Change', width: 2 }, { key: 'place', label: 'Where', width: 1 },
                    { key: 'area', label: 'Size and position (from top left)', width: 2.4 }, { key: 'cloud', label: 'Clouded', width: 0.9 }
                ],
                rows: list,
                summaries: [{ label: 'Pages', items: [
                    { name: 'compared', count: pages.length }, { name: 'with changes', count: changed },
                    { name: 'new', count: added }, { name: 'unchanged', count: pages.length - changed - added }] },
                    countBy(list, 'page', 'Changes by page', function (p) { return 'Page ' + p; }),
                    countBy(list, 'kind', 'Changes by kind')]
            };
        }

        // ----- Writing -----
        function cell(row, column) {
            var v = row[column.key];
            return v === undefined || v === null ? '' : String(v);
        }

        function csvCell(value) {
            var text = String(value === undefined || value === null ? '' : value);
            // Cells starting with = + - @ would be formulas in Excel.
            if (/^[=+\-@]/.test(text)) { text = "'" + text; }
            return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
        }

        function toCsv(table) {
            var lines = [table.columns.map(function (c) { return c.label; }).join(',')];
            table.rows.forEach(function (r) { lines.push(table.columns.map(function (c) { return csvCell(cell(r, c)); }).join(',')); });
            return lines.join('\r\n') + '\r\n';
        }

        function esc(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function toHtml(table) {
            var swatch = function (c) {
                var color = c === 'Yellow' ? '#ffdd00' : /^#[0-9a-f]{6}$/i.test(c) ? c : 'transparent';
                return '<span class="sw" style="background:' + color + '"></span>' + esc(c);
            };
            var body = '<table><thead><tr>' + table.columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
                table.rows.map(function (r) {
                    return '<tr>' + table.columns.map(function (c) {
                        return '<td' + (c.number ? ' class="num"' : '') + '>' + (c.key === 'color' ? swatch(cell(r, c)) : esc(cell(r, c))) + '</td>';
                    }).join('') + '</tr>';
                }).join('') + '</tbody></table>';
            var counts = (table.summaries || []).map(function (s) {
                return '<table class="counts"><thead><tr><th>' + esc(s.label) + '</th><th>Count</th></tr></thead><tbody>' +
                    s.items.map(function (i) { return '<tr><td>' + esc(i.name) + '</td><td class="num">' + i.count + '</td></tr>'; }).join('') +
                    '</tbody></table>';
            }).join('');
            return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
                '<title>' + esc(table.title) + '</title><style>' +
                'body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2933;margin:24px;}' +
                'h1{font-size:18px;margin:0 0 4px;}p.meta{color:#616e7c;margin:0 0 16px;}' +
                'table{border-collapse:collapse;width:100%;margin:0 0 18px;}th,td{border:1px solid #d5d9e0;padding:4px 6px;text-align:left;vertical-align:top;}' +
                'th{background:#eef0f3;}td.num{text-align:right;font-variant-numeric:tabular-nums;}' +
                '.counts{width:auto;min-width:220px;display:inline-table;margin-right:18px;vertical-align:top;}' +
                '.sw{display:inline-block;width:10px;height:10px;border:1px solid #999;margin-right:5px;vertical-align:-1px;}' +
                '@media print{body{margin:0;}th{background:#eee !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
                '</style></head><body>' +
                '<h1>' + esc(table.title) + '</h1><p class="meta">' + esc(table.subtitle) + '</p>' +
                (table.rows.length ? counts + body : '<p>Nothing to report.</p>') +
                '</body></html>\n';
        }

        /** The table as the host writes it (PDF / Excel): rows as lists of text. */
        function toHost(table) {
            return {
                title: table.title, subtitle: table.subtitle,
                columns: table.columns.map(function (c) { return { label: c.label, width: c.width || 1, number: !!c.number }; }),
                rows: table.rows.map(function (r) { return table.columns.map(function (c) { return cell(r, c); }); }),
                summaries: table.summaries
            };
        }

        return {
            rows: rows,
            summary: summary,
            markupTable: markupTable,
            reviewTable: reviewTable,
            changeTable: changeTable,
            toCsv: toCsv,
            toHtml: toHtml,
            toHost: toHost,
            formatTime: formatTime
        };
    }]);
})();
