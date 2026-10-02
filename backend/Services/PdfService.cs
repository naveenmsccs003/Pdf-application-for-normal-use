using System.Text;
using Microsoft.Extensions.Options;
using PdfViewer.Api.Models;

namespace PdfViewer.Api.Services;

/// <summary>
/// Validates uploaded PDFs and keeps them in a private temp folder.
/// Files are stored under a random GUID name (the original filename is never used on disk)
/// and are deleted automatically after the configured retention period.
/// </summary>
public class PdfService
{
    private static readonly byte[] PdfSignature = Encoding.ASCII.GetBytes("%PDF-");

    // The PDF spec allows a few bytes of junk before the header; real files keep it within 1 KB.
    private const int SignatureSearchBytes = 1024;

    private readonly PdfStorageOptions _options;
    private readonly ILogger<PdfService> _logger;
    private readonly string _storageDir;

    public PdfService(IOptions<PdfStorageOptions> options, ILogger<PdfService> logger)
    {
        _options = options.Value;
        _logger = logger;
        _storageDir = Path.Combine(Path.GetTempPath(), "pdf-viewer-uploads");
        Directory.CreateDirectory(_storageDir);
    }

    public async Task<PdfFileModel> SaveAsync(IFormFile? file, CancellationToken ct)
    {
        if (file is null)
            throw new PdfValidationException("Please select a PDF file.");
        if (file.Length == 0)
            throw new PdfValidationException("The selected file is empty.");
        if (file.Length > _options.MaxFileSizeBytes)
            throw new PdfValidationException($"The selected file is too large. Maximum size is {_options.MaxFileSizeMB} MB.");

        var fileName = SanitizeFileName(file.FileName);
        if (!fileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            throw new PdfValidationException("Please select a PDF file.");

        await using (var input = file.OpenReadStream())
        {
            if (!await HasPdfSignatureAsync(input, ct))
                throw new PdfValidationException("The selected file is not a valid PDF.");
        }

        DeleteExpiredFiles();

        var id = Guid.NewGuid();
        var path = GetPath(id);
        await using (var input = file.OpenReadStream())
        await using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
        {
            await input.CopyToAsync(output, ct);
        }

        return new PdfFileModel(id, fileName, file.Length);
    }

    /// <summary>Opens a stored PDF for reading, or returns null if it does not exist.</summary>
    public Stream? OpenRead(Guid id)
    {
        var path = GetPath(id);
        return File.Exists(path)
            ? new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)
            : null;
    }

    /// <summary>Path of a stored upload, or null if it does not exist (e.g. expired).</summary>
    public string? GetStoredPath(Guid id)
    {
        var path = GetPath(id);
        return File.Exists(path) ? path : null;
    }

    // The id is a Guid, so the resulting path can never escape the storage folder.
    private string GetPath(Guid id) => Path.Combine(_storageDir, id.ToString("N") + ".pdf");

    private static async Task<bool> HasPdfSignatureAsync(Stream stream, CancellationToken ct)
    {
        var buffer = new byte[SignatureSearchBytes];
        var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, ct);
        return buffer.AsSpan(0, read).IndexOf(PdfSignature) >= 0;
    }

    /// <summary>Keeps only the base name, strips unsafe characters and limits the length.</summary>
    public static string SanitizeFileName(string? name)
    {
        // Browsers on Windows may send full paths; take only the last segment either way.
        var baseName = (name ?? string.Empty).Replace('\\', '/');
        baseName = baseName[(baseName.LastIndexOf('/') + 1)..];

        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(baseName
            .Where(c => !char.IsControl(c) && !invalid.Contains(c) && c != '<' && c != '>' && c != '"')
            .ToArray())
            .Trim(' ', '.');

        if (cleaned.Length > 120)
        {
            var ext = Path.GetExtension(cleaned);
            cleaned = cleaned[..(120 - ext.Length)] + ext;
        }

        return string.IsNullOrEmpty(cleaned) ? "document.pdf" : cleaned;
    }

    public void DeleteExpiredFiles()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-_options.RetentionMinutes);
        foreach (var path in Directory.EnumerateFiles(_storageDir, "*.pdf"))
        {
            try
            {
                if (File.GetLastWriteTimeUtc(path) < cutoff)
                    File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Could not delete expired upload {Path}", path);
            }
        }
    }
}
