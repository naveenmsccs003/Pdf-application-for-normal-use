using System.Runtime.InteropServices;
using PDFiumCore;
using PdfViewer.Desktop.Models;

namespace PdfViewer.Desktop.Services;

/// <summary>
/// Opens PDFs from disk with PDFium and renders single pages to PNG.
/// PDFium reads only the parts of the file it needs, so very large files open quickly.
/// PDFium is not thread-safe: every call goes through one lock.
/// </summary>
public sealed class PdfiumService : IDisposable
{
    // Same limit as the browser viewer: keeps one rendered page at a sane size.
    private const long MaxRenderPixels = 16_777_216;

    private const int RenderAnnotations = 0x01;
    private const int ReverseByteOrder = 0x10;   // gives RGBA instead of BGRA

    private readonly object _gate = new();
    private readonly ILogger<PdfiumService> _logger;
    private FpdfDocumentT? _document;
    private Guid _token;

    public PdfiumService(ILogger<PdfiumService> logger)
    {
        _logger = logger;
        fpdfview.FPDF_InitLibrary();
    }

    /// <summary>
    /// The first text render makes PDFium scan the installed system fonts (several seconds on Linux).
    /// Doing it at startup keeps the first page fast.
    /// </summary>
    public void WarmUp()
    {
        const string pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
                           "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
                           "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 50 50]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
                           "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
                           "5 0 obj<</Length 31>>stream\nBT /F1 12 Tf 5 20 Td (Hi) Tj ET\nendstream endobj\n" +
                           "trailer<</Root 1 0 R>>\n%%EOF";
        var bytes = System.Text.Encoding.ASCII.GetBytes(pdf);
        var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            lock (_gate)
            {
                var doc = fpdfview.FPDF_LoadMemDocument(handle.AddrOfPinnedObject(), bytes.Length, null);
                if (doc == null) return;
                var page = fpdfview.FPDF_LoadPage(doc, 0);
                var bitmap = fpdfview.FPDFBitmapCreateEx(50, 50, (int)FPDFBitmapFormat.BGRA, IntPtr.Zero, 0);
                fpdfview.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 50, 50, 0, 0);
                fpdfview.FPDFBitmapDestroy(bitmap);
                fpdfview.FPDF_ClosePage(page);
                fpdfview.FPDF_CloseDocument(doc);
            }
        }
        finally
        {
            handle.Free();
        }
    }

    /// <summary>Opens a PDF (closing the previous one). Throws <see cref="LocalPdfException"/>.</summary>
    public LocalPdfInfo Open(string path)
    {
        PdfPreflight.Check(path);

        lock (_gate)
        {
            var document = fpdfview.FPDF_LoadDocument(path, null);
            if (document == null)
                throw new LocalPdfException(ErrorMessage(fpdfview.FPDF_GetLastError()));

            var pageCount = fpdfview.FPDF_GetPageCount(document);
            if (pageCount < 1)
            {
                fpdfview.FPDF_CloseDocument(document);
                throw new LocalPdfException("This PDF has no pages.");
            }

            CloseCurrent();
            _document = document;
            _token = Guid.NewGuid();
            return new LocalPdfInfo(_token, Path.GetFileName(path), new FileInfo(path).Length, pageCount);
        }
    }

    public PageSize? GetPageSize(Guid token, int pageNumber)
    {
        lock (_gate)
        {
            var page = LoadPage(token, pageNumber);
            if (page == null) return null;
            try
            {
                // Width/height already account for the page's /Rotate.
                return new PageSize(fpdfview.FPDF_GetPageWidthF(page), fpdfview.FPDF_GetPageHeightF(page));
            }
            finally
            {
                fpdfview.FPDF_ClosePage(page);
            }
        }
    }

    /// <summary>Renders a page at the given scale (1 = 72 dpi) as PNG, or null if the page does not exist.</summary>
    public byte[]? RenderPng(Guid token, int pageNumber, double scale)
    {
        byte[] pixels;
        int width, height, stride;

        lock (_gate)
        {
            var page = LoadPage(token, pageNumber);
            if (page == null) return null;
            try
            {
                var pageWidth = fpdfview.FPDF_GetPageWidthF(page);
                var pageHeight = fpdfview.FPDF_GetPageHeightF(page);
                var maxScale = Math.Sqrt(MaxRenderPixels / (pageWidth * pageHeight));
                scale = Math.Min(scale, maxScale);
                width = Math.Max(1, (int)Math.Round(pageWidth * scale));
                height = Math.Max(1, (int)Math.Round(pageHeight * scale));

                var bitmap = fpdfview.FPDFBitmapCreateEx(width, height, (int)FPDFBitmapFormat.BGRA, IntPtr.Zero, 0)
                             ?? throw new InvalidOperationException("Could not allocate page bitmap.");
                try
                {
                    fpdfview.FPDFBitmapFillRect(bitmap, 0, 0, width, height, 0xFFFFFFFF);
                    fpdfview.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RenderAnnotations | ReverseByteOrder);
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

        // Encoding happens outside the lock so it does not block other PDFium calls.
        return PngEncoder.Encode(pixels, width, height, stride);
    }

    private FpdfPageT? LoadPage(Guid token, int pageNumber)
    {
        if (_document == null || token != _token || pageNumber < 1 || pageNumber > fpdfview.FPDF_GetPageCount(_document))
            return null;
        return fpdfview.FPDF_LoadPage(_document, pageNumber - 1);
    }

    private static string ErrorMessage(ulong code) => code switch
    {
        2 => "The selected file could not be opened.",
        3 => "The selected file is not a valid PDF.",
        4 => "This PDF is password-protected and cannot be opened.",
        5 => "This PDF uses a security handler that is not supported.",
        _ => "Unable to open this PDF."
    };

    private void CloseCurrent()
    {
        if (_document != null)
        {
            fpdfview.FPDF_CloseDocument(_document);
            _document = null;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            CloseCurrent();
            fpdfview.FPDF_DestroyLibrary();
        }
        _logger.LogDebug("PDFium shut down");
    }
}
