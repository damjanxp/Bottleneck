using System.Text.Json.Nodes;
using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Venues;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Scenarios;

public sealed record ScenarioSummary(string Id, string Name, int SchemaVersion, long Revision, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record ScenarioResponse(string Id, string VenueId, string Name, int SchemaVersion, long Revision, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, JsonObject Document);

public static class ScenarioEndpoints
{
    public static void MapScenarioEndpoints(this RouteGroupBuilder venue)
    {
        var scenarios = venue.MapGroup("/scenarios").WithTags("Scenarios");

        scenarios.MapGet("/", List)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<List<ScenarioSummary>>()
            .WithSummary("List a venue's scenarios");

        scenarios.MapPost("/", Create)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Accepts<JsonObject>("application/json")
            .Produces<ScenarioResponse>(StatusCodes.Status201Created)
            .WithSummary("Create a scenario")
            .WithDescription("Body: a scenario document (/schema/scenario.schema.json). Its id and venueId are set by the server.");

        var one = scenarios.MapGroup($"/{{scenarioId{VenueEndpoints.IdConstraint}}}");

        one.MapGet("/", Get)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<ScenarioResponse>()
            .WithSummary("Read a scenario");

        one.MapPut("/", Update)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Accepts<JsonObject>("application/json")
            .Produces<ScenarioResponse>()
            .WithSummary("Replace a scenario")
            .WithDescription("Needs If-Match with the last ETag (428 without, 412 on a concurrent change).");

        one.MapDelete("/", Delete)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces(StatusCodes.Status204NoContent)
            .WithSummary("Delete a scenario")
            .WithDescription("Runs of this scenario are kept, with scenarioId cleared.");
    }

    private static async Task<IResult> List(string venueId, AppDbContext db, CancellationToken ct)
    {
        var list = await db.Scenarios.AsNoTracking()
            .Where(s => s.VenueId == venueId)
            .OrderBy(s => s.CreatedAt).ThenBy(s => s.Id)
            .Select(s => new ScenarioSummary(s.Id, s.Name, s.SchemaVersion, s.Revision, s.CreatedAt, s.UpdatedAt))
            .ToListAsync(ct);
        return TypedResults.Ok(list);
    }

    private static async Task<IResult> Create(string venueId, HttpRequest request, HttpResponse response, DocumentPipeline pipeline, AppDbContext db,
        IOptions<LimitsOptions> limits, TimeProvider clock, CancellationToken ct)
    {
        var parsed = await pipeline.ReadAsync(request, DocumentKind.Scenario, limits.Value.MaxScenarioBytes, ct);
        if (parsed.Error is not null) return parsed.Error;

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await VenueActivity.LockAsync(db, venueId, ct);
        if (await db.Scenarios.CountAsync(s => s.VenueId == venueId, ct) >= limits.Value.MaxScenariosPerVenue)
            return Problems.LimitReached($"A venue can hold at most {limits.Value.MaxScenariosPerVenue} scenarios. Delete one first.");

        var doc = parsed.Document!;
        var id = Secrets.NewId();
        doc["id"] = id;
        doc["venueId"] = venueId;
        var now = clock.GetUtcNow();
        var scenario = new Scenario
        {
            Id = id,
            VenueId = venueId,
            Name = (string)doc["name"]!,
            SchemaVersion = DocumentMigrator.ReadVersion(doc)!.Value,
            Document = DocumentPipeline.Serialize(doc),
            Revision = 1,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Scenarios.Add(scenario);
        await db.SaveChangesAsync(ct);
        await VenueActivity.TouchAsync(db, venueId, now, ct);
        await tx.CommitAsync(ct);

        response.Headers.ETag = ETags.For(scenario.Revision);
        return TypedResults.Created($"/api/venues/{venueId}/scenarios/{id}", ToResponse(scenario, doc));
    }

    private static async Task<IResult> Get(string venueId, string scenarioId, HttpResponse response, DocumentPipeline pipeline, AppDbContext db, CancellationToken ct)
    {
        var scenario = await db.Scenarios.AsNoTracking().SingleOrDefaultAsync(s => s.Id == scenarioId && s.VenueId == venueId, ct);
        if (scenario is null) return Problems.NotFound("Scenario not found.");
        var doc = pipeline.ReadStored(DocumentKind.Scenario, scenario.Document, scenario.SchemaVersion);
        response.Headers.ETag = ETags.For(scenario.Revision);
        response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(ToResponse(scenario, doc));
    }

    private static async Task<IResult> Update(string venueId, string scenarioId, HttpRequest request, HttpResponse response, DocumentPipeline pipeline,
        AppDbContext db, IOptions<LimitsOptions> limits, TimeProvider clock, CancellationToken ct)
    {
        if (!ETags.TryReadIfMatch(request, out var expected)) return Problems.PreconditionRequired();
        var parsed = await pipeline.ReadAsync(request, DocumentKind.Scenario, limits.Value.MaxScenarioBytes, ct);
        if (parsed.Error is not null) return parsed.Error;

        var scenario = await db.Scenarios.SingleOrDefaultAsync(s => s.Id == scenarioId && s.VenueId == venueId, ct);
        if (scenario is null) return Problems.NotFound("Scenario not found.");
        if (expected is null || expected.Value != scenario.Revision) return Problems.PreconditionFailed();

        var doc = parsed.Document!;
        doc["id"] = scenarioId;
        doc["venueId"] = venueId;
        var now = clock.GetUtcNow();
        scenario.Name = (string)doc["name"]!;
        scenario.SchemaVersion = DocumentMigrator.ReadVersion(doc)!.Value;
        scenario.Document = DocumentPipeline.Serialize(doc);
        db.Entry(scenario).Property(s => s.Revision).OriginalValue = expected.Value;
        scenario.Revision = expected.Value + 1;
        scenario.UpdatedAt = now;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Problems.PreconditionFailed();
        }
        await VenueActivity.TouchAsync(db, venueId, now, ct);

        response.Headers.ETag = ETags.For(scenario.Revision);
        return TypedResults.Ok(ToResponse(scenario, doc));
    }

    private static async Task<IResult> Delete(string venueId, string scenarioId, AppDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var deleted = await db.Scenarios.Where(s => s.Id == scenarioId && s.VenueId == venueId).ExecuteDeleteAsync(ct);
        if (deleted == 0) return Problems.NotFound("Scenario not found.");
        await VenueActivity.TouchAsync(db, venueId, clock.GetUtcNow(), ct);
        return TypedResults.NoContent();
    }

    private static ScenarioResponse ToResponse(Scenario s, JsonObject doc) =>
        new(s.Id, s.VenueId, s.Name, DocumentMigrator.ReadVersion(doc) ?? s.SchemaVersion, s.Revision, s.CreatedAt, s.UpdatedAt, doc);
}
