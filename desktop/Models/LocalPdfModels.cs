namespace PdfViewer.Desktop.Models;

/// <summary>Sent to the frontend when a PDF from disk has been opened.</summary>
public record LocalPdfInfo(Guid Token, string FileName, long Size, int PageCount);

public record PageSize(double Width, double Height);

/// <summary>A page's own text, for OCR (skip pages that have text) and Extract text.</summary>
public record PageText(string Text);

/// <summary>An error whose message is safe to show to the user.</summary>
public class LocalPdfException(string message) : Exception(message)
{
    /// <summary>The PDF needs a password to open (or the one given was wrong).</summary>
    public bool NeedsPassword { get; init; }
}

/// <summary>A rectangle in page units at scale 1, top-left origin, as displayed (after /Rotate).</summary>
public record TextRect(double X, double Y, double Width, double Height);

/// <summary>One occurrence of the search text (as found); it can span several lines, so several rectangles.</summary>
public record SearchMatch(int Page, IReadOnlyList<TextRect> Rects, string Text);

/// <summary>Matches found from the requested page on; <c>Next</c> is the page to continue from, or null at the end.</summary>
public record SearchResult(IReadOnlyList<SearchMatch> Matches, int? Next);
