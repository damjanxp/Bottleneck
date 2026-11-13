using Bottleneck.Api.Options;
using Microsoft.Extensions.Options;
using SkiaSharp;

namespace Bottleneck.Api.Features.Uploads;

public sealed record ProcessedImage(byte[] Bytes, ImageHeader Header);

/// <summary>
/// Decodes and re-encodes an image so only pixels survive: EXIF (GPS, camera), XMP, ICC and text chunks
/// are dropped, and any trailing or polyglot content is gone. Called only after
/// <see cref="ImageInspector"/> has checked the type and the pixel size.
///
/// Library: SkiaSharp (MIT). The spec names ImageSharp; ImageSharp 3.2+ and 4.x check for a Six Labors
/// licence key at build time, and the last version without that check (3.1.12) has known high-severity
/// advisories, so the review-D5 fallback is used.
/// </summary>
public sealed class ImageProcessor(IOptions<UploadOptions> options) : IDisposable
{
    private readonly SemaphoreSlim _decodes = new(Math.Max(1, options.Value.MaxConcurrentDecodes));

    public void Dispose() => _decodes.Dispose();

    /// <summary>Returns null if the bytes do not decode as the format the header claimed, at the size it claimed.</summary>
    public async Task<ProcessedImage?> ReencodeAsync(byte[] data, ImageHeader header, CancellationToken ct)
    {
        await _decodes.WaitAsync(ct);
        try
        {
            return Reencode(data, header, options.Value.JpegQuality);
        }
        finally
        {
            _decodes.Release();
        }
    }

    private static ProcessedImage? Reencode(byte[] data, ImageHeader header, int jpegQuality)
    {
        using var skData = SKData.CreateCopy(data);
        using var codec = SKCodec.Create(skData);
        if (codec is null) return null;
        var expected = header.Format == ImageFormat.Png ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg;
        if (codec.EncodedFormat != expected || codec.Info.Width != header.Width || codec.Info.Height != header.Height) return null;
        if (codec.FrameCount > 1) return null; // animated PNG: not a map image

        var alpha = header.Format == ImageFormat.Png ? SKAlphaType.Unpremul : SKAlphaType.Opaque;
        var info = new SKImageInfo(header.Width, header.Height, SKColorType.Rgba8888, alpha);
        using var decoded = new SKBitmap(info);
        var result = codec.GetPixels(info, decoded.GetPixels());
        if (result is not (SKCodecResult.Success or SKCodecResult.IncompleteInput)) return null;
        if (result == SKCodecResult.IncompleteInput) return null; // truncated files are rejected, not half-shown

        using var upright = ApplyOrigin(decoded, codec.EncodedOrigin);
        using var image = SKImage.FromBitmap(upright);
        using var encoded = header.Format == ImageFormat.Png
            ? image.Encode(SKEncodedImageFormat.Png, 100)
            : image.Encode(SKEncodedImageFormat.Jpeg, jpegQuality);
        if (encoded is null) return null;
        return new ProcessedImage(encoded.ToArray(), header with { Width = upright.Width, Height = upright.Height });
    }

    /// <summary>
    /// EXIF orientation is metadata, which is stripped, so it is applied to the pixels first;
    /// otherwise a phone photo would turn sideways.
    /// </summary>
    private static SKBitmap ApplyOrigin(SKBitmap src, SKEncodedOrigin origin)
    {
        if (origin is SKEncodedOrigin.TopLeft) return src.Copy();
        float w = src.Width, h = src.Height;
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        // x' = ScaleX·x + SkewX·y + TransX, y' = SkewY·x + ScaleY·y + TransY
        var m = origin switch
        {
            SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
            SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1),
            SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),
            _ => SKMatrix.Identity,
        };
        var dst = new SKBitmap(new SKImageInfo(swap ? src.Height : src.Width, swap ? src.Width : src.Height, src.ColorType, src.AlphaType));
        using var canvas = new SKCanvas(dst);
        canvas.SetMatrix(m);
        using var image = SKImage.FromBitmap(src);
        canvas.DrawImage(image, 0, 0, new SKSamplingOptions(SKFilterMode.Nearest));
        return dst;
    }
}
