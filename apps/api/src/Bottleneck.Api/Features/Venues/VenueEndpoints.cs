using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Uploads;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Venues;

public sealed record VenueResponse(
    string Id,
    string Name,
    int SchemaVersion,
    long Revision,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    JsonObject Document,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReadToken);

/// <summary>Returned once, on creation. The edit key cannot be recovered later, only rotated.</summary>
public sealed record VenueCreatedResponse(
    string Id,
    string Name,
    int SchemaVersion,
    long Revision,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    JsonObject Document,
    string ReadToken,
    string EditKey);

public sealed record EditKeyResponse(string EditKey);

public sealed record ReadTokenResponse(string ReadToken);

public static class VenueEndpoints
{
    /// <summary>Route segment for a server-generated id ({ and } doubled for the route template).</summary>
    public const string IdConstraint = ":regex(^[a-z2-7]{{26}}$)";

    public static RouteGroupBuilder MapVenueEndpoints(this IEndpointRouteBuilder app)
    {
        var venues = app.MapGroup("/api/venues").WithTags("Venues");

        venues.MapPost("/", Create)
            .RequireRateLimiting(RateLimitPolicies.CreateVenue)
            .Accepts<JsonObject>("application/json")
            .Produces<VenueCreatedResponse>(StatusCodes.Status201Created)
            .WithSummary("Create a venue")
            .WithDescription("Body: a venue document (/schema/venue.schema.json). Returns the id, the read token and the edit key. The edit key is shown only this once.");

        var venue = venues.MapGroup($"/{{{VenuePolicies.VenueIdRoute}{IdConstraint}}}");

        venue.MapGet("/", Get)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<VenueResponse>()
            .WithSummary("Read a venue")
            .WithDescription("Needs the read token (X-Read-Token header or ?t=) or the edit key. With the edit key the response also carries the read token. The ETag is the revision for If-Match.");

        venue.MapPut("/", Update)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Accepts<JsonObject>("application/json")
            .Produces<VenueResponse>()
            .WithSummary("Replace a venue's document")
            .WithDescription("Needs the edit key and If-Match with the last ETag: 428 without it, 412 if someone else changed the venue in the meantime.");

        venue.MapDelete("/", Delete)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces(StatusCodes.Status204NoContent)
            .WithSummary("Delete a venue with its scenarios, runs, uploads and jobs");

        venue.MapPost("/edit-key", RotateEditKey)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces<EditKeyResponse>()
            .WithSummary("Rotate the edit key")
            .WithDescription("Atomically replaces the edit key; the old key stops working at once. The new key is shown only this once.");

        venue.MapPost("/read-token", RotateReadToken)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces<ReadTokenResponse>()
            .WithSummary("Regenerate the read token")
            .WithDescription("Old share links stop working.");

        return venue;
    }

    private static async Task<IResult> Create(HttpRequest request, HttpResponse response, DocumentPipeline pipeline, AppDbContext db,
        IOptions<LimitsOptions> limits, TimeProvider clock, CancellationToken ct)
    {
        var parsed = await pipeline.ReadAsync(request, DocumentKind.Venue, limits.Value.MaxVenueBytes, ct);
        if (parsed.Error is not null) return parsed.Error;
        if (await db.Venues.CountAsync(ct) >= limits.Value.MaxVenues)
            return Problems.QuotaExceeded("This server already stores as many venues as it allows. Try again later.");

        var doc = parsed.Document!;
        var id = Secrets.NewId();
        var (editKey, editKeyHash) = Secrets.NewEditKey();
        doc["id"] = id;
        var now = clock.GetUtcNow();
        var venue = new Venue
        {
            Id = id,
            Name = (string)doc["name"]!,
            SchemaVersion = DocumentMigrator.ReadVersion(doc)!.Value,
            Document = DocumentPipeline.Serialize(doc),
            ReadToken = Secrets.NewToken(),
            EditKeyHash = editKeyHash,
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
            LastActivityAt = now,
        };
        db.Venues.Add(venue);
        await db.SaveChangesAsync(ct);

        response.Headers.CacheControl = "no-store";
        response.Headers.ETag = ETags.For(venue.Revision);
        return TypedResults.Created($"/api/venues/{id}", new VenueCreatedResponse(
            venue.Id, venue.Name, venue.SchemaVersion, venue.Revision, venue.CreatedAt, venue.UpdatedAt, doc, venue.ReadToken, editKey));
    }

    private static async Task<IResult> Get(string venueId, HttpContext http, DocumentPipeline pipeline, AppDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var venue = await db.Venues.AsNoTracking().SingleOrDefaultAsync(v => v.Id == venueId, ct);
        if (venue is null) return Problems.NotFound("Venue not found.");
        await VenueActivity.TouchOnReadAsync(db, venueId, clock.GetUtcNow(), ct);
        var doc = pipeline.ReadStored(DocumentKind.Venue, venue.Document, venue.SchemaVersion);

        http.Response.Headers.ETag = ETags.For(venue.Revision);
        http.Response.Headers.CacheControl = "no-store";
        var readToken = http.GrantedLevel() == VenueAccessLevel.Edit ? venue.ReadToken : null;
        return TypedResults.Ok(new VenueResponse(venue.Id, venue.Name, DocumentMigrator.ReadVersion(doc) ?? venue.SchemaVersion,
            venue.Revision, venue.CreatedAt, venue.UpdatedAt, doc, readToken));
    }

    private static async Task<IResult> Update(string venueId, HttpRequest request, HttpResponse response, DocumentPipeline pipeline, AppDbContext db,
        IOptions<LimitsOptions> limits, TimeProvider clock, CancellationToken ct)
    {
        if (!ETags.TryReadIfMatch(request, out var expected)) return Problems.PreconditionRequired();
        var parsed = await pipeline.ReadAsync(request, DocumentKind.Venue, limits.Value.MaxVenueBytes, ct);
        if (parsed.Error is not null) return parsed.Error;

        var venue = await db.Venues.SingleOrDefaultAsync(v => v.Id == venueId, ct);
        if (venue is null) return Problems.NotFound("Venue not found.");
        if (expected is null || expected.Value != venue.Revision) return Problems.PreconditionFailed();

        var doc = parsed.Document!;
        doc["id"] = venueId;
        var now = clock.GetUtcNow();
        venue.Name = (string)doc["name"]!;
        venue.SchemaVersion = DocumentMigrator.ReadVersion(doc)!.Value;
        venue.Document = DocumentPipeline.Serialize(doc);
        // The UPDATE carries "WHERE revision = <If-Match>", so a write that landed after our read is detected.
        db.Entry(venue).Property(v => v.Revision).OriginalValue = expected.Value;
        venue.Revision = expected.Value + 1;
        venue.UpdatedAt = now;
        venue.LastActivityAt = now;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Problems.PreconditionFailed();
        }

        response.Headers.ETag = ETags.For(venue.Revision);
        return TypedResults.Ok(new VenueResponse(venue.Id, venue.Name, venue.SchemaVersion, venue.Revision, venue.CreatedAt, venue.UpdatedAt, doc, null));
    }

    private static async Task<IResult> Delete(string venueId, AppDbContext db, UploadStorage storage, CancellationToken ct)
    {
        // Scenarios, runs, uploads and jobs go with it (ON DELETE CASCADE).
        var deleted = await db.Venues.Where(v => v.Id == venueId).ExecuteDeleteAsync(ct);
        if (deleted == 0) return Problems.NotFound("Venue not found.");
        storage.DeleteVenueFiles(venueId);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RotateEditKey(string venueId, HttpRequest request, HttpResponse response, AppDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var presentedHash = Secrets.HashPresentedEditKey(request.Headers[VenuePolicies.EditKeyHeader]);
        if (presentedHash is null) return Problems.Create(StatusCodes.Status403Forbidden, "Wrong credential", "The edit key does not match.", "credential-invalid");
        var (newKey, newHash) = Secrets.NewEditKey();
        var now = clock.GetUtcNow();
        // One conditional UPDATE: it succeeds only if the key used for this request is still the current one,
        // so two concurrent rotations cannot both win, and there is no moment where both keys work.
        var changed = await db.Venues
            .Where(v => v.Id == venueId && v.EditKeyHash == presentedHash)
            .ExecuteUpdateAsync(s => s.SetProperty(v => v.EditKeyHash, newHash).SetProperty(v => v.LastActivityAt, now), ct);
        if (changed == 0)
            return Problems.Create(StatusCodes.Status409Conflict, "Key already rotated", "The edit key was changed by another request.", "concurrent-update");
        response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(new EditKeyResponse(newKey));
    }

    private static async Task<IResult> RotateReadToken(string venueId, HttpResponse response, AppDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var token = Secrets.NewToken();
        var now = clock.GetUtcNow();
        var changed = await db.Venues.Where(v => v.Id == venueId)
            .ExecuteUpdateAsync(s => s.SetProperty(v => v.ReadToken, token).SetProperty(v => v.LastActivityAt, now), ct);
        if (changed == 0) return Problems.NotFound("Venue not found.");
        response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(new ReadTokenResponse(token));
    }
}
