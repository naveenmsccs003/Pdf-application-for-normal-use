using System.Text.Json;
using Photino.NET;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop;

/// <summary>
/// Messages between the web UI and the desktop host (Photino web messaging).
///   UI -> host: { type: "ready" } | { type: "open" }
///   host -> UI: { type: "opening", fileName } | { type: "opened", token, fileName, size, pageCount }
///             | { type: "open-error", message } | { type: "open-cancelled" }
/// </summary>
public class DesktopBridge(PdfiumService pdfium, ILogger<DesktopBridge> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private Action<string>? _send;
    private string? _startupFile;

    public void Attach(PhotinoWindow window, string? startupFile)
    {
        _startupFile = startupFile;
        _send = message => window.SendWebMessage(message);
        window.RegisterWebMessageReceivedHandler((_, message) => OnMessage(window, message));
    }

    /// <summary>Used by tests (no window): opens a path and returns the messages that would be sent.</summary>
    public async Task<List<object>> OpenForTestAsync(string path)
    {
        var messages = new List<object>();
        _send = json => messages.Add(JsonSerializer.Deserialize<JsonElement>(json));
        await OpenAsync(path);
        return messages;
    }

    private void OnMessage(PhotinoWindow window, string message)
    {
        string? type;
        try
        {
            type = JsonDocument.Parse(message).RootElement.GetProperty("type").GetString();
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
                _ = OpenAsync(file);
                break;

            case "open":
                // Runs on the UI thread, as native dialogs require.
                var paths = window.ShowOpenFile("Open PDF", null, false, [("PDF files", ["*.pdf"]), ("All files", ["*"])]);
                if (paths is { Length: > 0 } && !string.IsNullOrEmpty(paths[0]))
                    _ = OpenAsync(paths[0]);
                else
                    Send(new { type = "open-cancelled" });
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

    private void Send(object message) => _send?.Invoke(JsonSerializer.Serialize(message, Json));
}
