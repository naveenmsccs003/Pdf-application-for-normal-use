using Microsoft.AspNetCore.Mvc;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop.Controllers;

/// <summary>
/// Page sizes, text and rendered pages for the PDF opened from disk.
/// The token is a random id issued when the user opens a file, so only that file is reachable.
/// </summary>
[ApiController]
[Route("api/local/{token:guid}/pages/{page:int}")]
public class LocalPdfController(PdfiumService pdfium) : ControllerBase
{
    private const double MinScale = 0.05;
    private const double MaxScale = 12;

    [HttpGet("size")]
    public ActionResult<PageSize> Size(Guid token, int page)
    {
        var size = pdfium.GetPageSize(token, page);
        return size is null ? NotFound() : size;
    }

    /// <summary>The page's own text (empty for a scanned page).</summary>
    [HttpGet("text")]
    public ActionResult<PageText> Text(Guid token, int page)
    {
        var text = pdfium.GetPageText(token, page);
        return text is null ? NotFound() : new PageText(text);
    }

    [HttpGet]
    public IActionResult Render(Guid token, int page, [FromQuery] double scale = 1)
    {
        if (double.IsNaN(scale) || scale < MinScale || scale > MaxScale)
            return BadRequest(new { error = "Invalid scale." });

        var png = pdfium.RenderPng(token, page, scale);
        if (png is null)
            return NotFound();

        // Each token is unique to one opened file, so the browser may reuse renders (e.g. zooming back).
        Response.Headers.CacheControl = "private, max-age=3600";
        return File(png, "image/png");
    }
}
