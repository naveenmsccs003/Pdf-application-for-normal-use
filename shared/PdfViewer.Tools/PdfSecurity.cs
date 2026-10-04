using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using PdfSharp.Pdf;
using PdfSharp.Pdf.Annotations;
using PdfSharp.Pdf.IO;
using PdfSharp.Pdf.Signatures;

namespace PdfViewer.Tools;

/// <summary>What a reader of a protected PDF may do without the owner password.</summary>
public sealed record ProtectOptions(
    string? UserPassword, string? OwnerPassword,
    bool AllowPrint = true, bool AllowCopy = true, bool AllowModify = false, bool AllowAnnotate = true,
    bool AllowForms = true, bool AllowAssemble = false);

/// <summary>
/// A digital signature: the reason, location and contact stored in it, and where it is shown: on page
/// <paramref name="Page"/> (1-based; 0 for an invisible signature) in a corner ("bottom-right", "bottom-left",
/// "top-right", "top-left").
/// </summary>
public sealed record SignOptions(string? Reason, string? Location, string? ContactInfo, int Page = 0, string? Corner = "bottom-right");

/// <summary>Who signed, and whether the signature is shown on the page (a visible one needs a font on this computer).</summary>
public sealed record SignResult(string Signer, bool Visible);

/// <summary>
/// Password protection and digital signatures, with PDFsharp (MIT). PDFsharp reads the whole document into memory,
/// so these work on documents up to <see cref="MaxFileBytes"/>.
///   - Protect: AES-256 encryption (PDF 2.0, readable by Acrobat 9 and later and every current viewer) with an open
///     password and / or an owner password that guards the permissions.
///   - Remove password: a copy without encryption (needs the owner password, or the open password when no owner
///     password restricts the document).
///   - Sign: a detached CMS signature (SHA-256, adbe.pkcs7.detached) with the signer's certificate and private key
///     from a .pfx / .p12 file; optionally shown on a page.
/// </summary>
public static class PdfSecurity
{
    public const long MaxFileBytes = 1L << 30;     // 1 GB
    public const int MaxPasswordLength = 127;      // PDF 2.0 limit (UTF-8 bytes)
    public const int MaxCertificateBytes = 1 << 20;
    private const string OwnerRequired = "This PDF's permissions are protected: enter its permissions (owner) password.";

    public static void Protect(string input, string? inputPassword, Stream output, ProtectOptions options)
    {
        var user = options.UserPassword ?? string.Empty;
        var owner = options.OwnerPassword ?? string.Empty;
        if (user.Length == 0 && owner.Length == 0)
            throw new ToolException("Enter a password to open the PDF, a password for its permissions, or both.");
        CheckPassword(user);
        CheckPassword(owner);
        if (owner.Length > 0 && owner == user)
            throw new ToolException("The permissions password must differ from the open password, or the permissions would not protect anything.");

        var document = Load(input, inputPassword);
        var settings = document.SecuritySettings;
        settings.UserPassword = user;
        // Without an owner password anyone could change the permissions: use a random one nobody knows.
        settings.OwnerPassword = owner.Length > 0 ? owner : Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        settings.PermitPrint = options.AllowPrint;
        settings.PermitFullQualityPrint = options.AllowPrint;
        settings.PermitExtractContent = options.AllowCopy;
        settings.PermitModifyDocument = options.AllowModify;
        settings.PermitAnnotations = options.AllowAnnotate;
        settings.PermitFormsFill = options.AllowForms;
        settings.PermitAssembleDocument = options.AllowAssemble;
        document.SecurityHandler.SetEncryptionToV5();
        Save(document, output);
    }

    public static void RemovePassword(string input, string? password, Stream output)
    {
        if (!Pdfium.IsEncrypted(input, password))
            throw new ToolException("This PDF has no password.");
        var document = Load(input, password);
        document.SecurityHandler.SetEncryptionToNoneAndResetPasswords();
        Save(document, output);
    }

    /// <summary>Signs the document with the certificate in a .pfx / .p12 file.</summary>
    public static async Task<SignResult> SignAsync(string input, Stream output, byte[] certificateFile, string? certificatePassword,
        SignOptions options)
    {
        if (certificateFile.Length == 0 || certificateFile.Length > MaxCertificateBytes)
            throw new ToolException("Choose a certificate file (.pfx or .p12).");
        X509Certificate2 certificate;
        try
        {
            certificate = X509CertificateLoader.LoadPkcs12(certificateFile, certificatePassword, X509KeyStorageFlags.EphemeralKeySet);
        }
        catch (CryptographicException)
        {
            throw new ToolException("The certificate could not be opened: check its password, and that it is a .pfx or .p12 file.");
        }

        using (certificate)
        {
            if (!certificate.HasPrivateKey)
                throw new ToolException("This certificate file has no private key, so it cannot sign. Export it with its private key (.pfx).");
            var now = DateTime.Now;
            if (now < certificate.NotBefore || now > certificate.NotAfter)
                throw new ToolException($"This certificate is only valid from {certificate.NotBefore:d} to {certificate.NotAfter:d}.");
            CheckText(options.Reason, "reason");
            CheckText(options.Location, "location");
            CheckText(options.ContactInfo, "contact");
            bool encrypted;
            try { encrypted = Pdfium.IsEncrypted(input, null); }
            catch (ToolException) { encrypted = true; }   // needs a password to open
            if (encrypted)
                throw new ToolException("Remove the password before signing: a password-protected PDF cannot be signed here.");

            var document = Load(input, null);
            if (options.Page < 0 || options.Page > document.PageCount)
                throw new ToolException($"Choose a page between 1 and {document.PageCount}.");

            var signer = certificate.GetNameInfo(X509NameType.SimpleName, false);
            var visible = options.Page > 0 && SystemFonts.Available;
            var signatureOptions = new DigitalSignatureOptions
            {
                Reason = Clean(options.Reason),
                Location = Clean(options.Location),
                ContactInfo = Clean(options.ContactInfo),
                AppName = "PDF Viewer",
                PageIndex = Math.Max(0, options.Page - 1),
                // An empty rectangle makes the signature invisible.
                Rectangle = visible ? Box(document.Pages[options.Page - 1], options.Corner) : new XRect(0, 0, 0, 0),
                AppearanceHandler = visible ? new SignatureAppearance(signer, Clean(options.Reason), Clean(options.Location), DateTimeOffset.Now) : null
            };
            DigitalSignatureHandler.ForDocument(document, new PdfSharpDefaultSigner(certificate, PdfMessageDigestType.SHA256, null), signatureOptions);
            try
            {
                await document.SaveAsync(output);
            }
            catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or CryptographicException)
            {
                throw new ToolException("This PDF could not be signed.");
            }
            return new SignResult(signer, visible);
        }
    }

    private const double BoxWidth = 220, BoxHeight = 64, Margin = 24;

    /// <summary>The signature's box in a corner of the page, in PDF space (the origin is the page's bottom left).</summary>
    private static XRect Box(PdfPage page, string? corner)
    {
        double w = page.Width.Point, h = page.Height.Point;
        var width = Math.Min(BoxWidth, w - 2 * Margin);
        var height = Math.Min(BoxHeight, h - 2 * Margin);
        var right = corner is null or "bottom-right" or "top-right";
        var bottom = corner is null or "bottom-right" or "bottom-left";
        return new XRect(right ? w - Margin - width : Margin, bottom ? Margin : h - Margin - height, width, height);
    }

    private static PdfDocument Load(string path, string? password)
    {
        if (new FileInfo(path).Length > MaxFileBytes)
            throw new ToolException("This PDF is too large for this tool (over 1 GB).");
        try
        {
            return string.IsNullOrEmpty(password)
                ? PdfReader.Open(path, PdfDocumentOpenMode.Modify)
                : PdfReader.Open(path, password, PdfDocumentOpenMode.Modify);
        }
        catch (PdfReaderException ex) when (ex.Message.Contains("owner password", StringComparison.OrdinalIgnoreCase))
        {
            throw new ToolException(OwnerRequired);
        }
        catch (PdfReaderException ex) when (ex.Message.Contains("password", StringComparison.OrdinalIgnoreCase))
        {
            throw new ToolException(string.IsNullOrEmpty(password) ? "This PDF is password-protected: enter its password." : "The password is not correct.");
        }
        catch (Exception ex) when (ex is PdfReaderException or InvalidOperationException or NotSupportedException or FormatException)
        {
            throw new ToolException("This PDF could not be read for this tool (it may be damaged or use features it does not support).");
        }
    }

    private static void Save(PdfDocument document, Stream output)
    {
        try
        {
            document.Save(output);
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            throw new ToolException("This PDF could not be saved with this tool.");
        }
    }

    private static void CheckPassword(string password)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(password) > MaxPasswordLength)
            throw new ToolException($"Passwords can be at most {MaxPasswordLength} characters.");
    }

    private static void CheckText(string? text, string what)
    {
        if (text is { Length: > 200 })
            throw new ToolException($"The {what} can be at most 200 characters.");
    }

    private static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();

    /// <summary>The visible signature: a box with who signed, when, why and where.</summary>
    private sealed class SignatureAppearance(string signer, string? reason, string? location, DateTimeOffset time) : IAnnotationAppearanceHandler
    {
        // Drawn in the signature's own box: (0, 0) is its top left.
        public void DrawAppearance(XGraphics gfx, XRect rect)
        {
            rect = new XRect(0, 0, rect.Width, rect.Height);
            var lines = new List<(string Text, bool Bold)> { ("Digitally signed by " + signer, true), ("Date: " + time.ToString("yyyy-MM-dd HH:mm zzz"), false) };
            if (reason is not null) lines.Add(("Reason: " + reason, false));
            if (location is not null) lines.Add(("Location: " + location, false));
            var size = Math.Clamp((rect.Height - 8) / lines.Count / 1.25, 5, 11);
            gfx.DrawRectangle(new XPen(XColor.FromArgb(26, 95, 180), 0.8), XBrushes.White, new XRect(rect.X + 0.5, rect.Y + 0.5, rect.Width - 1, rect.Height - 1));
            var y = rect.Y + 4 + size;
            foreach (var (text, bold) in lines)
            {
                var font = new XFont(SystemFonts.Family, size, bold ? XFontStyleEx.Bold : XFontStyleEx.Regular);
                gfx.DrawString(Fit(gfx, text, font, rect.Width - 8), font, XBrushes.Black, new XPoint(rect.X + 4, y));
                y += size * 1.25;
            }
        }

        private static string Fit(XGraphics gfx, string text, XFont font, double width)
        {
            if (gfx.MeasureString(text, font).Width <= width) return text;
            while (text.Length > 1 && gfx.MeasureString(text + "…", font).Width > width) text = text[..^1];
            return text + "…";
        }
    }

    /// <summary>
    /// Fonts for drawing visible signatures: PDFsharp has none of its own, so a common sans-serif font of this computer
    /// is used (Arial or Segoe UI on Windows, DejaVu Sans, Liberation Sans or Noto Sans on Linux, Arial on macOS).
    /// </summary>
    private sealed class SystemFonts : IFontResolver
    {
        public const string Family = "SignatureSans";
        private static readonly string[][] Candidates =
        [
            [@"C:\Windows\Fonts\arial.ttf", @"C:\Windows\Fonts\arialbd.ttf"],
            [@"C:\Windows\Fonts\segoeui.ttf", @"C:\Windows\Fonts\segoeuib.ttf"],
            ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
            ["/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
            ["/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"],
            ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"],
            ["/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"],
            ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
            ["/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"]
        ];
        private static readonly Lazy<string[]?> Files = new(() => Candidates.FirstOrDefault(c => File.Exists(c[0])));
        private static readonly Lazy<bool> Registered = new(() =>
        {
            if (Files.Value is null) return false;
            GlobalFontSettings.FallbackFontResolver ??= new SystemFonts();
            return true;
        });

        public static bool Available => Registered.Value;

        public FontResolverInfo? ResolveTypeface(string familyName, bool bold, bool italic)
        {
            var hasBold = Files.Value is { } f && File.Exists(f[1]);
            return new FontResolverInfo(bold && hasBold ? "sig-bold" : "sig-regular", bold && !hasBold, italic);
        }

        public byte[]? GetFont(string faceName)
        {
            var files = Files.Value;
            return files is null ? null : File.ReadAllBytes(faceName == "sig-bold" ? files[1] : files[0]);
        }
    }
}
