using System.Runtime.InteropServices;
using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>
/// A highlight as the viewer stores it: page-relative, in points at scale 1, origin top-left,
/// in the page's displayed orientation (after /Rotate).
/// </summary>
public readonly record struct HighlightRect(int PageNumber, double X, double Y, double Width, double Height);

/// <summary>Merge, split, page export and highlight saving with PDFium. Inputs are read from disk.</summary>
public static class PdfTools
{
    private const int AnnotHighlight = 9;           // FPDF_ANNOT_HIGHLIGHT
    private const int AnnotFlagPrint = 4;           // FPDF_ANNOT_FLAG_PRINT
    public const int MaxHighlights = 10_000;
    private const long MaxImagePixels = 40_000_000;   // ~300 dpi for A3

    public static int GetPageCount(string path)
    {
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path);
            try { return fpdfview.FPDF_GetPageCount(document); }
            finally { fpdfview.FPDF_CloseDocument(document); }
        }
    }

    /// <summary>Combines the inputs, in order, into one PDF. Returns the total page count.</summary>
    public static int Merge(IReadOnlyList<(string Path, string Name)> inputs, Stream output)
    {
        if (inputs.Count < 2)
            throw new ToolException("Choose at least two PDF files to merge.");

        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var merged = fpdf_edit.FPDF_CreateNewDocument();
            try
            {
                var total = 0;
                foreach (var (path, name) in inputs)
                {
                    FpdfDocumentT source;
                    try { source = Pdfium.OpenDocument(path); }
                    catch (ToolException ex) { throw new ToolException($"{name}: {ex.Message}"); }

                    try
                    {
                        if (fpdf_ppo.FPDF_ImportPages(merged, source, null, total) == 0)
                            throw new ToolException($"{name}: its pages could not be copied.");
                        total += fpdfview.FPDF_GetPageCount(source);
                    }
                    finally
                    {
                        fpdfview.FPDF_CloseDocument(source);
                    }
                }

                Pdfium.Save(merged, output);
                return total;
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(merged);
            }
        }
    }

    /// <summary>Writes one PDF per range. <paramref name="openOutput"/> receives the file name to create.</summary>
    public static void Split(string path, IReadOnlyList<PageRange> ranges, string baseName, Func<string, Stream> openOutput)
    {
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var source = Pdfium.OpenDocument(path);
            try
            {
                foreach (var range in ranges)
                {
                    var part = fpdf_edit.FPDF_CreateNewDocument();
                    try
                    {
                        if (fpdf_ppo.FPDF_ImportPages(part, source, range.ToPdfiumRange(), 0) == 0)
                            throw new ToolException($"Pages {range.ToPdfiumRange()} could not be copied.");
                        using var output = openOutput($"{baseName}-{range.ToFileSuffix()}.pdf");
                        Pdfium.Save(part, output);
                    }
                    finally
                    {
                        fpdfview.FPDF_CloseDocument(part);
                    }
                }
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(source);
            }
        }
    }

    /// <summary>Renders every page to a PNG at the given resolution.</summary>
    public static void ExportPng(string path, int dpi, string baseName, Func<string, Stream> openOutput, CancellationToken ct = default)
    {
        if (dpi is < 36 or > 600)
            throw new ToolException("Resolution must be between 36 and 600 dpi.");

        Pdfium.EnsureInitialized();
        FpdfDocumentT document;
        int pageCount;
        lock (Pdfium.Lock)
        {
            document = Pdfium.OpenDocument(path);
            pageCount = fpdfview.FPDF_GetPageCount(document);
        }

        try
        {
            var digits = pageCount.ToString().Length;
            for (var index = 0; index < pageCount; index++)
            {
                ct.ThrowIfCancellationRequested();
                using var output = openOutput($"{baseName}-page-{(index + 1).ToString().PadLeft(digits, '0')}.png");
                output.Write(RenderPagePng(document, index, dpi));
            }
        }
        finally
        {
            lock (Pdfium.Lock) fpdfview.FPDF_CloseDocument(document);
        }
    }

    // Locks per page so the viewer stays responsive during long exports.
    private static byte[] RenderPagePng(FpdfDocumentT document, int index, int dpi)
    {
        byte[] pixels;
        int width, height, stride;
        lock (Pdfium.Lock)
        {
            var page = fpdfview.FPDF_LoadPage(document, index);
            try
            {
                double pageWidth = fpdfview.FPDF_GetPageWidthF(page), pageHeight = fpdfview.FPDF_GetPageHeightF(page);
                var scale = Math.Min(dpi / 72.0, Math.Sqrt(MaxImagePixels / (pageWidth * pageHeight)));
                width = Math.Max(1, (int)Math.Round(pageWidth * scale));
                height = Math.Max(1, (int)Math.Round(pageHeight * scale));

                var bitmap = fpdfview.FPDFBitmapCreateEx(width, height, (int)FPDFBitmapFormat.BGRA, IntPtr.Zero, 0)
                             ?? throw new ToolException("Not enough memory to render the page.");
                try
                {
                    fpdfview.FPDFBitmapFillRect(bitmap, 0, 0, width, height, 0xFFFFFFFF);
                    fpdfview.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x01 | 0x10);   // annotations, RGBA
                    stride = fpdfview.FPDFBitmapGetStride(bitmap);
                    pixels = new byte[stride * height];
                    Marshal.Copy(fpdfview.FPDFBitmapGetBuffer(bitmap), pixels, 0, pixels.Length);
                }
                finally
                {
                    fpdfview.FPDFBitmapDestroy(bitmap);
                }
            }
            finally
            {
                fpdfview.FPDF_ClosePage(page);
            }
        }
        return PngEncoder.Encode(pixels, width, height, stride);
    }

    /// <summary>
    /// Writes a copy of the PDF with the highlights added as standard Highlight annotations
    /// (yellow, printable), which other PDF viewers show and can edit. The source file is not changed.
    /// Returns the number of highlights written.
    /// </summary>
    public static int SaveWithHighlights(string path, IReadOnlyList<HighlightRect> highlights, Stream output)
    {
        if (highlights.Count == 0)
            throw new ToolException("There are no highlights to save.");
        if (highlights.Count > MaxHighlights)
            throw new ToolException($"Too many highlights (maximum {MaxHighlights}).");

        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path);
            try
            {
                var pageCount = fpdfview.FPDF_GetPageCount(document);
                foreach (var pageHighlights in highlights.GroupBy(h => h.PageNumber))
                {
                    if (pageHighlights.Key < 1 || pageHighlights.Key > pageCount)
                        throw new ToolException("A highlight refers to a page that does not exist.");

                    var page = fpdfview.FPDF_LoadPage(document, pageHighlights.Key - 1);
                    try
                    {
                        foreach (var highlight in pageHighlights)
                            AddHighlight(page, highlight);

                        // Rendering with annotations makes PDFium generate their appearance streams
                        // (yellow, multiply blend), so viewers that need them show the highlights too.
                        var bitmap = fpdfview.FPDFBitmapCreateEx(1, 1, (int)FPDFBitmapFormat.BGRA, IntPtr.Zero, 0);
                        fpdfview.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 1, 1, 0, 0x01);
                        fpdfview.FPDFBitmapDestroy(bitmap);
                    }
                    finally
                    {
                        fpdfview.FPDF_ClosePage(page);
                    }
                }

                Pdfium.Save(document, output);
                return highlights.Count;
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    private static void AddHighlight(FpdfPageT page, HighlightRect highlight)
    {
        double pageWidth = fpdfview.FPDF_GetPageWidthF(page), pageHeight = fpdfview.FPDF_GetPageHeightF(page);
        if (!double.IsFinite(highlight.X) || !double.IsFinite(highlight.Y) ||
            !double.IsFinite(highlight.Width) || !double.IsFinite(highlight.Height) ||
            highlight.Width <= 0 || highlight.Height <= 0)
            throw new ToolException("A highlight has an invalid size.");

        // Clamp to the page, as the viewer does.
        var left = Math.Clamp(highlight.X, 0, pageWidth);
        var top = Math.Clamp(highlight.Y, 0, pageHeight);
        var right = Math.Clamp(highlight.X + highlight.Width, 0, pageWidth);
        var bottom = Math.Clamp(highlight.Y + highlight.Height, 0, pageHeight);
        if (right - left < 0.5 || bottom - top < 0.5)
            return;

        // Device coordinates are integers; work at 1/100 point for precision.
        const double precision = 100;
        int sizeX = (int)Math.Round(pageWidth * precision), sizeY = (int)Math.Round(pageHeight * precision);
        (double X, double Y) ToPage(double x, double y)
        {
            double px = 0, py = 0;
            fpdfview.FPDF_DeviceToPage(page, 0, 0, sizeX, sizeY, 0,
                (int)Math.Round(x * precision), (int)Math.Round(y * precision), ref px, ref py);
            return (px, py);
        }

        // Quad points: upper-left, upper-right, lower-left, lower-right as seen on screen;
        // DeviceToPage maps them correctly for rotated pages.
        var ul = ToPage(left, top);
        var ur = ToPage(right, top);
        var ll = ToPage(left, bottom);
        var lr = ToPage(right, bottom);

        var annot = fpdf_annot.FPDFPageCreateAnnot(page, AnnotHighlight)
                    ?? throw new ToolException("Could not add a highlight to the PDF.");
        try
        {
            fpdf_annot.FPDFAnnotSetColor(annot, FPDFANNOT_COLORTYPE.FPDFANNOT_COLORTYPE_Color, 255, 221, 0, 255);
            fpdf_annot.FPDFAnnotAppendAttachmentPoints(annot, new FS_QUADPOINTSF
            {
                X1 = (float)ul.X, Y1 = (float)ul.Y, X2 = (float)ur.X, Y2 = (float)ur.Y,
                X3 = (float)ll.X, Y3 = (float)ll.Y, X4 = (float)lr.X, Y4 = (float)lr.Y
            });
            double[] xs = [ul.X, ur.X, ll.X, lr.X], ys = [ul.Y, ur.Y, ll.Y, lr.Y];
            fpdf_annot.FPDFAnnotSetRect(annot, new FS_RECTF_
            {
                Left = (float)xs.Min(), Right = (float)xs.Max(), Bottom = (float)ys.Min(), Top = (float)ys.Max()
            });
            fpdf_annot.FPDFAnnotSetFlags(annot, AnnotFlagPrint);
            SetString(annot, "M", $"D:{DateTime.UtcNow:yyyyMMddHHmmss}Z");
        }
        finally
        {
            fpdf_annot.FPDFPageCloseAnnot(annot);
        }
    }

    // PDFium takes UTF-16, null-terminated.
    private static void SetString(FpdfAnnotationT annot, string key, string value)
    {
        var utf16 = value.Select(c => (ushort)c).Append((ushort)0).ToArray();
        fpdf_annot.FPDFAnnotSetStringValue(annot, key, ref utf16[0]);
    }

    /// <summary>Extracts the text of each page as lines.</summary>
    public static List<string[]> ExtractText(string path, CancellationToken ct = default)
    {
        Pdfium.EnsureInitialized();
        var pages = new List<string[]>();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path);
            try
            {
                var pageCount = fpdfview.FPDF_GetPageCount(document);
                for (var index = 0; index < pageCount; index++)
                {
                    ct.ThrowIfCancellationRequested();
                    var page = fpdfview.FPDF_LoadPage(document, index);
                    var textPage = fpdf_text.FPDFTextLoadPage(page);
                    try
                    {
                        var count = fpdf_text.FPDFTextCountChars(textPage);
                        var text = string.Empty;
                        if (count > 0)
                        {
                            var buffer = new ushort[count + 1];   // UTF-16 plus terminator
                            var written = fpdf_text.FPDFTextGetText(textPage, 0, count, ref buffer[0]);
                            var chars = new char[Math.Max(0, written - 1)];
                            for (var i = 0; i < chars.Length; i++) chars[i] = (char)buffer[i];
                            text = new string(chars);
                        }
                        pages.Add(text.Split(["\r\n", "\n", "\r"], StringSplitOptions.None)
                            .Select(line => line.TrimEnd())
                            .ToArray());
                    }
                    finally
                    {
                        fpdf_text.FPDFTextClosePage(textPage);
                        fpdfview.FPDF_ClosePage(page);
                    }
                }
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
        return pages;
    }
}
