using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PdfViewer.Api.Models;
using PdfViewer.Api.Services;
using PdfViewer.Tools;

namespace PdfViewer.Api.Controllers;

/// <summary>
/// New documents and page edits (delete, insert, reorder, duplicate, rotate, replace, extract).
/// An edit never changes the stored upload: the result is stored as a new one, which the viewer then shows,
/// so the browser can always go back to the file as it was opened.
/// </summary>
[ApiController]
[Route("api/pages")]
public class PagesController(PdfService pdfService, ILogger<PagesController> logger) : ControllerBase
{
    private const int MaxInsertFiles = 10;
    private const long MaxRequestBytes = 600L * 1024 * 1024;   // 10 files x 50 MB plus overhead

    /// <summary>A new PDF with blank pages.</summary>
    [HttpPost("new")]
    public Task<IActionResult> New([FromBody] NewDocumentRequest request, CancellationToken ct) =>
        Run(async () =>
        {
            var stored = await pdfService.StoreGeneratedAsync(NameOrDefault(request.Name, "Untitled.pdf"),
                output => PageEditor.CreateBlank(request.Count, request.Width, request.Height, output), ct);
            return Ok(new EditedDocument(stored.Id, stored.FileName, stored.Size, request.Count));
        });

    /// <summary>
    /// Rebuilds the document <paramref name="id"/> with the pages in <paramref name="layout"/> (a JSON list of
    /// <see cref="PageSpec"/>); <paramref name="files"/> are the files that sources 1..n refer to.
    /// </summary>
    [HttpPost("rearrange")]
    [RequestSizeLimit(MaxRequestBytes)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxRequestBytes)]
    public Task<IActionResult> Rearrange([FromForm] Guid id, [FromForm] string? name, [FromForm] string layout,
        [FromForm] List<IFormFile> files, CancellationToken ct) =>
        Run(async () =>
        {
            var (path, specs, others) = await ResolveAsync(id, layout, files, ct);
            var pages = 0;
            var stored = await pdfService.StoreGeneratedAsync(NameOrDefault(name, "document.pdf"),
                output => pages = PageEditor.Rearrange(path, specs, others, output), ct);
            return Ok(new EditedDocument(stored.Id, stored.FileName, stored.Size, pages));
        });

    /// <summary>Like rearrange, but returns the pages as a download (the open document stays as it is).</summary>
    [HttpPost("extract")]
    public Task<IActionResult> Extract([FromForm] Guid id, [FromForm] string? name, [FromForm] string layout, CancellationToken ct) =>
        Run(async () =>
        {
            var (path, specs, others) = await ResolveAsync(id, layout, [], ct);
            var output = new FileStream(Path.Combine(Path.GetTempPath(), $"pdf-viewer-out-{Guid.NewGuid():N}"),
                FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose);
            var pages = await Task.Run(() => PageEditor.Rearrange(path, specs, others, output), ct);
            output.Position = 0;
            Response.Headers["X-Page-Count"] = pages.ToString();
            var baseName = Path.GetFileNameWithoutExtension(NameOrDefault(name, "document.pdf"));
            return File(output, "application/pdf", $"{baseName}-pages.pdf");
        });

    private async Task<(string Path, List<PageSpec> Specs, List<(string Path, string Name)> Others)> ResolveAsync(
        Guid id, string layout, List<IFormFile> files, CancellationToken ct)
    {
        var path = pdfService.GetStoredPath(id)
                   ?? throw new ToolException("The document is no longer available. Please open it again.");
        if (files.Count > MaxInsertFiles)
            throw new ToolException($"You can add pages from up to {MaxInsertFiles} files at a time.");

        List<PageSpec>? specs;
        try { specs = JsonSerializer.Deserialize<List<PageSpec>>(layout, JsonSerializerOptions.Web); }
        catch (JsonException) { specs = null; }
        if (specs is null)
            throw new ToolException("Invalid page edit.");

        var others = new List<(string Path, string Name)>();
        foreach (var file in files)
        {
            var saved = await pdfService.SaveAsync(file, ct);
            others.Add((pdfService.GetStoredPath(saved.Id)!, saved.FileName));
        }
        return (path, specs, others);
    }

    private static string NameOrDefault(string? name, string fallback)
    {
        var cleaned = PdfService.SanitizeFileName(string.IsNullOrWhiteSpace(name) ? fallback : name);
        return cleaned.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? cleaned : cleaned + ".pdf";
    }

    private async Task<IActionResult> Run(Func<Task<IActionResult>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ex is ToolException or PdfValidationException)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Page edit failed");
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "Something went wrong. Please try again." });
        }
    }
}

/// <summary>A blank PDF: <c>Count</c> pages of <c>Width</c> x <c>Height</c> points.</summary>
public record NewDocumentRequest(int Count, double Width, double Height, string? Name);

/// <summary>The stored result of a page edit or a new document, ready to open in the viewer.</summary>
public record EditedDocument(Guid Id, string FileName, long Size, int PageCount);
