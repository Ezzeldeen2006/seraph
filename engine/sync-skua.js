// Refresh engine/vendor from Skua's source (<skua-src>, kept current by Seraph's updater) and re-apply
// Seraph's patches. Run after a Skua release, then build.bat:
//   node sync-skua.js            copy + patch (refuses if a patch no longer applies)
//   node sync-skua.js --check    only report whether the patches still apply to the current source
// The patches are listed in vendor/PATCHES.md. Each one is a small, exact text replacement, so a Skua change in
// the same lines makes this stop with a clear message instead of building something half-patched.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.env.SKUA_SRC || path.join(__dirname, 'skua-src');
const VENDOR = path.join(__dirname, 'vendor');
const PROJECTS = ['Skua.Core', 'Skua.Core.Interfaces', 'Skua.Core.Models', 'Skua.Core.Utils', 'Skua.Core.Generators'];
const check = process.argv.includes('--check');
const stageOnly = process.argv.includes('--stage');   // build work/vendor-staging only (to diff against vendor/)

const PATCHES = [
  {
    file: 'Skua.Core.Models/ClientFileSources.cs',
    from: 'public static string SkuaDIR { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Skua");',
    to: '// Seraph patch: SKUA_DIR / SKUA_SCRIPTS_DIR let every character have its own data folder over one shared script library.\n    public static string SkuaDIR { get; } = Environment.GetEnvironmentVariable("SKUA_DIR") is { Length: > 0 } d ? d : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Skua");',
  },
  {
    file: 'Skua.Core.Models/ClientFileSources.cs',
    from: 'public static string SkuaScriptsDIR { get; } = Path.Combine(SkuaDIR, "Scripts");',
    to: 'public static string SkuaScriptsDIR { get; } = Environment.GetEnvironmentVariable("SKUA_SCRIPTS_DIR") is { Length: > 0 } s ? s : Path.Combine(SkuaDIR, "Scripts");',
  },
  {
    file: 'Skua.Core.Models/ClientFileSources.cs',
    from: '    public static string SkuaOptionsDIR { get; } = Path.Combine(SkuaDIR, "options");',
    to: '    // Seraph patch: SKUA_OPTIONS_DIR shares one options folder between characters, as one Skua install would (army sync files live there).\n    public static string SkuaOptionsDIR { get; } = Environment.GetEnvironmentVariable("SKUA_OPTIONS_DIR") is { Length: > 0 } o ? o : Path.Combine(SkuaDIR, "options");',
  },
  {
    file: 'Skua.Core/AppStartup/Services.cs',
    from: '                    refs.AddRange(refPaths.Select(s => MetadataReference.CreateFromFile(s)));\n                    _cachedBaseReferences = refs;',
    to: [
      '                    refs.AddRange(refPaths.Select(s => MetadataReference.CreateFromFile(s)));',
      '',
      '                    // Seraph patch: the WPF app has most of the framework loaded by the time a script compiles, so',
      '                    // scripts silently rely on Process, TcpClient, Dns... A headless host has loaded almost nothing,',
      '                    // so reference the whole shared framework (metadata only, nothing gets loaded) and the',
      '                    // assemblies next to the host (the System.Windows.Forms / System.Drawing stand-ins).',
      '                    HashSet<string> have = new(refs.Select(r => Path.GetFileName(r.FilePath ?? string.Empty)), StringComparer.OrdinalIgnoreCase);',
      '                    string? frameworkDir = Path.GetDirectoryName(typeof(object).Assembly.Location);',
      '                    IEnumerable<string> extra = frameworkDir is null ? Enumerable.Empty<string>() : Directory.EnumerateFiles(frameworkDir, "*.dll")',
      '                        .Where(f => Path.GetFileName(f) is var n && (n.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || n.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase) || n is "netstandard.dll" or "mscorlib.dll"));',
      '                    extra = extra.Concat(new[] { "System.Windows.Forms.dll" }.Select(n => Path.Combine(AppContext.BaseDirectory, n)).Where(File.Exists));',
      '                    foreach (string f in extra)',
      '                    {',
      '                        if (!have.Add(Path.GetFileName(f)))',
      '                            continue;',
      '                        try { AssemblyName.GetAssemblyName(f); refs.Add(MetadataReference.CreateFromFile(f)); }',
      '                        catch { /* not a managed assembly */ }',
      '                    }',
      '                    _cachedBaseReferences = refs;',
    ].join('\n'),
  },
  // Patch 16: the compiler's references through a memory map (SeraphSourceFilter.Reference), not a private copy of every
  // image in every engine (~100 MB each, 2026-10-24). Runs after patch 4, whose text it also covers.
  { file: 'Skua.Core/AppStartup/Services.cs', from: 'MetadataReference.CreateFromFile(', to: 'SeraphSourceFilter.Reference(', count: 4 },
  ...['LoadedScript', 'currentFile', 'includedFile', 'newFile'].map((v) => ({
    file: 'Skua.Core/Scripts/ScriptManager.cs',
    from: `File.ReadAllText(${v})`,
    to: `SeraphSourceFilter.Read(${v})`,
  })),
  // Includes written with another letter case than the file (Scripts/Good/BLOD/CoreBLOD.cs for Good/BLoD) only work
  // on Windows. SeraphSourceFilter.Resolve finds them on Linux's case-sensitive file system.
  {
    file: 'Skua.Core/Scripts/ScriptManager.cs',
    from: 'Path.Combine(ClientFileSources.SkuaScriptsDIR, parts[1].Replace("Scripts/", ""))',
    to: 'SeraphSourceFilter.Resolve(Path.Combine(ClientFileSources.SkuaScriptsDIR, parts[1].Replace("Scripts/", "")))',
    count: 5,
  },
  {
    file: 'Skua.Core/Scripts/ScriptManager.cs',
    from: 'Path.Combine(ClientFileSources.SkuaScriptsDIR, includePath.Replace("Scripts/", ""))',
    to: 'SeraphSourceFilter.Resolve(Path.Combine(ClientFileSources.SkuaScriptsDIR, includePath.Replace("Scripts/", "")))',
  },
  {
    file: 'Skua.Core/Scripts/ScriptInterface.cs',
    from: '                        case "ct":\n                            dynamic p = data.p?[Player.Username.ToLower()]!;',
    to: '                        case "ct":\n                            // Seraph patch: a combat turn can arrive before the character name is known (login, reconnect).\n                            if (string.IsNullOrEmpty(Player.Username))\n                                break;\n                            dynamic p = data.p?[Player.Username.ToLower()]!;',
  },
  {
    file: 'Skua.Core/Scripts/ScriptInterface.cs',
    from: '                                invItem = Bank.GetItem(itemID)!;\n                                Messenger.Send<ItemAddedToBankMessage, int>(new(invItem, invItem.Quantity), (int)MessageChannels.GameEvents);',
    to: '                                invItem = Bank.GetItem(itemID)!;\n                                // Seraph patch: an item in neither bag nor bank threw here, and the whole handler was\n                                // lost with it - no ItemDropped event for that item (31 a day on the laptop, 2026-09-20).\n                                if (invItem is null)\n                                    break;\n                                Messenger.Send<ItemAddedToBankMessage, int>(new(invItem, invItem.Quantity), (int)MessageChannels.GameEvents);',
  },
  {
    file: 'Skua.Core/Scripts/ScriptSkill.cs',
    from: '        _provider = OverrideProvider ?? BaseProvider;\n\n        if (TimerRunning)\n            return;',
    to: '        _provider = OverrideProvider ?? BaseProvider;\n        // Seraph patch 13: VibeSkua\'s function-based skills (Skills/MasterSkillProvider.cs) replace the JSON rotation a\n        // script loaded when Seraph turns them on for this character. A script\'s own custom provider is left alone.\n        if (Environment.GetEnvironmentVariable(\"SERAPH_ADAPTIVE_SKILLS\") == \"1\" && _provider is AdvancedSkillProvider)\n        {\n            MasterSkillProvider adaptive = new();\n            adaptive.Init(Player, Self, Target, Combat, Flash);\n            _provider = adaptive;\n        }\n\n        if (TimerRunning)\n            return;',
  },
  // Patch 15: the handler list is a plain List shared by the script thread (RegisterHandler/Remove) and the handler
  // timer (ScriptInterface.RunScriptHandlers copies it with ToList every tick). A copy taken while the script adds a
  // handler throws "Destination array was not long enough" (Known-Bugs, audit 2026-09-28). Every use takes one lock
  // and readers get their own copy.
  {
    file: 'Skua.Core/Scripts/Handlers/ScriptHandlers.cs',
    from: '    private List<IHandler> _currentHandlers = new();\n    public IEnumerable<IHandler> CurrentHandlers => _currentHandlers;',
    to: '    private List<IHandler> _currentHandlers = new();\n    // Seraph patch 15: shared by the script thread and the handler timer; every use takes this lock, readers get a copy.\n    private readonly object _sync = new();\n    public IEnumerable<IHandler> CurrentHandlers { get { lock (_sync) return _currentHandlers.ToArray(); } }',
  },
  ...[
    ['        _currentHandlers.Add(handler);', '        lock (_sync)\n            _currentHandlers.Add(handler);'],
    ['        return _currentHandlers.RemoveAll(h => h.Name == name) > 0;', '        lock (_sync)\n            return _currentHandlers.RemoveAll(h => h.Name == name) > 0;'],
    ['        return _currentHandlers.Remove(handler);', '        lock (_sync)\n            return _currentHandlers.Remove(handler);'],
    ['        return _currentHandlers.RemoveAll(h => handlers.Contains(h)) == handlers.Count;', '        lock (_sync)\n            return _currentHandlers.RemoveAll(h => handlers.Contains(h)) == handlers.Count;'],
    ['        _currentHandlers.Clear();', '        lock (_sync)\n            _currentHandlers.Clear();'],
  ].map(([from, to]) => ({ file: 'Skua.Core/Scripts/Handlers/ScriptHandlers.cs', from, to })),
  // Patch 17: the drop loop retried a failing tick with no pause (100,000 log lines a second after a restart).
  {
    file: 'Skua.Core/Scripts/ScriptDrop.cs',
    from: "                System.Diagnostics.Trace.WriteLine($\"Error in drop handler: {ex.Message}\");\n            }",
    to: "                System.Diagnostics.Trace.WriteLine($\"Error in drop handler: {ex.Message}\");\n                // Seraph patch 17: no pause here meant a loop that threw at once (a second consumer on the shared PeriodicTimer\n                // after a restart) logged 100,000 lines a second on the laptop (2026-10-25). Back off one tick.\n                try { await Task.Delay(1000, token); }\n                catch (OperationCanceledException) { break; }\n            }",
  },
  // Patch 18: the assembly resolver gave up silently when another engine was rewriting the cache file.
  {
    file: 'Skua.Core/ScriptLoadContext.cs',
    from: "            try\n            {\n                using FileStream stream = File.OpenRead(latestFile);\n                return LoadFromStream(stream);\n            }\n            catch\n            {\n                return null;\n            }",
    to: "            // Seraph patch 18: another engine rewrites this cache file at the same moment (seven engines share one\n            // Cached-Scripts folder): a sharing violation or a half-written file made the load fail silently and the script\n            // died with \"Could not load file or assembly 'DragonOfTime'\" (laptop, 2026-10-25, 4x). Read it shared and retry.\n            for (int attempt = 0; attempt < 8; attempt++)\n            {\n                if (attempt > 0)\n                {\n                    Thread.Sleep(250);\n                    if (_isUnloading || !File.Exists(latestFile))\n                        return null;\n                }\n                try\n                {\n                    using FileStream stream = new(latestFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);\n                    return LoadFromStream(stream);\n                }\n                catch\n                {\n                }\n            }\n            return null;",
  },
  // Patch 19: Stop() and StopAsync() raced on the same CancellationTokenSource.
  {
    file: 'Skua.Core/Scripts/ScriptDrop.cs',
    from: "        _ctsDrops?.Cancel();\n        Wait.ForTrue(() => _taskDrops?.IsCompleted == true, null, 2);",
    to: "        // Seraph patch 19: Stop() and the ScriptStopped message stop the drop loop at the same moment; the second Cancel()\n        // hit the disposed source (59 \"CancellationTokenSource has been disposed\" lines on the laptop, 2026-10-25).\n        try { _ctsDrops?.Cancel(); } catch (ObjectDisposedException) { }\n        Wait.ForTrue(() => _taskDrops?.IsCompleted == true, null, 2);",
  },
  {
    file: 'Skua.Core/Scripts/ScriptDrop.cs',
    from: "        _ctsDrops?.Cancel();\n        await Wait.ForTrueAsync(() => _taskDrops?.IsCompleted == true, 20);",
    to: "        // Seraph patch 19: Stop() and the ScriptStopped message stop the drop loop at the same moment; the second Cancel()\n        // hit the disposed source (59 \"CancellationTokenSource has been disposed\" lines on the laptop, 2026-10-25).\n        try { _ctsDrops?.Cancel(); } catch (ObjectDisposedException) { }\n        await Wait.ForTrueAsync(() => _taskDrops?.IsCompleted == true, 20);",
  },
  // Patch 20: engines deleted each other's cached include DLLs (shared Cached-Scripts): "Could not load file or assembly
  // 'ArchPaladin'" x11 in a week. Recent versions are kept; the loader waits for a DLL another engine is compiling.
  {
    file: "Skua.Core/Compiler.cs",
    from: "    private const int _maxCachedAssemblies = 1024;",
    to: "    private const int _maxCachedAssemblies = 1024;\n    // Seraph patch 20: how long a cached include DLL is safe from deletion by another engine's compile or cleanup.\n    private static readonly TimeSpan SeraphKeepRecent = TimeSpan.FromHours(6);",
  },
  {
    file: "Skua.Core/Compiler.cs",
    from: "                if (dashIndex > 0 && int.TryParse(fileNameWithoutExt[..dashIndex], out int fileHash) && fileHash != currentHash)\n                {\n                    bool deleted = false;",
    to: "                if (dashIndex > 0 && int.TryParse(fileNameWithoutExt[..dashIndex], out int fileHash) && fileHash != currentHash)\n                {\n                    // Seraph patch 20: up to eight engines share this folder. Deleting another engine's recent version of an\n                    // include left its running script with no DLL to load (\"Could not load file or assembly 'ArchPaladin'\",\n                    // 11 crashes 10-22..27 - Forge Hero's Valiance, VDK, LoO). Only versions untouched for SeraphKeepRecent (6 h) go.\n                    if (DateTime.UtcNow - File.GetLastWriteTimeUtc(file) < SeraphKeepRecent)\n                        continue;\n                    bool deleted = false;",
  },
  {
    file: "Skua.Core/Compiler.cs",
    from: "                if (kvp.Value.Count > 1)\n                {\n                    FileInfo newest = kvp.Value.MaxBy(f => f.LastWriteTimeUtc)!;\n                    foreach (FileInfo file in kvp.Value)\n                    {\n                        if (file != newest)\n                            filesToDelete.Add(file);\n                    }\n                }",
    to: "                if (kvp.Value.Count > 1)\n                {\n                    FileInfo newest = kvp.Value.MaxBy(f => f.LastWriteTimeUtc)!;\n                    foreach (FileInfo file in kvp.Value)\n                    {\n                        // Seraph patch 20: never a version another engine may still load (see DeleteOldVersions).\n                        if (file != newest && now.ToUniversalTime() - file.LastWriteTimeUtc >= SeraphKeepRecent)\n                            filesToDelete.Add(file);\n                    }\n                }",
  },
  {
    file: "Skua.Core/ScriptLoadContext.cs",
    from: "        string[] matchingFiles = Directory.GetFiles(_cacheDirectory, $\"*-{assemblyName.Name}.dll\");\n",
    to: "        string[] matchingFiles = Directory.GetFiles(_cacheDirectory, $\"*-{assemblyName.Name}.dll\");\n        // Seraph patch 20: no file at all can mean another engine deleted the old version and is still compiling the new\n        // one (a few seconds): wait up to 15 s for it instead of failing the script at once.\n        for (int wait = 0; matchingFiles.Length == 0 && wait < 60 && !_isUnloading; wait++)\n        {\n            Thread.Sleep(250);\n            matchingFiles = Directory.GetFiles(_cacheDirectory, $\"*-{assemblyName.Name}.dll\");\n        }\n",
  },
];
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'bin' || e.name === 'obj') continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function main() {
  const staging = path.join(__dirname, 'work', 'vendor-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  for (const p of PROJECTS) copyDir(path.join(SRC, p), path.join(staging, p));
  fs.copyFileSync(path.join(SRC, 'Directory.Build.props'), path.join(staging, 'Directory.Build.props'));
  // net10.0-windows -> net10.0: nothing in these projects needs Windows (the WinForms bits are in Skua.WPF).
  for (const p of PROJECTS) {
    const f = path.join(staging, p, `${p}.csproj`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/net10\.0-windows/g, 'net10.0'));
  }
  const failed = [];
  for (const patch of PATCHES) {
    const f = path.join(staging, patch.file);
    const s = fs.readFileSync(f, 'utf8');
    const nl = s.includes('\r\n') ? '\r\n' : '\n';          // each file keeps its own line endings
    const from = patch.from.replace(/\n/g, nl);
    const to = patch.to.replace(/\n/g, nl);
    const n = s.split(from).length - 1;
    if (n !== (patch.count || 1)) { failed.push(`${patch.file}: expected the text ${patch.count || 1} time(s), found it ${n} times:\n    ${patch.from.split('\n')[0]}`); continue; }
    fs.writeFileSync(f, s.split(from).join(to));
  }
  fs.copyFileSync(path.join(__dirname, 'skua-additions', 'Skua.Core', 'SeraphSourceFilter.cs'), path.join(staging, 'Skua.Core', 'SeraphSourceFilter.cs'));
  fs.copyFileSync(path.join(__dirname, 'skua-additions', 'Skua.Core', 'Skills', 'MasterSkillProvider.cs'), path.join(staging, 'Skua.Core', 'Skills', 'MasterSkillProvider.cs'));   // patch 13 (VibeSkua, MIT)
  if (failed.length) {
    console.error(`Skua changed in patched lines - update PATCHES in sync-skua.js:\n  ${failed.join('\n  ')}`);
    process.exit(1);
  }
  let commit = 'unknown';
  try { commit = execFileSync('git', ['-C', SRC, 'rev-parse', 'HEAD']).toString().trim(); } catch (e) { /* not a git checkout */ }
  if (check) { console.log(`all ${PATCHES.length} patches apply to Skua ${commit}`); fs.rmSync(staging, { recursive: true, force: true }); return; }
  if (stageOnly) { console.log(`work/vendor-staging = Skua ${commit} + ${PATCHES.length} patches (vendor/ untouched)`); return; }
  fs.writeFileSync(path.join(staging, 'SKUA_COMMIT'), `${commit}\n`);
  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.renameSync(staging, VENDOR);
  console.log(`vendor/ now Skua ${commit} + ${PATCHES.length} patches. Next: build.bat`);
}

main();
