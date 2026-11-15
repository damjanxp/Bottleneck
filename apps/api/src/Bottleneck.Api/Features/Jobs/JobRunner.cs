using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Bottleneck.Api.Data;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Jobs;

/// <summary>
/// Wakes the runner when a job is queued. Only a hint (triage D2): the jobs table is the queue, and the runner
/// also polls it every Jobs:PollSeconds, so a lost signal only delays a job.
/// </summary>
public sealed class JobSignal
{
    private readonly Channel<bool> _channel = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });

    public void Notify() => _channel.Writer.TryWrite(true);

    /// <summary>Waits for a signal or the timeout, whichever comes first.</summary>
    public async Task WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            await _channel.Reader.ReadAsync(cts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // timeout: poll the table
        }
    }
}

/// <summary>Cancellation of the job running in this process, so a cancel request aborts the in-flight sidecar call at once.</summary>
public sealed class JobCancellations
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new(StringComparer.Ordinal);

    public void Register(string jobId, CancellationTokenSource cts) => _running[jobId] = cts;

    public void Unregister(string jobId) => _running.TryRemove(jobId, out _);

    public bool TryCancel(string jobId)
    {
        if (!_running.TryGetValue(jobId, out var cts)) return false;
        try
        {
            cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
        return true;
    }
}

/// <summary>
/// Runs jobs one at a time (triage D1) through the engine sidecar (D2).
/// <list type="number">
/// <item>Startup: jobs left Running by a stopped or crashed process go back to Queued.</item>
/// <item>Claim: one atomic UPDATE … WHERE id = (SELECT … ORDER BY created_at FOR UPDATE SKIP LOCKED) RETURNING id, so two
/// runners (or two API instances) never take the same job.</item>
/// <item>Run: the plan is rebuilt from the stored request; runs already stored for the job (an earlier attempt) are reused,
/// the rest go to the sidecar (up to Jobs:MaxParallelRuns at a time). Each finished run is stored as a Run with origin
/// "job" and progress is bumped in the same transaction.</item>
/// <item>A heartbeat task updates heartbeat_at and notices a cancel requested through the database.</item>
/// <item>Cancel: the job's token is cancelled, which aborts the in-flight HTTP request; the sidecar stops the run when
/// its client disconnects. No further runs start.</item>
/// <item>Shutdown: the job goes back to Queued (it resumes on the next start).</item>
/// </list>
/// </summary>
public sealed class JobRunner(
    IServiceProvider services,
    JobSignal signal,
    JobCancellations cancellations,
    IOptions<JobOptions> options,
    TimeProvider clock,
    ILogger<JobRunner> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.RunnerEnabled) return;
        await Task.Yield();
        try
        {
            await RequeueInterruptedAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex, "Could not requeue interrupted jobs");
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var jobId = await ClaimAsync(stoppingToken);
                if (jobId is null)
                {
                    await signal.WaitAsync(TimeSpan.FromSeconds(Math.Max(1, options.Value.PollSeconds)), stoppingToken);
                    continue;
                }
                await RunJobAsync(jobId, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Job runner loop failed; retrying shortly");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    /// <summary>D2: on startup, Running → Queued (this process is the only runner, so nothing is really running).</summary>
    internal async Task<int> RequeueInterruptedAsync(CancellationToken ct)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var n = await db.Jobs.Where(j => j.Status == JobStatus.Running)
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, JobStatus.Queued), ct);
        if (n > 0 && log.IsEnabled(LogLevel.Information)) log.LogInformation("Requeued {Count} interrupted jobs", n);
        return n;
    }

    internal async Task<string?> ClaimAsync(CancellationToken ct)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = clock.GetUtcNow();
        var ids = await db.Database.SqlQuery<string>($"""
            UPDATE jobs SET status = 'Running', attempts = attempts + 1, started_at = COALESCE(started_at, {now}), heartbeat_at = {now}
            WHERE id = (
                SELECT id FROM jobs WHERE status = 'Queued'
                ORDER BY created_at, id
                LIMIT 1
                FOR UPDATE SKIP LOCKED)
            RETURNING id AS "Value"
            """).ToListAsync(ct);
        return ids.Count == 0 ? null : ids[0];
    }

    private async Task RunJobAsync(string jobId, CancellationToken stoppingToken)
    {
        using var jobCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        cancellations.Register(jobId, jobCts);
        var o = options.Value;
        try
        {
            Job job;
            await using (var scope = services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                job = await db.Jobs.AsNoTracking().SingleAsync(j => j.Id == jobId, stoppingToken);
            }
            if (job.CancelRequested)
            {
                await FinishAsync(jobId, JobStatus.Cancelled, null, null, null, CancellationToken.None);
                return;
            }
            if (log.IsEnabled(LogLevel.Information))
                log.LogInformation("Job {JobId} ({Kind}) started, attempt {Attempt}", jobId, job.Kind, job.Attempts);

            var venue = JsonNode.Parse(job.VenueSnapshot)!.AsObject();
            var plan = JobPlan.FromStored(JsonNode.Parse(job.Request)!.AsObject(), venue);
            var venueJson = job.VenueSnapshot;
            var venueHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(venueJson)))[..16];

            // Resume: reuse runs stored by an earlier attempt of this job.
            var values = new ConcurrentDictionary<int, IReadOnlyDictionary<string, double>>();
            string? engineVersion = job.EngineVersion;
            await using (var scope = services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var stored = await db.Runs.AsNoTracking()
                    .Where(r => r.JobId == jobId && r.JobRunIndex != null)
                    .Select(r => new { r.Id, Index = r.JobRunIndex!.Value, r.EngineVersion, r.Record })
                    .ToListAsync(stoppingToken);
                foreach (var r in stored)
                {
                    if (r.Index >= plan.TotalRuns) continue;
                    values[r.Index] = MetricExtractor.Extract(JsonNode.Parse(r.Record)!["metrics"]!.AsObject());
                    engineVersion ??= r.EngineVersion;
                }
                await db.Jobs.Where(j => j.Id == jobId)
                    .ExecuteUpdateAsync(s => s.SetProperty(j => j.CompletedRuns, values.Count), stoppingToken);
            }

            using var heartbeat = StartHeartbeat(jobId, jobCts, TimeSpan.FromSeconds(Math.Max(1, o.HeartbeatSeconds)));
            var pending = plan.Runs().Where(r => !values.ContainsKey(r.Index)).ToList();
            var engineLock = new object();
            try
            {
                await Parallel.ForEachAsync(pending, new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, o.MaxParallelRuns), CancellationToken = jobCts.Token },
                    async (spec, ct) =>
                    {
                        await using var scope = services.CreateAsyncScope();
                        var sidecar = scope.ServiceProvider.GetRequiredService<SidecarClient>();
                        SidecarRun result;
                        try
                        {
                            result = await sidecar.RunAsync(venueJson, spec.Point.Scenario, spec.Seed, spec.Point.Overrides, ct);
                        }
                        catch (OperationCanceledException) when (ct.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
                        {
                            if (log.IsEnabled(LogLevel.Information))
                                log.LogInformation("Job {JobId}: in-flight run {Index} aborted by cancel", jobId, spec.Index);
                            throw;
                        }
                        lock (engineLock)
                        {
                            engineVersion ??= result.EngineVersion;
                            if (engineVersion != result.EngineVersion)
                                throw new SidecarRunException($"The engine version changed during the job ({engineVersion} → {result.EngineVersion}); results from different engines are not mixed.");
                        }
                        await StoreRunAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), job, plan, spec, result, venueHash, ct);
                        values[spec.Index] = MetricExtractor.Extract(result.Metrics);
                    });
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Shutdown: give the job back to the queue; stored runs are reused on the next attempt.
                await using var scope = services.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await db.Jobs.Where(j => j.Id == jobId && j.Status == JobStatus.Running)
                    .ExecuteUpdateAsync(s => s.SetProperty(j => j.Status, JobStatus.Queued), CancellationToken.None);
                if (log.IsEnabled(LogLevel.Information))
                    log.LogInformation("Job {JobId} returned to the queue at shutdown", jobId);
                throw;
            }
            catch (OperationCanceledException) when (jobCts.IsCancellationRequested)
            {
                await FinishAsync(jobId, JobStatus.Cancelled, null, null, engineVersion, CancellationToken.None);
                if (log.IsEnabled(LogLevel.Information))
                    log.LogInformation("Job {JobId} cancelled after {Done} of {Total} runs", jobId, values.Count, plan.TotalRuns);
                return;
            }

            var resultJson = JobAggregator.Build(plan, values.ToDictionary(kv => kv.Key, kv => kv.Value), engineVersion ?? "unknown");
            await FinishAsync(jobId, JobStatus.Succeeded, DocumentPipeline.Serialize(resultJson), null, engineVersion, CancellationToken.None);
            if (log.IsEnabled(LogLevel.Information))
                log.LogInformation("Job {JobId} succeeded ({Total} runs)", jobId, plan.TotalRuns);
        }
        catch (SidecarRunException ex)
        {
            if (log.IsEnabled(LogLevel.Warning))
                log.LogWarning("Job {JobId} failed: {Error}", jobId, ex.Message);
            await FinishAsync(jobId, JobStatus.Failed, null, ex.Message, null, CancellationToken.None);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex, "Job {JobId} failed unexpectedly", jobId);
            await FinishAsync(jobId, JobStatus.Failed, null, "Internal error while running the job.", null, CancellationToken.None);
        }
        finally
        {
            cancellations.Unregister(jobId);
        }
    }

    private async Task StoreRunAsync(AppDbContext db, Job job, JobPlan plan, RunSpec spec, SidecarRun result, string venueHash, CancellationToken ct)
    {
        var id = Secrets.NewId();
        var now = clock.GetUtcNow();
        var record = new JsonObject
        {
            ["schemaVersion"] = JsonSchemaValidator.SchemaVersion,
            ["id"] = id,
            ["engineVersion"] = result.EngineVersion,
            ["createdAt"] = now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
            ["origin"] = RunOrigins.Job,
            ["scenario"] = JobPlan.Apply(spec.Point.Scenario, spec.Seed, spec.Point.Overrides),
            ["venueHash"] = venueHash,
            ["parameters"] = result.Parameters,
            ["metrics"] = result.Metrics,
            ["metricsHash"] = result.MetricsHash,
        };
        var json = DocumentPipeline.Serialize(record);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var run = new Run
        {
            Id = id,
            VenueId = job.VenueId,
            ScenarioId = job.ScenarioId,
            JobId = job.Id,
            JobRunIndex = spec.Index,
            Origin = RunOrigins.Job,
            EngineVersion = result.EngineVersion,
            Seed = spec.Seed,
            MetricsHash = result.MetricsHash,
            SchemaVersion = JsonSchemaValidator.SchemaVersion,
            Record = json,
            SizeBytes = Encoding.UTF8.GetByteCount(json),
            CreatedAt = now,
        };
        db.Runs.Add(run);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23503" } && run.ScenarioId is not null)
        {
            // The scenario was deleted while the job ran (EF rolled back to its savepoint): keep the run without the link.
            run.ScenarioId = null;
            await db.SaveChangesAsync(ct);
        }
        await db.Jobs.Where(j => j.Id == job.Id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.CompletedRuns, j => j.CompletedRuns + 1)
                .SetProperty(j => j.EngineVersion, result.EngineVersion)
                .SetProperty(j => j.HeartbeatAt, now), ct);
        await tx.CommitAsync(ct);
    }

    private async Task FinishAsync(string jobId, JobStatus status, string? result, string? error, string? engineVersion, CancellationToken ct)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = clock.GetUtcNow();
        await db.Jobs.Where(j => j.Id == jobId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, status)
                .SetProperty(j => j.Result, result)
                .SetProperty(j => j.Error, error)
                .SetProperty(j => j.EngineVersion, j => engineVersion ?? j.EngineVersion)
                .SetProperty(j => j.FinishedAt, now)
                .SetProperty(j => j.HeartbeatAt, now), ct);
    }

    /// <summary>Writes heartbeat_at every interval and cancels the job if a cancel was requested through the database.</summary>
    private Heartbeat StartHeartbeat(string jobId, CancellationTokenSource jobCts, TimeSpan interval)
    {
        var stop = new CancellationTokenSource();
        var task = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(interval, clock);
            try
            {
                while (await timer.WaitForNextTickAsync(stop.Token))
                {
                    await using var scope = services.CreateAsyncScope();
                    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var now = clock.GetUtcNow();
                    await db.Jobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(s => s.SetProperty(j => j.HeartbeatAt, now), stop.Token);
                    if (await db.Jobs.AnyAsync(j => j.Id == jobId && (j.CancelRequested || j.Status != JobStatus.Running), stop.Token))
                    {
                        await jobCts.CancelAsync();
                        return;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopped
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Heartbeat of job {JobId} failed", jobId);
            }
        });
        return new Heartbeat(stop, task);
    }

    private sealed class Heartbeat(CancellationTokenSource stop, Task task) : IDisposable
    {
        public void Dispose()
        {
            stop.Cancel();
            try
            {
                task.Wait(TimeSpan.FromSeconds(5));
            }
            catch (AggregateException)
            {
                // logged inside
            }
            stop.Dispose();
        }
    }
}
