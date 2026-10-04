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
     *   pen, polyline                     points [x0, y0, x1, y1, ...]
     *   stamp                             x, y, width, height, text (the stamp, e.g. APPROVED), sub (optional
     *                                     second line: name and date), fontSize
     *   text                              x, y, width, height, text, fontSize
     *   callout                           as text, plus tipX, tipY (the point the leader arrow points at)
     *   distance, hdistance, vdistance    points [x0, y0, x1, y1], fontSize (value label)
     *   area, perimeter                   points [x0, y0, ...] of the closed outline, fontSize
     *   count                             points [x0, y0, ...]: one marker per counted item, fontSize
     *   perpendicular                     points [ax, ay, bx, by, px, py]: reference line A-B and the point P, fontSize
     *   strikeout, underline              x, y, width, height (the text the line goes through / under)
     *   replace                           as strikeout, plus text (the correction) and fontSize
     *   comment                           x, y, width, height (the icon), text
     *   revtag                            x, y, width, height (the triangle), text (revision label), fontSize
     * Any markup may have `revision`: the label of the revision it was made in (revisionService); `opacity` (0.1-1,
 * none = 1); `locked` (cannot be moved, resized, changed or deleted until unlocked); `groupId` (selected, moved,
 * copied and deleted together with the other markups of its page with the same id). Markups with visible text
 * (hasFont) may have `fontFamily` (a key of FONTS, none = helvetica), `bold` and `italic`.
     * Measurement values come from the page's scale (scaleService), so they follow a new calibration.
     */
    angular.module('pdfViewerApp').factory('markupGeometry', ['scaleService', function (scaleService) {
        var LABELS = {
            highlight: 'Highlight', rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', line: 'Line',
            arrow: 'Arrow', pen: 'Freehand', polyline: 'Polyline', text: 'Text note', callout: 'Callout', stamp: 'Stamp',
            distance: 'Distance', hdistance: 'Horizontal distance', vdistance: 'Vertical distance',
            area: 'Area', perimeter: 'Perimeter', count: 'Count', perpendicular: 'Perpendicular distance',
            comment: 'Comment', strikeout: 'Strikeout', underline: 'Underline', replace: 'Replace text',
            revtag: 'Revision tag'
        };
        var TEXT_TYPES = { text: true, callout: true, comment: true, replace: true, stamp: true };   // markups with typed text
        var MEASURES = { distance: true, hdistance: true, vdistance: true, area: true, perimeter: true, count: true, perpendicular: true };
        var LINE_HEIGHT = 1.25;     // times the font size
        var PADDING = 0.4;          // text box padding, times the font size
        var ASCENT = 0.8;           // first baseline below the padding, times the font size
        var FONT = 'Helvetica, Arial, sans-serif';
        // The PDF standard fonts, so a saved copy uses the same font; css is the closest font on screen.
        var FONTS = {
            helvetica: { name: 'Sans-serif (Helvetica)', css: FONT },
            times: { name: 'Serif (Times)', css: '"Times New Roman", Times, "Liberation Serif", serif' },
            courier: { name: 'Monospace (Courier)', css: '"Courier New", Courier, "Liberation Mono", monospace' }
        };
        var FONT_SIZE = { min: 4, max: 300 };
        var STROKE_WIDTH = { min: 0.25, max: 50 };
        var NO_STROKE = { highlight: true, comment: true, strikeout: true, underline: true };   // drawn without a set line width
        var KEEP_ASPECT = { text: true, callout: true, stamp: true, comment: true, revtag: true };   // resized evenly

        /** CSS font family of a markup's text. */
        function fontFamily(m) { return (FONTS[m && m.fontFamily] || FONTS.helvetica).css; }

        // Canvas font for measuring `size` px text in the markup's font (`bold` forces bold).
        function cssFont(size, font, bold) {
            font = font || {};
            return (font.italic ? 'italic ' : '') + (bold || font.bold ? 'bold ' : '') + size + 'px ' + fontFamily(font);
        }

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

        // ----- Measurements -----
        function isMeasure(m) { return MEASURES[m.type] === true; }

        function closedOutline(p) { return p.concat([p[0], p[1]]); }

        // Short tick across a dimension line's end, perpendicular to (dx, dy).
        function tick(x, y, dx, dy, size) {
            var len = Math.hypot(dx, dy) || 1;
            var nx = -dy / len * size, ny = dx / len * size;
            return [x - nx, y - ny, x + nx, y + ny];
        }

        // ----- Count: a ringed dot per item -----
        function markerRadius(m) { return m.fontSize * 0.45; }

        function circle(cx, cy, r) {
            var out = [], STEPS = 16;
            for (var i = 0; i <= STEPS; i++) {
                var a = 2 * Math.PI * i / STEPS;
                out.push(Math.round((cx + r * Math.cos(a)) * 100) / 100, Math.round((cy + r * Math.sin(a)) * 100) / 100);
            }
            return out;
        }

        function countStrokes(m) {
            var p = m.points, r = markerRadius(m), out = [];
            for (var i = 0; i + 1 < p.length; i += 2) {
                out.push(circle(p[i], p[i + 1], r), circle(p[i], p[i + 1], r * 0.3));
            }
            return out;
        }

        // ----- Perpendicular distance: from the point P square to the line through A and B -----
        /** The foot of the perpendicular from P to the line A-B, and where it is along A-B (0 = A, 1 = B). */
        function perpendicularFoot(m) {
            var p = m.points, ax = p[0], ay = p[1], dx = p[2] - ax, dy = p[3] - ay;
            var t = dx || dy ? ((p[4] - ax) * dx + (p[5] - ay) * dy) / (dx * dx + dy * dy) : 0;
            return { x: ax + t * dx, y: ay + t * dy, t: t };
        }

        function perpendicularStrokes(m) {
            var p = m.points, f = perpendicularFoot(m), size = m.fontSize * 0.35;
            var out = [[p[0], p[1], p[2], p[3]]];
            // The line is extended (A-B is the reference) when the foot is beyond its ends.
            if (f.t < 0) { out.push([p[0], p[1], f.x, f.y]); }
            if (f.t > 1) { out.push([p[2], p[3], f.x, f.y]); }
            var dx = p[4] - f.x, dy = p[5] - f.y, length = Math.hypot(dx, dy);
            out.push([p[4], p[5], f.x, f.y]);
            if (length > size * 2) {
                out.push(tick(p[4], p[5], dx, dy, size));
                // Right-angle mark at the foot, on the side of the line towards the middle of A-B.
                var ux = p[2] - p[0], uy = p[3] - p[1], ul = Math.hypot(ux, uy) || 1;
                var toward = f.t > 0.5 ? -1 : 1, q = Math.min(size * 1.6, length / 3);
                ux = ux / ul * q * toward; uy = uy / ul * q * toward;
                var vx = dx / length * q, vy = dy / length * q;
                out.push([f.x + ux, f.y + uy, f.x + ux + vx, f.y + uy + vy, f.x + vx, f.y + vy]);
            }
            return out;
        }

        function measureStrokes(m) {
            if (m.type === 'count') { return countStrokes(m); }
            if (m.type === 'perpendicular') { return perpendicularStrokes(m); }
            var p = m.points, t = m.fontSize * 0.35;
            var x0 = p[0], y0 = p[1], x1 = p[2], y1 = p[3];
            switch (m.type) {
                case 'distance':
                    return [[x0, y0, x1, y1], tick(x0, y0, x1 - x0, y1 - y0, t), tick(x1, y1, x1 - x0, y1 - y0, t)];
                case 'hdistance':
                    // Dimension line level with the first point; a witness line drops to the second point.
                    var h = [[x0, y0, x1, y0], tick(x0, y0, 1, 0, t), tick(x1, y0, 1, 0, t)];
                    return Math.abs(y1 - y0) > 0.5 ? h.concat([[x1, y0, x1, y1]]) : h;
                case 'vdistance':
                    var v = [[x0, y0, x0, y1], tick(x0, y0, 0, 1, t), tick(x0, y1, 0, 1, t)];
                    return Math.abs(x1 - x0) > 0.5 ? v.concat([[x0, y1, x1, y1]]) : v;
                default:
                    return [closedOutline(p)];
            }
        }

        function polygonArea(p) {
            var sum = 0;
            for (var i = 0; i < p.length; i += 2) {
                var j = (i + 2) % p.length;
                sum += p[i] * p[j + 1] - p[j] * p[i + 1];
            }
            return Math.abs(sum) / 2;
        }

        function outlineLength(p) {
            var sum = 0;
            for (var i = 0; i < p.length; i += 2) {
                var j = (i + 2) % p.length;
                sum += Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
            }
            return sum;
        }

        /** The measured value as shown, e.g. "3.25 m" or "12.40 m²". */
        function measureText(m) {
            var p = m.points;
            switch (m.type) {
                case 'distance': return scaleService.formatLength(Math.hypot(p[2] - p[0], p[3] - p[1]), m.pageNumber);
                case 'hdistance': return scaleService.formatLength(Math.abs(p[2] - p[0]), m.pageNumber);
                case 'vdistance': return scaleService.formatLength(Math.abs(p[3] - p[1]), m.pageNumber);
                case 'area': return scaleService.formatArea(polygonArea(p), m.pageNumber);
                case 'count':
                    var n = p.length / 2;
                    return n.toLocaleString('en-US') + (n === 1 ? ' item' : ' items');
                case 'perpendicular':
                    var f = perpendicularFoot(m);
                    return scaleService.formatLength(Math.hypot(p[4] - f.x, p[5] - f.y), m.pageNumber);
                default: return scaleService.formatLength(outlineLength(p), m.pageNumber);
            }
        }

        // Where the value label sits: the middle of the dimension line, or the middle of the outline.
        function labelAnchor(m) {
            var p = m.points;
            if (m.type === 'distance') { return [(p[0] + p[2]) / 2, (p[1] + p[3]) / 2]; }
            if (m.type === 'hdistance') { return [(p[0] + p[2]) / 2, p[1]]; }
            if (m.type === 'vdistance') { return [p[0], (p[1] + p[3]) / 2]; }
            if (m.type === 'perpendicular') {
                var foot = perpendicularFoot(m);
                return [(p[4] + foot.x) / 2, (p[5] + foot.y) / 2];
            }
            if (m.type === 'count') {
                // Above the first marker.
                return [p[0], p[1] - markerRadius(m) - m.fontSize * 1.1];
            }
            // Centroid of the polygon; the average of the corners if it has no area.
            var a = 0, cx = 0, cy = 0, n = p.length / 2;
            for (var i = 0; i < p.length; i += 2) {
                var j = (i + 2) % p.length, f = p[i] * p[j + 1] - p[j] * p[i + 1];
                a += f; cx += (p[i] + p[j]) * f; cy += (p[i + 1] + p[j + 1]) * f;
            }
            if (Math.abs(a) < 1e-6) {
                for (var k = 0; k < p.length; k += 2) { cx += p[k]; cy += p[k + 1]; }
                return [cx / n, cy / n];
            }
            return [cx / (3 * a), cy / (3 * a)];
        }

        /** The value label: a box centred on the anchor, with its text laid out like a note. */
        function measureLabel(m) {
            var text = measureText(m);
            var box = textBox(text, m.fontSize, m);
            var anchor = labelAnchor(m);
            var label = { text: text, fontSize: m.fontSize, width: box.width, height: box.height,
                          x: anchor[0] - box.width / 2, y: anchor[1] - box.height / 2 };
            label.lines = textLayout(label);
            return label;
        }

        /** The lines of stroke the shape is drawn with, as polylines [x0, y0, x1, y1, ...]. */
        function strokes(m) {
            if (isMeasure(m)) { return measureStrokes(m); }
            switch (m.type) {
                case 'strikeout':
                case 'replace':
                    var mid = m.y + m.height / 2;
                    return [[m.x, mid, m.x + m.width, mid]];
                case 'underline':
                    var base = m.y + m.height - m.strokeWidth / 2;
                    return [[m.x, base, m.x + m.width, base]];
                case 'revtag':
                    return [[m.x + m.width / 2, m.y, m.x + m.width, m.y + m.height, m.x, m.y + m.height, m.x + m.width / 2, m.y]];
                case 'line': return [[m.x1, m.y1, m.x2, m.y2]];
                case 'arrow': return [[m.x1, m.y1, m.x2, m.y2], arrowHead(m.x1, m.y1, m.x2, m.y2, m.strokeWidth)];
                case 'pen':
                case 'polyline': return [m.points];
                case 'stamp': return stampFrames(m);
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
                case 'comment': return commentIcon(m).bubble;
                default: return strokes(m).map(polylinePath).join('');
            }
        }

        function bounds(m) {
            if (m.type === 'replace') {
                var r = replaceLabel(m);
                return boundsOf([[m.x, m.y, m.x + m.width, m.y + m.height], [r.x, r.y, r.x + r.width, r.y + r.height]]);
            }
            if (isMeasure(m)) {
                var l = measureLabel(m);
                var all = strokes(m).concat([[l.x, l.y, l.x + l.width, l.y + l.height]]);
                return boundsOf(all);
            }
            if (m.x !== undefined && m.width !== undefined) {
                var b = { x: m.x, y: m.y, width: m.width, height: m.height };
                if (m.type === 'callout') {
                    var x0 = Math.min(b.x, m.tipX), y0 = Math.min(b.y, m.tipY);
                    b = { x: x0, y: y0, width: Math.max(b.x + b.width, m.tipX) - x0, height: Math.max(b.y + b.height, m.tipY) - y0 };
                }
                return b;
            }
            return boundsOf(strokes(m));
        }

        function boundsOf(polylines) {
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            polylines.forEach(function (p) {
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
            if (near) { return true; }
            if (isMeasure(m)) {
                var l = measureLabel(m);
                if (m.type === 'count') {
                    for (var i = 0; i + 1 < m.points.length; i += 2) {
                        if (Math.hypot(x - m.points[i], y - m.points[i + 1]) <= markerRadius(m) + tolerance) { return true; }
                    }
                }
                return (x >= l.x && x <= l.x + l.width && y >= l.y && y <= l.y + l.height) ||
                       (m.type === 'area' && insidePolygon(m.points, x, y));
            }
            if (m.type === 'replace') {
                var r = replaceLabel(m);
                if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) { return true; }
            }
            if (m.width === undefined) { return false; }
            return x >= m.x - tolerance && x <= m.x + m.width + tolerance && y >= m.y - tolerance && y <= m.y + m.height + tolerance;
        }

        function insidePolygon(p, x, y) {
            var inside = false;
            for (var i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
                if ((p[i + 1] > y) !== (p[j + 1] > y) && x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) {
                    inside = !inside;
                }
            }
            return inside;
        }

        // ----- Review marks -----
        /** Speech-bubble icon of a comment filling its box: the bubble and three text lines (SVG paths). */
        function commentIcon(m) {
            var x = m.x, y = m.y, w = m.width, h = m.height, r = w * 0.15;
            var bottom = y + h * 0.75;
            var bubble = 'M' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) +
                         'V' + (bottom - r) + 'Q' + (x + w) + ' ' + bottom + ' ' + (x + w - r) + ' ' + bottom +
                         'H' + (x + w * 0.45) + 'L' + (x + w * 0.2) + ' ' + (y + h) + 'L' + (x + w * 0.25) + ' ' + bottom +
                         'H' + (x + r) + 'Q' + x + ' ' + bottom + ' ' + x + ' ' + (bottom - r) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'Z';
            var lines = '';
            [0.22, 0.38, 0.54].forEach(function (f, i) {
                lines += 'M' + (x + w * 0.22) + ' ' + (y + h * f) + 'H' + (x + w * (i === 2 ? 0.6 : 0.78));
            });
            return { bubble: bubble, lines: lines };
        }

        /** The correction of a Replace text mark: a label just above the struck text (below it at the page top). */
        function replaceLabel(m) {
            var box = textBox(m.text, m.fontSize, m);
            var gap = m.fontSize * 0.2;
            var y = m.y - gap - box.height;
            if (y < 0) { y = m.y + m.height + gap; }
            var label = { text: m.text, fontSize: m.fontSize, x: m.x, y: y, width: box.width, height: box.height };
            label.lines = textLayout(label);
            return label;
        }

        /** The revision label centred in the lower part of a revision tag's triangle. */
        function revtagLines(m) {
            return [{ text: m.text, x: m.x + m.width / 2 - textWidth(m.text, m.fontSize, m) / 2, y: m.y + m.height * 0.82 }];
        }

        // ----- Stamp: a framed, bold word with an optional smaller line (name and date) -----
        var STAMP_SUB = 0.45;       // second line, times the font size

        function boldWidth(text, fontSize, font) {
            if (!measureContext) { measureContext = document.createElement('canvas').getContext('2d'); }
            measureContext.font = cssFont(fontSize, font, true);
            return measureContext.measureText(text).width;
        }

        /** Size of a stamp's box for its text and second line. */
        function stampSize(text, sub, fontSize, font) {
            var pad = fontSize * 0.45, side = fontSize * 0.75;
            var width = Math.max(boldWidth(text, fontSize, font), sub ? textWidth(sub, fontSize * STAMP_SUB, font) : 0);
            return { width: Math.ceil(width + 2 * side), height: Math.ceil(fontSize * (sub ? 1.05 + STAMP_SUB * 1.25 : 1.05) + 2 * pad) };
        }

        /** The stamp's two frames (outer and a thin inner one), as closed polylines. */
        function stampFrames(m) {
            var g = m.strokeWidth * 1.6;
            var frame = function (x, y, w, h) { return [x, y, x + w, y, x + w, y + h, x, y + h, x, y]; };
            return [frame(m.x, m.y, m.width, m.height), frame(m.x + g, m.y + g, m.width - 2 * g, m.height - 2 * g)];
        }

        /** Its text lines, centred: the word in bold, the second line smaller (size set). */
        function stampLines(m) {
            var pad = m.fontSize * 0.45, cx = m.x + m.width / 2;
            var lines = [{ text: m.text, bold: true, x: cx - boldWidth(m.text, m.fontSize, m) / 2, y: m.y + pad + m.fontSize * 0.82 }];
            if (m.sub) {
                var size = Math.round(m.fontSize * STAMP_SUB * 10) / 10;
                lines.push({ text: m.sub, size: size, x: cx - textWidth(m.sub, size, m) / 2, y: m.y + pad + m.fontSize * 1.05 + size * 0.95 });
            }
            return lines;
        }

        /** A copy of the markup moved by (dx, dy) PDF units. */
        function translate(m, dx, dy) {
            var moved = angular.extend({}, m);
            ['x', 'x1', 'x2', 'tipX'].forEach(function (k) { if (typeof m[k] === 'number') { moved[k] = round(m[k] + dx); } });
            ['y', 'y1', 'y2', 'tipY'].forEach(function (k) { if (typeof m[k] === 'number') { moved[k] = round(m[k] + dy); } });
            if (m.points) { moved.points = m.points.map(function (v, i) { return round(v + (i % 2 ? dy : dx)); }); }
            return moved;
        }

        // Boxes that hold upright text or an icon keep their size when the page turns; only their place moves.
        var UPRIGHT_BOXES = { text: true, callout: true, comment: true, revtag: true, stamp: true };

        /**
         * The markup's fields after its page (width x height at scale 1) is turned clockwise by `turns` quarter
         * turns, so the markup stays on the same content (Pages > Rotate).
         */
        function rotate(m, turns, width, height) {
            var r = angular.extend({}, m);
            for (var t = 0; t < ((turns % 4) + 4) % 4; t++) {
                // A quarter turn clockwise: (x, y) on a width x height page -> (height - y, x).
                var h = height;
                ['x1', 'x2', 'tipX'].forEach(function (k, i) {
                    var ky = ['y1', 'y2', 'tipY'][i];
                    if (typeof r[k] === 'number') {
                        var x = r[k];
                        r[k] = round(h - r[ky]);
                        r[ky] = round(x);
                    }
                });
                if (r.points) {
                    var p = r.points, turned = [];
                    for (var i = 0; i < p.length; i += 2) { turned.push(round(h - p[i + 1]), round(p[i])); }
                    r.points = turned;
                }
                if (typeof r.x === 'number' && typeof r.width === 'number') {
                    if (UPRIGHT_BOXES[r.type]) {
                        var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
                        r.x = round(h - cy - r.width / 2);
                        r.y = round(cx - r.height / 2);
                    } else {
                        var x0 = r.x;
                        r.x = round(h - (r.y + r.height));
                        r.y = round(x0);
                        var w = r.width;
                        r.width = r.height;
                        r.height = w;
                    }
                }
                height = width;
                width = h;
            }
            return r;
        }

        function hasText(m) { return TEXT_TYPES[m.type] === true; }

        /** Whether the markup shows text in a font that can be set (a comment's text is only in its pop-up). */
        function hasFont(m) { return typeof m.fontSize === 'number' && m.type !== 'comment'; }

        /** Whether the markup is drawn with a line whose thickness can be set. */
        function hasStroke(m) { return !NO_STROKE[m.type] && typeof m.strokeWidth === 'number'; }

        /** Whether resizing keeps the markup's proportions (boxes sized by their text or icon). */
        function keepsAspect(m) { return KEEP_ASPECT[m.type] === true; }

        /** The box the resize handles work on: the shape itself, without a measurement's or correction's label. */
        function frame(m) {
            if (m.points) { return boundsOf([m.points]); }
            if (typeof m.x1 === 'number') { return boundsOf([[m.x1, m.y1, m.x2, m.y2]]); }
            if (m.type === 'replace') { return { x: m.x, y: m.y, width: m.width, height: m.height }; }
            return bounds(m);
        }

        /**
         * The markup's fields after its box fits its text again (text, font or size changed): a note's box
         * grows from its top-left corner, a stamp's around its centre. Other markups: no changes.
         */
        function refit(m) {
            if (m.type === 'text' || m.type === 'callout') {
                var box = textBox(m.text, m.fontSize, m);
                return { width: box.width, height: box.height };
            }
            if (m.type === 'stamp') {
                var s = stampSize(m.text, m.sub, m.fontSize, m);
                return { x: round(m.x + (m.width - s.width) / 2), y: round(m.y + (m.height - s.height) / 2), width: s.width, height: s.height };
            }
            return {};
        }

        /**
         * A copy of the markup stretched from the box `from` (its frame) to `to`. Lines and points follow the box;
         * boxes sized by their text or icon (keepsAspect) scale evenly, their text size with them.
         */
        function resize(m, from, to) {
            var sx = from.width > 0.01 ? to.width / from.width : 1, sy = from.height > 0.01 ? to.height / from.height : 1;
            var X = function (v) { return round(to.x + (v - from.x) * sx); };
            var Y = function (v) { return round(to.y + (v - from.y) * sy); };
            var r = angular.extend({}, m);
            ['x1', 'x2', 'tipX'].forEach(function (k) { if (typeof m[k] === 'number') { r[k] = X(m[k]); } });
            ['y1', 'y2', 'tipY'].forEach(function (k) { if (typeof m[k] === 'number') { r[k] = Y(m[k]); } });
            if (m.points) { r.points = m.points.map(function (v, i) { return i % 2 ? Y(v) : X(v); }); }
            if (typeof m.x === 'number' && typeof m.width === 'number') {
                r.x = X(m.x);
                r.y = Y(m.y);
                if (keepsAspect(m)) {
                    var k = Math.sqrt(sx * sy);
                    if (typeof m.fontSize === 'number') {
                        r.fontSize = Math.min(Math.max(Math.round(m.fontSize * k * 10) / 10, FONT_SIZE.min), FONT_SIZE.max);
                        k = r.fontSize / m.fontSize;
                    }
                    if (m.type === 'text' || m.type === 'callout' || m.type === 'stamp') {
                        var box = m.type === 'stamp' ? stampSize(m.text, m.sub, r.fontSize, m) : textBox(m.text, r.fontSize, m);
                        r.width = box.width;
                        r.height = box.height;
                    } else {
                        r.width = round(Math.max(2, m.width * k));
                        r.height = round(Math.max(2, m.height * k));
                    }
                } else {
                    r.width = round(Math.max(1, m.width * sx));
                    r.height = round(Math.max(1, m.height * sy));
                }
            }
            return r;
        }

        // ----- Text boxes -----
        var measureContext = null;
        function textWidth(text, fontSize, font) {
            if (!measureContext) { measureContext = document.createElement('canvas').getContext('2d'); }
            measureContext.font = cssFont(fontSize, font);
            return measureContext.measureText(text).width;
        }

        /** Size of the box for a note: lines as typed, no wrapping. `font`: { fontFamily, bold, italic } (a markup). */
        function textBox(text, fontSize, font) {
            var lines = textLines(text);
            var widest = Math.max.apply(null, lines.map(function (l) { return textWidth(l, fontSize, font); }));
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
            var saved = savedShape(m);
            if (typeof m.opacity === 'number' && m.opacity < 1) { saved.opacity = m.opacity; }
            if (saved.lines && ((m.fontFamily && m.fontFamily !== 'helvetica') || m.bold || m.italic)) {
                saved.font = FONTS[m.fontFamily] ? m.fontFamily : 'helvetica';
                saved.bold = !!m.bold;
                saved.italic = !!m.italic;
            }
            return saved;
        }

        function savedShape(m) {
            var saved = { type: m.type, pageNumber: m.pageNumber };
            if (isMeasure(m)) {
                // Saved like a note: the value label is the box and text, the dimension lines are the strokes.
                var l = measureLabel(m);
                saved.x = round(l.x); saved.y = round(l.y); saved.width = round(l.width); saved.height = round(l.height);
                saved.color = m.color;
                saved.strokeWidth = m.strokeWidth;
                saved.strokes = strokes(m).map(function (p) { return p.map(round); });
                saved.text = l.text;
                saved.fontSize = m.fontSize;
                saved.lines = l.lines.map(function (line) { return { text: line.text, x: round(line.x), y: round(line.y) }; });
                if (m.type === 'area') { saved.fill = m.points.map(round); }
                return saved;
            }
            if (m.type === 'highlight' || m.type === 'strikeout' || m.type === 'underline' || m.type === 'comment') {
                saved.x = m.x; saved.y = m.y; saved.width = m.width; saved.height = m.height;
                if (m.type !== 'highlight') { saved.color = m.color; }
                if (m.type === 'comment') { saved.text = m.text; }
                return saved;
            }
            if (m.type === 'revtag') {
                // Saved like a note without a box: the triangle is the stroke.
                saved.x = round(m.x); saved.y = round(m.y); saved.width = round(m.width); saved.height = round(m.height);
                saved.color = m.color;
                saved.strokeWidth = m.strokeWidth;
                saved.strokes = strokes(m).map(function (p) { return p.map(round); });
                saved.text = m.text;
                saved.fontSize = m.fontSize;
                saved.lines = revtagLines(m).map(function (line) { return { text: line.text, x: round(line.x), y: round(line.y) }; });
                return saved;
            }
            if (m.type === 'stamp') {
                // Saved like a note without a box: the frames are the strokes.
                saved.x = round(m.x); saved.y = round(m.y); saved.width = round(m.width); saved.height = round(m.height);
                saved.color = m.color;
                saved.strokeWidth = m.strokeWidth;
                saved.strokes = strokes(m).map(function (p) { return p.map(round); });
                saved.text = m.text;
                saved.fontSize = m.fontSize;
                saved.lines = stampLines(m).map(function (line) {
                    return { text: line.text, x: round(line.x), y: round(line.y), size: line.size || 0, bold: !!line.bold };
                });
                return saved;
            }
            if (m.type === 'replace') {
                // Saved like a note: the correction is the box and text, the strike line is the stroke.
                var rl = replaceLabel(m);
                saved.x = round(rl.x); saved.y = round(rl.y); saved.width = round(rl.width); saved.height = round(rl.height);
                saved.color = m.color;
                saved.strokeWidth = m.strokeWidth;
                saved.strokes = strokes(m).map(function (p) { return p.map(round); });
                saved.text = m.text;
                saved.fontSize = m.fontSize;
                saved.lines = rl.lines.map(function (line) { return { text: line.text, x: round(line.x), y: round(line.y) }; });
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
            FONTS: FONTS,
            FONT_SIZE: FONT_SIZE,
            STROKE_WIDTH: STROKE_WIDTH,
            fontFamily: fontFamily,
            hasFont: hasFont,
            hasStroke: hasStroke,
            keepsAspect: keepsAspect,
            frame: frame,
            refit: refit,
            resize: resize,
            sizesFor: sizesFor,
            path: path,
            bounds: bounds,
            hits: hits,
            strokes: strokes,
            textBox: textBox,
            textLayout: textLayout,
            toSaved: toSaved,
            label: label,
            isMeasure: isMeasure,
            hasText: hasText,
            commentIcon: commentIcon,
            replaceLabel: replaceLabel,
            revtagLines: revtagLines,
            translate: translate,
            stampSize: stampSize,
            stampLines: stampLines,
            rotate: rotate,
            measureText: measureText,
            measureLabel: measureLabel
        };
    }]);
})();
