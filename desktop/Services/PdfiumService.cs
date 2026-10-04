using System.Runtime.InteropServices;
using PDFiumCore;
using PdfViewer.Desktop.Models;
using PdfViewer.Tools;

namespace PdfViewer.Desktop.Services;

/// <summary>
/// Opens PDFs from disk with PDFium, renders single pages to PNG and finds text. Besides the document in the
/// viewer, a second one can be open to compare revisions (Revision tab); it has its own token.
/// PDFium reads only the parts of the file it needs, so very large files open quickly.
/// PDFium is not thread-safe: every call goes through the process-wide <see cref="Pdfium.Lock"/>,
/// shared with the merge/split/convert tools.
/// </summary>
public sealed class PdfiumService : IDisposable
{
    // Same limit as the browser viewer: keeps one rendered page at a sane size.
    private const long MaxRenderPixels = 16_777_216;

    private const int RenderAnnotations = 0x01;
    private const int ReverseByteOrder = 0x10;   // gives RGBA instead of BGRA

    private readonly object _gate = Pdfium.Lock;
    private FpdfDocumentT? _document;
    private Guid _token;
    private string? _path;          // the file PDFium reads: the user's file, or a temp working copy after page edits
    private string? _name;          // file name shown in the viewer
    private string? _savePath;      // where Save writes; null for a new document that was never saved
    private bool _pathIsTemp;
    private FpdfDocumentT? _compare;
    private Guid _compareToken;

    public PdfiumService()
    {
        Pdfium.EnsureInitialized();
        DeleteStaleWorkingCopies();
    }

    // Working copies are deleted when the document closes; these were left by a crash. Only old ones,
    // so another running copy of the app keeps its own.
    private static void DeleteStaleWorkingCopies()
    {
        if (!Directory.Exists(WorkingFolder)) return;
        foreach (var file in Directory.EnumerateFiles(WorkingFolder, "*.pdf"))
        {
            try
            {
                if (File.GetLastWriteTimeUtc(file) < DateTime.UtcNow.AddDays(-1))
                    File.Delete(file);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* in use */ }
        }
    }

    /// <summary>Path and name of the document open in the viewer (its working copy after page edits), or null.</summary>
    public (string Path, string Name)? Current
    {
        get
        {
            lock (_gate)
                return _path is null ? null : (_path, _name!);
        }
    }

    /// <summary>The file PDFium reads for the viewer's document with this token, or null.</summary>
    public string? PathFor(Guid token)
    {
        lock (_gate)
            return _document != null && token == _token ? _path : null;
    }

    /// <summary>The file Save writes to, or null for a new document that was never saved.</summary>
    public string? SavePath
    {
        get { lock (_gate) return _savePath; }
    }

    /// <summary>Temp folder for working copies (page edits, new documents); see <see cref="OpenWorkingCopy"/>.</summary>
    public static string WorkingFolder { get; } = Path.Combine(Path.GetTempPath(), "pdf-viewer-desktop");

    public static string NewWorkingPath()
    {
        Directory.CreateDirectory(WorkingFolder);
        return Path.Combine(WorkingFolder, $"{Guid.NewGuid():N}.pdf");
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

    /// <summary>Opens a PDF (closing the previous one and any comparison). Throws <see cref="LocalPdfException"/>.</summary>
    public LocalPdfInfo Open(string path)
    {
        PdfPreflight.Check(path);

        lock (_gate)
        {
            var (document, pageCount) = LoadDocument(path);
            CloseCurrent();
            CloseCompareDocument();
            _document = document;
            _token = Guid.NewGuid();
            _path = path;
            _name = Path.GetFileName(path);
            _savePath = path;
            _pathIsTemp = false;
            return new LocalPdfInfo(_token, _name, new FileInfo(path).Length, pageCount);
        }
    }

    /// <summary>
    /// Shows a working copy in the viewer (the result of a page edit, or a new document), in place of the
    /// current document; the previous working copy is deleted. The user's file is only written by Save.
    /// </summary>
    public LocalPdfInfo OpenWorkingCopy(string tempPath, string name, string? savePath)
    {
        lock (_gate)
        {
            (FpdfDocumentT Document, int PageCount) loaded;
            try
            {
                loaded = LoadDocument(tempPath);
            }
            catch
            {
                File.Delete(tempPath);
                throw;
            }
            CloseCurrent();
            CloseCompareDocument();
            _document = loaded.Document;
            _token = Guid.NewGuid();
            _path = tempPath;
            _name = name;
            _savePath = savePath;
            _pathIsTemp = true;
            return new LocalPdfInfo(_token, name, new FileInfo(tempPath).Length, loaded.PageCount);
        }
    }

    /// <summary>After Save / Save As: the document now belongs to that file.</summary>
    public void MarkSaved(string savePath)
    {
        lock (_gate)
        {
            _savePath = savePath;
            _name = Path.GetFileName(savePath);
        }
    }

    /// <summary>Opens another revision to compare with (closing the previous one). Throws <see cref="LocalPdfException"/>.</summary>
    public LocalPdfInfo OpenCompare(string path)
    {
        PdfPreflight.Check(path);

        lock (_gate)
        {
            var (document, pageCount) = LoadDocument(path);
            CloseCompareDocument();
            _compare = document;
            _compareToken = Guid.NewGuid();
            return new LocalPdfInfo(_compareToken, Path.GetFileName(path), new FileInfo(path).Length, pageCount);
        }
    }

    public void CloseCompare()
    {
        lock (_gate)
            CloseCompareDocument();
    }

    private static (FpdfDocumentT Document, int PageCount) LoadDocument(string path)
    {
        var document = fpdfview.FPDF_LoadDocument(path, null);
        if (document == null)
            throw new LocalPdfException(Pdfium.ErrorMessage(fpdfview.FPDF_GetLastError()));

        var pageCount = fpdfview.FPDF_GetPageCount(document);
        if (pageCount < 1)
        {
            fpdfview.FPDF_CloseDocument(document);
            throw new LocalPdfException("This PDF has no pages.");
        }
        return (document, pageCount);
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

    /// <summary>
    /// Finds <paramref name="query"/> on pages <paramref name="fromPage"/> to <paramref name="toPage"/>
    /// (null: the last page), stopping after
    /// <paramref name="budget"/> or <paramref name="maxMatches"/> so a request never holds PDFium for long;
    /// the caller continues from <see cref="SearchResult.Next"/>. The lock is taken per page, so page
    /// renders are not held up by a long search. Returns null if the token is not the open document.
    /// </summary>
    /// <summary>
    /// Finds <paramref name="query"/> (PDFium's search), or with <paramref name="pattern"/> every match of that regular
    /// expression in the page text (drawing, beam and column numbers), from <paramref name="fromPage"/> on, for about
    /// <paramref name="budget"/>. Null if the token is not the open document.
    /// </summary>
    public SearchResult? Search(Guid token, string query, int fromPage, int? toPage, bool matchCase, bool wholeWord,
                                int maxMatches, TimeSpan budget, System.Text.RegularExpressions.Regex? pattern = null)
    {
        // PDFium expects a null-terminated UTF-16 string.
        var text = new ushort[query.Length + 1];
        for (var i = 0; i < query.Length; i++) text[i] = query[i];
        var flags = (matchCase ? FindMatchCase : 0) | (wholeWord ? FindWholeWord : 0);

        var matches = new List<SearchMatch>();
        var started = System.Diagnostics.Stopwatch.StartNew();
        var pageNumber = Math.Max(1, fromPage);
        while (true)
        {
            lock (_gate)
            {
                if (_document == null || token != _token) return null;
                var lastPage = Math.Min(toPage ?? int.MaxValue, fpdfview.FPDF_GetPageCount(_document));
                if (pageNumber > lastPage) return new SearchResult(matches, null);
                SearchPage(pageNumber, text, flags, pattern, matches, maxMatches);
            }
            pageNumber++;
            if (matches.Count >= maxMatches || started.Elapsed >= budget)
                return new SearchResult(matches, pageNumber);
        }
    }

    private const int FindMatchCase = 0x1;
    private const int FindWholeWord = 0x2;

    /// <summary>Adds the matches on one page; caller holds the lock.</summary>
    private void SearchPage(int pageNumber, ushort[] text, int flags, System.Text.RegularExpressions.Regex? pattern,
                            List<SearchMatch> matches, int maxMatches)
    {
        var page = fpdfview.FPDF_LoadPage(_document!, pageNumber - 1);
        if (page == null) return;   // a damaged page is skipped, like a page without text
        var textPage = fpdf_text.FPDFTextLoadPage(page);
        try
        {
            if (textPage == null) return;

            // Device coordinates are integers; map at 1/100 point for precision.
            const double precision = 100;
            double pageWidth = fpdfview.FPDF_GetPageWidthF(page), pageHeight = fpdfview.FPDF_GetPageHeightF(page);
            int sizeX = (int)Math.Round(pageWidth * precision), sizeY = (int)Math.Round(pageHeight * precision);
            (double X, double Y) ToView(double x, double y)
            {
                int dx = 0, dy = 0;
                fpdfview.FPDF_PageToDevice(page, 0, 0, sizeX, sizeY, 0, x, y, ref dx, ref dy);
                return (dx / precision, dy / precision);
            }

            void Add(int start, int count)
            {
                var rects = new List<TextRect>();
                var rectCount = fpdf_text.FPDFTextCountRects(textPage, start, count);
                for (var i = 0; i < rectCount; i++)
                {
                    double left = 0, top = 0, right = 0, bottom = 0;
                    if (fpdf_text.FPDFTextGetRect(textPage, i, ref left, ref top, ref right, ref bottom) == 0) continue;
                    // Page space has its origin at the bottom left and ignores /Rotate; the viewer
                    // uses the displayed page with the origin at the top left, so map both corners.
                    var a = ToView(left, top);
                    var b = ToView(right, bottom);
                    rects.Add(new TextRect(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y)));
                }
                if (rects.Count > 0) matches.Add(new SearchMatch(pageNumber, rects, PageText(textPage, start, count)));
            }

            if (pattern is not null)
            {
                // Character positions in the page text are PDFium's character indexes, so a match maps to its boxes.
                var chars = fpdf_text.FPDFTextCountChars(textPage);
                if (chars <= 0) return;
                try
                {
                    for (var m = pattern.Match(PageText(textPage, 0, chars)); m.Success && matches.Count < maxMatches; m = m.NextMatch())
                        if (m.Length > 0) Add(m.Index, m.Length);
                }
                catch (System.Text.RegularExpressions.RegexMatchTimeoutException)
                {
                    // A pathological pattern on this page: skip it, like a page without text.
                }
                return;
            }

            var find = fpdf_text.FPDFTextFindStart(textPage, ref text[0], (ulong)flags, 0);
            if (find == null) return;
            try
            {
                // Stops at the limit even within a page (e.g. a one-letter search on a dense page).
                while (matches.Count < maxMatches && fpdf_text.FPDFTextFindNext(find) != 0)
                    Add(fpdf_text.FPDFTextGetSchResultIndex(find), fpdf_text.FPDFTextGetSchCount(find));
            }
            finally
            {
                fpdf_text.FPDFTextFindClose(find);
            }
        }
        finally
        {
            if (textPage != null) fpdf_text.FPDFTextClosePage(textPage);
            fpdfview.FPDF_ClosePage(page);
        }
    }

    /// <summary>
    /// The page's own text (PDFium's text layer, lines ending in CR LF): empty for a scanned page, null if there is no
    /// such page. The viewer uses it to skip pages that need no OCR, and for Extract text.
    /// </summary>
    public string? GetPageText(Guid token, int pageNumber)
    {
        lock (_gate)
        {
            var page = LoadPage(token, pageNumber);
            if (page == null) return null;
            var textPage = fpdf_text.FPDFTextLoadPage(page);
            try
            {
                if (textPage == null) return string.Empty;
                var chars = fpdf_text.FPDFTextCountChars(textPage);
                return chars <= 0 ? string.Empty : PageText(textPage, 0, chars);
            }
            finally
            {
                if (textPage != null) fpdf_text.FPDFTextClosePage(textPage);
                fpdfview.FPDF_ClosePage(page);
            }
        }
    }

    /// <summary>Characters [start, start + count) of a text page, one per character index.</summary>
    private static string PageText(FpdfTextpageT textPage, int start, int count)
    {
        var buffer = new ushort[count + 1];   // UTF-16 plus terminator
        var written = fpdf_text.FPDFTextGetText(textPage, start, count, ref buffer[0]);
        var chars = new char[Math.Max(0, Math.Min(count, written - 1))];
        for (var i = 0; i < chars.Length; i++) chars[i] = (char)buffer[i];
        return new string(chars);
    }

    /// <summary>A page of the viewer's document or of the comparison, by token; null if there is no such page.</summary>
    private FpdfPageT? LoadPage(Guid token, int pageNumber)
    {
        var document = _document != null && token == _token ? _document
                     : _compare != null && token == _compareToken ? _compare
                     : null;
        if (document == null || pageNumber < 1 || pageNumber > fpdfview.FPDF_GetPageCount(document))
            return null;
        return fpdfview.FPDF_LoadPage(document, pageNumber - 1);
    }

    /// <summary>Closes the document shown in the viewer (tab closed), and the comparison with it.</summary>
    public void Close()
    {
        lock (_gate)
        {
            CloseCurrent();
            CloseCompareDocument();
        }
    }

    private void CloseCompareDocument()
    {
        if (_compare != null)
        {
            fpdfview.FPDF_CloseDocument(_compare);
            _compare = null;
            _compareToken = Guid.Empty;
        }
    }

    private void CloseCurrent()
    {
        if (_document != null)
        {
            fpdfview.FPDF_CloseDocument(_document);
            _document = null;
            if (_pathIsTemp)
            {
                try { File.Delete(_path!); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* left in the temp folder */ }
            }
            _path = _name = _savePath = null;
            _pathIsTemp = false;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            CloseCurrent();
            CloseCompareDocument();
        }
    }
}
