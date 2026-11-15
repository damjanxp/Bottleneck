using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

[assembly: AssemblyFixture(typeof(Bottleneck.Api.Tests.Infrastructure.SidecarFixture))]

namespace Bottleneck.Api.Tests.Infrastructure;

/// <summary>
/// The real engine sidecar (apps/sidecar) for the job tests, started on first use: it is rebuilt from the engine
/// source (esbuild, under a second) so it can never be stale, then run with `node dist/server.mjs` on a free port.
/// Needs Node and `npm ci` at the repository root. Set BOTTLENECK_SIDECAR_URL to use a sidecar that is already
/// running instead (e.g. the Docker image).
/// </summary>
public sealed class SidecarFixture : IAsyncLifetime
{
    public const int Concurrency = 4;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly StringBuilder _output = new();
    private Process? _process;
    private string? _url;

    public static string RepoRoot { get; } = FindRepoRoot();

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    /// <summary>The sidecar's base URL, starting it if needed.</summary>
    public async Task<string> UrlAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (_url is not null) return _url;
            var external = Environment.GetEnvironmentVariable("BOTTLENECK_SIDECAR_URL");
            if (!string.IsNullOrEmpty(external))
            {
                await WaitHealthyAsync(external, null);
                return _url = external;
            }

            var sidecarDir = Path.Combine(RepoRoot, "apps", "sidecar");
            await RunAsync("node", ["scripts/build.mjs"], sidecarDir, TimeSpan.FromSeconds(60));

            using (var probe = new TcpListener(IPAddress.Loopback, 0))
            {
                probe.Start();
                var port = ((IPEndPoint)probe.LocalEndpoint).Port;
                probe.Stop();
                _url = $"http://127.0.0.1:{port}";
                var psi = new ProcessStartInfo("node", ["dist/server.mjs"])
                {
                    WorkingDirectory = sidecarDir,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                };
                psi.Environment["PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
                psi.Environment["CONCURRENCY"] = Concurrency.ToString(System.Globalization.CultureInfo.InvariantCulture);
                _process = Process.Start(psi)!;
                _process.OutputDataReceived += (_, e) => { lock (_output) if (_output.Length < 200_000) _output.AppendLine(e.Data); };
                _process.ErrorDataReceived += (_, e) => { lock (_output) _output.AppendLine(e.Data); };
                _process.BeginOutputReadLine();
                _process.BeginErrorReadLine();
            }
            await WaitHealthyAsync(_url, _process);
            return _url;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The sidecar's log lines so far (one JSON line per request).</summary>
    public string Output()
    {
        lock (_output) return _output.ToString();
    }

    private static async Task WaitHealthyAsync(string url, Process? process)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            if (process is { HasExited: true }) throw new InvalidOperationException($"The sidecar exited with code {process.ExitCode}.");
            try
            {
                if ((await http.GetAsync(url.TrimEnd('/') + "/health")).IsSuccessStatusCode) return;
            }
            catch (HttpRequestException)
            {
            }
            catch (TaskCanceledException)
            {
            }
            if (DateTime.UtcNow > deadline) throw new InvalidOperationException($"The sidecar at {url} did not become healthy.");
            await Task.Delay(100);
        }
    }

    private static async Task RunAsync(string file, string[] args, string dir, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(file, args) { WorkingDirectory = dir, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(timeout);
        await p.WaitForExitAsync(cts.Token);
        if (p.ExitCode != 0)
            throw new InvalidOperationException($"`{file} {string.Join(' ', args)}` failed ({p.ExitCode}). Run `npm ci` at the repository root first.\n{await stdout}\n{await stderr}");
    }

    private static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "package.json")) && Directory.Exists(Path.Combine(dir.FullName, "apps", "sidecar")))
                return dir.FullName;
        throw new InvalidOperationException("Repository root not found above " + AppContext.BaseDirectory);
    }

    public ValueTask DisposeAsync()
    {
        if (_process is { HasExited: false })
        {
            try
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(5000);
            }
            catch (InvalidOperationException)
            {
            }
        }
        _process?.Dispose();
        _gate.Dispose();
        return ValueTask.CompletedTask;
    }
}
