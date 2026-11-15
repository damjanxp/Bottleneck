using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Venues;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Uploads;

public sealed record UploadResponse(string Id, string ContentType, long Bytes, int Width, int Height, DateTimeOffset CreatedAt, string Url);

public static class UploadEndpoints
{
    public static void MapUploadEndpoints(this RouteGroupBuilder venue)
    {
        var uploads = venue.MapGroup("/uploads").WithTags("Uploads");

        uploads.MapPost("/", Create)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Uploads)
            .Accepts<byte[]>("image/png", "image/jpeg", "application/octet-stream")
            .Produces<UploadResponse>(StatusCodes.Status201Created)
            .WithSummary("Upload a background image")
            .WithDescription("Body: the raw file bytes. PNG or JPEG only, decided by magic bytes; at most 5 MB and 4096 px per side (checked from the header before decoding). The image is decoded and re-encoded, which strips all metadata. Use the returned id as background.image.");

        uploads.MapGet("/", List)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<List<UploadResponse>>()
            .WithSummary("List a venue's uploads");

        var one = uploads.MapGroup($"/{{uploadId{VenueEndpoints.IdConstraint}}}");

        one.MapGet("/", Get)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces(StatusCodes.Status200OK, contentType: "image/png")
            .WithSummary("Download an image")
            .WithDescription("Served with its fixed content type, nosniff and a CSP. Use ?t=<readToken> in <img src>.");

        one.MapDelete("/", Delete)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces(StatusCodes.Status204NoContent)
            .WithSummary("Delete an image");
    }

    private static async Task<IResult> Create(string venueId, HttpRequest request, AppDbContext db, ImageProcessor processor, UploadStorage storage,
        IOptions<UploadOptions> options, TimeProvider clock, ILoggerFactory loggers, CancellationToken ct)
    {
        var o = options.Value;
        var body = await RequestBody.ReadAsync(request, o.MaxBytes, ct);
        if (body.Error is not null) return body.Error;
        var data = body.Bytes!;

        // 1. Type by magic bytes only. 2. Size from the header, before any decoding.
        if (ImageInspector.DetectFormat(data) is null)
            return Problems.UnsupportedMediaType("Only PNG and JPEG images are accepted (checked by the file's content, not its name or Content-Type).");
        var header = ImageInspector.ReadHeader(data);
        if (header is null)
            return Problems.Unprocessable("Unreadable image", "The image header is malformed.", "image-invalid");
        if (header.Width > o.MaxSide || header.Height > o.MaxSide)
            return Problems.Unprocessable("Image too large",
                $"The image is {header.Width} × {header.Height} px; at most {o.MaxSide} px per side is accepted.", "image-too-large");

        // 3. Decode and re-encode (strips metadata).
        var processed = await processor.ReencodeAsync(data, header, ct);
        if (processed is null)
            return Problems.Unprocessable("Unreadable image", "The image could not be decoded.", "image-invalid");
        var size = processed.Bytes.LongLength;

        // 4. Quotas, under the venue lock so concurrent uploads cannot overshoot.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await VenueActivity.LockAsync(db, venueId, ct);
        var used = await db.Uploads.Where(u => u.VenueId == venueId).GroupBy(_ => 1)
            .Select(g => new { Count = g.Count(), Bytes = g.Sum(u => u.Bytes) }).SingleOrDefaultAsync(ct);
        if ((used?.Count ?? 0) >= o.MaxUploadsPerVenue)
            return Problems.LimitReached($"A venue can hold at most {o.MaxUploadsPerVenue} images. Delete one first.");
        if ((used?.Bytes ?? 0) + size > o.VenueQuotaBytes)
            return Problems.QuotaExceeded($"This venue's images would exceed {o.VenueQuotaBytes / (1024 * 1024)} MB. Delete one first.");
        var total = await db.Uploads.SumAsync(u => (long?)u.Bytes, ct) ?? 0;
        if (total + size > o.GlobalQuotaBytes)
            return Problems.QuotaExceeded("This server's image storage is full. Try again later.");

        var now = clock.GetUtcNow();
        var upload = new Upload
        {
            Id = Secrets.NewId(),
            VenueId = venueId,
            ContentType = processed.Header.ContentType,
            Bytes = size,
            Width = processed.Header.Width,
            Height = processed.Header.Height,
            CreatedAt = now,
        };
        await storage.WriteAsync(venueId, upload.Id, upload.ContentType, processed.Bytes, ct);
        try
        {
            db.Uploads.Add(upload);
            await db.SaveChangesAsync(ct);
            await VenueActivity.TouchAsync(db, venueId, now, ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            try { storage.Delete(venueId, upload.Id, upload.ContentType); }
            catch (IOException ex) { loggers.CreateLogger("Uploads").LogWarning(ex, "Could not remove an orphaned upload file"); }
            throw;
        }

        return TypedResults.Created(UrlFor(venueId, upload.Id), ToResponse(upload));
    }

    private static async Task<IResult> List(string venueId, AppDbContext db, CancellationToken ct)
    {
        var list = await db.Uploads.AsNoTracking().Where(u => u.VenueId == venueId)
            .OrderBy(u => u.CreatedAt).ThenBy(u => u.Id).ToListAsync(ct);
        return TypedResults.Ok(list.Select(ToResponse).ToList());
    }

    private static async Task<IResult> Get(string venueId, string uploadId, HttpResponse response, AppDbContext db, UploadStorage storage, CancellationToken ct)
    {
        var upload = await db.Uploads.AsNoTracking().SingleOrDefaultAsync(u => u.Id == uploadId && u.VenueId == venueId, ct);
        if (upload is null) return Problems.NotFound("Image not found.");
        var path = storage.PathFor(venueId, upload.Id, upload.ContentType);
        if (!File.Exists(path)) return Problems.NotFound("Image not found.");

        // nosniff and the API's CSP ("default-src 'none'; sandbox") come from SecurityHeaders, so an image
        // opened directly cannot run anything.
        response.Headers.CacheControl = "private, max-age=3600";
        response.Headers.ContentDisposition = $"inline; filename=\"{upload.Id}{(upload.ContentType == "image/png" ? ".png" : ".jpg")}\"";
        // The content type is the one fixed at upload, never derived from the request.
        return TypedResults.PhysicalFile(path, upload.ContentType);
    }

    private static async Task<IResult> Delete(string venueId, string uploadId, AppDbContext db, UploadStorage storage, CancellationToken ct)
    {
        var upload = await db.Uploads.SingleOrDefaultAsync(u => u.Id == uploadId && u.VenueId == venueId, ct);
        if (upload is null) return Problems.NotFound("Image not found.");
        db.Uploads.Remove(upload);
        await db.SaveChangesAsync(ct);
        storage.Delete(venueId, upload.Id, upload.ContentType);
        return TypedResults.NoContent();
    }

    private static string UrlFor(string venueId, string uploadId) => $"/api/venues/{venueId}/uploads/{uploadId}";

    private static UploadResponse ToResponse(Upload u) => new(u.Id, u.ContentType, u.Bytes, u.Width, u.Height, u.CreatedAt, UrlFor(u.VenueId, u.Id));
}
