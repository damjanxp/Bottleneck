using Microsoft.AspNetCore.Http.Features;
using Microsoft.Net.Http.Headers;

namespace Bottleneck.Api.Infrastructure;

/// <summary>Reads a request body with a hard byte cap, before anything parses it.</summary>
public static class RequestBody
{
    public sealed record Result(byte[]? Bytes, IResult? Error);

    public static async Task<Result> ReadAsync(HttpRequest request, int maxBytes, CancellationToken ct)
    {
        if (request.ContentLength > maxBytes)
            return new(null, Problems.TooLarge($"The body is larger than {maxBytes} bytes."));

        // Also lower the server's own limit, so Kestrel stops reading early on chunked bodies.
        var sizeFeature = request.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = maxBytes + 1L;

        using var buffer = new MemoryStream(capacity: (int)Math.Min(request.ContentLength ?? 16 * 1024, maxBytes));
        var chunk = new byte[16 * 1024];
        try
        {
            while (true)
            {
                var read = await request.Body.ReadAsync(chunk, ct);
                if (read == 0) break;
                if (buffer.Length + read > maxBytes)
                    return new(null, Problems.TooLarge($"The body is larger than {maxBytes} bytes."));
                buffer.Write(chunk, 0, read);
            }
        }
        catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return new(null, Problems.TooLarge($"The body is larger than {maxBytes} bytes."));
        }
        return new(buffer.ToArray(), null);
    }

    /// <summary>True if the request declares a JSON body (application/json or application/*+json).</summary>
    public static bool IsJson(HttpRequest request)
    {
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var mt)) return false;
        var type = mt.MediaType.Value ?? "";
        return type.Equals("application/json", StringComparison.OrdinalIgnoreCase)
            || (type.StartsWith("application/", StringComparison.OrdinalIgnoreCase) && type.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>Strong ETags made from the row's revision number.</summary>
public static class ETags
{
    public static string For(long revision) => $"\"{revision}\"";

    /// <summary>Parses If-Match. Returns false if the header is absent; revision is null if it is present but not one of ours.</summary>
    public static bool TryReadIfMatch(HttpRequest request, out long? revision)
    {
        revision = null;
        var raw = request.Headers.IfMatch.ToString();
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var value = raw.Trim();
        if (value.StartsWith("W/", StringComparison.Ordinal)) value = value[2..];
        if (value.Length >= 3 && value[0] == '"' && value[^1] == '"'
            && long.TryParse(value.AsSpan(1, value.Length - 2), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var r))
            revision = r;
        return true;
    }
}
