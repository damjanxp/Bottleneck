using System.Text;
using System.Text.Json.Nodes;
using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Venues;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Runs;

public sealed record RunSummary(string Id, string? ScenarioId, string? JobId, string Origin, string EngineVersion, long Seed, string MetricsHash, int SizeBytes, DateTimeOffset CreatedAt);

public sealed record RunResponse(string Id, string VenueId, string? ScenarioId, string? JobId, string Origin, string EngineVersion, long Seed, string MetricsHash, DateTimeOffset CreatedAt, JsonObject Record);

public static class RunEndpoints
{
    public static void MapRunEndpoints(this RouteGroupBuilder venue)
    {
        var runs = venue.MapGroup("/runs").WithTags("Runs");

        runs.MapGet("/", List)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<List<RunSummary>>()
            .WithSummary("List a venue's runs (newest first, without the records)");

        runs.MapPost("/", Create)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Accepts<JsonObject>("application/json")
            .Produces<RunResponse>(StatusCodes.Status201Created)
            .WithSummary("Store a run computed in the browser")
            .WithDescription("Body: a run record (/schema/run.schema.json) with origin \"clientReported\". At most 256 KB and 50 per venue (spec section 8). Runs with origin \"job\" are only written by the job runner.");

        var one = runs.MapGroup($"/{{runId{VenueEndpoints.IdConstraint}}}");

        one.MapGet("/", Get)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<RunResponse>()
            .WithSummary("Read a run with its full record");

        one.MapDelete("/", Delete)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces(StatusCodes.Status204NoContent)
            .WithSummary("Delete a run");
    }

    private static async Task<IResult> List(string venueId, AppDbContext db, CancellationToken ct, [FromQuery] int? limit = null)
    {
        var take = Math.Clamp(limit ?? 100, 1, 500);
        var list = await db.Runs.AsNoTracking()
            .Where(r => r.VenueId == venueId)
            .OrderByDescending(r => r.CreatedAt).ThenBy(r => r.Id)
            .Take(take)
            .Select(r => new RunSummary(r.Id, r.ScenarioId, r.JobId, r.Origin, r.EngineVersion, r.Seed, r.MetricsHash, r.SizeBytes, r.CreatedAt))
            .ToListAsync(ct);
        return TypedResults.Ok(list);
    }

    private static async Task<IResult> Create(string venueId, HttpRequest request, DocumentPipeline pipeline, AppDbContext db,
        IOptions<LimitsOptions> limits, TimeProvider clock, CancellationToken ct, [FromQuery] string? scenarioId = null)
    {
        var parsed = await pipeline.ReadAsync(request, DocumentKind.Run, limits.Value.MaxClientRunBytes, ct);
        if (parsed.Error is not null) return parsed.Error;
        var record = parsed.Document!;
        if ((string?)record["origin"] != RunOrigins.ClientReported)
            return Problems.Unprocessable("Only client-reported runs can be uploaded",
                "Set origin to \"clientReported\". Runs with origin \"job\" are computed and stored by the server.", "origin-not-allowed");

        if (scenarioId is not null && !await db.Scenarios.AnyAsync(s => s.Id == scenarioId && s.VenueId == venueId, ct))
            return Problems.NotFound("scenarioId does not name a scenario of this venue.");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await VenueActivity.LockAsync(db, venueId, ct);
        var count = await db.Runs.CountAsync(r => r.VenueId == venueId && r.Origin == RunOrigins.ClientReported, ct);
        if (count >= limits.Value.MaxClientRunsPerVenue)
            return Problems.LimitReached($"A venue keeps at most {limits.Value.MaxClientRunsPerVenue} client-reported runs. Delete an old run first.");

        var id = Secrets.NewId();
        record["id"] = id;
        var json = DocumentPipeline.Serialize(record);
        var now = clock.GetUtcNow();
        var run = new Run
        {
            Id = id,
            VenueId = venueId,
            ScenarioId = scenarioId,
            Origin = RunOrigins.ClientReported,
            EngineVersion = (string)record["engineVersion"]!,
            Seed = (long)record["scenario"]!["seed"]!,
            MetricsHash = (string)record["metricsHash"]!,
            SchemaVersion = DocumentMigrator.ReadVersion(record)!.Value,
            Record = json,
            SizeBytes = Encoding.UTF8.GetByteCount(json),
            CreatedAt = now,
        };
        db.Runs.Add(run);
        await db.SaveChangesAsync(ct);
        await VenueActivity.TouchAsync(db, venueId, now, ct);
        await tx.CommitAsync(ct);

        return TypedResults.Created($"/api/venues/{venueId}/runs/{id}", ToResponse(run, record));
    }

    private static async Task<IResult> Get(string venueId, string runId, HttpResponse response, DocumentPipeline pipeline, AppDbContext db, CancellationToken ct)
    {
        var run = await db.Runs.AsNoTracking().SingleOrDefaultAsync(r => r.Id == runId && r.VenueId == venueId, ct);
        if (run is null) return Problems.NotFound("Run not found.");
        response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(ToResponse(run, pipeline.ReadStored(DocumentKind.Run, run.Record, run.SchemaVersion)));
    }

    private static async Task<IResult> Delete(string venueId, string runId, AppDbContext db, CancellationToken ct)
    {
        var deleted = await db.Runs.Where(r => r.Id == runId && r.VenueId == venueId).ExecuteDeleteAsync(ct);
        return deleted == 0 ? Problems.NotFound("Run not found.") : TypedResults.NoContent();
    }

    private static RunResponse ToResponse(Run r, JsonObject record) =>
        new(r.Id, r.VenueId, r.ScenarioId, r.JobId, r.Origin, r.EngineVersion, r.Seed, r.MetricsHash, r.CreatedAt, record);
}
