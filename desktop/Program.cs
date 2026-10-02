using Photino.NET;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop;

/// <summary>
/// Desktop PDF viewer: the shared AngularJS UI in a native window (Photino), with pages rendered
/// by PDFium straight from disk, so large PDFs open without being uploaded or copied.
///
/// Usage: PdfViewer.Desktop [file.pdf]
/// Test mode (no window, fixed port, extra test endpoint): set PDFVIEWER_TEST_PORT.
/// </summary>
public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        var testPort = Environment.GetEnvironmentVariable("PDFVIEWER_TEST_PORT");
        var app = BuildServer(testPort);

        if (testPort is not null)
        {
            // Sends one UI message to the host; dialog answers come from the request.
            app.MapPost("/api/test/message", async (TestMessage request, DesktopBridge bridge) =>
                Results.Ok(await bridge.HandleForTestAsync(request.Message,
                    new PresetFileDialogs(request.Files, request.Save, request.Folder))));
            app.Run();
            return;
        }

        LinuxEnvironment.RestoreSnapOverrides();
        app.StartAsync().GetAwaiter().GetResult();
        var url = app.Urls.First();

        var pdfium = app.Services.GetRequiredService<PdfiumService>();
        _ = Task.Run(pdfium.WarmUp);

        var window = new PhotinoWindow()
            .SetTitle("PDF Viewer")
            .SetUseOsDefaultSize(false)
            .SetSize(1280, 860)
            .SetMinSize(640, 480)
            .Center()
            .SetResizable(true)
            .SetContextMenuEnabled(false)
            .SetDevToolsEnabled(app.Environment.IsDevelopment());

        var startupFile = args.FirstOrDefault(a => !a.StartsWith('-') && File.Exists(a));
        app.Services.GetRequiredService<DesktopBridge>().Attach(window, startupFile);

        window.Load(url);
        window.WaitForClose();

        app.StopAsync().GetAwaiter().GetResult();
        pdfium.Dispose();
    }

    private static WebApplication BuildServer(string? testPort)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            ContentRootPath = AppContext.BaseDirectory,
            WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
        });

        // Only reachable from this computer; a random free port unless testing.
        builder.WebHost.UseUrls($"http://127.0.0.1:{testPort ?? "0"}");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);

        builder.Services.AddSingleton<PdfiumService>();
        builder.Services.AddSingleton<DesktopBridge>();
        builder.Services.AddSingleton<DesktopTools>();
        builder.Services.AddControllers();

        var app = builder.Build();

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
        app.UseStaticFiles();
        app.MapControllers();
        return app;
    }

    private record TestMessage(string Message, string[]? Files, string? Save, string? Folder);
}
