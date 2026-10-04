using Microsoft.AspNetCore.Mvc;
using PdfViewer.Desktop.Services;
using PdfViewer.Tools;

namespace PdfViewer.Desktop.Controllers;

/// <summary>Document properties of the PDF opened from disk (PDF version, metadata, security, page sizes).</summary>
[ApiController]
[Route("api/local/{token:guid}/info")]
public class LocalInfoController(PdfiumService pdfium) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Info(Guid token)
    {
        var path = pdfium.PathFor(token);
        if (path is null)
            return NotFound();
        try
        {
            return Ok(await Task.Run(() => PdfInfoReader.Read(path)));
        }
        catch (ToolException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
