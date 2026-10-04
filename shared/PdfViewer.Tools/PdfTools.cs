using System.Runtime.InteropServices;
using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>How an annotated copy is written: flattened, and only some pages (1-based, in order; null = all).</summary>
public sealed record AnnotatedOptions(bool Flatten = false, IReadOnlyList<int>? Pages = null);

/// <summary>Merge, split, page export and markup saving with PDFium. Inputs are read from disk.</summary>
public static class PdfTools
{
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
    /// Writes a copy of the PDF with the markups added as standard annotations (see <see cref="MarkupWriter"/>),
    /// which other PDF viewers show, print and can edit. The source file is not changed.
    /// Returns the number of markups written.
    /// </summary>
    public static int SaveWithHighlights(string path, IReadOnlyList<Markup> markups, Stream output) =>
        SaveAnnotated(path, markups, new AnnotatedOptions(), output);

    /// <summary>
    /// Writes a copy of the PDF with the markups as annotations. <see cref="AnnotatedOptions.Flatten"/> makes every
    /// annotation and form field (the markups and the PDF's own) part of the page content, so it can no longer be
    /// edited or hidden; <see cref="AnnotatedOptions.Pages"/> keeps only those pages, in that order.
    /// Returns the number of markups written.
    /// </summary>
    public static int SaveAnnotated(string path, IReadOnlyList<Markup> markups, AnnotatedOptions options, Stream output)
    {
        if (markups.Count == 0 && !options.Flatten && options.Pages is null)
            throw new ToolException("There are no markups to save.");
        if (markups.Count > MaxHighlights)
            throw new ToolException($"Too many markups (maximum {MaxHighlights}).");

        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path);
            try
            {
                var pageCount = fpdfview.FPDF_GetPageCount(document);
                var pages = options.Pages;
                if (pages is not null && (pages.Count == 0 || pages.Any(p => p < 1 || p > pageCount)))
                    throw new ToolException($"Choose pages from 1 to {pageCount}.");
                var wanted = pages is null ? null : new HashSet<int>(pages);

                var byPage = markups.GroupBy(m => m.PageNumber).ToDictionary(g => g.Key, g => g.ToList());
                if (byPage.Keys.Any(p => p < 1 || p > pageCount))
                    throw new ToolException("A markup refers to a page that does not exist.");

                // Pages that are written and have markups to add or (flattening) annotations to merge.
                var toVisit = options.Flatten
                    ? Enumerable.Range(1, pageCount).Where(p => wanted is null || wanted.Contains(p))
                    : byPage.Keys.Where(p => wanted is null || wanted.Contains(p)).OrderBy(p => p);
                var written = 0;
                foreach (var pageNumber in toVisit)
                {
                    var page = fpdfview.FPDF_LoadPage(document, pageNumber - 1);
                    try
                    {
                        if (byPage.TryGetValue(pageNumber, out var pageMarkups))
                        {
                            MarkupWriter.AddAll(document, page, pageMarkups);
                            written += pageMarkups.Count;
                        }
                        if (options.Flatten)
                            fpdf_flatten.FPDFPageFlatten(page, FlattenForPrint);
                    }
                    finally
                    {
                        fpdfview.FPDF_ClosePage(page);
                    }
                }

                if (pages is null)
                {
                    Pdfium.Save(document, output);
                    return written;
                }

                // Only some pages: write the whole annotated copy aside, then take those pages from it.
                var temp = Path.Combine(Path.GetTempPath(), $"pdf-viewer-annotated-{Guid.NewGuid():N}.pdf");
                try
                {
                    using (var stream = File.Create(temp))
                        Pdfium.Save(document, stream);
                    PageEditor.Rearrange(temp, pages.Select(p => new PageSpec(0, p)).ToList(), [], output);
                    return written;
                }
                finally
                {
                    File.Delete(temp);
                }
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    private const int FlattenForPrint = 1;   // FLAT_PRINT: annotations as they print

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
