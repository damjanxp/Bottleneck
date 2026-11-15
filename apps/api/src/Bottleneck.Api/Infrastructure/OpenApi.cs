using Bottleneck.Api.Security;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Bottleneck.Api.Infrastructure;

/// <summary>Describes the two credentials in the OpenAPI document, so the interactive UI can send them.</summary>
public sealed class CredentialSchemesTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        document.Info.Title = "Bottleneck API";
        document.Info.Description =
            "Stores venues, scenarios, runs and background images for the Bottleneck simulator. Sharing works without logins: " +
            "a venue has a public id, a read token (share link) and an edit key (shown once, sent only in X-Edit-Key). " +
            "Errors are application/problem+json.";
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["editKey"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.ApiKey,
            In = ParameterLocation.Header,
            Name = VenuePolicies.EditKeyHeader,
            Description = "The venue's edit key (256 random bits, base64url). Needed for every write.",
        };
        document.Components.SecuritySchemes["readToken"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.ApiKey,
            In = ParameterLocation.Header,
            Name = VenuePolicies.ReadTokenHeader,
            Description = "The venue's read token. Also accepted as ?t= (for image URLs).",
        };
        return Task.CompletedTask;
    }
}

/// <summary>Marks each venue operation with the credential its authorization policy needs (edit key, or read token / edit key).</summary>
public sealed class CredentialRequirementTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken cancellationToken)
    {
        var policies = context.Description.ActionDescriptor.EndpointMetadata
            .OfType<Microsoft.AspNetCore.Authorization.IAuthorizeData>()
            .Select(a => a.Policy)
            .ToList();
        var schemes = policies.Contains(VenuePolicies.Edit) ? new[] { "editKey" }
            : policies.Contains(VenuePolicies.Read) ? new[] { "readToken", "editKey" }
            : [];
        if (schemes.Length == 0) return Task.CompletedTask;
        operation.Security ??= [];
        foreach (var scheme in schemes)
            operation.Security.Add(new OpenApiSecurityRequirement { [new OpenApiSecuritySchemeReference(scheme, context.Document)] = [] });
        return Task.CompletedTask;
    }
}
