using Microsoft.AspNetCore.Mvc;
using PdfViewer.Api.Models;
using PdfViewer.Api.Services;
using PdfViewer.Tools;

namespace PdfViewer.Api.Controllers;

[ApiController]
[Route("api/pdf")]
public class PdfController(PdfService pdfService, ILogger<PdfController> logger) : ControllerBase
{
    /// <summary>Uploads and validates a PDF. Returns an id used to fetch the file.</summary>
    [HttpPost("upload")]
    public async Task<ActionResult<PdfFileModel>> Upload(IFormFile? file, CancellationToken ct)
    {
        try
        {
            return Ok(await pdfService.SaveAsync(file, ct));
        }
        catch (PdfValidationException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "PDF upload failed");
            return StatusCode(StatusCodes.Status500InternalServerError,
                new { error = "Unable to upload this PDF. Please try again." });
        }
    }

    /// <summary>The password of a protected document, sent by the viewer with each request (never stored).</summary>
    public const string PasswordHeader = "X-Pdf-Password";
    private static readonly TimeSpan FontsBudget = TimeSpan.FromSeconds(3);

    /// <summary>Document properties: PDF version, metadata, security and page sizes.</summary>
    [HttpGet("{id:guid}/info")]
    public Task<IActionResult> Info(Guid id, [FromHeader(Name = PasswordHeader)] string? password, CancellationToken ct) =>
        Read(id, path => PdfInfoReader.Read(path, password), ct);

    /// <summary>The fonts of the document's text (as many pages as fit in a few seconds).</summary>
    [HttpGet("{id:guid}/fonts")]
    public Task<IActionResult> Fonts(Guid id, [FromHeader(Name = PasswordHeader)] string? password, CancellationToken ct) =>
        Read(id, path => PdfInfoReader.ReadFonts(path, password, FontsBudget, ct), ct);

    /// <summary>The document's digital signatures, each checked.</summary>
    [HttpGet("{id:guid}/signatures")]
    public Task<IActionResult> Signatures(Guid id, [FromHeader(Name = PasswordHeader)] string? password, CancellationToken ct) =>
        Read(id, path => PdfSignatures.Verify(path, password), ct);

    private async Task<IActionResult> Read<T>(Guid id, Func<string, T> read, CancellationToken ct)
    {
        var path = pdfService.GetStoredPath(id);
        if (path is null)
            return NotFound(new { error = "The requested PDF was not found. Please open it again." });
        try
        {
            return Ok(await Task.Run(() => read(path), ct));
        }
        catch (ToolException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    /// <summary>Returns a previously uploaded PDF.</summary>
    [HttpGet("{id:guid}")]
    public IActionResult Get(Guid id)
    {
        var stream = pdfService.OpenRead(id);
        if (stream is null)
            return NotFound(new { error = "The requested PDF was not found. Please open it again." });

        // Range support lets pdf.js fetch large files in chunks.
        return File(stream, "application/pdf", enableRangeProcessing: true);
    }
}
