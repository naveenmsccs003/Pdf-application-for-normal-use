namespace PdfViewer.Desktop.Models;

/// <summary>Sent to the frontend when a PDF from disk has been opened.</summary>
public record LocalPdfInfo(Guid Token, string FileName, long Size, int PageCount);

public record PageSize(double Width, double Height);

/// <summary>An error whose message is safe to show to the user.</summary>
public class LocalPdfException(string message) : Exception(message);
