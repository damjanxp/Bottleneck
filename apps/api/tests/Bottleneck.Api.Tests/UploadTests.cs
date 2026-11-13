using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Bottleneck.Api.Tests.Infrastructure;
using SkiaSharp;

namespace Bottleneck.Api.Tests;

/// <summary>Uploads (spec section 8, F20, review D5).</summary>
public sealed class UploadTests(DefaultApi api) : IClassFixture<DefaultApi>
{
    private readonly HttpClient _client = api.Factory.CreateClient();

    private static ByteArrayContent Body(byte[] bytes, string contentType = "application/octet-stream")
    {
        var c = new ByteArrayContent(bytes);
        c.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        return c;
    }

    private Task<HttpResponseMessage> Upload(CreatedVenue v, byte[] bytes, string contentType = "application/octet-stream") =>
        _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/uploads", editKey: v.EditKey, content: Body(bytes, contentType)));

    [Fact]
    public async Task A_png_is_stored_and_served_with_fixed_headers()
    {
        var v = await _client.CreateVenueAsync();
        var response = await Upload(v, Images.Png(300, 200));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var u = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("image/png", (string)u["contentType"]!);
        Assert.Equal(300, (int)u["width"]!);
        Assert.Equal(200, (int)u["height"]!);
        var id = (string)u["id"]!;
        Assert.Matches("^[a-z2-7]{26}$", id);

        // Stored under the server-generated name, outside any web root.
        Assert.True(File.Exists(Path.Combine(api.Factory.UploadPath, v.Id, id + ".png")));

        var url = (string)u["url"]!;
        await Http.ProblemAsync(await _client.GetAsync(url), HttpStatusCode.Unauthorized);
        var get = await _client.GetAsync($"{url}?t={v.ReadToken}");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        Assert.Equal("image/png", get.Content.Headers.ContentType!.MediaType);
        Assert.Equal("nosniff", string.Join(",", get.Headers.GetValues("X-Content-Type-Options")));
        Assert.Contains("sandbox", string.Join(",", get.Headers.GetValues("Content-Security-Policy")), StringComparison.Ordinal);
        using var decoded = SKBitmap.Decode(await get.Content.ReadAsByteArrayAsync());
        Assert.Equal(300, decoded.Width);

        var list = (await (await _client.GetAsync($"/api/venues/{v.Id}/uploads?t={v.ReadToken}")).Content.ReadFromJsonAsync<JsonArray>())!;
        Assert.Single(list);

        Assert.Equal(HttpStatusCode.NoContent, (await _client.SendAsync(Http.Request(HttpMethod.Delete, url, editKey: v.EditKey))).StatusCode);
        Assert.False(File.Exists(Path.Combine(api.Factory.UploadPath, v.Id, id + ".png")));
    }

    [Fact]
    public async Task Re_encoding_strips_metadata()
    {
        var v = await _client.CreateVenueAsync();
        var jpeg = Images.WithExif(Images.Jpeg(120, 80), "GPS-SECRET-LOCATION");
        Assert.Contains("GPS-SECRET-LOCATION", Encoding.ASCII.GetString(jpeg), StringComparison.Ordinal);

        var response = await Upload(v, jpeg, "image/jpeg");
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var u = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("image/jpeg", (string)u["contentType"]!);
        var served = await (await _client.GetAsync($"{u["url"]}?t={v.ReadToken}")).Content.ReadAsByteArrayAsync();
        var text = Encoding.ASCII.GetString(served);
        Assert.DoesNotContain("GPS-SECRET-LOCATION", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Exif", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_type_comes_from_magic_bytes_not_from_the_request()
    {
        var v = await _client.CreateVenueAsync();
        // A JPEG labelled as PNG is stored and served as the JPEG it is.
        var r = await Upload(v, Images.Jpeg(), "image/png");
        Assert.Equal("image/jpeg", (string)(await r.Content.ReadFromJsonAsync<JsonObject>())!["contentType"]!);
    }

    [Theory]
    [InlineData("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;", "image/png")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "image/svg+xml")]
    [InlineData("<html><script>alert(1)</script></html>", "image/jpeg")]
    public async Task A_wrong_file_type_is_rejected(string content, string declared)
    {
        var v = await _client.CreateVenueAsync();
        // A declared type other than PNG, JPEG or octet-stream is refused by routing; a PNG/JPEG label on other
        // content is refused by the magic-byte check. Both are 415 problems.
        await Http.ProblemAsync(await Upload(v, Encoding.ASCII.GetBytes(content), declared), HttpStatusCode.UnsupportedMediaType);
        var problem = await Http.ProblemAsync(await Upload(v, Encoding.ASCII.GetBytes(content)), HttpStatusCode.UnsupportedMediaType);
        Assert.EndsWith("unsupported-media-type", problem.Type(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_oversized_file_is_rejected()
    {
        var v = await _client.CreateVenueAsync();
        var bytes = new byte[5 * 1024 * 1024 + 1];
        Images.Png().CopyTo(bytes, 0);
        await Http.ProblemAsync(await Upload(v, bytes), HttpStatusCode.RequestEntityTooLarge);
    }

    [Fact]
    public async Task Too_many_pixels_are_rejected_before_decoding()
    {
        var v = await _client.CreateVenueAsync();
        // The header claims 5000 × 10 px; the rest is junk that no decoder could read. Getting "too large"
        // (not "could not be decoded") shows the size was checked from the header, before decoding.
        var problem = await Http.ProblemAsync(await Upload(v, Images.PngHeaderOnly(5000, 10)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("image-too-large", problem.Type(), StringComparison.Ordinal);
        Assert.Contains("5000", (string)problem["detail"]!, StringComparison.Ordinal);

        problem = await Http.ProblemAsync(await Upload(v, Images.PngHeaderOnly(10, 4097)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("image-too-large", problem.Type(), StringComparison.Ordinal);

        // A real image just over the limit, too.
        problem = await Http.ProblemAsync(await Upload(v, Images.Png(4097, 1)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("image-too-large", problem.Type(), StringComparison.Ordinal);

        // And an image within the limit whose body is junk is refused at decoding.
        problem = await Http.ProblemAsync(await Upload(v, Images.PngHeaderOnly(100, 100)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("image-invalid", problem.Type(), StringComparison.Ordinal);
        Assert.Empty(Directory.Exists(Path.Combine(api.Factory.UploadPath, v.Id)) ? Directory.GetFiles(Path.Combine(api.Factory.UploadPath, v.Id)) : []);
    }

    [Fact]
    public async Task Uploading_needs_the_edit_key()
    {
        var v = await _client.CreateVenueAsync();
        var r = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/uploads", readToken: v.ReadToken, content: Body(Images.Png())));
        await Http.ProblemAsync(r, HttpStatusCode.Unauthorized);
    }
}

/// <summary>Per-venue upload caps with small limits.</summary>
public sealed class UploadQuotaTests(PostgresFixture postgres)
{
    [Fact]
    public async Task Per_venue_count_and_storage_quotas_apply()
    {
        await using var factory = new ApiFactory(postgres, new Dictionary<string, string?>
        {
            ["Uploads:MaxUploadsPerVenue"] = "2",
            ["Uploads:VenueQuotaBytes"] = "1000000",
        });
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync();
        HttpResponseMessage Send(byte[] b) => client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/uploads", editKey: v.EditKey, content: new ByteArrayContent(b))).GetAwaiter().GetResult();

        Assert.Equal(HttpStatusCode.Created, Send(Images.Png(10, 10)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, Send(Images.Png(10, 10)).StatusCode);
        Assert.EndsWith("limit-reached", (await Http.ProblemAsync(Send(Images.Png(10, 10)), HttpStatusCode.Conflict)).Type(), StringComparison.Ordinal);

        await using var small = new ApiFactory(postgres, new Dictionary<string, string?> { ["Uploads:VenueQuotaBytes"] = "200" });
        var c2 = small.CreateClient();
        var v2 = await c2.CreateVenueAsync();
        var noisy = NoisyPng(64, 64); // does not compress below 200 bytes
        var r = await c2.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v2.Id}/uploads", editKey: v2.EditKey, content: new ByteArrayContent(noisy)));
        Assert.EndsWith("quota-exceeded", (await Http.ProblemAsync(r, HttpStatusCode.InsufficientStorage)).Type(), StringComparison.Ordinal);
    }

    private static byte[] NoisyPng(int w, int h)
    {
        using var bitmap = new SKBitmap(w, h);
        var rng = new Random(1);
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                bitmap.SetPixel(x, y, new SKColor((byte)rng.Next(256), (byte)rng.Next(256), (byte)rng.Next(256)));
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
