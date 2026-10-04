using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>Pages of one size (points, as displayed, after /Rotate) and where they are.</summary>
public sealed record PageSizeGroup(double Width, double Height, int Count, IReadOnlyList<int> Pages);

/// <summary>A font used by the document's text: embedded (the whole font or a subset of it) or not (the viewer
/// substitutes a similar font, so text may look different), and on how many pages it was seen.</summary>
public sealed record FontInfo(string Name, string? Family, bool Embedded, bool Subset, int Weight, bool Italic, int Pages, IReadOnlyList<int> FirstPages);

/// <summary>The fonts seen on the first <paramref name="PagesScanned"/> of <paramref name="PageCount"/> pages
/// (fonts are found page by page, for a limited time).</summary>
public sealed record FontsResult(IReadOnlyList<FontInfo> Fonts, int PagesScanned, int PageCount);

/// <summary>Document properties: PDF version, the Info dictionary, security and the page sizes.</summary>
public sealed record PdfInfo(
    string? Version, int PageCount, IReadOnlyDictionary<string, string> Metadata, bool Encrypted,
    IReadOnlyList<string> Restrictions, bool Tagged, bool HasBookmarks, IReadOnlyList<PageSizeGroup> PageSizes);

public static class PdfInfoReader
{
    private static readonly string[] MetadataKeys = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
    private const int MaxPagesListed = 200;     // page numbers kept per size (the count is always complete)

    // Permission bits of the /P entry (PDF 32000-1, table 22).
    private static readonly (uint Bit, string Name)[] Permissions =
    [
        (1u << 2, "Printing"), (1u << 3, "Changing the document"), (1u << 4, "Copying text and images"),
        (1u << 5, "Adding comments"), (1u << 8, "Filling in forms")
    ];

    public static PdfInfo Read(string path, string? password = null)
    {
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path, password);
            try
            {
                var version = 0;
                var hasVersion = fpdfview.FPDF_GetFileVersion(document, ref version) != 0;
                var metadata = new Dictionary<string, string>();
                foreach (var key in MetadataKeys)
                {
                    var value = MetaText(document, key);
                    if (!string.IsNullOrWhiteSpace(value)) metadata[key] = value.Trim();
                }

                var encrypted = fpdfview.FPDF_GetSecurityHandlerRevision(document) != -1;
                var restrictions = new List<string>();
                if (encrypted)
                {
                    var allowed = (uint)fpdfview.FPDF_GetDocPermissions(document);
                    restrictions.AddRange(Permissions.Where(p => (allowed & p.Bit) == 0).Select(p => p.Name));
                }

                var pageCount = fpdfview.FPDF_GetPageCount(document);
                var sizes = new List<(double W, double H, List<int> Pages, int Count)>();
                for (var i = 0; i < pageCount; i++)
                {
                    var size = new FS_SIZEF_();
                    if (fpdfview.FPDF_GetPageSizeByIndexF(document, i, size) == 0) continue;
                    double w = Math.Round(size.Width, 1), h = Math.Round(size.Height, 1);
                    var at = sizes.FindIndex(s => Math.Abs(s.W - w) < 1 && Math.Abs(s.H - h) < 1);
                    if (at < 0)
                    {
                        sizes.Add((w, h, [i + 1], 1));
                        continue;
                    }
                    var group = sizes[at];
                    if (group.Pages.Count < MaxPagesListed) group.Pages.Add(i + 1);
                    sizes[at] = group with { Count = group.Count + 1 };
                }

                return new PdfInfo(
                    hasVersion ? $"{version / 10}.{version % 10}" : null, pageCount, metadata, encrypted, restrictions,
                    fpdf_catalog.FPDFCatalogIsTagged(document) != 0,
                    fpdf_doc.FPDFBookmarkGetFirstChild(document, null) != null,
                    sizes.Select(s => new PageSizeGroup(s.W, s.H, s.Count, s.Pages)).ToList());
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    private const int TextObject = 1;       // FPDF_PAGEOBJ_TEXT
    private const int ItalicFlag = 1 << 6;  // font descriptor flags

    /// <summary>
    /// The fonts of the document's text, page by page until all pages are done or <paramref name="budget"/> is used up
    /// (a very long document reports the pages it got to). The lock is taken per page.
    /// </summary>
    public static FontsResult ReadFonts(string path, string? password, TimeSpan budget, CancellationToken ct = default)
    {
        Pdfium.EnsureInitialized();
        var fonts = new Dictionary<string, (FontInfo Font, List<int> Pages, int Count)>();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        FpdfDocumentT document;
        int pageCount;
        lock (Pdfium.Lock)
        {
            document = Pdfium.OpenDocument(path, password);
            pageCount = fpdfview.FPDF_GetPageCount(document);
        }
        var scanned = 0;
        try
        {
            for (var i = 0; i < pageCount && (scanned == 0 || watch.Elapsed < budget); i++)
            {
                ct.ThrowIfCancellationRequested();
                lock (Pdfium.Lock)
                {
                    var page = fpdfview.FPDF_LoadPage(document, i);
                    if (page != null)
                    {
                        try
                        {
                            var seen = new HashSet<string>();
                            var objects = fpdf_edit.FPDFPageCountObjects(page);
                            for (var k = 0; k < objects; k++)
                            {
                                var obj = fpdf_edit.FPDFPageGetObject(page, k);
                                if (obj == null || fpdf_edit.FPDFPageObjGetType(obj) != TextObject) continue;
                                var font = fpdf_edit.FPDFTextObjGetFont(obj);
                                if (font == null) continue;
                                var info = Describe(font);
                                var key = info.Name + "|" + info.Embedded;
                                if (!seen.Add(key)) continue;
                                if (fonts.TryGetValue(key, out var known))
                                {
                                    if (known.Pages.Count < 10) known.Pages.Add(i + 1);
                                    fonts[key] = known with { Count = known.Count + 1 };
                                }
                                else
                                    fonts[key] = (info, [i + 1], 1);
                            }
                        }
                        finally
                        {
                            fpdfview.FPDF_ClosePage(page);
                        }
                    }
                }
                scanned = i + 1;
            }
        }
        finally
        {
            lock (Pdfium.Lock) fpdfview.FPDF_CloseDocument(document);
        }
        var list = fonts.Values.Select(f => f.Font with { Pages = f.Count, FirstPages = f.Pages })
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase).ToList();
        return new FontsResult(list, scanned, pageCount);
    }

    private static unsafe FontInfo Describe(FpdfFontT font)
    {
        var name = FontText((buffer, length) => fpdf_edit.FPDFFontGetBaseFontName(font, (sbyte*)buffer, length)) ?? "(unnamed)";
        var family = FontText((buffer, length) => fpdf_edit.FPDFFontGetFamilyName(font, (sbyte*)buffer, length));
        // A subset is named with six capitals and a plus sign: ABCDEF+Helvetica.
        var subset = name.Length > 7 && name[6] == '+' && name[..6].All(c => c is >= 'A' and <= 'Z');
        var embedded = fpdf_edit.FPDFFontGetIsEmbedded(font) == 1;
        var flags = fpdf_edit.FPDFFontGetFlags(font);
        // For a font that is not embedded, PDFium names the font it substitutes: not the document's.
        return new FontInfo(subset ? name[7..] : name, !embedded || string.IsNullOrWhiteSpace(family) ? null : family, embedded, subset && embedded,
            fpdf_edit.FPDFFontGetWeight(font), flags > 0 && (flags & ItalicFlag) != 0, 0, []);
    }

    private static string? FontText(Func<IntPtr, ulong, ulong> read)
    {
        var length = (int)read(IntPtr.Zero, 0);
        if (length <= 1) return null;
        var buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(length);
        try
        {
            read(buffer, (ulong)length);
            return System.Runtime.InteropServices.Marshal.PtrToStringUTF8(buffer, length - 1);
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer);
        }
    }

    private static string MetaText(FpdfDocumentT document, string key)
    {
        // First call: the size in bytes (UTF-16LE with a terminator).
        var length = (int)fpdf_doc.FPDF_GetMetaText(document, key, IntPtr.Zero, 0);
        if (length <= 2) return string.Empty;
        var buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(length);
        try
        {
            fpdf_doc.FPDF_GetMetaText(document, key, buffer, (ulong)length);
            return System.Runtime.InteropServices.Marshal.PtrToStringUni(buffer, length / 2 - 1) ?? string.Empty;
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer);
        }
    }
}
