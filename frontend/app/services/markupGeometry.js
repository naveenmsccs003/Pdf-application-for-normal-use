(function () {
    'use strict';

    /**
     * Shapes of the markups, all in PDF units at scale 1 (top-left origin, displayed orientation):
     * SVG outlines for the page overlay, bounding boxes, hit testing, and the data sent when saving
     * a copy (curves are sent as polylines, so the host draws exactly what is on screen).
     *
     * Markup fields by type (besides id, type, pageNumber, color, strokeWidth, createdAt):
     *   highlight, rect, ellipse, cloud   x, y, width, height
     *   line, arrow                       x1, y1, x2, y2
     *   pen                               points [x0, y0, x1, y1, ...]
     *   text                              x, y, width, height, text, fontSize
     *   callout                           as text, plus tipX, tipY (the point the leader arrow points at)
     */
    angular.module('pdfViewerApp').factory('markupGeometry', function () {
        var LABELS = {
            highlight: 'Highlight', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', line: 'Line',
            arrow: 'Arrow', pen: 'Freehand', text: 'Text note', callout: 'Callout'
        };
        var LINE_HEIGHT = 1.25;     // times the font size
        var PADDING = 0.4;          // text box padding, times the font size
        var ASCENT = 0.8;           // first baseline below the padding, times the font size
        var FONT = 'Helvetica, Arial, sans-serif';

        /** Line width and text size for a page: readable at Fit Page on anything from A4 to A0. */
        function sizesFor(pageWidth, pageHeight) {
            var side = Math.max(pageWidth, pageHeight);
            return {
                strokeWidth: Math.max(1.5, Math.round(side / 500 * 10) / 10),
                fontSize: Math.max(10, Math.round(side / 70))
            };
        }

        function arrowHead(x1, y1, x2, y2, strokeWidth) {
            var length = Math.hypot(x2 - x1, y2 - y1) || 1;
            var size = Math.min(Math.max(8, strokeWidth * 5), length * 0.6);
            var ux = (x2 - x1) / length, uy = (y2 - y1) / length;
            var spread = 0.45;  // about 25° each side
            return [
                x2 - size * (ux * Math.cos(spread) - uy * Math.sin(spread)), y2 - size * (uy * Math.cos(spread) + ux * Math.sin(spread)),
                x2, y2,
                x2 - size * (ux * Math.cos(spread) + uy * Math.sin(spread)), y2 - size * (uy * Math.cos(spread) - ux * Math.sin(spread))
            ];
        }

        // Cloud: semicircular scallops bulging outwards, clockwise around the rectangle.
        function cloudPoints(m) {
            var step = Math.max(8, m.strokeWidth * 7);
            var corners = [[m.x, m.y], [m.x + m.width, m.y], [m.x + m.width, m.y + m.height], [m.x, m.y + m.height]];
            var points = [];
            for (var i = 0; i < 4; i++) {
                var a = corners[i], b = corners[(i + 1) % 4];
                var n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
                for (var k = 0; k < n; k++) {
                    points.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
                }
            }
            return points;
        }

        function cloudPath(m) {
            var pts = cloudPoints(m);
            var d = 'M' + pts[0][0] + ' ' + pts[0][1];
            for (var i = 0; i < pts.length; i++) {
                var a = pts[i], b = pts[(i + 1) % pts.length];
                var r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
                d += 'A' + r + ' ' + r + ' 0 0 1 ' + b[0] + ' ' + b[1];
            }
            return d + 'Z';
        }

        function cloudPolyline(m) {
            var pts = cloudPoints(m), out = [], STEPS = 8;
            for (var i = 0; i < pts.length; i++) {
                var a = pts[i], b = pts[(i + 1) % pts.length];
                var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
                var len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
                // Outward normal for a clockwise path in top-left-origin coordinates.
                var nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
                for (var s = (i === 0 ? 0 : 1); s <= STEPS; s++) {
                    var t = Math.PI * s / STEPS;
                    out.push(cx + (a[0] - cx) * Math.cos(t) + nx * len / 2 * Math.sin(t),
                             cy + (a[1] - cy) * Math.cos(t) + ny * len / 2 * Math.sin(t));
                }
            }
            return out;
        }

        function polylinePath(p) {
            var d = '';
            for (var i = 0; i < p.length; i += 2) { d += (i ? 'L' : 'M') + p[i] + ' ' + p[i + 1]; }
            return d;
        }

        /** Where the callout's leader line leaves its box: the nearest point on the box to the tip. */
        function leaderStart(m) {
            return [Math.min(Math.max(m.tipX, m.x), m.x + m.width), Math.min(Math.max(m.tipY, m.y), m.y + m.height)];
        }

        function calloutHasLeader(m) {
            var s = leaderStart(m);
            return Math.hypot(m.tipX - s[0], m.tipY - s[1]) > 1;
        }

        /** The lines of stroke the shape is drawn with, as polylines [x0, y0, x1, y1, ...]. */
        function strokes(m) {
            switch (m.type) {
                case 'line': return [[m.x1, m.y1, m.x2, m.y2]];
                case 'arrow': return [[m.x1, m.y1, m.x2, m.y2], arrowHead(m.x1, m.y1, m.x2, m.y2, m.strokeWidth)];
                case 'pen': return [m.points];
                case 'cloud': return [cloudPolyline(m)];
                case 'callout':
                    if (!calloutHasLeader(m)) { return []; }
                    var s = leaderStart(m);
                    return [[s[0], s[1], m.tipX, m.tipY], arrowHead(s[0], s[1], m.tipX, m.tipY, m.strokeWidth)];
                default: return [];
            }
        }

        /** SVG path data of the outline (text boxes are drawn separately). */
        function path(m) {
            switch (m.type) {
                case 'rect':
                case 'text':
                case 'callout':
                    var box = 'M' + m.x + ' ' + m.y + 'h' + m.width + 'v' + m.height + 'h' + (-m.width) + 'Z';
                    return m.type === 'callout' ? box + strokes(m).map(polylinePath).join('') : box;
                case 'ellipse':
                    var rx = m.width / 2, ry = m.height / 2, cy = m.y + ry;
                    return 'M' + m.x + ' ' + cy + 'A' + rx + ' ' + ry + ' 0 1 0 ' + (m.x + m.width) + ' ' + cy +
                           'A' + rx + ' ' + ry + ' 0 1 0 ' + m.x + ' ' + cy + 'Z';
                case 'cloud': return cloudPath(m);
                default: return strokes(m).map(polylinePath).join('');
            }
        }

        function bounds(m) {
            if (m.x !== undefined && m.width !== undefined) {
                var b = { x: m.x, y: m.y, width: m.width, height: m.height };
                if (m.type === 'callout') {
                    var x0 = Math.min(b.x, m.tipX), y0 = Math.min(b.y, m.tipY);
                    b = { x: x0, y: y0, width: Math.max(b.x + b.width, m.tipX) - x0, height: Math.max(b.y + b.height, m.tipY) - y0 };
                }
                return b;
            }
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            strokes(m).forEach(function (p) {
                for (var i = 0; i < p.length; i += 2) {
                    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
                    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
                }
            });
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }

        function distanceToSegment(px, py, ax, ay, bx, by) {
            var dx = bx - ax, dy = by - ay;
            var t = dx || dy ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
            return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }

        /** Whether a point (PDF units) is on the markup: inside a box or shape, or near a line. */
        function hits(m, x, y, tolerance) {
            var near = strokes(m).some(function (p) {
                if (p.length === 2) { return Math.hypot(x - p[0], y - p[1]) <= tolerance; }
                for (var i = 0; i + 3 < p.length; i += 2) {
                    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= tolerance) { return true; }
                }
                return false;
            });
            if (near || m.width === undefined) { return near; }
            return x >= m.x - tolerance && x <= m.x + m.width + tolerance && y >= m.y - tolerance && y <= m.y + m.height + tolerance;
        }

        // ----- Text boxes -----
        var measureContext = null;
        function textWidth(text, fontSize) {
            if (!measureContext) { measureContext = document.createElement('canvas').getContext('2d'); }
            measureContext.font = fontSize + 'px ' + FONT;
            return measureContext.measureText(text).width;
        }

        /** Size of the box for a note: lines as typed, no wrapping. */
        function textBox(text, fontSize) {
            var lines = textLines(text);
            var widest = Math.max.apply(null, lines.map(function (l) { return textWidth(l, fontSize); }));
            var pad = fontSize * PADDING;
            return { width: Math.ceil(widest + 2 * pad), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT + 2 * pad - fontSize * (LINE_HEIGHT - 1)) };
        }

        function textLines(text) {
            return String(text || '').replace(/\r/g, '').split('\n');
        }

        /** Baseline positions of each line, shared with the host so the saved copy matches the screen. */
        function textLayout(m) {
            var pad = m.fontSize * PADDING;
            return textLines(m.text).map(function (line, i) {
                return { text: line, x: m.x + pad, y: m.y + pad + m.fontSize * ASCENT + i * m.fontSize * LINE_HEIGHT };
            });
        }

        function round(v) { return Math.round(v * 100) / 100; }

        /** What the host needs to write the markup into a PDF copy. */
        function toSaved(m) {
            var saved = { type: m.type, pageNumber: m.pageNumber };
            if (m.type === 'highlight') {
                saved.x = m.x; saved.y = m.y; saved.width = m.width; saved.height = m.height;
                return saved;
            }
            var b = bounds(m);
            saved.x = round(b.x); saved.y = round(b.y); saved.width = round(b.width); saved.height = round(b.height);
            if (m.type === 'rect' || m.type === 'ellipse' || m.type === 'text' || m.type === 'callout') {
                saved.x = round(m.x); saved.y = round(m.y); saved.width = round(m.width); saved.height = round(m.height);
            }
            saved.color = m.color;
            saved.strokeWidth = m.strokeWidth;
            saved.strokes = strokes(m).map(function (p) { return p.map(round); });
            if (m.type === 'text' || m.type === 'callout') {
                saved.text = m.text;
                saved.fontSize = m.fontSize;
                saved.lines = textLayout(m).map(function (l) { return { text: l.text, x: round(l.x), y: round(l.y) }; });
            }
            return saved;
        }

        function label(m) {
            return LABELS[m.type] || 'Markup';
        }

        return {
            LABELS: LABELS,
            FONT: FONT,
            sizesFor: sizesFor,
            path: path,
            bounds: bounds,
            hits: hits,
            strokes: strokes,
            textBox: textBox,
            textLayout: textLayout,
            toSaved: toSaved,
            label: label
        };
    });
})();
