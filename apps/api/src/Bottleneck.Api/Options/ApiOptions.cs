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
