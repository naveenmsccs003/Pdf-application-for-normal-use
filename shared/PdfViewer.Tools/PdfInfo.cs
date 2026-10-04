using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>Pages of one size (points, as displayed, after /Rotate) and where they are.</summary>
public sealed record PageSizeGroup(double Width, double Height, int Count, IReadOnlyList<int> Pages);

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

    public static PdfInfo Read(string path)
    {
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path);
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
