using Bottleneck.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Bottleneck.Api.Infrastructure;

/// <summary>Response headers for every API response (spec section 8, review D3).</summary>
public static class SecurityHeaders
{
    /// <summary>The API only returns JSON and images, so nothing may run, frame or load anything.</summary>
    public const string ApiCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        context.Response.OnStarting(() =>
        {
            var h = context.Response.Headers;
            h.XContentTypeOptions = "nosniff";
            h["Referrer-Policy"] = "no-referrer";
            h.XFrameOptions = "DENY";
            // The interactive API reference (Scalar) is a page with scripts; it gets the browser defaults.
            if (!context.Request.Path.StartsWithSegments("/scalar", StringComparison.OrdinalIgnoreCase))
                h.ContentSecurityPolicy = ApiCsp;
            // No cookies are ever issued (sharing works by link, spec section 8).
            h.Remove("Set-Cookie");
            return Task.CompletedTask;
        });
        await next();
    });
}

/// <summary>Bookkeeping on the venue row that must not bump its ETag.</summary>
public static class VenueActivity
{
    /// <summary>Marks the venue as used now (for retention). Does not touch Revision, so editors' ETags stay valid.</summary>
    public static Task TouchAsync(AppDbContext db, string venueId, DateTimeOffset now, CancellationToken ct) =>
        db.Venues.Where(v => v.Id == venueId).ExecuteUpdateAsync(s => s.SetProperty(v => v.LastActivityAt, now), ct);

    /// <summary>On reads, only write when the stored value is more than a day old, so reads stay cheap.</summary>
    public static Task TouchOnReadAsync(AppDbContext db, string venueId, DateTimeOffset now, CancellationToken ct)
    {
        var threshold = now.AddDays(-1);
        return db.Venues.Where(v => v.Id == venueId && v.LastActivityAt < threshold)
            .ExecuteUpdateAsync(s => s.SetProperty(v => v.LastActivityAt, now), ct);
    }

    /// <summary>
    /// Locks the venue row for the current transaction, so per-venue caps (runs, scenarios, upload quota)
    /// cannot be exceeded by concurrent requests.
    /// </summary>
    public static Task LockAsync(AppDbContext db, string venueId, CancellationToken ct) =>
        db.Database.ExecuteSqlAsync($"SELECT 1 FROM venues WHERE id = {venueId} FOR UPDATE", ct);
}
