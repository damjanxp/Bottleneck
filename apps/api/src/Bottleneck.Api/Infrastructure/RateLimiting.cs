using System.Globalization;
using System.Threading.RateLimiting;
using Bottleneck.Api.Options;
using Microsoft.AspNetCore.RateLimiting;

namespace Bottleneck.Api.Infrastructure;

public static class RateLimitPolicies
{
    public const string Writes = "writes";
    public const string CreateVenue = "create-venue";
    public const string Uploads = "uploads";

    /// <summary>
    /// Fixed windows per client IP (they report Retry-After; sliding windows do not) (review D4). The IP is the connection's address after
    /// UseForwardedHeaders, which only believes X-Forwarded-For from the configured proxy (Caddy).
    /// A global limiter covers every request; writes get a stricter per-route policy on top.
    /// </summary>
    public static IServiceCollection AddBottleneckRateLimits(this IServiceCollection services, RateLimitOptions limits)
    {
        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(http =>
                http.Request.Path.StartsWithSegments("/health")
                    ? RateLimitPartition.GetNoLimiter("health")
                    : Window("global:" + ClientKey(http), limits.Global));
            o.AddPolicy(Writes, http => Window(ClientKey(http), limits.Writes));
            o.AddPolicy(CreateVenue, http => Window(ClientKey(http), limits.CreateVenue));
            o.AddPolicy(Uploads, http => Window(ClientKey(http), limits.Uploads));
            o.OnRejected = async (ctx, ct) =>
            {
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry))
                    ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retry.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                await Problems.Create(StatusCodes.Status429TooManyRequests, "Too many requests",
                    "This client sent too many requests. Wait a moment and try again.", "rate-limited").ExecuteAsync(ctx.HttpContext);
            };
        });
        return services;
    }

    private static string ClientKey(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    private static RateLimitPartition<string> Window(string key, WindowLimit limit) =>
        RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = Math.Max(1, limit.PermitLimit),
            Window = TimeSpan.FromSeconds(Math.Max(1, limit.WindowSeconds)),
            QueueLimit = 0,
            AutoReplenishment = true,
        });
}
