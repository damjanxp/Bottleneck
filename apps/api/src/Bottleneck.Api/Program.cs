using System.Net;
using Bottleneck.Api.Data;
using Bottleneck.Api.Features.Runs;
using Bottleneck.Api.Features.Scenarios;
using Bottleneck.Api.Features.Uploads;
using Bottleneck.Api.Features.Venues;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Bottleneck.Schema;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Scalar.AspNetCore;
using Serilog;
using Serilog.Events;
using Serilog.Formatting.Compact;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;

// ---- Logging: Serilog, JSON to stdout. Request logs carry method, path, status and timing only:
// no query strings (read tokens), no headers (edit keys), no bodies.
builder.Services.AddSerilog((services, lc) =>
{
    lc.ReadFrom.Configuration(config)
        .ReadFrom.Services(services) // extra sinks registered in DI (the tests capture logs this way)
        .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
        .MinimumLevel.Override("Microsoft.EntityFrameworkCore", LogEventLevel.Warning)
        .Enrich.FromLogContext();
    if (config.GetValue("Serilog:Console", true)) lc.WriteTo.Console(new RenderedCompactJsonFormatter());
}, preserveStaticLogger: true); // no global Log.Logger: every host (and every test host) keeps its own

// ---- Options
builder.Services.Configure<LimitsOptions>(config.GetSection(LimitsOptions.Section));
builder.Services.Configure<UploadOptions>(config.GetSection(UploadOptions.Section));
builder.Services.Configure<RetentionOptions>(config.GetSection(RetentionOptions.Section));
var rateLimits = config.GetSection(RateLimitOptions.Section).Get<RateLimitOptions>() ?? new RateLimitOptions();
var forwarding = config.GetSection(ForwardingOptions.Section).Get<ForwardingOptions>() ?? new ForwardingOptions();
var cors = config.GetSection(CorsSettings.Section).Get<CorsSettings>() ?? new CorsSettings();
var uploadOptions = config.GetSection(UploadOptions.Section).Get<UploadOptions>() ?? new UploadOptions();

builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;
    // The largest body any route accepts; each route lowers it further.
    k.Limits.MaxRequestBodySize = uploadOptions.MaxBytes + 64 * 1024;
});

// ---- Database
var connectionString = config.GetConnectionString("Bottleneck")
    ?? throw new InvalidOperationException("ConnectionStrings:Bottleneck is not set.");
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention());
if (config.GetValue("Database:MigrateOnStartup", true))
    builder.Services.AddHostedService<DatabaseMigrator>();

// ---- Schema validation and migrations (shared /schema files)
builder.Services.AddSingleton<IDocumentSchemaValidator, JsonSchemaValidator>();
builder.Services.AddSingleton(sp => new DocumentMigrator(sp.GetRequiredService<IDocumentSchemaValidator>(), sp.GetServices<IDocumentMigration>()));
builder.Services.AddSingleton<DocumentPipeline>();
builder.Services.AddSingleton(TimeProvider.System);

// ---- Uploads, retention
builder.Services.AddSingleton<UploadStorage>();
builder.Services.AddSingleton<ImageProcessor>();
builder.Services.AddScoped<RetentionCleaner>();
builder.Services.AddHostedService<RetentionService>();

// ---- Sharing without logins: an authorization policy per capability (spec section 8)
builder.Services.AddScoped<IAuthorizationHandler, VenueAccessHandler>();
builder.Services.AddSingleton<Microsoft.AspNetCore.Authorization.IAuthorizationMiddlewareResultHandler, VenueAuthorizationResultHandler>();
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(VenuePolicies.Read, p => p.AddRequirements(new VenueAccessRequirement(VenueAccessLevel.Read)))
    .AddPolicy(VenuePolicies.Edit, p => p.AddRequirements(new VenueAccessRequirement(VenueAccessLevel.Edit)));

// ---- Errors as ProblemDetails, everywhere
builder.Services.AddProblemDetails();

// ---- Rate limits, forwarded headers, CORS
builder.Services.AddBottleneckRateLimits(rateLimits);
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = forwarding.ForwardLimit;
    // Trust only the configured proxy (Caddy); loopback stays trusted by default.
    foreach (var proxy in forwarding.KnownProxies) o.KnownProxies.Add(IPAddress.Parse(proxy));
    foreach (var network in forwarding.KnownNetworks) o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
});
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(cors.AllowedOrigins)
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .WithHeaders("Content-Type", "If-Match", VenuePolicies.EditKeyHeader, VenuePolicies.ReadTokenHeader)
    .WithExposedHeaders("ETag", "Location", "Retry-After")
    .SetPreflightMaxAge(TimeSpan.FromMinutes(10))));

// ---- Health checks and OpenAPI
builder.Services.AddHealthChecks().AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
builder.Services.AddOpenApi(o => o.AddDocumentTransformer<CredentialSchemesTransformer>());

var app = builder.Build();

if (forwarding.Enabled) app.UseForwardedHeaders();
app.UseSerilogRequestLogging(o =>
{
    o.Logger = app.Services.GetRequiredService<Serilog.ILogger>();
    o.MessageTemplate = "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0} ms";
    o.GetLevel = (http, _, ex) => ex is not null || http.Response.StatusCode >= 500 ? LogEventLevel.Error : LogEventLevel.Information;
});
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseSecurityHeaders();
app.UseRouting();
app.UseCors();
app.UseRateLimiter();
app.UseAuthorization();

app.MapHealthChecks("/health", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

if (config.GetValue("OpenApi:Enabled", true))
{
    app.MapOpenApi("/openapi/{documentName}.json");
    app.MapScalarApiReference("/scalar", o => o.WithTitle("Bottleneck API"));
}

var venue = app.MapVenueEndpoints();
venue.MapScenarioEndpoints();
venue.MapRunEndpoints();
venue.MapUploadEndpoints();

app.Run();

/// <summary>Entry point; public so the integration tests can host it with WebApplicationFactory.</summary>
public partial class Program;
