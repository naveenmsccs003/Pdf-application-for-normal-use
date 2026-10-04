using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using PDFiumCore;

namespace PdfViewer.Tools;

/// <summary>
/// One digital signature and the result of checking it:
///   - Intact: the signed bytes still match the signature (nothing in them was changed);
///   - CoversWholeFile: the signature covers the whole file. If not, the file was extended after signing (a later
///     revision, a second signature, or edits): the signed revision is still intact, but later changes are not signed;
///   - Trusted: the signer's certificate chains to a root this computer trusts (a self-signed certificate does not).
/// </summary>
public sealed record SignatureCheck(
    int Number, string Status, string Summary, string? Signer, string? Issuer, string? Email, DateTimeOffset? SignedAt,
    string? Reason, string? Location, string? Format, bool Intact, bool CoversWholeFile, bool Trusted, string? TrustProblem,
    DateTimeOffset? CertificateValidFrom, DateTimeOffset? CertificateValidTo, string? Detail);

public static class PdfSignatures
{
    private const long MaxSignedBytes = 1L << 30;   // signed ranges are read into memory to check them

    /// <summary>Checks every signature in the PDF (none: an empty list).</summary>
    public static IReadOnlyList<SignatureCheck> Verify(string path, string? password = null)
    {
        var raw = new List<(byte[] Contents, int[] Ranges, string? SubFilter, string? Reason, string? Time)>();
        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = Pdfium.OpenDocument(path, password);
            try
            {
                var count = fpdf_signature.FPDF_GetSignatureCount(document);
                for (var i = 0; i < count; i++)
                {
                    var signature = fpdf_signature.FPDF_GetSignatureObject(document, i);
                    if (signature == null) continue;
                    raw.Add((Contents(signature), ByteRange(signature), SubFilter(signature), Reason(signature), Time(signature)));
                }
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }

        var fileLength = new FileInfo(path).Length;
        return raw.Select((r, i) => Check(i + 1, path, fileLength, r.Contents, r.Ranges, r.SubFilter, r.Reason, r.Time)).ToList();
    }

    private static SignatureCheck Check(int number, string path, long fileLength, byte[] contents, int[] ranges,
        string? subFilter, string? reason, string? pdfTime)
    {
        SignatureCheck Broken(string detail) => new(number, "invalid", "The signature is damaged and cannot be checked.", null, null, null,
            ParsePdfDate(pdfTime), reason, null, subFilter, false, false, false, null, null, null, detail);

        if (contents.Length == 0 || ranges.Length < 4 || ranges.Length % 2 != 0)
            return Broken("The signature has no contents or byte range.");
        var spans = new List<(long Start, long Length)>();
        long total = 0, end = 0;
        for (var k = 0; k < ranges.Length; k += 2)
        {
            long start = (uint)ranges[k], length = (uint)ranges[k + 1];
            if (start + length > fileLength) return Broken("The byte range goes past the end of the file.");
            spans.Add((start, length));
            total += length;
            end = Math.Max(end, start + length);
        }
        if (total > MaxSignedBytes)
            return Broken("The signed part is larger than 1 GB, too large to check here.");

        var signed = new byte[total];
        using (var file = File.OpenRead(path))
        {
            var at = 0;
            foreach (var (start, length) in spans)
            {
                file.Position = start;
                file.ReadExactly(signed, at, (int)length);
                at += (int)length;
            }
        }

        var cms = new SignedCms();
        var sha1Embedded = string.Equals(subFilter, "adbe.pkcs7.sha1", StringComparison.Ordinal);
        try
        {
            if (sha1Embedded)
            {
                // Older format: the CMS signs the SHA-1 digest of the signed bytes, which it contains.
                cms.Decode(Trim(contents));
            }
            else
            {
                cms = new SignedCms(new ContentInfo(signed), detached: true);
                cms.Decode(Trim(contents));
            }
        }
        catch (CryptographicException ex)
        {
            return Broken("The signature data could not be read: " + ex.Message);
        }
        if (cms.SignerInfos.Count == 0)
            return Broken("The signature has no signer.");

        var signerInfo = cms.SignerInfos[0];
        var certificate = signerInfo.Certificate;
        var intact = true;
        string? detail = null;
        try
        {
            if (sha1Embedded && !SHA1.HashData(signed).AsSpan().SequenceEqual(cms.ContentInfo.Content))
                throw new CryptographicException("The digest does not match the document.");
            signerInfo.CheckSignature(verifySignatureOnly: true);
        }
        catch (CryptographicException ex)
        {
            intact = false;
            detail = ex.Message;
        }

        var (trusted, trustProblem) = certificate is null ? (false, "The signature has no certificate.") : CheckTrust(certificate, cms.Certificates);
        var coversWholeFile = end == fileLength;
        var signedAt = SigningTime(signerInfo) ?? ParsePdfDate(pdfTime);
        var signer = certificate?.GetNameInfo(X509NameType.SimpleName, false);
        var status = !intact ? "invalid" : trusted && coversWholeFile ? "valid" : "warning";
        var summary = !intact
            ? "Invalid: the document was changed after it was signed, or the signature is damaged."
            : (coversWholeFile ? "The document has not been changed since it was signed." : "The signed revision is intact, but the document was changed or added to after this signature.")
              + (trusted ? " The signer's certificate is trusted." : " The signer's identity is not verified: " + trustProblem);

        return new SignatureCheck(number, status, summary, signer, certificate?.GetNameInfo(X509NameType.SimpleName, true),
            certificate?.GetNameInfo(X509NameType.EmailName, false) is { Length: > 0 } email ? email : null,
            signedAt, reason, null, subFilter, intact, coversWholeFile, trusted, trusted ? null : trustProblem,
            certificate?.NotBefore, certificate?.NotAfter, detail);
    }

    private static (bool Trusted, string? Problem) CheckTrust(X509Certificate2 certificate, X509Certificate2Collection extra)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;    // offline: no revocation lookups
        chain.ChainPolicy.VerificationFlags = X509VerificationFlags.IgnoreNotTimeValid;   // judged at signing time, not now
        chain.ChainPolicy.ExtraStore.AddRange(extra);
        if (chain.Build(certificate)) return (true, null);
        var flags = chain.ChainStatus.Select(s => s.Status).Aggregate(X509ChainStatusFlags.NoError, (a, b) => a | b);
        if (flags.HasFlag(X509ChainStatusFlags.UntrustedRoot))
            return (false, certificate.SubjectName.RawData.AsSpan().SequenceEqual(certificate.IssuerName.RawData)
                ? "the certificate is self-signed." : "the certificate's issuer is not trusted on this computer.");
        if (flags.HasFlag(X509ChainStatusFlags.PartialChain))
            return (false, "the certificate's issuer is unknown on this computer.");
        if (flags.HasFlag(X509ChainStatusFlags.NotValidForUsage))
            return (false, "the certificate is not meant for signing.");
        return (false, "the certificate could not be verified (" + flags + ").");
    }

    private static DateTimeOffset? SigningTime(SignerInfo signer)
    {
        foreach (var attribute in signer.SignedAttributes)
            foreach (var value in attribute.Values)
                if (value is Pkcs9SigningTime time)
                    return new DateTimeOffset(time.SigningTime.ToUniversalTime(), TimeSpan.Zero);
        return null;
    }

    /// <summary>A PDF date (D:YYYYMMDDHHmmSS+HH'mm'), or null.</summary>
    public static DateTimeOffset? ParsePdfDate(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var s = text.StartsWith("D:", StringComparison.Ordinal) ? text[2..] : text;
        if (s.Length < 4 || !int.TryParse(s[..4], out var year)) return null;
        int Part(int at, int fallback) => s.Length >= at + 2 && int.TryParse(s.AsSpan(at, 2), out var v) ? v : fallback;
        var offset = TimeSpan.Zero;
        if (s.Length > 14 && (s[14] == '+' || s[14] == '-'))
        {
            var sign = s[14] == '-' ? -1 : 1;
            var rest = s[15..].Replace("'", "");
            int.TryParse(rest.Length >= 2 ? rest[..2] : "0", out var hours);
            int.TryParse(rest.Length >= 4 ? rest.Substring(2, 2) : "0", out var minutes);
            offset = sign * new TimeSpan(hours, minutes, 0);
        }
        try
        {
            return new DateTimeOffset(year, Part(4, 1), Part(6, 1), Part(8, 0), Part(10, 0), Part(12, 0), offset);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    // The /Contents hex string is padded with zeros after the DER data; the DER length says where it ends.
    private static byte[] Trim(byte[] der)
    {
        if (der.Length < 2 || der[0] != 0x30) return der;
        int length, header;
        if (der[1] < 0x80) { length = der[1]; header = 2; }
        else
        {
            var bytes = der[1] & 0x7f;
            if (bytes is 0 or > 4 || der.Length < 2 + bytes) return der;
            length = 0;
            for (var k = 0; k < bytes; k++) length = (length << 8) | der[2 + k];
            header = 2 + bytes;
        }
        return header + length <= der.Length ? der[..(header + length)] : der;
    }

    // ----- PDFium signature fields -----
    private static byte[] Contents(FpdfSignatureT signature)
    {
        var length = (int)fpdf_signature.FPDFSignatureObjGetContents(signature, IntPtr.Zero, 0);
        if (length <= 0) return [];
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            fpdf_signature.FPDFSignatureObjGetContents(signature, buffer, (ulong)length);
            var bytes = new byte[length];
            Marshal.Copy(buffer, bytes, 0, length);
            return bytes;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int[] ByteRange(FpdfSignatureT signature)
    {
        var count = (int)fpdf_signature.FPDFSignatureObjGetByteRange(signature, ref System.Runtime.CompilerServices.Unsafe.NullRef<int>(), 0);
        if (count <= 0) return [];
        var values = new int[count];
        fpdf_signature.FPDFSignatureObjGetByteRange(signature, ref values[0], (ulong)count);
        return values;
    }

    private static unsafe string? SubFilter(FpdfSignatureT signature) =>
        AsciiField(length => (int)fpdf_signature.FPDFSignatureObjGetSubFilter(signature, null, 0),
                   (buffer, length) => fpdf_signature.FPDFSignatureObjGetSubFilter(signature, (sbyte*)buffer, (ulong)length));

    private static unsafe string? Time(FpdfSignatureT signature) =>
        AsciiField(length => (int)fpdf_signature.FPDFSignatureObjGetTime(signature, null, 0),
                   (buffer, length) => fpdf_signature.FPDFSignatureObjGetTime(signature, (sbyte*)buffer, (ulong)length));

    private static string? Reason(FpdfSignatureT signature)
    {
        var length = (int)fpdf_signature.FPDFSignatureObjGetReason(signature, IntPtr.Zero, 0);
        if (length <= 2) return null;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            fpdf_signature.FPDFSignatureObjGetReason(signature, buffer, (ulong)length);
            return Marshal.PtrToStringUni(buffer, length / 2 - 1);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string? AsciiField(Func<int, int> size, Action<IntPtr, int> read)
    {
        var length = size(0);
        if (length <= 1) return null;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            read(buffer, length);
            return Marshal.PtrToStringAnsi(buffer, length - 1);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
