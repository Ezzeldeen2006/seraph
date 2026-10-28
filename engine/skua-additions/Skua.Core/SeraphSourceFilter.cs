using System.Text.RegularExpressions;

namespace Skua.Core;

/// <summary>
/// Seraph patch: every script source is read through here. It removes the one thing no unattended bot should do,
/// CoreBots' April Fools pranks (they open Notepad, YouTube and a .bat file on the host machine).
/// </summary>
public static class SeraphSourceFilter
{
    private static readonly Regex AprilFoolsCall = new(@"^(\s*)AprilFools\(\);", RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>
    /// Seraph patch 16: a compiler reference read through a memory map. MetadataReference.CreateFromFile copies the
    /// whole image into the process ("prefetch image, close stream to avoid locking it"), so the shared framework
    /// patch 4 references (~60 MB) plus Roslyn and Skua (~12 MB) sat as private memory in every engine - even one whose
    /// scripts all came from Cached-Scripts. A mapped file is shared by every engine on the machine, and only the
    /// metadata pages a compile actually reads are ever loaded. SERAPH_MAPPED_REFS=0 goes back to the copies.
    /// </summary>
    public static Microsoft.CodeAnalysis.PortableExecutableReference Reference(string path)
    {
        if (Environment.GetEnvironmentVariable("SERAPH_MAPPED_REFS") != "0")
        {
            FileStream? stream = null;
            try
            {
                stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                // Default options: nothing is prefetched; System.Reflection.Metadata maps every block over 16 KB.
                Microsoft.CodeAnalysis.ModuleMetadata module = Microsoft.CodeAnalysis.ModuleMetadata.CreateFromStream(stream, System.Reflection.PortableExecutable.PEStreamOptions.Default);
                return Microsoft.CodeAnalysis.AssemblyMetadata.Create(module).GetReference(filePath: path);
            }
            catch
            {
                stream?.Dispose();
            }
        }
        return Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(path);
    }

    public static string Read(string path)
    {
        string source = Fixed(path, File.ReadAllText(path));
        if (Path.GetFileName(path).Equals("CoreBots.cs", StringComparison.OrdinalIgnoreCase))
            source = AprilFoolsCall.Replace(source, "$1/* AprilFools(); disabled by Seraph */");
        return source;
    }

    /// <summary>
    /// Seraph patch: Seraph's corrected copy of a library file that is broken upstream (SERAPH_FIXES_DIR/fixes.json,
    /// the same manifest as app/lib/scriptfix.js). Used for included files too (Core13LoC.cs is pulled in by Farmer
    /// Joe, 00Complete13LOC and the ultra story scripts). The copy is served only while the library file still has the
    /// sha256 (LF line endings) it was written against, so a Skua update retires it by itself.
    /// </summary>
    private static string Fixed(string path, string source)
    {
        try
        {
            string? dir = Environment.GetEnvironmentVariable("SERAPH_FIXES_DIR");
            if (string.IsNullOrEmpty(dir)) return source;
            string manifest = Path.Combine(dir, "fixes.json");
            if (!File.Exists(manifest)) return source;
            string rel = Path.GetRelativePath(Path.GetFullPath(Skua.Core.Models.ClientFileSources.SkuaScriptsDIR), Path.GetFullPath(path)).Replace('\\', '/');
            if (rel.StartsWith("..")) return source;
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(manifest));
            foreach (var fix in doc.RootElement.EnumerateObject())
            {
                if (!string.Equals(fix.Name, rel, StringComparison.OrdinalIgnoreCase)) continue;
                string want = fix.Value.TryGetProperty("base", out var b) ? b.GetString() ?? "" : "";
                byte[] lf = System.Text.Encoding.UTF8.GetBytes(source.Replace("\r\n", "\n"));
                string have = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(lf)).ToLowerInvariant();
                string copy = Path.Combine(dir, fix.Name.Replace('/', Path.DirectorySeparatorChar));
                return have == want && File.Exists(copy) ? File.ReadAllText(copy) : source;
            }
        }
        catch { }
        return source;
    }

    /// <summary>
    /// Seraph patch: a script path whose letter case differs from the file on disk ("Good/BLOD" for "Good/BLoD").
    /// Windows ignores case, so Skua's library has such includes; on Linux, look the path up ignoring case.
    /// </summary>
    public static string Resolve(string path)
    {
        if (OperatingSystem.IsWindows() || File.Exists(path) || Directory.Exists(path)) return path;
        string full = Path.GetFullPath(path.Replace('\\', '/'));
        string root = Path.GetPathRoot(full) ?? "/";
        string current = root;
        foreach (string part in full[root.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            string next = Path.Combine(current, part);
            if (!File.Exists(next) && !Directory.Exists(next))
            {
                string? match = Directory.Exists(current)
                    ? Directory.EnumerateFileSystemEntries(current).FirstOrDefault(e => string.Equals(Path.GetFileName(e), part, StringComparison.OrdinalIgnoreCase))
                    : null;
                if (match == null) return path;
                next = match;
            }
            current = next;
        }
        return current;
    }
}
