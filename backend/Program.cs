using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using PdfViewer.Api.Models;
using PdfViewer.Api.Services;

// The AngularJS frontend lives in ../frontend and is served by this app,
// so a single `dotnet run` starts the whole application.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "frontend"))
});

builder.Services.Configure<PdfStorageOptions>(builder.Configuration.GetSection("PdfStorage"));
builder.Services.AddSingleton<PdfService>();
builder.Services.AddHostedService<PdfCleanupService>();
builder.Services.AddControllers().ConfigureApiBehaviorOptions(o =>
{
    // Replace the default validation response (which includes framework details) with a simple message.
    o.InvalidModelStateResponseFactory = context =>
    {
        var tooLarge = context.ModelState.Values
            .SelectMany(v => v.Errors)
            .Any(e => e.ErrorMessage.Contains("too large", StringComparison.OrdinalIgnoreCase));
        return tooLarge
            ? new ObjectResult(new { error = "The selected file is too large." }) { StatusCode = StatusCodes.Status413PayloadTooLarge }
            : new BadRequestObjectResult(new { error = "Please select a PDF file." });
    };
});

// Allow the configured max file size plus a little room for multipart overhead.
var maxFileBytes = builder.Configuration.GetSection("PdfStorage").Get<PdfStorageOptions>()?.MaxFileSizeBytes
                   ?? new PdfStorageOptions().MaxFileSizeBytes;
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = maxFileBytes + 1024 * 1024);
builder.Services.Configure<FormOptions>(o => o.MultipartBodyLengthLimit = maxFileBytes + 1024 * 1024);

// Behind a reverse proxy (nginx, IIS, a load balancer) that ends HTTPS: trust its X-Forwarded-For / -Proto headers,
// so the client's address (rate limiting) and the original scheme (HTTPS redirection) are known. Only proxies on this
// computer are trusted unless more are listed in ReverseProxy:KnownProxies.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    foreach (var proxy in builder.Configuration.GetSection("ReverseProxy:KnownProxies").Get<string[]>() ?? [])
        if (IPAddress.TryParse(proxy, out var address))
            o.KnownProxies.Add(address);
});
var https = builder.Configuration.GetSection("Https").Get<HttpsOptions>() ?? new HttpsOptions();
builder.Services.AddHttpsRedirection(o => o.HttpsPort = https.Port);
builder.Services.AddHsts(o => o.MaxAge = TimeSpan.FromDays(https.HstsDays));

// Requests per client address and minute: uploads and tools (which read and write whole files) have lower limits than
// the rest of the API. Pages, scripts and styles are not limited.
var limits = builder.Configuration.GetSection("RateLimiting").Get<RateLimitOptions>() ?? new RateLimitOptions();
builder.Services.AddRateLimiter(o =>
{
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var kind = RateLimitKind(context.Request);
        if (kind is null || !limits.Enabled)
            return RateLimitPartition.GetNoLimiter("none");
        var permits = kind switch { "upload" => limits.UploadsPerMinute, "tool" => limits.ToolsPerMinute, _ => limits.RequestsPerMinute };
        return RateLimitPartition.GetFixedWindowLimiter(kind + ":" + context.Connection.RemoteIpAddress,
            _ => new FixedWindowRateLimiterOptions { PermitLimit = permits, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 });
    });
    o.OnRejected = async (context, ct) =>
    {
        var response = context.HttpContext.Response;
        response.StatusCode = StatusCodes.Status429TooManyRequests;
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(System.Globalization.CultureInfo.InvariantCulture);
        await response.WriteAsJsonAsync(new { error = "Too many requests. Please wait a minute and try again." }, ct);
    };
});

var app = builder.Build();

app.UseForwardedHeaders();
if (https.Redirect && !app.Environment.IsDevelopment())
{
    app.UseHsts();
    app.UseHttpsRedirection();
}

// Never expose stack traces: unhandled errors become a short JSON message.
app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
{
    var error = context.Features.Get<IExceptionHandlerFeature>()?.Error;
    var tooLarge = error is BadHttpRequestException { StatusCode: StatusCodes.Status413PayloadTooLarge };
    context.Response.StatusCode = tooLarge ? StatusCodes.Status413PayloadTooLarge : StatusCodes.Status500InternalServerError;
    await context.Response.WriteAsJsonAsync(new
    {
        error = tooLarge ? "The selected file is too large." : "Something went wrong. Please try again."
    });
}));

app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers.XContentTypeOptions = "nosniff";
    headers.XFrameOptions = "DENY";
    headers["Referrer-Policy"] = "no-referrer";
    headers.ContentSecurityPolicy =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    await next();
});

app.UseDefaultFiles();
// The browser checks each file again on every load (cheap: ETag, 304), so after an update
// it never mixes new HTML with old cached scripts.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
});
app.UseRateLimiter();
app.MapControllers();

app.Run();

// Which rate limit a request counts against; null: not limited (the frontend's own files).
static string? RateLimitKind(HttpRequest request)
{
    var path = request.Path;
    if (!path.StartsWithSegments("/api"))
        return null;
    var post = HttpMethods.IsPost(request.Method);
    if (post && (path.StartsWithSegments("/api/pdf/upload") || path.StartsWithSegments("/api/pages/new") ||
                 path.StartsWithSegments("/api/pages/rearrange")))
        return "upload";
    if (post && (path.StartsWithSegments("/api/tools") || path.StartsWithSegments("/api/pages/extract")))
        return "tool";
    return "api";
}

/// <summary>HTTPS outside Development: redirect HTTP requests and send HSTS. Set Redirect to false only on a trusted
/// internal network without a certificate.</summary>
internal sealed class HttpsOptions
{
    public bool Redirect { get; set; } = true;
    public int Port { get; set; } = 443;
    public int HstsDays { get; set; } = 30;
}

/// <summary>Requests allowed per client address and minute.</summary>
internal sealed class RateLimitOptions
{
    public bool Enabled { get; set; } = true;
    public int RequestsPerMinute { get; set; } = 1200;   // pdf.js reads large files in many range requests
    public int UploadsPerMinute { get; set; } = 30;
    public int ToolsPerMinute { get; set; } = 20;
}
