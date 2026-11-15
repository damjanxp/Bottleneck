using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Bottleneck.Api.Security;

/// <summary>Ids, read tokens and edit keys (spec section 8, "Sharing without logins").</summary>
public static class Secrets
{
    private const string Base32 = "abcdefghijklmnopqrstuvwxyz234567";

    /// <summary>Route constraint for every server-generated id.</summary>
    public const string IdPattern = "^[a-z2-7]{26}$";

    /// <summary>
    /// A public id: 128 random bits as 26 lowercase base32 characters. It also matches the schema's Id
    /// pattern (letters and digits), so it can be written into the stored documents as is.
    /// </summary>
    public static string NewId()
    {
        Span<byte> bytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(bytes);
        var sb = new StringBuilder(26);
        int buffer = 0, bits = 0;
        foreach (var b in bytes)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Base32[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Base32[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    /// <summary>256 random bits, base64url without padding (43 characters).</summary>
    public static string NewToken()
    {
        Span<byte> bytes = stackalloc byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Base64Url.EncodeToString(bytes);
    }

    /// <summary>A new edit key and the SHA-256 hash that is stored instead of it.</summary>
    public static (string Key, byte[] Hash) NewEditKey()
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return (Base64Url.EncodeToString(bytes), SHA256.HashData(bytes));
    }

    /// <summary>
    /// Hash of a presented edit key, or null if it is not 32 bytes of base64url
    /// (malformed keys are simply wrong keys, without saying why).
    /// </summary>
    public static byte[]? HashPresentedEditKey(string? presented)
    {
        if (string.IsNullOrEmpty(presented) || presented.Length > 64) return null;
        Span<byte> bytes = stackalloc byte[48];
        if (Base64Url.DecodeFromChars(presented, bytes, out _, out var written) != System.Buffers.OperationStatus.Done || written != 32)
            return null;
        return SHA256.HashData(bytes[..32]);
    }

    /// <summary>Constant-time comparison of a presented edit key with the stored hash.</summary>
    public static bool EditKeyMatches(string? presented, byte[] storedHash)
    {
        var hash = HashPresentedEditKey(presented);
        // Always run the comparison, so a malformed key takes as long as a wrong one.
        var equal = CryptographicOperations.FixedTimeEquals(hash ?? new byte[32], storedHash);
        return hash is not null && equal;
    }

    /// <summary>Constant-time comparison of read tokens (hashed first, so lengths never matter).</summary>
    public static bool ReadTokenMatches(string? presented, string stored)
    {
        if (string.IsNullOrEmpty(presented) || presented.Length > 128) return false;
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(presented));
        var b = SHA256.HashData(Encoding.UTF8.GetBytes(stored));
        return CryptographicOperations.FixedTimeEquals(a, b);
    }
}
