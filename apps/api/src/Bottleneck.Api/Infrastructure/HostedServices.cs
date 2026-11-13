using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Uploads;
using Bottleneck.Api.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Infrastructure;

/// <summary>
/// Applies EF Core migrations before anything else starts (IHostedLifecycleService.StartingAsync runs
/// before every hosted service's StartAsync, including the web server's). Controlled by Database:MigrateOnStartup.
/// </summary>
public sealed class DatabaseMigrator(IServiceProvider services, ILogger<DatabaseMigrator> log) : IHostedLifecycleService
{
    public async Task StartingAsync(CancellationToken cancellationToken)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken)).ToList();
        if (pending.Count == 0) return;
        log.LogInformation("Applying {Count} database migrations", pending.Count);
        await db.Database.MigrateAsync(cancellationToken);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>Deletes venues nobody has used for Retention:InactiveDays (abandoned demo data), with their files.</summary>
public sealed class RetentionCleaner(AppDbContext db, UploadStorage storage, IOptions<RetentionOptions> options, ILogger<RetentionCleaner> log)
{
    /// <summary>One pass; returns how many venues were deleted.</summary>
    public async Task<int> RunOnceAsync(DateTimeOffset now, CancellationToken ct)
    {
        var o = options.Value;
        var cutoff = now.AddDays(-Math.Max(1, o.InactiveDays));
        var deleted = 0;
        while (!ct.IsCancellationRequested)
        {
            var ids = await db.Venues.AsNoTracking()
                .Where(v => !v.Pinned && v.LastActivityAt < cutoff)
                .OrderBy(v => v.LastActivityAt).ThenBy(v => v.Id)
                .Select(v => v.Id)
                .Take(Math.Max(1, o.BatchSize))
                .ToListAsync(ct);
            if (ids.Count == 0) break;
            foreach (var id in ids)
            {
                // Re-check the cutoff in the DELETE itself, in case the venue was used a moment ago.
                var n = await db.Venues.Where(v => v.Id == id && !v.Pinned && v.LastActivityAt < cutoff).ExecuteDeleteAsync(ct);
                if (n == 0) continue;
                storage.DeleteVenueFiles(id);
                deleted++;
            }
            if (ids.Count < o.BatchSize) break;
        }
        if (deleted > 0) log.LogInformation("Retention cleanup deleted {Count} inactive venues", deleted);
        return deleted;
    }
}

public sealed class RetentionService(IServiceProvider services, IOptions<RetentionOptions> options, TimeProvider clock, ILogger<RetentionService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(Math.Max(1, options.Value.IntervalMinutes)), clock);
        do
        {
            try
            {
                await using var scope = services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<RetentionCleaner>().RunOnceAsync(clock.GetUtcNow(), stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Retention cleanup failed");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
