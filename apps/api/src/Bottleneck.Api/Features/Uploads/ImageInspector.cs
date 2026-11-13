using System.Buffers.Binary;

namespace Bottleneck.Api.Features.Uploads;

public enum ImageFormat
{
    Png,
    Jpeg,
}

public sealed record ImageHeader(ImageFormat Format, int Width, int Height)
{
    public string ContentType => Format == ImageFormat.Png ? "image/png" : "image/jpeg";
    public string Extension => Format == ImageFormat.Png ? ".png" : ".jpg";
}

/// <summary>
/// Reads the file type from magic bytes and the pixel size from the header, without decoding anything
/// (spec section 8 and review D5: the pixel cap is checked before a decoder allocates a bitmap).
/// The declared Content-Type and file name are ignored.
/// </summary>
public static class ImageInspector
{
    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>The format from the magic bytes, or null if it is neither PNG nor JPEG.</summary>
    public static ImageFormat? DetectFormat(ReadOnlySpan<byte> data)
    {
        if (data.Length >= 8 && data[..8].SequenceEqual(PngSignature)) return ImageFormat.Png;
        if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) return ImageFormat.Jpeg;
        return null;
    }

    /// <summary>Format and size from the header, or null if the header is malformed.</summary>
    public static ImageHeader? ReadHeader(ReadOnlySpan<byte> data) => DetectFormat(data) switch
    {
        ImageFormat.Png => ReadPng(data),
        ImageFormat.Jpeg => ReadJpeg(data),
        _ => null,
    };

    private static ImageHeader? ReadPng(ReadOnlySpan<byte> data)
    {
        // Signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4). IHDR must come first.
        if (data.Length < 24) return null;
        if (BinaryPrimitives.ReadUInt32BigEndian(data[8..]) != 13) return null;
        if (!data[12..16].SequenceEqual("IHDR"u8)) return null;
        var w = BinaryPrimitives.ReadUInt32BigEndian(data[16..]);
        var h = BinaryPrimitives.ReadUInt32BigEndian(data[20..]);
        return w is 0 or > int.MaxValue || h is 0 or > int.MaxValue ? null : new ImageHeader(ImageFormat.Png, (int)w, (int)h);
    }

    private static ImageHeader? ReadJpeg(ReadOnlySpan<byte> data)
    {
        // Walk the marker segments after SOI until a start-of-frame marker, which holds the size.
        var i = 2;
        while (i + 4 <= data.Length)
        {
            if (data[i] != 0xFF) return null;
            var marker = data[i + 1];
            if (marker == 0xFF) { i++; continue; } // fill byte
            i += 2;
            if (marker is 0x01 or (>= 0xD0 and <= 0xD7)) continue; // stand-alone markers
            if (marker is 0xD9 or 0xDA) return null; // end of image or start of scan before any frame header
            if (i + 2 > data.Length) return null;
            int length = BinaryPrimitives.ReadUInt16BigEndian(data[i..]);
            if (length < 2 || i + length > data.Length) return null;
            var isFrame = marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC);
            if (isFrame)
            {
                // length (2), precision (1), height (2), width (2)
                if (length < 7) return null;
                int h = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 3)..]);
                int w = BinaryPrimitives.ReadUInt16BigEndian(data[(i + 5)..]);
                return w == 0 || h == 0 ? null : new ImageHeader(ImageFormat.Jpeg, w, h);
            }
            i += length;
        }
        return null;
    }
}
