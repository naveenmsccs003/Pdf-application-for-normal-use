using System.Text;
using PdfViewer.Desktop.Models;

namespace PdfViewer.Desktop.Services;

/// <summary>
/// Quick checks before handing a file to PDFium. PDFium reads cross-reference stream offsets
/// as 32-bit values, so such files above 4 GB make it scan the entire file (minutes) and still fail.
/// Detecting that up front lets us show a clear message instead of hanging.
/// </summary>
public static class PdfPreflight
{
    private const long FourGB = 4L * 1024 * 1024 * 1024;

    // Without a valid index PDFium rebuilds it by scanning the whole file; only allow that for smaller files.
    private const long MaxRepairSize = 512L * 1024 * 1024;

    public static void Check(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists)
            throw new LocalPdfException("The selected file could not be found.");
        if (info.Length == 0)
            throw new LocalPdfException("The selected file is empty.");

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.RandomAccess);

        var head = ReadAt(stream, 0, 1024);
        if (!head.Contains("%PDF-", StringComparison.Ordinal))
            throw new LocalPdfException("The selected file is not a valid PDF.");

        var tailLength = (int)Math.Min(4096, info.Length);
        var tail = ReadAt(stream, info.Length - tailLength, tailLength);
        var startXref = FindStartXref(tail);

        if (startXref is null || startXref.Value >= info.Length)
        {
            if (info.Length > MaxRepairSize)
                throw new LocalPdfException("This PDF is damaged (its page index is missing) and is too large to repair.");
            return; // PDFium will rebuild the index for smaller files
        }

        var atXref = ReadAt(stream, startXref.Value, 32);
        var isClassicTable = atXref.TrimStart().StartsWith("xref", StringComparison.Ordinal);
        if (!isClassicTable && info.Length > FourGB)
            throw new LocalPdfException(
                "This PDF is larger than 4 GB and uses a compressed page index, which the PDF engine cannot read. " +
                "PDFs up to 4 GB are supported, and larger ones (up to about 9 GB) when saved with a classic index.");
    }

    private static string ReadAt(FileStream stream, long offset, int count)
    {
        var buffer = new byte[count];
        stream.Position = offset;
        var read = stream.ReadAtLeast(buffer, count, throwOnEndOfStream: false);
        return Encoding.Latin1.GetString(buffer, 0, read);
    }

    private static long? FindStartXref(string tail)
    {
        var index = tail.LastIndexOf("startxref", StringComparison.Ordinal);
        if (index < 0)
            return null;

        var digits = new string(tail[(index + "startxref".Length)..]
            .SkipWhile(char.IsWhiteSpace)
            .TakeWhile(char.IsAsciiDigit)
            .ToArray());
        return long.TryParse(digits, out var offset) ? offset : null;
    }
}
