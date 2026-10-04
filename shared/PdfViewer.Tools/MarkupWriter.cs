using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>One line of a note: its text and baseline start, as laid out by the viewer.</summary>
/// <summary>A line of a note's text at its baseline; <c>Size</c> 0 means the markup's font size.</summary>
public sealed record MarkupLine(string Text, double X, double Y, double Size = 0, bool Bold = false);

/// <summary>
/// A markup as the viewer sends it: page-relative, in points at scale 1, origin top-left, in the page's
/// displayed orientation (after /Rotate). <c>X, Y, Width, Height</c> is the highlight / shape / note box;
/// <c>Strokes</c> are the lines it is drawn with as polylines [x0, y0, x1, y1, ...] (curves already flattened).
/// Measurements send their value label as the note box and text, and an area its outline as <c>Fill</c>.
/// A markup without a type is a highlight. <c>Opacity</c> (0.05-1) applies to the whole markup; <c>Font</c>
/// (helvetica, times or courier), <c>Bold</c> and <c>Italic</c> to the text of notes, labels and stamps.
/// </summary>
public sealed record Markup(int PageNumber, string? Type, double X, double Y, double Width, double Height,
                            string? Color = null, double StrokeWidth = 0, double[][]? Strokes = null,
                            string? Text = null, double FontSize = 0, MarkupLine[]? Lines = null, double[]? Fill = null,
                            double Opacity = 1, string? Font = null, bool Bold = false, bool Italic = false);

/// <summary>
/// Writes markups as standard PDF annotations that other viewers show, print and can edit:
/// highlight → Highlight, rectangle → Square, ellipse → Circle, line / arrow / freehand / cloud → Ink,
/// text note / callout → Stamp whose appearance holds the box, text and leader line, measurements → Stamp
/// with the dimension lines (and area fill) and the value label (so they look the same in every viewer),
/// strikeout → StrikeOut, underline → Underline, comment → Text (sticky note), replace text → Stamp with the
/// strike line and the correction, revision tag → Stamp with the triangle and label, polyline → Ink,
/// stamp → Stamp with its frames and words. Caller holds <see cref="Pdfium.Lock"/>.
/// </summary>
internal static partial class MarkupWriter
{
    private const int AnnotText = 1, AnnotSquare = 5, AnnotCircle = 6, AnnotHighlight = 9, AnnotUnderline = 10,
                      AnnotStrikeOut = 12, AnnotStamp = 13, AnnotInk = 15;
    private const int AnnotFlagPrint = 4;           // FPDF_ANNOT_FLAG_PRINT
    private const int FillModeNone = 0, FillModeAlternate = 1;
    private const int LineCapRound = 1, LineJoinRound = 1;
    // A count has two circles per item, up to 200 items.
    private const int MaxStrokes = 500, MaxStrokeCoordinates = 20_000, MaxTextLength = 1000, MaxLines = 200;

    private const uint AreaFillAlpha = 31;          // 12 %, as on screen

    private static readonly HashSet<string> InkTypes = ["line", "arrow", "pen", "cloud", "polyline"];
    private static readonly HashSet<string> MeasureTypes = ["distance", "hdistance", "vdistance", "area", "perimeter", "count", "perpendicular"];

    // PDFiumCore passes a single point here; the native call takes an array.
    [StructLayout(LayoutKind.Sequential)]
    private struct PointF { public float X, Y; }

    [DllImport("pdfium", EntryPoint = "FPDFAnnot_AddInkStroke")]
    private static extern int AddInkStroke(IntPtr annot, [In] PointF[] points, nuint count);

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();

    /// <summary>Adds the markups of one page.</summary>
    public static void AddAll(FpdfDocumentT document, FpdfPageT page, IEnumerable<Markup> markups)
    {
        var map = new PageMap(page);
        var notes = new List<(int Index, string Text)>();
        foreach (var markup in markups)
        {
            switch (markup.Type ?? "highlight")
            {
                case "highlight": AddTextMarkup(page, map, markup, AnnotHighlight, (255, 221, 0)); break;
                case "strikeout": AddTextMarkup(page, map, markup, AnnotStrikeOut, ParseColor(markup.Color)); break;
                case "underline": AddTextMarkup(page, map, markup, AnnotUnderline, ParseColor(markup.Color)); break;
                case "comment": notes.Add((AddComment(page, map, markup), markup.Text!)); break;
                case "replace": notes.Add((AddNote(document, page, map, markup), $"Replace with: {markup.Text}")); break;
                case "revtag": notes.Add((AddNote(document, page, map, markup), $"Revision {markup.Text}")); break;
                case "stamp": notes.Add((AddNote(document, page, map, markup), $"Stamp: {markup.Text}")); break;
                case "rect": AddShape(page, map, markup, AnnotSquare); break;
                case "ellipse": AddShape(page, map, markup, AnnotCircle); break;
                case "text":
                case "callout": notes.Add((AddNote(document, page, map, markup), markup.Text!)); break;
                case var type when MeasureTypes.Contains(type):
                    notes.Add((AddNote(document, page, map, markup), $"{Label(type)}: {markup.Text}"));
                    break;
                case var type when InkTypes.Contains(type): AddInk(page, map, markup); break;
                default: throw new ToolException("Unknown markup type.");
            }
        }

        // Rendering with annotations makes PDFium generate the appearance streams of
        // highlights, shapes and ink, so viewers that need them show the markups too.
        var bitmap = fpdfview.FPDFBitmapCreateEx(1, 1, (int)FPDFBitmapFormat.BGRA, IntPtr.Zero, 0);
        fpdfview.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 1, 1, 0, 0x01);
        fpdfview.FPDFBitmapDestroy(bitmap);

        // The note text goes in /Contents (shown in other viewers' comment lists) only after rendering:
        // for an annotation with /Contents the render builds a popup appearance that is saved unused.
        foreach (var (index, text) in notes)
        {
            var annot = fpdf_annot.FPDFPageGetAnnot(page, index)
                        ?? throw new ToolException("Could not add a note to the PDF.");
            try
            {
                SetString(annot, "Contents", text);
            }
            finally
            {
                fpdf_annot.FPDFPageCloseAnnot(annot);
            }
        }
    }

    // ----- Highlight -----
    // ----- Highlight / strikeout / underline: text markup over the box, appearance generated by PDFium -----
    private static void AddTextMarkup(FpdfPageT page, PageMap map, Markup m, int subtype, (uint R, uint G, uint B) color)
    {
        CheckBox(m, "A highlight has an invalid size.");
        if (m.Width <= 0 || m.Height <= 0)
            throw new ToolException("A highlight has an invalid size.");

        // Clamp to the page, as the viewer does.
        var left = Math.Clamp(m.X, 0, map.Width);
        var top = Math.Clamp(m.Y, 0, map.Height);
        var right = Math.Clamp(m.X + m.Width, 0, map.Width);
        var bottom = Math.Clamp(m.Y + m.Height, 0, map.Height);
        if (right - left < 0.5 || bottom - top < 0.5)
            return;

        // Quad points: upper-left, upper-right, lower-left, lower-right as seen on screen;
        // the page map handles rotated pages.
        var ul = map.ToPage(left, top);
        var ur = map.ToPage(right, top);
        var ll = map.ToPage(left, bottom);
        var lr = map.ToPage(right, bottom);

        var annot = Create(page, subtype);
        try
        {
            fpdf_annot.FPDFAnnotSetColor(annot, FPDFANNOT_COLORTYPE.FPDFANNOT_COLORTYPE_Color, color.R, color.G, color.B, Alpha(m));
            fpdf_annot.FPDFAnnotAppendAttachmentPoints(annot, new FS_QUADPOINTSF
            {
                X1 = (float)ul.X, Y1 = (float)ul.Y, X2 = (float)ur.X, Y2 = (float)ur.Y,
                X3 = (float)ll.X, Y3 = (float)ll.Y, X4 = (float)lr.X, Y4 = (float)lr.Y
            });
            SetRect(annot, [ul, ur, ll, lr], 0);
            Finish(annot);
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    // ----- Comment: Text annotation (sticky note); viewers show their note icon, the text in a pop-up -----
    /// <summary>Adds the comment and returns its annotation index on the page (the text is set later).</summary>
    private static int AddComment(FpdfPageT page, PageMap map, Markup m)
    {
        CheckBox(m, "A comment has an invalid size.");
        if (string.IsNullOrWhiteSpace(m.Text) || m.Text.Length > MaxTextLength)
            throw new ToolException($"A comment must have between 1 and {MaxTextLength} characters.");
        var (r, g, b) = ParseColor(m.Color);
        var annot = Create(page, AnnotText);
        try
        {
            fpdf_annot.FPDFAnnotSetColor(annot, FPDFANNOT_COLORTYPE.FPDFANNOT_COLORTYPE_Color, r, g, b, Alpha(m));
            SetRect(annot, Corners(map, m.X, m.Y, m.Width, m.Height), 0);
            Finish(annot);
            return fpdf_annot.FPDFPageGetAnnotIndex(page, annot);
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    // ----- Rectangle / ellipse: Square / Circle, appearance generated by PDFium -----
    private static void AddShape(FpdfPageT page, PageMap map, Markup m, int subtype)
    {
        CheckBox(m, "A shape has an invalid size.");
        var (r, g, b) = ParseColor(m.Color);
        var width = CheckStrokeWidth(m.StrokeWidth);
        var annot = Create(page, subtype);
        try
        {
            fpdf_annot.FPDFAnnotSetColor(annot, FPDFANNOT_COLORTYPE.FPDFANNOT_COLORTYPE_Color, r, g, b, Alpha(m));
            fpdf_annot.FPDFAnnotSetBorder(annot, 0, 0, (float)width);
            // The appearance is drawn inside /Rect, so widen it by half the line width: the line then
            // runs along the edge the user drew.
            SetRect(annot, Corners(map, m.X, m.Y, m.Width, m.Height), width / 2);
            Finish(annot);
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    // ----- Line / arrow / freehand / cloud: Ink, appearance generated by PDFium -----
    private static void AddInk(FpdfPageT page, PageMap map, Markup m)
    {
        var strokes = CheckStrokes(m.Strokes, required: true);
        var (r, g, b) = ParseColor(m.Color);
        var width = CheckStrokeWidth(m.StrokeWidth);
        var annot = Create(page, AnnotInk);
        try
        {
            fpdf_annot.FPDFAnnotSetColor(annot, FPDFANNOT_COLORTYPE.FPDFANNOT_COLORTYPE_Color, r, g, b, Alpha(m));
            fpdf_annot.FPDFAnnotSetBorder(annot, 0, 0, (float)width);
            var all = new List<(double X, double Y)>();
            foreach (var stroke in strokes)
            {
                var points = new PointF[stroke.Length / 2];
                for (var i = 0; i < points.Length; i++)
                {
                    var p = map.ToPage(stroke[2 * i], stroke[2 * i + 1]);
                    points[i] = new PointF { X = (float)p.X, Y = (float)p.Y };
                    all.Add(p);
                }
                if (AddInkStroke(annot.__Instance, points, (nuint)points.Length) < 0)
                    throw new ToolException("Could not add a markup to the PDF.");
            }
            SetRect(annot, all, width);
            Finish(annot);
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    private static string Label(string type) => type switch
    {
        "distance" => "Distance",
        "hdistance" => "Horizontal distance",
        "vdistance" => "Vertical distance",
        "area" => "Area",
        "count" => "Count",
        "perpendicular" => "Perpendicular distance",
        _ => "Perimeter"
    };

    // ----- Text note / callout / measurement: Stamp with a white box, the text and the lines -----
    /// <summary>
    /// Adds the note and returns its annotation index on the page. Notes have a framed box; a measurement's
    /// value label is a plain white box over its dimension lines, and an area is filled lightly.
    /// </summary>
    private static int AddNote(FpdfDocumentT document, FpdfPageT page, PageMap map, Markup m)
    {
        CheckBox(m, "A note has an invalid size.");
        if (string.IsNullOrWhiteSpace(m.Text) || m.Text.Length > MaxTextLength)
            throw new ToolException($"A note must have between 1 and {MaxTextLength} characters.");
        if (!double.IsFinite(m.FontSize) || m.FontSize < 2 || m.FontSize > 300)
            throw new ToolException("A note has an invalid text size.");
        var lines = m.Lines ?? [];
        if (lines.Length == 0 || lines.Length > MaxLines ||
            lines.Any(l => l.Text is null || !double.IsFinite(l.X) || !double.IsFinite(l.Y) ||
                           !double.IsFinite(l.Size) || l.Size < 0 || l.Size > 300))
            throw new ToolException("A note has invalid text lines.");
        var strokes = CheckStrokes(m.Strokes, required: false);
        var (r, g, b) = ParseColor(m.Color);
        var width = CheckStrokeWidth(m.StrokeWidth);
        var alpha = Alpha(m);
        var opacity = alpha / 255.0;
        FontName(m.Font, false, false);   // checks the font before anything is added
        // Notes have a framed box; measurement values and corrections sit on a plain white box.
        var isMeasure = MeasureTypes.Contains(m.Type!);
        var framed = m.Type is "text" or "callout";
        var fill = m.Fill is null ? null : CheckStrokes([m.Fill], required: true)[0];
        if (fill is not null && (!isMeasure || fill.Length < 6))
            throw new ToolException("A markup has an invalid area.");

        var box = Corners(map, m.X, m.Y, m.Width, m.Height);
        var annot = Create(page, AnnotStamp);
        try
        {
            // /Rect first: the appearance created for the first object uses it as its bounding box.
            SetRect(annot, box.Concat(strokes.SelectMany(s => Points(map, s))), width);

            if (fill is not null)
            {
                var area = NewPath(Points(map, fill).ToList());
                fpdf_edit.FPDFPathClose(area);
                fpdf_edit.FPDFPageObjSetFillColor(area, r, g, b, (uint)Math.Round(AreaFillAlpha * opacity));
                fpdf_edit.FPDFPathSetDrawMode(area, FillModeAlternate, 0);
                Append(annot, area);
            }

            foreach (var stroke in strokes)
            {
                var path = NewPath(Points(map, stroke).ToList());
                Stroke(path, r, g, b, alpha, width, FillModeNone);
                Append(annot, path);
            }

            // A revision tag and a stamp are just their lines and words: no box.
            if (m.Type is not ("revtag" or "stamp"))
            {
                var frame = NewPath(box);
                fpdf_edit.FPDFPathClose(frame);
                fpdf_edit.FPDFPageObjSetFillColor(frame, 255, 255, 255, (uint)Math.Round((framed ? 255 : 230) * opacity));
                if (framed)
                    Stroke(frame, r, g, b, alpha, width, FillModeAlternate);
                else
                    fpdf_edit.FPDFPathSetDrawMode(frame, FillModeAlternate, 0);
                Append(annot, frame);
            }

            foreach (var line in lines.Where(l => l.Text.Length > 0))
            {
                var text = fpdf_edit.FPDFPageObjNewTextObj(document, FontName(m.Font, line.Bold || m.Bold, m.Italic),
                               (float)(line.Size > 0 ? line.Size : m.FontSize))
                           ?? throw new ToolException("Could not add a note to the PDF.");
                var utf16 = line.Text.Select(c => (ushort)c).Append((ushort)0).ToArray();
                fpdf_edit.FPDFTextSetText(text, ref utf16[0]);
                fpdf_edit.FPDFPageObjSetFillColor(text, r, g, b, alpha);
                // Text runs along the page's displayed x axis and stands upright on screen, also on rotated pages.
                var (origin, right, down) = map.Axes(line.X, line.Y);
                fpdf_edit.FPDFPageObjTransform(text, right.X, right.Y, -down.X, -down.Y, origin.X, origin.Y);
                Append(annot, text);
            }
            Finish(annot);
            return fpdf_annot.FPDFPageGetAnnotIndex(page, annot);
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    // ----- Helpers -----
    private static FpdfAnnotationT Create(FpdfPageT page, int subtype) =>
        fpdf_annot.FPDFPageCreateAnnot(page, subtype) ?? throw new ToolException("Could not add a markup to the PDF.");

    private static void Finish(FpdfAnnotationT annot)
    {
        fpdf_annot.FPDFAnnotSetFlags(annot, AnnotFlagPrint);
        SetString(annot, "M", $"D:{DateTime.UtcNow:yyyyMMddHHmmss}Z");
    }

    private static void Append(FpdfAnnotationT annot, FpdfPageobjectT obj)
    {
        if (fpdf_annot.FPDFAnnotAppendObject(annot, obj) == 0)
        {
            fpdf_edit.FPDFPageObjDestroy(obj);
            throw new ToolException("Could not add a note to the PDF.");
        }
    }

    private static FpdfPageobjectT NewPath(List<(double X, double Y)> points)
    {
        var path = fpdf_edit.FPDFPageObjCreateNewPath((float)points[0].X, (float)points[0].Y);
        foreach (var p in points.Skip(1))
            fpdf_edit.FPDFPathLineTo(path, (float)p.X, (float)p.Y);
        return path;
    }

    private static void Stroke(FpdfPageobjectT path, uint r, uint g, uint b, uint alpha, double width, int fillMode)
    {
        fpdf_edit.FPDFPageObjSetStrokeColor(path, r, g, b, alpha);
        fpdf_edit.FPDFPageObjSetStrokeWidth(path, (float)width);
        fpdf_edit.FPDFPageObjSetLineCap(path, LineCapRound);
        fpdf_edit.FPDFPageObjSetLineJoin(path, LineJoinRound);
        fpdf_edit.FPDFPathSetDrawMode(path, fillMode, 1);
    }

    private static void SetRect(FpdfAnnotationT annot, IEnumerable<(double X, double Y)> points, double margin)
    {
        var list = points.ToList();
        fpdf_annot.FPDFAnnotSetRect(annot, new FS_RECTF_
        {
            Left = (float)(list.Min(p => p.X) - margin), Right = (float)(list.Max(p => p.X) + margin),
            Bottom = (float)(list.Min(p => p.Y) - margin), Top = (float)(list.Max(p => p.Y) + margin)
        });
    }

    private static List<(double X, double Y)> Corners(PageMap map, double x, double y, double width, double height) =>
        [map.ToPage(x, y), map.ToPage(x + width, y), map.ToPage(x + width, y + height), map.ToPage(x, y + height)];

    private static IEnumerable<(double X, double Y)> Points(PageMap map, double[] stroke)
    {
        for (var i = 0; i + 1 < stroke.Length; i += 2)
            yield return map.ToPage(stroke[i], stroke[i + 1]);
    }

    private static void CheckBox(Markup m, string message)
    {
        if (!double.IsFinite(m.X) || !double.IsFinite(m.Y) || !double.IsFinite(m.Width) || !double.IsFinite(m.Height) ||
            m.Width < 0 || m.Height < 0 || m.Width > 100_000 || m.Height > 100_000)
            throw new ToolException(message);
    }

    private static double CheckStrokeWidth(double width) =>
        double.IsFinite(width) && width >= 0.1 && width <= 100 ? width : throw new ToolException("A markup has an invalid line width.");

    private static double[][] CheckStrokes(double[][]? strokes, bool required)
    {
        strokes ??= [];
        if ((required && strokes.Length == 0) || strokes.Length > MaxStrokes ||
            strokes.Any(s => s is null || s.Length < 4 || s.Length % 2 != 0 || s.Length > MaxStrokeCoordinates || s.Any(v => !double.IsFinite(v))))
            throw new ToolException("A markup has invalid lines.");
        return strokes;
    }

    /// <summary>The markup's opacity as a colour alpha (0-255).</summary>
    private static uint Alpha(Markup m) =>
        double.IsFinite(m.Opacity) && m.Opacity >= 0.05 && m.Opacity <= 1
            ? (uint)Math.Round(m.Opacity * 255)
            : throw new ToolException("A markup has an invalid opacity.");

    /// <summary>The PDF standard font for a note's text.</summary>
    private static string FontName(string? font, bool bold, bool italic) => (font ?? "helvetica") switch
    {
        "helvetica" => "Helvetica" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""),
        "times" => bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman",
        "courier" => "Courier" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""),
        _ => throw new ToolException("A note has an invalid font.")
    };

    private static (uint R, uint G, uint B) ParseColor(string? color)
    {
        if (color is null || !ColorPattern().IsMatch(color))
            throw new ToolException("A markup has an invalid colour.");
        var value = Convert.ToUInt32(color[1..], 16);
        return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
    }

    // PDFium takes UTF-16, null-terminated.
    private static void SetString(FpdfAnnotationT annot, string key, string value)
    {
        var utf16 = value.Select(c => (ushort)c).Append((ushort)0).ToArray();
        fpdf_annot.FPDFAnnotSetStringValue(annot, key, ref utf16[0]);
    }

    /// <summary>Maps the viewer's coordinates (displayed page, top-left origin) to PDF page space.</summary>
    private sealed class PageMap
    {
        // Device coordinates are integers; work at 1/100 point for precision.
        private const double Precision = 100;
        private readonly FpdfPageT _page;
        private readonly int _sizeX, _sizeY;

        public PageMap(FpdfPageT page)
        {
            _page = page;
            Width = fpdfview.FPDF_GetPageWidthF(page);
            Height = fpdfview.FPDF_GetPageHeightF(page);
            _sizeX = (int)Math.Round(Width * Precision);
            _sizeY = (int)Math.Round(Height * Precision);
        }

        public double Width { get; }
        public double Height { get; }

        public (double X, double Y) ToPage(double x, double y)
        {
            double px = 0, py = 0;
            fpdfview.FPDF_DeviceToPage(_page, 0, 0, _sizeX, _sizeY, 0,
                (int)Math.Round(x * Precision), (int)Math.Round(y * Precision), ref px, ref py);
            return (px, py);
        }

        /// <summary>A point and the page-space directions of one unit right and one unit down on screen.</summary>
        public ((double X, double Y) Origin, (double X, double Y) Right, (double X, double Y) Down) Axes(double x, double y)
        {
            const double step = 100;
            var o = ToPage(x, y);
            var rx = ToPage(x + step, y);
            var dy = ToPage(x, y + step);
            return (o, ((rx.X - o.X) / step, (rx.Y - o.Y) / step), ((dy.X - o.X) / step, (dy.Y - o.Y) / step));
        }
    }
}
