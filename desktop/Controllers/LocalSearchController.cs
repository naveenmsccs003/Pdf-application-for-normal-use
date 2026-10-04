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
    private const int MaxPatternLength = 400;
    private static readonly TimeSpan PatternTimeout = TimeSpan.FromMilliseconds(200);
    private const int MaxMatchesPerRequest = 500;
    private static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(250);

    /// <param name="pattern">A regular expression to find instead of <paramref name="q"/> (drawing, beam and column
    /// numbers; built by the viewer). Each page gets a short time limit.</param>
    [HttpGet]
    public ActionResult<SearchResult> Search(Guid token, [FromQuery] string? q, [FromQuery] int from = 1, [FromQuery] int? to = null,
                                             [FromQuery] bool matchCase = false, [FromQuery] bool wholeWord = false,
                                             [FromQuery] string? pattern = null)
    {
        System.Text.RegularExpressions.Regex? regex = null;
        if (pattern is not null)
        {
            if (pattern.Length == 0 || pattern.Length > MaxPatternLength)
                return BadRequest(new { error = "Invalid search pattern." });
            try
            {
                var options = System.Text.RegularExpressions.RegexOptions.CultureInvariant |
                              (matchCase ? 0 : System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                regex = new System.Text.RegularExpressions.Regex(pattern, options, PatternTimeout);
            }
            catch (ArgumentException)
            {
                return BadRequest(new { error = "Invalid search pattern." });
            }
        }
        else if (string.IsNullOrWhiteSpace(q) || q.Length > MaxQueryLength)
            return BadRequest(new { error = $"Enter between 1 and {MaxQueryLength} characters to find." });
        if (from < 1 || to < from)
            return BadRequest(new { error = "Invalid page." });

        var result = pdfium.Search(token, q ?? string.Empty, from, to, matchCase, wholeWord, MaxMatchesPerRequest, Budget, regex);
        return result is null ? NotFound() : result;
    }
}
