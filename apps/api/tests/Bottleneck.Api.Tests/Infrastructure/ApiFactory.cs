using System.Collections.Concurrent;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Serilog.Core;
using Serilog.Events;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(Bottleneck.Api.Tests.Infrastructure.PostgresFixture))]

namespace Bottleneck.Api.Tests.Infrastructure;

/// <summary>
/// One PostgreSQL container for the whole test run (Testcontainers). Needs Docker; if Docker is not
/// running, every integration test fails here: they are never skipped or faked.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public async ValueTask InitializeAsync() => await _container.StartAsync();

    public async ValueTask DisposeAsync() => await _container.DisposeAsync();

    /// <summary>A connection string for a fresh database (created by the API's migrations on startup).</summary>
    public string NewDatabase()
    {
        var builder = new Npgsql.NpgsqlConnectionStringBuilder(_container.GetConnectionString())
        {
            Database = "test_" + Guid.NewGuid().ToString("N")[..12],
        };
        return builder.ConnectionString;
    }
}

/// <summary>Collects every log event, so tests can check that no secret is ever logged.</summary>
public sealed class CapturingSink : ILogEventSink
{
    public ConcurrentQueue<LogEvent> Events { get; } = new();

    public void Emit(LogEvent logEvent) => Events.Enqueue(logEvent);

    /// <summary>Every event rendered with all its properties (and exception), for "does not contain" checks.</summary>
    public string AllText() => string.Join("\n", Events.Select(e =>
        e.RenderMessage() + " " + string.Join(" ", e.Properties.Select(p => $"{p.Key}={p.Value}")) + " " + e.Exception));
}

/// <summary>The API in-process, on its own database and upload folder, with generous rate limits unless overridden.</summary>
public sealed class ApiFactory(PostgresFixture postgres, IReadOnlyDictionary<string, string?>? overrides = null) : WebApplicationFactory<Program>
{
    public string UploadPath { get; } = Path.Combine(Path.GetTempPath(), "bottleneck-tests", Guid.NewGuid().ToString("N"));

    public CapturingSink Logs { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Bottleneck"] = postgres.NewDatabase(),
            ["Uploads:Path"] = UploadPath,
            ["Retention:Enabled"] = "false",
            ["Serilog:Console"] = "false",
            ["RateLimits:Global:PermitLimit"] = "100000",
            ["RateLimits:Writes:PermitLimit"] = "100000",
            ["RateLimits:CreateVenue:PermitLimit"] = "100000",
            ["RateLimits:Uploads:PermitLimit"] = "100000",
            ["Cors:AllowedOrigins:0"] = "https://frontend.test",
        };
        foreach (var (k, v) in overrides ?? new Dictionary<string, string?>()) settings[k] = v;
        // UseSetting (not ConfigureAppConfiguration) so values read before Build() in Program.cs see them.
        foreach (var (k, v) in settings) builder.UseSetting(k, v);
        builder.ConfigureTestServices(services => services.AddSingleton<ILogEventSink>(Logs));
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        try
        {
            if (Directory.Exists(UploadPath)) Directory.Delete(UploadPath, recursive: true);
        }
        catch (IOException)
        {
            // best effort
        }
    }
}

/// <summary>Shared default API for a test class.</summary>
public sealed class DefaultApi(PostgresFixture postgres) : IAsyncLifetime
{
    public ApiFactory Factory { get; } = new(postgres);

    public ValueTask InitializeAsync()
    {
        _ = Factory.Server; // start the host (runs migrations)
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => Factory.DisposeAsync();
}
