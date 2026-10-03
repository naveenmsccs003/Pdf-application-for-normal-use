using Microsoft.AspNetCore.Diagnostics;
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

var app = builder.Build();

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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
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
app.MapControllers();

app.Run();
