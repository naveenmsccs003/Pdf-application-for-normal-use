using System.Runtime.InteropServices;
using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>An error whose message is safe to show to the user.</summary>
public class ToolException(string message) : Exception(message);

/// <summary>
/// Process-wide PDFium access. PDFium is not thread-safe, so every caller (viewer and tools)
/// must hold <see cref="Lock"/> while using it.
/// </summary>
public static class Pdfium
{
    public static readonly object Lock = new();
    private static bool _initialized;

    public static void EnsureInitialized()
    {
        lock (Lock)
        {
            if (_initialized) return;
            fpdfview.FPDF_InitLibrary();
            _initialized = true;
        }
    }

    /// <summary>Opens a document, with its password if it has one; caller holds the lock. Throws <see cref="ToolException"/>.</summary>
    public static FpdfDocumentT OpenDocument(string path, string? password = null)
    {
        var document = fpdfview.FPDF_LoadDocument(path, string.IsNullOrEmpty(password) ? null : password);
        if (document != null) return document;
        var code = fpdfview.FPDF_GetLastError();
        throw new ToolException(code == PasswordError && !string.IsNullOrEmpty(password) ? "The password is not correct." : ErrorMessage(code));
    }

    /// <summary>Whether the document is encrypted (has a password or permissions). Throws <see cref="ToolException"/>.</summary>
    public static bool IsEncrypted(string path, string? password)
    {
        EnsureInitialized();
        lock (Lock)
        {
            var document = OpenDocument(path, password);
            try
            {
                return fpdfview.FPDF_GetSecurityHandlerRevision(document) != -1;
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    /// <summary>FPDF_GetLastError: the document needs a password (or the one given is wrong).</summary>
    public const ulong PasswordError = 4;

    public static string ErrorMessage(ulong code) => code switch
    {
        2 => "The selected file could not be opened.",
        3 => "The selected file is not a valid PDF.",
        4 => "This PDF is password-protected and cannot be opened.",
        5 => "This PDF uses a security handler that is not supported.",
        _ => "Unable to open this PDF."
    };

    /// <summary>Writes a document to a stream; caller holds the lock.</summary>
    public static void Save(FpdfDocumentT document, Stream output)
    {
        Exception? writeError = null;
        var buffer = Array.Empty<byte>();

        // PDFium calls back with chunks of the file; return 1 for success.
        PDFiumCore.Delegates.Func_int___IntPtr___IntPtr_ulong writeBlock = (_, data, size) =>
            {
                try
                {
                    var length = checked((int)size);
                    if (buffer.Length < length) buffer = new byte[length];
                    Marshal.Copy(data, buffer, 0, length);
                    output.Write(buffer, 0, length);
                    return 1;
                }
                catch (Exception ex)
                {
                    writeError = ex;
                    return 0;
                }
            };
        var fileWrite = new FPDF_FILEWRITE_ { Version = 1, WriteBlock = writeBlock };

        var ok = fpdf_save.FPDF_SaveAsCopy(document, fileWrite, 0);
        GC.KeepAlive(writeBlock);   // the native side holds only a function pointer
        GC.KeepAlive(fileWrite);
        if (writeError is IOException)
            throw new ToolException("Could not write the output file. Check that there is enough disk space.");
        if (ok == 0 || writeError is not null)
            throw new ToolException("Could not save the PDF.");
    }
}
