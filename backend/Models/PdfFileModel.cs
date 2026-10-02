namespace PdfViewer.Api.Models;

/// <summary>Returned to the client after a successful upload.</summary>
public record PdfFileModel(Guid Id, string FileName, long Size);

/// <summary>Bound from the "PdfStorage" section of appsettings.json.</summary>
public class PdfStorageOptions
{
    public int MaxFileSizeMB { get; set; } = 50;
    public int RetentionMinutes { get; set; } = 60;

    public long MaxFileSizeBytes => MaxFileSizeMB * 1024L * 1024L;
}

/// <summary>Thrown for invalid uploads; the message is safe to show to the user.</summary>
public class PdfValidationException(string message) : Exception(message);
