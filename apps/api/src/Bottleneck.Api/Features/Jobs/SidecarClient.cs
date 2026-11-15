using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Bottleneck.Api.Options;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Jobs;

/// <summary>A sidecar answer the job cannot recover from (400, 404, 413, 422, 504 or retries used up).</summary>
public sealed class SidecarRunException(string message, int? status = null) : Exception(message)
{
    public int? Status { get; } = status;
}

/// <summary>One successful run: the sidecar's 200 body.</summary>
public sealed record SidecarRun(string EngineVersion, long Seed, string MetricsHash, JsonObject Metrics, JsonObject Parameters, bool Drained, bool Deadlock, double SimulatedSeconds, long WallMs);

/// <summary>
/// Calls the engine sidecar (apps/sidecar/src/server.ts). POST /run is retried on 503 (busy) and on connection
/// failures with exponential backoff; every other error fails the run. Cancelling the token aborts the HTTP
/// request, and the sidecar stops the run when its client disconnects.
/// </summary>
public sealed class SidecarClient(HttpClient http, IOptions<SidecarOptions> options, ILogger<SidecarClient> log)
{
    public async Task<SidecarRun> RunAsync(string venueJson, JsonObject scenario, long seed, JsonObject? overrides, CancellationToken ct)
    {
        var o = options.Value;
        // The venue is already JSON text; build the body by hand instead of parsing a 1 MB document again.
        var body = new StringBuilder(venueJson.Length + 4096)
            .Append("{\"venue\":").Append(venueJson)
            .Append(",\"scenario\":").Append(scenario.ToJsonString())
            .Append(",\"seed\":").Append(seed)
            .Append(overrides is null ? "" : ",\"overrides\":" + overrides.ToJsonString())
            .Append(",\"timeoutMs\":").Append(o.RunTimeoutSeconds * 1000L)
            .Append('}').ToString();

        var delay = Math.Max(10, o.RetryDelayMs);
        for (var attempt = 0; ; attempt++)
        {
            string? retryReason;
            try
            {
                using var content = new StringContent(body, Encoding.UTF8, "application/json");
                using var response = await http.PostAsync("run", content, ct);
                if (response.IsSuccessStatusCode)
                {
                    var json = (await response.Content.ReadFromJsonAsync<JsonObject>(ct))!;
                    // Detach the two big members, so they can go straight into the run record.
                    json.Remove("metrics", out var metrics);
                    json.Remove("parameters", out var parameters);
                    return new SidecarRun(
                        (string)json["engineVersion"]!, (long)json["seed"]!, (string)json["metricsHash"]!,
                        metrics!.AsObject(), parameters!.AsObject(),
                        (bool)json["drained"]!, (bool)json["deadlock"]!, (double)json["simulatedSeconds"]!, (long?)json["wallMs"] ?? 0);
                }
                if (response.StatusCode != HttpStatusCode.ServiceUnavailable)
                {
                    var detail = await ReadDetailAsync(response, ct);
                    throw new SidecarRunException(response.StatusCode == HttpStatusCode.GatewayTimeout
                        ? $"A run took longer than {o.RunTimeoutSeconds} s (seed {seed})."
                        : $"The engine sidecar refused a run (seed {seed}): {(int)response.StatusCode} {detail}", (int)response.StatusCode);
                }
                retryReason = "busy (503)";
            }
            catch (HttpRequestException ex)
            {
                retryReason = "unreachable: " + ex.Message;
            }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new SidecarRunException($"No answer from the engine sidecar within the HTTP timeout (seed {seed}).");
            }

            if (attempt >= o.MaxRetries)
                throw new SidecarRunException($"The engine sidecar is {retryReason}; gave up after {attempt + 1} attempts.");
            if (log.IsEnabled(LogLevel.Information))
                log.LogInformation("Sidecar {Reason}; retrying in {Delay} ms", retryReason, delay);
            await Task.Delay(delay, ct);
            delay = Math.Min(delay * 2, Math.Max(delay, o.MaxRetryDelayMs));
        }
    }

    private static async Task<string> ReadDetailAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var problem = await response.Content.ReadFromJsonAsync<JsonObject>(ct);
            var detail = (string?)problem?["detail"] ?? "";
            return detail.Length > 500 ? detail[..500] : detail;
        }
        catch (System.Text.Json.JsonException)
        {
            return "";
        }
    }
}
