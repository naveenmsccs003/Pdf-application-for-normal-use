using System.Text.Json;
using Photino.NET;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop;

/// <summary>
/// Messages between the web UI and the desktop host (Photino web messaging).
///   UI -> host: { type: "ready" } | { type: "open" } | { type: "close" }
///               | { type: "pick-pdfs" } | { type: "run-tool", tool, inputs, options }
///   host -> UI: { type: "opening", fileName } | { type: "opened", token, fileName, size, pageCount }
///             | { type: "open-error", message } | { type: "open-cancelled" }
///             | { type: "picked-pdfs", files } | { type: "tool-done" | "tool-error", message } | { type: "tool-cancelled" }
/// </summary>
public class DesktopBridge(PdfiumService pdfium, DesktopTools tools, ILogger<DesktopBridge> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly (string, string[])[] PdfFilter = [("PDF files", ["*.pdf"]), ("All files", ["*"])];

    private Action<string>? _send;
    private string? _startupFile;

    // Test mode: replies go to the collector of the request being handled. AsyncLocal keeps
    // overlapping test requests (e.g. "ready" and "open") from receiving each other's replies.
    private readonly AsyncLocal<List<JsonElement>?> _testReplies = new();

    public void Attach(PhotinoWindow window, string? startupFile)
    {
        _startupFile = startupFile;
        _send = message => window.SendWebMessage(message);
        var dialogs = new PhotinoFileDialogs(window);
        // Runs on the UI thread up to the first await, so dialogs open on the right thread.
        window.RegisterWebMessageReceivedHandler((_, message) => _ = HandleAsync(dialogs, message));
    }

    /// <summary>Test mode: handles one message with preset dialog answers and returns the replies.</summary>
    public async Task<List<JsonElement>> HandleForTestAsync(string message, IFileDialogs dialogs)
    {
        var replies = new List<JsonElement>();
        _testReplies.Value = replies;
        await HandleAsync(dialogs, message);
        return replies;
    }

    private async Task HandleAsync(IFileDialogs dialogs, string message)
    {
        JsonElement root;
        string? type;
        try
        {
            root = JsonDocument.Parse(message).RootElement;
            type = root.GetProperty("type").GetString();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            logger.LogWarning("Ignoring malformed web message");
            return;
        }

        switch (type)
        {
            case "ready" when _startupFile is not null:
                var file = _startupFile;
                _startupFile = null;
                await OpenAsync(file);
                break;

            case "open":
                var paths = dialogs.OpenFiles("Open PDF", false, PdfFilter);
                if (paths is { Length: > 0 } && !string.IsNullOrEmpty(paths[0]))
                    await OpenAsync(paths[0]);
                else
                    Send(new { type = "open-cancelled" });
                break;

            case "close":
                pdfium.Close();
                break;

            case "pick-pdfs":
                Send(tools.PickPdfs(dialogs));
                break;

            case "run-tool":
                Send(await tools.RunAsync(dialogs, root));
                break;
        }
    }

    private async Task OpenAsync(string path)
    {
        Send(new { type = "opening", fileName = Path.GetFileName(path) });
        try
        {
            // Large files can take a moment; keep the UI thread free.
            var info = await Task.Run(() => pdfium.Open(path));
            Send(new { type = "opened", info.Token, info.FileName, info.Size, info.PageCount });
        }
        catch (LocalPdfException ex)
        {
            Send(new { type = "open-error", message = ex.Message });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to open {Path}", path);
            Send(new { type = "open-error", message = "Unable to open this PDF." });
        }
    }

    private void Send(object message)
    {
        var json = JsonSerializer.Serialize(message, Json);
        if (_testReplies.Value is { } replies)
        {
            lock (replies) replies.Add(JsonSerializer.Deserialize<JsonElement>(json));
            return;
        }
        _send?.Invoke(json);
    }
}
