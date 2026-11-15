using Bottleneck.Api.Data;
using Bottleneck.Api.Infrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.EntityFrameworkCore;

namespace Bottleneck.Api.Security;

/// <summary>The two capabilities a venue link can carry.</summary>
public enum VenueAccessLevel
{
    /// <summary>The read token (share link) or the edit key.</summary>
    Read,
    /// <summary>The edit key only.</summary>
    Edit,
}

/// <summary>
/// Authorization policies for venue routes (spec section 8: "The check is an ASP.NET authorization policy,
/// so real accounts can replace it later without touching endpoints"). Endpoints only say
/// RequireAuthorization(VenuePolicies.Read / Edit); swapping <see cref="VenueAccessHandler"/> for an
/// account-based handler changes nothing else.
/// </summary>
public static class VenuePolicies
{
    public const string Read = "venue-read";
    public const string Edit = "venue-edit";

    /// <summary>Header carrying the edit key. The key is never accepted anywhere else.</summary>
    public const string EditKeyHeader = "X-Edit-Key";

    /// <summary>Header carrying the read token. The query parameter <see cref="ReadTokenQuery"/> also works, for &lt;img src&gt;.</summary>
    public const string ReadTokenHeader = "X-Read-Token";

    public const string ReadTokenQuery = "t";

    /// <summary>Route parameter every venue route uses.</summary>
    public const string VenueIdRoute = "venueId";

    /// <summary>HttpContext.Items key holding why access was refused (see VenueAuthorizationResultHandler).</summary>
    public const string FailureItem = "bottleneck.venue-access-failure";

    /// <summary>HttpContext.Items key holding the level the caller proved.</summary>
    public const string GrantedLevelItem = "bottleneck.venue-access";

    public static VenueAccessLevel? GrantedLevel(this HttpContext http) =>
        http.Items.TryGetValue(GrantedLevelItem, out var v) && v is VenueAccessLevel l ? l : null;
}

public sealed class VenueAccessRequirement(VenueAccessLevel level) : IAuthorizationRequirement
{
    public VenueAccessLevel Level { get; } = level;
}

/// <summary>Why access was refused; turned into 404 / 401 / 403 by <see cref="VenueAuthorizationResultHandler"/>.</summary>
public enum VenueAccessFailure
{
    NotFound,
    MissingCredential,
    WrongCredential,
}

public sealed class VenueAccessFailureReason(IAuthorizationHandler handler, VenueAccessFailure failure, VenueAccessLevel level)
    : AuthorizationFailureReason(handler, failure.ToString())
{
    public VenueAccessFailure Failure { get; } = failure;
    public VenueAccessLevel Level { get; } = level;
}

/// <summary>Checks the venue's read token or edit key in constant time.</summary>
public sealed class VenueAccessHandler(AppDbContext db) : AuthorizationHandler<VenueAccessRequirement>
{
    private void Fail(AuthorizationHandlerContext context, HttpContext? http, VenueAccessFailure failure, VenueAccessLevel level)
    {
        var reason = new VenueAccessFailureReason(this, failure, level);
        // Without an authentication scheme the middleware reports a bare "challenge" with no reasons,
        // so the reason also travels in HttpContext.Items.
        if (http is not null) http.Items[VenuePolicies.FailureItem] = reason;
        context.Fail(reason);
    }

    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, VenueAccessRequirement requirement)
    {
        if (context.Resource is not HttpContext http) return;
        var venueId = http.GetRouteValue(VenuePolicies.VenueIdRoute) as string;
        if (venueId is null)
        {
            Fail(context, http, VenueAccessFailure.NotFound, requirement.Level);
            return;
        }

        var credentials = await db.Venues.AsNoTracking()
            .Where(v => v.Id == venueId)
            .Select(v => new { v.ReadToken, v.EditKeyHash })
            .SingleOrDefaultAsync(http.RequestAborted);
        if (credentials is null)
        {
            Fail(context, http, VenueAccessFailure.NotFound, requirement.Level);
            return;
        }

        string? editKey = http.Request.Headers[VenuePolicies.EditKeyHeader];
        string? readToken = http.Request.Headers[VenuePolicies.ReadTokenHeader];
        if (string.IsNullOrEmpty(readToken)) readToken = http.Request.Query[VenuePolicies.ReadTokenQuery];

        var editOk = !string.IsNullOrEmpty(editKey) && Secrets.EditKeyMatches(editKey, credentials.EditKeyHash);
        if (editOk)
        {
            http.Items[VenuePolicies.GrantedLevelItem] = VenueAccessLevel.Edit;
            context.Succeed(requirement);
            return;
        }

        if (requirement.Level == VenueAccessLevel.Read && Secrets.ReadTokenMatches(readToken, credentials.ReadToken))
        {
            http.Items[VenuePolicies.GrantedLevelItem] = VenueAccessLevel.Read;
            context.Succeed(requirement);
            return;
        }

        var presented = requirement.Level == VenueAccessLevel.Edit
            ? !string.IsNullOrEmpty(editKey)
            : !string.IsNullOrEmpty(editKey) || !string.IsNullOrEmpty(readToken);
        Fail(context, http, presented ? VenueAccessFailure.WrongCredential : VenueAccessFailure.MissingCredential, requirement.Level);
    }
}

/// <summary>
/// Writes ProblemDetails for refused requests instead of challenging an authentication scheme
/// (there are no logins and no cookies).
/// </summary>
public sealed class VenueAuthorizationResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public async Task HandleAsync(RequestDelegate next, HttpContext context, AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        if (authorizeResult.Succeeded)
        {
            await next(context);
            return;
        }
        var reason = authorizeResult.AuthorizationFailure?.FailureReasons.OfType<VenueAccessFailureReason>().FirstOrDefault()
            ?? (context.Items.TryGetValue(VenuePolicies.FailureItem, out var item) ? item as VenueAccessFailureReason : null);
        if (reason is null)
        {
            await _default.HandleAsync(next, context, policy, authorizeResult);
            return;
        }

        var credential = reason.Level == VenueAccessLevel.Edit ? "the edit key (X-Edit-Key header)" : "the read token (X-Read-Token header or ?t=) or the edit key";
        var result = reason.Failure switch
        {
            VenueAccessFailure.NotFound => Problems.NotFound("Venue not found."),
            VenueAccessFailure.MissingCredential => Problems.Create(StatusCodes.Status401Unauthorized, "Credential required", $"This request needs {credential}.", "credential-required"),
            _ => Problems.Create(StatusCodes.Status403Forbidden, "Wrong credential", $"The credential does not match: this request needs {credential}.", "credential-invalid"),
        };
        if (reason.Failure == VenueAccessFailure.MissingCredential)
            context.Response.Headers.WWWAuthenticate = reason.Level == VenueAccessLevel.Edit ? "X-Edit-Key" : "X-Read-Token, X-Edit-Key";
        await result.ExecuteAsync(context);
    }
}
