using Bottleneck.Schema;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Bottleneck.Api.Infrastructure;

/// <summary>ProblemDetails (RFC 9457) for every error the API returns.</summary>
public static class Problems
{
    /// <summary>Base of the "type" URIs. They identify the error kind; they are not fetched.</summary>
    public const string TypeBase = "https://bottleneck.dev/problems/";

    public static ProblemHttpResult Create(int status, string title, string? detail = null, string? type = null) =>
        TypedResults.Problem(detail: detail, statusCode: status, title: title, type: type is null ? null : TypeBase + type);

    public static ProblemHttpResult NotFound(string detail) => Create(StatusCodes.Status404NotFound, "Not found", detail, "not-found");

    public static ProblemHttpResult BadJson(string detail) => Create(StatusCodes.Status400BadRequest, "Malformed request", detail, "malformed-json");

    public static ProblemHttpResult TooLarge(string detail) => Create(StatusCodes.Status413PayloadTooLarge, "Request too large", detail, "too-large");

    public static ProblemHttpResult UnsupportedMediaType(string detail) => Create(StatusCodes.Status415UnsupportedMediaType, "Unsupported media type", detail, "unsupported-media-type");

    public static ProblemHttpResult LimitReached(string detail) => Create(StatusCodes.Status409Conflict, "Limit reached", detail, "limit-reached");

    public static ProblemHttpResult QuotaExceeded(string detail) => Create(StatusCodes.Status507InsufficientStorage, "Storage limit reached", detail, "quota-exceeded");

    public static ProblemHttpResult PreconditionRequired() => Create(StatusCodes.Status428PreconditionRequired, "If-Match required",
        "Send the ETag you last read in an If-Match header, so a concurrent change is not overwritten.", "precondition-required");

    public static ProblemHttpResult PreconditionFailed() => Create(StatusCodes.Status412PreconditionFailed, "Changed by someone else",
        "The document was changed since you read it (ETag mismatch). Reload it and apply your change again.", "concurrent-update");

    public static ProblemHttpResult Unprocessable(string title, string detail, string type) => Create(StatusCodes.Status422UnprocessableEntity, title, detail, type);

    /// <summary>422 with the schema errors keyed by JSON Pointer (an RFC 9457 "errors" extension, like ASP.NET validation problems).</summary>
    public static ProblemHttpResult SchemaInvalid(IReadOnlyList<SchemaError> errors, string? detail = null)
    {
        var dict = errors
            .GroupBy(e => e.Path, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(e => e.Message).ToArray(), StringComparer.Ordinal);
        return TypedResults.Problem(new HttpValidationProblemDetails(dict)
        {
            Status = StatusCodes.Status422UnprocessableEntity,
            Title = "Schema validation failed",
            Detail = detail ?? "The document does not match the JSON Schema in /schema.",
            Type = TypeBase + "schema-invalid",
        });
    }
}
