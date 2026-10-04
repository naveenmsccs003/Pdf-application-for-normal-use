using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>
/// One page of an edited document. <see cref="Source"/> 0 is the document being edited, 1..n the n-th
/// other file (insert / replace), -1 a blank page of <see cref="Width"/> x <see cref="Height"/> points.
/// <see cref="Page"/> is 1-based; page 0 of another file means all its pages. <see cref="Rotate"/> turns the page clockwise by 0, 90, 180 or 270 degrees.
/// </summary>
public record PageSpec(int Source, int Page, int Rotate = 0, double Width = 0, double Height = 0);

/// <summary>
/// Page operations: new blank documents, and rebuilding a document's pages in a new order (delete, insert,
/// reorder, duplicate, rotate, replace and extract are all a list of <see cref="PageSpec"/>).
/// The document is edited in place, so its bookmarks, links, form and metadata are kept for the pages that stay.
/// </summary>
public static class PageEditor
{
    public const int MaxPages = 100_000;
    public const double MinPageSize = 72;       // 1 inch
    public const double MaxPageSize = 14_400;   // PDF's 200-inch limit

    /// <summary>Writes a new PDF with <paramref name="count"/> blank pages.</summary>
    public static void CreateBlank(int count, double width, double height, Stream output)
    {
        if (count is < 1 or > 1000)
            throw new ToolException("Choose between 1 and 1000 pages.");
        CheckSize(width, height);

        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = fpdf_edit.FPDF_CreateNewDocument();
            try
            {
                for (var i = 0; i < count; i++)
                    fpdfview.FPDF_ClosePage(fpdf_edit.FPDFPageNew(document, i, width, height));
                Pdfium.Save(document, output);
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    /// <summary>
    /// Writes the document at <paramref name="path"/> with the pages in <paramref name="layout"/>, in that order.
    /// <paramref name="others"/> are the files that <see cref="PageSpec.Source"/> 1..n refer to.
    /// Returns the number of pages written.
    /// </summary>
    public static int Rearrange(string path, IReadOnlyList<PageSpec> layout, IReadOnlyList<(string Path, string Name)> others, Stream output)
    {
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var opened = new List<FpdfDocumentT>();
            try
            {
                var document = Pdfium.OpenDocument(path);
                opened.Add(document);
                var pageCount = fpdfview.FPDF_GetPageCount(document);

                var sources = new Dictionary<int, FpdfDocumentT>();
                FpdfDocumentT Source(int source)
                {
                    if (sources.TryGetValue(source, out var doc)) return doc;
                    var (otherPath, name) = source == 0 ? (path, "This PDF") : others[source - 1];
                    try { doc = Pdfium.OpenDocument(otherPath); }
                    catch (ToolException ex) { throw new ToolException($"{name}: {ex.Message}"); }
                    opened.Add(doc);
                    return sources[source] = doc;
                }

                layout = Expand(layout, others.Count, source => fpdfview.FPDF_GetPageCount(Source(source)));
                if (layout.Count == 0)
                    throw new ToolException("A PDF needs at least one page.");
                if (layout.Count > MaxPages)
                    throw new ToolException($"A PDF can have up to {MaxPages:N0} pages here.");
                Validate(layout, others.Count, pageCount, source => fpdfview.FPDF_GetPageCount(Source(source)));

                // The first use of each page of the document keeps that page; everything else is added at the
                // end: copies (duplicates, other files) and blank pages. `positions` is where each layout entry is.
                var positions = new int[layout.Count];
                var kept = new bool[pageCount];
                var next = pageCount;
                var i = 0;
                while (i < layout.Count)
                {
                    var spec = layout[i];
                    if (spec.Source == 0 && !kept[spec.Page - 1])
                    {
                        kept[spec.Page - 1] = true;
                        positions[i++] = spec.Page - 1;
                    }
                    else if (spec.Source < 0)
                    {
                        CheckSize(spec.Width, spec.Height);
                        fpdfview.FPDF_ClosePage(fpdf_edit.FPDFPageNew(document, next, spec.Width, spec.Height));
                        positions[i++] = next++;
                    }
                    else
                    {
                        // A run of copies from one file: imported together, which is much faster for long runs.
                        var indices = new List<int>();
                        var start = i;
                        while (i < layout.Count && layout[i].Source == spec.Source
                               && (spec.Source != 0 || kept[layout[i].Page - 1]))
                            indices.Add(layout[i++].Page - 1);
                        var array = indices.ToArray();
                        // Copies of the document's own pages come from a second copy of it.
                        var from = Source(spec.Source);
                        if (fpdf_ppo.FPDF_ImportPagesByIndex(document, from, ref array[0], (ulong)array.Length, next) == 0)
                            throw new ToolException("Pages could not be copied.");
                        for (var k = 0; k < array.Length; k++)
                            positions[start + k] = next++;
                    }
                }

                // Remove the document's pages that are not used, last first so the indices stay valid.
                var removedBefore = new int[next + 1];
                for (var p = 0; p < next; p++)
                    removedBefore[p + 1] = removedBefore[p] + (p < pageCount && !kept[p] ? 1 : 0);
                for (var p = pageCount - 1; p >= 0; p--)
                    if (!kept[p])
                        fpdf_edit.FPDFPageDelete(document, p);
                for (var k = 0; k < positions.Length; k++)
                    positions[k] -= removedBefore[positions[k]];

                if (positions.Where((position, k) => position != k).Any()
                    && fpdf_edit.FPDF_MovePages(document, ref positions[0], (ulong)positions.Length, 0) == 0)
                    throw new ToolException("The pages could not be reordered.");

                for (var k = 0; k < layout.Count; k++)
                {
                    var turns = layout[k].Rotate / 90;
                    if (turns == 0) continue;
                    var page = fpdfview.FPDF_LoadPage(document, k);
                    try { fpdf_edit.FPDFPageSetRotation(page, (fpdf_edit.FPDFPageGetRotation(page) + turns) % 4); }
                    finally { fpdfview.FPDF_ClosePage(page); }
                }

                Pdfium.Save(document, output);
                return layout.Count;
            }
            finally
            {
                foreach (var doc in opened)
                    fpdfview.FPDF_CloseDocument(doc);
            }
        }
    }

    /// <summary>Page 0 of another file: all of its pages.</summary>
    private static IReadOnlyList<PageSpec> Expand(IReadOnlyList<PageSpec> layout, int otherCount, Func<int, int> pageCountOf)
    {
        if (!layout.Any(spec => spec.Source > 0 && spec.Page == 0))
            return layout;
        var expanded = new List<PageSpec>();
        foreach (var spec in layout)
        {
            if (spec.Source > 0 && spec.Page == 0 && spec.Source <= otherCount)
                expanded.AddRange(Enumerable.Range(1, pageCountOf(spec.Source)).Select(page => spec with { Page = page }));
            else
                expanded.Add(spec);
        }
        return expanded;
    }

    private static void Validate(IReadOnlyList<PageSpec> layout, int otherCount, int pageCount, Func<int, int> pageCountOf)
    {
        var counts = new Dictionary<int, int> { [0] = pageCount };
        foreach (var spec in layout)
        {
            if (spec.Rotate is not (0 or 90 or 180 or 270))
                throw new ToolException("Pages can only be turned by 90, 180 or 270 degrees.");
            if (spec.Source < 0)
                continue;
            if (spec.Source > otherCount)
                throw new ToolException("One of the files to insert is missing. Please choose it again.");
            if (!counts.TryGetValue(spec.Source, out var count))
                counts[spec.Source] = count = pageCountOf(spec.Source);
            if (spec.Page < 1 || spec.Page > count)
                throw new ToolException($"Page {spec.Page} does not exist (the file has {count} page{(count == 1 ? "" : "s")}).");
        }
    }

    private static void CheckSize(double width, double height)
    {
        if (!(width >= MinPageSize && width <= MaxPageSize && height >= MinPageSize && height <= MaxPageSize))
            throw new ToolException("The page size must be between 1 and 200 inches.");
    }
}
