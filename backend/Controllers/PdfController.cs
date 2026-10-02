using Microsoft.AspNetCore.Mvc;
using PdfViewer.Api.Models;
using PdfViewer.Api.Services;

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
