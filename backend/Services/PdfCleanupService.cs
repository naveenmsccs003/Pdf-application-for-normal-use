namespace PdfViewer.Api.Services;

/// <summary>Deletes expired uploads on startup and then periodically, even when nobody uploads.</summary>
public class PdfCleanupService(PdfService pdfService) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            pdfService.DeleteExpiredFiles();
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
