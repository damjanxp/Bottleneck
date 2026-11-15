using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Venues;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Jobs;

public sealed record JobProgress(int CompletedRuns, int TotalRuns);

public sealed record JobSummary(string Id, string RequestId, string Kind, string Status, JobProgress Progress, string? EngineVersion, string? Error,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt);

public sealed record JobResponse(string Id, string VenueId, string RequestId, string Kind, string Status, JobProgress Progress, string? EngineVersion, string? Error,
    bool CancelRequested, int Attempts, DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? FinishedAt, DateTimeOffset? HeartbeatAt,
    JsonObject Request, JsonObject? Result);

/// <summary>Batches and sweeps run by the server (spec 6.4). Their runs are trusted (origin "job").</summary>
public static partial class JobEndpoints
{
    [GeneratedRegex("^[A-Za-z0-9._:-]{1,64}$")]
    private static partial Regex RequestIdPattern();

    public static void MapJobEndpoints(this RouteGroupBuilder venue)
    {
        var jobs = venue.MapGroup("/jobs").WithTags("Jobs");

        jobs.MapPost("/", Create)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Accepts<JsonObject>("application/json")
            .Produces<JobResponse>(StatusCodes.Status201Created)
            .Produces<JobResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .WithSummary("Submit a batch or sweep")
            .WithDescription("""
                Needs the edit key. Idempotent by requestId: the same (venue, requestId) returns the existing job with 200 instead of 201.
                Body: { requestId, kind, scenarioId | scenario, ... }. Seeds: `baseSeed` (default the scenario's seed) plus derived seeds, as in the browser
                (or an explicit `seedList`); the same seeds are used at every sweep point (common random numbers).
                - kind "batch": `seeds` (default 20). Result: mean, sd and 95% CI (Student t) of every headline metric.
                - kind "laneSweep": `elementId` (gate group, screening stage or vehicle barrier), `minLanes` (default 1), `maxLanes` (≤ 64), `seedsPerPoint` (default 5),
                  `targetWait` (s), `metric` (peakHourP95Wait | p95Wait | meanWait | elementP95Wait), `rule` (mean | ci). Result: the CI per lane count and the smallest
                  lane count that meets the target.
                - kind "gateOpeningSweep": `gatesOpen` (candidate times, scenario seconds), `targetShareInside` (default 0.95), `seedsPerPoint`, `rule`. Result: the latest
                  gate opening whose share inside by the event start meets the target.
                422 job-invalid (bad fields), work-budget-exceeded (runs × simulated hours over the limit); 409 limit-reached (queue caps, jobs per venue).
                """);

        jobs.MapGet("/", List)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<List<JobSummary>>()
            .WithSummary("List a venue's jobs (newest first, without request and result)");

        var one = jobs.MapGroup($"/{{jobId{VenueEndpoints.IdConstraint}}}");

        one.MapGet("/", Get)
            .RequireAuthorization(VenuePolicies.Read)
            .Produces<JobResponse>()
            .WithSummary("Read a job: status, progress and result")
            .WithDescription("Status: queued, running, succeeded, failed or cancelled. The job's runs are listed by GET /runs?jobId=.");

        one.MapPost("/cancel", Cancel)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces<JobResponse>(StatusCodes.Status202Accepted)
            .Produces<JobResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .WithSummary("Cancel a job")
            .WithDescription("A queued job is cancelled at once (200). A running job stops its in-flight run and starts no more (202; poll until status is cancelled). Runs already finished are kept. 409 if the job already succeeded or failed.");

        one.MapDelete("/", Delete)
            .RequireAuthorization(VenuePolicies.Edit)
            .RequireRateLimiting(RateLimitPolicies.Writes)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .WithSummary("Delete a finished job and its runs")
            .WithDescription("409 while the job is queued or running: cancel it first.");
    }

    public static string StatusName(JobStatus s) => s switch
    {
        JobStatus.Queued => "queued",
        JobStatus.Running => "running",
        JobStatus.Succeeded => "succeeded",
        JobStatus.Failed => "failed",
        _ => "cancelled",
    };

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Invalid(Dictionary<string, string[]> errors) => TypedResults.Problem(new HttpValidationProblemDetails(errors)
    {
        Status = StatusCodes.Status422UnprocessableEntity,
        Title = "Invalid job request",
        Detail = "Some fields of the job request are missing or out of range.",
        Type = Problems.TypeBase + "job-invalid",
    });

    private static async Task<IResult> Create(string venueId, HttpRequest request, DocumentPipeline pipeline, AppDbContext db,
        IOptions<LimitsOptions> limits, IOptions<JobOptions> jobOptions, IDocumentSchemaValidator validator, JobSignal signal, TimeProvider clock, CancellationToken ct)
    {
        var o = jobOptions.Value;
        if (!RequestBody.IsJson(request)) return Problems.UnsupportedMediaType("Send the job request as application/json.");
        var bytes = await RequestBody.ReadAsync(request, limits.Value.MaxScenarioBytes + 64 * 1024, ct);
        if (bytes.Error is not null) return bytes.Error;
        var body = JsonLimits.ParseObject(bytes.Bytes, pipeline.JsonLimits, out var parseError);
        if (body is null) return Problems.BadJson(parseError ?? "The body is not a JSON object.");

        var requestId = body["requestId"] is JsonValue rv && rv.TryGetValue<string>(out var r) ? r : null;
        if (requestId is null || !RequestIdPattern().IsMatch(requestId))
            return Invalid(new() { ["/requestId"] = ["Required: 1 to 64 characters from A-Z a-z 0-9 . _ : - (e.g. a UUID the client made). Resubmitting the same requestId returns the same job."] });

        // Idempotency first: a retry of a submitted request gets the job, whatever else changed.
        var existing = await db.Jobs.AsNoTracking().SingleOrDefaultAsync(j => j.VenueId == venueId && j.RequestId == requestId, ct);
        if (existing is not null) return TypedResults.Ok(ToResponse(existing));

        // The scenario: a stored one, or an inline document (validated and migrated like any write).
        var scenarioId = body["scenarioId"] is JsonValue sv && sv.TryGetValue<string>(out var sid) ? sid : null;
        JsonObject scenario;
        var hasInline = body["scenario"] is not null;
        if ((scenarioId is null) == !hasInline)
            return Invalid(new() { ["/scenarioId"] = ["Give either scenarioId (a stored scenario of this venue) or scenario (an inline scenario document)."] });
        if (scenarioId is not null)
        {
            var stored = await db.Scenarios.AsNoTracking().SingleOrDefaultAsync(s => s.Id == scenarioId && s.VenueId == venueId, ct);
            if (stored is null) return Problems.NotFound("scenarioId does not name a scenario of this venue.");
            scenario = pipeline.ReadStored(DocumentKind.Scenario, stored.Document, stored.SchemaVersion);
        }
        else
        {
            if (body["scenario"] is not JsonObject inline) return Invalid(new() { ["/scenario"] = ["Must be a scenario document."] });
            var processed = pipeline.Process(DocumentKind.Scenario, Encoding.UTF8.GetBytes(inline.ToJsonString()));
            if (processed.Error is not null) return processed.Error;
            scenario = processed.Document!;
        }
        scenario["venueId"] = venueId;
        body["scenario"] = scenario;

        var venueRow = await db.Venues.AsNoTracking().Where(v => v.Id == venueId).Select(v => new { v.Document, v.SchemaVersion }).SingleAsync(ct);
        var venue = pipeline.ReadStored(DocumentKind.Venue, venueRow.Document, venueRow.SchemaVersion);

        var plan = JobPlanner.Build(body, venue, o, out var errors);
        if (plan is null) return Invalid(errors);

        // Every point's scenario must be valid (e.g. a candidate gate opening), checked now rather than failing in the runner.
        foreach (var p in plan.Points)
        {
            var applied = JobPlan.Apply(p.Scenario, plan.Seeds[0], p.Overrides);
            var outcome = validator.Validate(DocumentKind.Scenario, JsonSchemaValidator.SchemaVersion, applied);
            if (!outcome.IsValid) return Problems.SchemaInvalid(outcome.Errors, $"The scenario at sweep point {p.Label} is not valid.");
        }

        // Work budget (D1), refused up front.
        var hours = plan.SimulatedHours();
        if (plan.TotalRuns > o.MaxRuns || hours > o.MaxSimulatedHours)
            return Problems.Unprocessable("Work budget exceeded",
                string.Create(CultureInfo.InvariantCulture,
                    $"This job needs {plan.TotalRuns} runs and {hours:0.#} simulated hours; the limit is {o.MaxRuns} runs and {o.MaxSimulatedHours:0.#} simulated hours per job. Use fewer seeds or sweep points."),
                "work-budget-exceeded");

        var now = clock.GetUtcNow();
        var job = new Job
        {
            Id = Secrets.NewId(),
            VenueId = venueId,
            RequestId = requestId,
            Kind = plan.Kind,
            ScenarioId = scenarioId,
            Status = JobStatus.Queued,
            Request = DocumentPipeline.Serialize(plan.Request),
            VenueSnapshot = DocumentPipeline.Serialize(venue),
            TotalRuns = plan.TotalRuns,
            CreatedAt = now,
        };

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            await VenueActivity.LockAsync(db, venueId, ct);
            var again = await db.Jobs.AsNoTracking().SingleOrDefaultAsync(j => j.VenueId == venueId && j.RequestId == requestId, ct);
            if (again is not null) return TypedResults.Ok(ToResponse(again));

            var active = new[] { JobStatus.Queued, JobStatus.Running };
            if (await db.Jobs.CountAsync(j => j.VenueId == venueId && active.Contains(j.Status), ct) >= o.MaxActivePerVenue)
                return Problems.LimitReached($"A venue can have at most {o.MaxActivePerVenue} queued or running jobs. Wait for one to finish or cancel it.");
            if (await db.Jobs.CountAsync(j => j.VenueId == venueId, ct) >= o.MaxJobsPerVenue)
                return Problems.LimitReached($"A venue keeps at most {o.MaxJobsPerVenue} jobs. Delete an old job first.");
            if (await db.Jobs.CountAsync(j => active.Contains(j.Status), ct) >= o.MaxActiveGlobal)
                return Problems.LimitReached("The server's job queue is full. Try again later.");

            db.Jobs.Add(job);
            await db.SaveChangesAsync(ct);
            await VenueActivity.TouchAsync(db, venueId, now, ct);
            await tx.CommitAsync(ct);
        }
        signal.Notify();
        return TypedResults.Created($"/api/venues/{venueId}/jobs/{job.Id}", ToResponse(job));
    }

    private static async Task<IResult> List(string venueId, AppDbContext db, CancellationToken ct)
    {
        var list = await db.Jobs.AsNoTracking()
            .Where(j => j.VenueId == venueId)
            .OrderByDescending(j => j.CreatedAt).ThenBy(j => j.Id)
            .Select(j => new { j.Id, j.RequestId, j.Kind, j.Status, j.CompletedRuns, j.TotalRuns, j.EngineVersion, j.Error, j.CreatedAt, j.StartedAt, j.FinishedAt })
            .ToListAsync(ct);
        return TypedResults.Ok(list.Select(j => new JobSummary(j.Id, j.RequestId, j.Kind, StatusName(j.Status), new JobProgress(j.CompletedRuns, j.TotalRuns),
            j.EngineVersion, j.Error, j.CreatedAt, j.StartedAt, j.FinishedAt)).ToList());
    }

    private static async Task<IResult> Get(string venueId, string jobId, HttpResponse response, AppDbContext db, CancellationToken ct)
    {
        var job = await db.Jobs.AsNoTracking().SingleOrDefaultAsync(j => j.Id == jobId && j.VenueId == venueId, ct);
        if (job is null) return Problems.NotFound("Job not found.");
        response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(ToResponse(job));
    }

    private static async Task<IResult> Cancel(string venueId, string jobId, AppDbContext db, JobCancellations cancellations, TimeProvider clock, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        // Queued: cancelled at once (the runner's claim only takes Queued rows, so there is no race).
        var queued = await db.Jobs.Where(j => j.Id == jobId && j.VenueId == venueId && j.Status == JobStatus.Queued)
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, JobStatus.Cancelled).SetProperty(j => j.CancelRequested, true).SetProperty(j => j.FinishedAt, now), ct);
        if (queued == 0)
        {
            var running = await db.Jobs.Where(j => j.Id == jobId && j.VenueId == venueId && j.Status == JobStatus.Running)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.CancelRequested, true), ct);
            // Same process: abort the in-flight run now. Another instance notices the flag at its next heartbeat.
            if (running > 0) cancellations.TryCancel(jobId);
        }
        var job = await db.Jobs.AsNoTracking().SingleOrDefaultAsync(j => j.Id == jobId && j.VenueId == venueId, ct);
        if (job is null) return Problems.NotFound("Job not found.");
        return job.Status switch
        {
            JobStatus.Cancelled => TypedResults.Ok(ToResponse(job)),
            JobStatus.Running or JobStatus.Queued => TypedResults.Accepted($"/api/venues/{venueId}/jobs/{jobId}", ToResponse(job)),
            _ => Problems.Create(StatusCodes.Status409Conflict, "Job already finished", $"The job has status {StatusName(job.Status)} and cannot be cancelled.", "job-finished"),
        };
    }

    private static async Task<IResult> Delete(string venueId, string jobId, AppDbContext db, CancellationToken ct)
    {
        var job = await db.Jobs.AsNoTracking().Where(j => j.Id == jobId && j.VenueId == venueId).Select(j => new { j.Status }).SingleOrDefaultAsync(ct);
        if (job is null) return Problems.NotFound("Job not found.");
        if (job.Status is JobStatus.Queued or JobStatus.Running)
            return Problems.Create(StatusCodes.Status409Conflict, "Job still active", "Cancel the job and wait until it is cancelled before deleting it.", "job-active");
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Runs.Where(r => r.JobId == jobId && r.VenueId == venueId).ExecuteDeleteAsync(ct);
        var deleted = await db.Jobs.Where(j => j.Id == jobId && j.VenueId == venueId && j.Status != JobStatus.Queued && j.Status != JobStatus.Running).ExecuteDeleteAsync(ct);
        if (deleted == 0) return Problems.Create(StatusCodes.Status409Conflict, "Job still active", "The job was requeued meanwhile.", "job-active");
        await tx.CommitAsync(ct);
        return TypedResults.NoContent();
    }

    public static JobResponse ToResponse(Job j) => new(
        j.Id, j.VenueId, j.RequestId, j.Kind, StatusName(j.Status), new JobProgress(j.CompletedRuns, j.TotalRuns), j.EngineVersion, j.Error,
        j.CancelRequested, j.Attempts, j.CreatedAt, j.StartedAt, j.FinishedAt, j.HeartbeatAt,
        JsonNode.Parse(j.Request)!.AsObject(), j.Result is null ? null : JsonNode.Parse(j.Result)!.AsObject());
}
