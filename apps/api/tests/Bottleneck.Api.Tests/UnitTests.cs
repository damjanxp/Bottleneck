using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Bottleneck.Api.Features.Uploads;
using Bottleneck.Api.Security;
using SkiaSharp;

namespace Bottleneck.Api.Tests;

public sealed class SecretsTests
{
    [Fact]
    public void Ids_are_128_bit_base32_and_match_the_schema_id_pattern()
    {
        var ids = Enumerable.Range(0, 200).Select(_ => Secrets.NewId()).ToList();
        Assert.All(ids, id => Assert.Matches(Secrets.IdPattern, id));
        Assert.All(ids, id => Assert.Matches("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", id));
        Assert.Equal(ids.Count, ids.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Edit_key_is_256_bits_and_only_its_hash_is_kept()
    {
        var (key, hash) = Secrets.NewEditKey();
        Assert.Equal(43, key.Length);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", key);
        Assert.Equal(32, hash.Length);
        Assert.True(Secrets.EditKeyMatches(key, hash));
        Assert.Equal(hash, SHA256.HashData(System.Buffers.Text.Base64Url.DecodeFromChars(key)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not base64 !")]
    [InlineData("AAAA")]
    public void Malformed_keys_never_match(string? presented)
    {
        var (_, hash) = Secrets.NewEditKey();
        Assert.False(Secrets.EditKeyMatches(presented, hash));
    }

    [Fact]
    public void Another_key_does_not_match()
    {
        var (_, hash) = Secrets.NewEditKey();
        var (other, _) = Secrets.NewEditKey();
        Assert.False(Secrets.EditKeyMatches(other, hash));
    }

    [Fact]
    public void Read_tokens_compare_exactly()
    {
        var token = Secrets.NewToken();
        Assert.True(Secrets.ReadTokenMatches(token, token));
        Assert.False(Secrets.ReadTokenMatches(token[..^1], token));
        Assert.False(Secrets.ReadTokenMatches(null, token));
    }

    [Fact]
    public void Comparisons_use_FixedTimeEquals()
    {
        // Guard against a refactor back to == or SequenceEqual on secrets.
        var source = File.ReadAllText(Path.Combine(TestPaths.ApiSource, "Security", "Secrets.cs"));
        Assert.Equal(2, Regex.Matches(source, @"CryptographicOperations\.FixedTimeEquals").Count);
        Assert.DoesNotContain("SequenceEqual", source, StringComparison.Ordinal);
    }
}

public static class TestPaths
{
    public static string RepoRoot { get; } = Find(AppContext.BaseDirectory);
    public static string ApiSource => Path.Combine(RepoRoot, "apps", "api", "src", "Bottleneck.Api");

    private static string Find(string start)
    {
        for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "schema", "common.schema.json"))) return d.FullName;
        throw new InvalidOperationException("Repository root not found.");
    }
}

/// <summary>Test images, made with SkiaSharp or by hand.</summary>
public static class Images
{
    public static byte[] Png(int width = 64, int height = 32) => Encode(width, height, SKEncodedImageFormat.Png);

    public static byte[] Jpeg(int width = 64, int height = 32) => Encode(width, height, SKEncodedImageFormat.Jpeg);

    private static byte[] Encode(int width, int height, SKEncodedImageFormat format)
    {
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap)) canvas.Clear(new SKColor(30, 120, 200));
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(format, 90);
        return data.ToArray();
    }

    /// <summary>A PNG signature and IHDR that claim the given size, followed by junk that would not decode.</summary>
    public static byte[] PngHeaderOnly(int width, int height, int junkBytes = 1024)
    {
        var bytes = new byte[33 + junkBytes];
        byte[] sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        sig.CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(8), 13);
        "IHDR"u8.CopyTo(bytes.AsSpan(12));
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(16), (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(20), (uint)height);
        bytes[24] = 8; // bit depth
        bytes[25] = 6; // RGBA
        for (var i = 33; i < bytes.Length; i++) bytes[i] = 0xAB;
        return bytes;
    }

    /// <summary>Inserts an EXIF APP1 segment (with a recognisable marker string) right after the JPEG SOI.</summary>
    public static byte[] WithExif(byte[] jpeg, string marker)
    {
        var payload = System.Text.Encoding.ASCII.GetBytes("Exif\0\0" + marker);
        var segment = new byte[4 + payload.Length];
        segment[0] = 0xFF;
        segment[1] = 0xE1;
        BinaryPrimitives.WriteUInt16BigEndian(segment.AsSpan(2), (ushort)(payload.Length + 2));
        payload.CopyTo(segment, 4);
        return [.. jpeg.AsSpan(0, 2), .. segment, .. jpeg.AsSpan(2)];
    }
}

public sealed class ImageInspectorTests
{
    [Fact]
    public void Reads_png_size_from_the_header()
    {
        var h = ImageInspector.ReadHeader(Images.Png(123, 45));
        Assert.Equal(new ImageHeader(ImageFormat.Png, 123, 45), h);
    }

    [Fact]
    public void Reads_jpeg_size_from_the_frame_header_even_after_other_segments()
    {
        var h = ImageInspector.ReadHeader(Images.WithExif(Images.Jpeg(200, 100), "hello"));
        Assert.Equal(new ImageHeader(ImageFormat.Jpeg, 200, 100), h);
    }

    [Fact]
    public void Claimed_size_is_read_without_decoding()
    {
        Assert.Equal(new ImageHeader(ImageFormat.Png, 5000, 10), ImageInspector.ReadHeader(Images.PngHeaderOnly(5000, 10)));
    }

    [Theory]
    [InlineData("GIF89a......")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")]
    [InlineData("BM......")]
    public void Other_formats_are_not_detected(string content)
    {
        Assert.Null(ImageInspector.DetectFormat(System.Text.Encoding.ASCII.GetBytes(content)));
    }

    [Fact]
    public void Truncated_headers_are_rejected()
    {
        Assert.Null(ImageInspector.ReadHeader(Images.Png().AsSpan(0, 20)));
        Assert.Null(ImageInspector.ReadHeader([0xFF, 0xD8, 0xFF, 0xE0, 0x00]));
    }
}
