using Microsoft.AspNetCore.Mvc;
using PdfViewer.Desktop.Services;
using PdfViewer.Tools;

namespace PdfViewer.Desktop.Controllers;

/// <summary>
/// Document properties of the PDF opened from disk (PDF version, metadata, security, page sizes), its fonts and its
/// digital signatures. A protected document is read with the password it was opened with.
/// </summary>
[ApiController]
[Route("api/local/{token:guid}")]
public class LocalInfoController(PdfiumService pdfium) : ControllerBase
{
    private static readonly TimeSpan FontsBudget = TimeSpan.FromSeconds(3);

    [HttpGet("info")]
    public Task<IActionResult> Info(Guid token) => Read(token, (path, password) => PdfInfoReader.Read(path, password));

    [HttpGet("fonts")]
    public Task<IActionResult> Fonts(Guid token, CancellationToken ct) =>
        Read(token, (path, password) => PdfInfoReader.ReadFonts(path, password, FontsBudget, ct));

    [HttpGet("signatures")]
    public Task<IActionResult> Signatures(Guid token) => Read(token, PdfSignatures.Verify);

    private async Task<IActionResult> Read<T>(Guid token, Func<string, string?, T> read)
    {
        var path = pdfium.PathFor(token);
        if (path is null)
            return NotFound();
        var password = pdfium.PasswordFor(token);
        try
        {
            return Ok(await Task.Run(() => read(path, password)));
        }
        catch (ToolException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
