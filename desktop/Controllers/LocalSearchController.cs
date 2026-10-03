using Microsoft.AspNetCore.Mvc;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop.Controllers;

/// <summary>
/// Text search in the PDF opened from disk. Each request searches for a short time and says where to
/// continue, so very large documents can be searched in steps while the viewer stays responsive.
/// </summary>
[ApiController]
[Route("api/local/{token:guid}/search")]
public class LocalSearchController(PdfiumService pdfium) : ControllerBase
{
    public const int MaxQueryLength = 200;
    private const int MaxMatchesPerRequest = 500;
    private static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(250);

    [HttpGet]
    public ActionResult<SearchResult> Search(Guid token, [FromQuery] string? q, [FromQuery] int from = 1, [FromQuery] int? to = null,
                                             [FromQuery] bool matchCase = false, [FromQuery] bool wholeWord = false)
    {
        if (string.IsNullOrWhiteSpace(q) || q.Length > MaxQueryLength)
            return BadRequest(new { error = $"Enter between 1 and {MaxQueryLength} characters to find." });
        if (from < 1 || to < from)
            return BadRequest(new { error = "Invalid page." });

        var result = pdfium.Search(token, q, from, to, matchCase, wholeWord, MaxMatchesPerRequest, Budget);
        return result is null ? NotFound() : result;
    }
}
