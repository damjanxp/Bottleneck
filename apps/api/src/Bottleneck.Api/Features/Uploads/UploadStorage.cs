using System.Text.RegularExpressions;
using Bottleneck.Api.Options;
using Bottleneck.Api.Security;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Features.Uploads;

/// <summary>
/// Files on disk under {Uploads:Path}/{venueId}/{uploadId}{.png|.jpg}. Both ids are server-generated and
/// checked against <see cref="Secrets.IdPattern"/> before any path is built, so no client text reaches the file system.
/// The folder is outside any web root: nothing serves it except the upload endpoint.
/// </summary>
public sealed partial class UploadStorage(IOptions<UploadOptions> options, IHostEnvironment env)
{
    public string Root { get; } = Path.GetFullPath(Path.IsPathRooted(options.Value.Path)
        ? options.Value.Path
        : Path.Combine(env.ContentRootPath, options.Value.Path));

    [GeneratedRegex(Secrets.IdPattern)]
    private static partial Regex IdRegex();

    public string PathFor(string venueId, string uploadId, string contentType)
    {
        if (!IdRegex().IsMatch(venueId) || !IdRegex().IsMatch(uploadId)) throw new ArgumentException("Not a server-generated id.");
        return Path.Combine(Root, venueId, uploadId + (contentType == "image/png" ? ".png" : ".jpg"));
    }

    public async Task WriteAsync(string venueId, string uploadId, string contentType, byte[] bytes, CancellationToken ct)
    {
        var path = PathFor(venueId, uploadId, contentType);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        await File.WriteAllBytesAsync(temp, bytes, ct);
        File.Move(temp, path, overwrite: false);
    }

    public void Delete(string venueId, string uploadId, string contentType)
    {
        var path = PathFor(venueId, uploadId, contentType);
        if (File.Exists(path)) File.Delete(path);
    }

    public void DeleteVenueFiles(string venueId)
    {
        if (!IdRegex().IsMatch(venueId)) return;
        var dir = Path.Combine(Root, venueId);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }
}
