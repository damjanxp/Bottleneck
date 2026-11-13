namespace Bottleneck.Api.Data;

/// <summary>
/// A venue and its sharing credentials. The document (the /schema venue) is jsonb; id, name,
/// schemaVersion and timestamps are columns (spec section 8, Fixed).
/// </summary>
public sealed class Venue
{
    /// <summary>Public, unguessable id: 128 random bits, base32 (26 characters).</summary>
    public required string Id { get; set; }
    public required string Name { get; set; }
    public int SchemaVersion { get; set; }
    /// <summary>The venue document as JSON text, stored as jsonb.</summary>
    public required string Document { get; set; }
    /// <summary>Read token for share links; regenerable. 256 random bits, base64url.</summary>
    public required string ReadToken { get; set; }
    /// <summary>SHA-256 of the 256-bit edit key. The key itself is never stored.</summary>
    public required byte[] EditKeyHash { get; set; }
    /// <summary>Optimistic-concurrency token, sent as the ETag. Bumped only when the document changes.</summary>
    public long Revision { get; set; }
    /// <summary>Exempt from retention cleanup (examples). Only settable in the database.</summary>
    public bool Pinned { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    /// <summary>Last read or write of the venue or anything in it; drives retention cleanup.</summary>
    public DateTimeOffset LastActivityAt { get; set; }

    public List<Scenario> Scenarios { get; set; } = [];
    public List<Run> Runs { get; set; } = [];
    public List<Upload> Uploads { get; set; } = [];
    public List<Job> Jobs { get; set; } = [];
}

public sealed class Scenario
{
    public required string Id { get; set; }
    public required string VenueId { get; set; }
    public required string Name { get; set; }
    public int SchemaVersion { get; set; }
    public required string Document { get; set; }
    public long Revision { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public static class RunOrigins
{
    public const string Job = "job";
    public const string ClientReported = "clientReported";
}

/// <summary>One simulation run. Immutable once stored.</summary>
public sealed class Run
{
    public required string Id { get; set; }
    public required string VenueId { get; set; }
    /// <summary>The stored scenario it ran, if any (a run may come from an unsaved scenario).</summary>
    public string? ScenarioId { get; set; }
    /// <summary>The job that produced it (origin "job"), if any.</summary>
    public string? JobId { get; set; }
    /// <summary>"job" (trusted, computed by the backend) or "clientReported" (uploaded from a browser).</summary>
    public required string Origin { get; set; }
    public required string EngineVersion { get; set; }
    public long Seed { get; set; }
    public required string MetricsHash { get; set; }
    public int SchemaVersion { get; set; }
    /// <summary>The run record (/schema run) as jsonb.</summary>
    public required string Record { get; set; }
    public int SizeBytes { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>A background image. Bytes live on disk under a server-generated name, outside any web root.</summary>
public sealed class Upload
{
    /// <summary>Server-generated id; also the file name (plus extension).</summary>
    public required string Id { get; set; }
    public required string VenueId { get; set; }
    /// <summary>image/png or image/jpeg, decided by magic bytes and fixed at upload.</summary>
    public required string ContentType { get; set; }
    public long Bytes { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public enum JobStatus
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

/// <summary>
/// Placeholder for the job runner (next wave; triage D1/D2). The table is the real queue:
/// the runner claims the oldest Queued row, a Channel only wakes it up, and on startup Running rows
/// go back to Queued. (VenueId, RequestId) is unique, so resubmitting the same request is idempotent.
/// </summary>
public sealed class Job
{
    public required string Id { get; set; }
    public required string VenueId { get; set; }
    /// <summary>Client-chosen idempotency key, unique per venue.</summary>
    public required string RequestId { get; set; }
    /// <summary>"batch" or "sweep".</summary>
    public required string Kind { get; set; }
    public JobStatus Status { get; set; }
    /// <summary>The submitted request (scenario, seeds, sweep range) as jsonb.</summary>
    public required string Request { get; set; }
    /// <summary>Runs finished so far, and runs in total (the work budget from D1).</summary>
    public int CompletedRuns { get; set; }
    public int TotalRuns { get; set; }
    /// <summary>The aggregated result (mean, CI, sweep answer) as jsonb.</summary>
    public string? Result { get; set; }
    public string? Error { get; set; }
    /// <summary>Engine version that produced the result (D2): results from different engines are not mixed.</summary>
    public string? EngineVersion { get; set; }
    public bool CancelRequested { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public DateTimeOffset? HeartbeatAt { get; set; }

    public List<Run> Runs { get; set; } = [];
}
