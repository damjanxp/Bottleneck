namespace Bottleneck.Api.Options;

/// <summary>Document size and count limits (review D5). Section "Limits" in appsettings.json.</summary>
public sealed class LimitsOptions
{
    public const string Section = "Limits";

    /// <summary>Largest venue document accepted, in bytes of UTF-8 JSON.</summary>
    public int MaxVenueBytes { get; set; } = 1024 * 1024;

    /// <summary>Largest scenario document accepted, in bytes.</summary>
    public int MaxScenarioBytes { get; set; } = 256 * 1024;

    /// <summary>Largest client-reported run record, in bytes (spec section 8: 256 KB).</summary>
    public int MaxClientRunBytes { get; set; } = 256 * 1024;

    /// <summary>Deepest JSON nesting accepted (the schema itself needs about 12).</summary>
    public int MaxJsonDepth { get; set; } = 32;

    /// <summary>Most JSON values (objects, arrays, scalars) in one document.</summary>
    public int MaxJsonNodes { get; set; } = 200_000;

    public int MaxScenariosPerVenue { get; set; } = 100;

    /// <summary>Client-reported runs kept per venue (spec section 8: 50).</summary>
    public int MaxClientRunsPerVenue { get; set; } = 50;

    /// <summary>Global cap on stored venues (review D4).</summary>
    public int MaxVenues { get; set; } = 2_000;
}

/// <summary>Background-image uploads (spec section 8, review D5). Section "Uploads".</summary>
public sealed class UploadOptions
{
    public const string Section = "Uploads";

    /// <summary>Where files are stored. Relative paths are resolved against the content root. Never served as static files.</summary>
    public string Path { get; set; } = "storage/uploads";

    public int MaxBytes { get; set; } = 5 * 1024 * 1024;

    /// <summary>Largest width or height in pixels, checked from the file header before decoding.</summary>
    public int MaxSide { get; set; } = 4096;

    public int MaxUploadsPerVenue { get; set; } = 20;

    public long VenueQuotaBytes { get; set; } = 25L * 1024 * 1024;

    public long GlobalQuotaBytes { get; set; } = 2L * 1024 * 1024 * 1024;

    public int JpegQuality { get; set; } = 90;

    /// <summary>Images decoded at the same time (each can take up to 64 MB of pixels).</summary>
    public int MaxConcurrentDecodes { get; set; } = 2;
}

/// <summary>One fixed or sliding window per client IP.</summary>
public sealed class WindowLimit
{
    public int PermitLimit { get; set; }
    public int WindowSeconds { get; set; }
}

/// <summary>Rate limits per client IP (review D4). Section "RateLimits".</summary>
public sealed class RateLimitOptions
{
    public const string Section = "RateLimits";

    /// <summary>Every request except health checks.</summary>
    public WindowLimit Global { get; set; } = new() { PermitLimit = 600, WindowSeconds = 60 };

    /// <summary>Writes (POST, PUT, DELETE) other than the two below.</summary>
    public WindowLimit Writes { get; set; } = new() { PermitLimit = 60, WindowSeconds = 60 };

    public WindowLimit CreateVenue { get; set; } = new() { PermitLimit = 10, WindowSeconds = 3600 };

    public WindowLimit Uploads { get; set; } = new() { PermitLimit = 20, WindowSeconds = 600 };
}

/// <summary>Trusted reverse proxies (Caddy). Section "ForwardedHeaders".</summary>
public sealed class ForwardingOptions
{
    public const string Section = "ForwardedHeaders";

    public bool Enabled { get; set; } = true;

    /// <summary>Proxy addresses whose X-Forwarded-For is trusted.</summary>
    public string[] KnownProxies { get; set; } = [];

    /// <summary>Proxy networks in CIDR form, e.g. the Docker network Caddy runs in.</summary>
    public string[] KnownNetworks { get; set; } = [];

    public int ForwardLimit { get; set; } = 1;
}

/// <summary>Section "Cors".</summary>
public sealed class CorsSettings
{
    public const string Section = "Cors";

    /// <summary>Frontend origins allowed to call the API, e.g. "https://bottleneck.example".</summary>
    public string[] AllowedOrigins { get; set; } = [];
}

/// <summary>Cleanup of abandoned demo data. Section "Retention".</summary>
public sealed class RetentionOptions
{
    public const string Section = "Retention";

    public bool Enabled { get; set; } = true;

    /// <summary>A venue nobody has read or written for this many days is deleted, unless pinned.</summary>
    public int InactiveDays { get; set; } = 90;

    public int IntervalMinutes { get; set; } = 360;

    public int BatchSize { get; set; } = 100;
}

/// <summary>The engine sidecar (apps/sidecar). Section "Sidecar"; in Docker Compose set Sidecar__BaseUrl.</summary>
public sealed class SidecarOptions
{
    public const string Section = "Sidecar";

    /// <summary>Base URL of the sidecar, e.g. http://sidecar:8080 in Compose.</summary>
    public string BaseUrl { get; set; } = "http://localhost:8080";

    /// <summary>Wall-clock budget of one run, passed to the sidecar as timeoutMs (it answers 504 when exceeded).</summary>
    public int RunTimeoutSeconds { get; set; } = 120;

    /// <summary>How often a busy (503) or unreachable sidecar is retried before the job fails.</summary>
    public int MaxRetries { get; set; } = 8;

    /// <summary>First retry delay; doubles each time up to <see cref="MaxRetryDelayMs"/>.</summary>
    public int RetryDelayMs { get; set; } = 250;

    public int MaxRetryDelayMs { get; set; } = 5000;
}

/// <summary>Background jobs: batches and sweeps (spec 6.4, review D1/D2). Section "Jobs".</summary>
public sealed class JobOptions
{
    public const string Section = "Jobs";

    /// <summary>Runs the job runner in this process. Off: jobs are accepted and stay Queued.</summary>
    public bool RunnerEnabled { get; set; } = true;

    /// <summary>Runs of one job sent to the sidecar at the same time (match the sidecar's CONCURRENCY). Jobs themselves run one at a time.</summary>
    public int MaxParallelRuns { get; set; } = 1;

    /// <summary>Queued or running jobs per venue.</summary>
    public int MaxActivePerVenue { get; set; } = 3;

    /// <summary>Queued or running jobs on the whole server.</summary>
    public int MaxActiveGlobal { get; set; } = 50;

    /// <summary>Stored jobs per venue, finished ones included (delete old ones first).</summary>
    public int MaxJobsPerVenue { get; set; } = 20;

    /// <summary>Work budget of one job: runs × simulated hours per run.</summary>
    public double MaxSimulatedHours { get; set; } = 400;

    /// <summary>Most runs in one job.</summary>
    public int MaxRuns { get; set; } = 200;

    public int DefaultBatchSeeds { get; set; } = 20;

    public int MaxBatchSeeds { get; set; } = 100;

    public int DefaultSeedsPerPoint { get; set; } = 5;

    public int MaxSeedsPerPoint { get; set; } = 30;

    /// <summary>Most candidate gate-opening times in one sweep.</summary>
    public int MaxSweepPoints { get; set; } = 24;

    /// <summary>The runner writes a heartbeat (and checks for a cancel from another instance) this often.</summary>
    public int HeartbeatSeconds { get; set; } = 5;

    /// <summary>Fallback poll of the queue table, in case a wake-up signal was missed (another instance enqueued).</summary>
    public int PollSeconds { get; set; } = 30;
}
