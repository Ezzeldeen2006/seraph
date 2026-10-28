# Seraph's changes to the vendored Skua engine

`vendor/` is Skua's own engine (Skua.Core, Skua.Core.Interfaces, Skua.Core.Models, Skua.Core.Utils,
Skua.Core.Generators) copied from `<skua-src>` at the commit in `SKUA_COMMIT`. It is **not** a
rewrite: scripts run on Skua's ScriptManager, compiler, ScriptInterface and every Script* class unchanged.

`node ..\sync-skua.js` re-creates this folder from the Skua source and re-applies exactly these changes
(it stops if Skua changed one of the patched lines):

| # | File | Change | Why |
|---|------|--------|-----|
| 0 | all `*.csproj` | `net10.0-windows` → `net10.0` | runs on the Linux laptop too; none of these projects needs Windows |
| 1 | `Skua.Core.Models/ClientFileSources.cs` | `SKUA_DIR` env var | each character gets its own Skua folder (settings, cache) |
| 2 | same | `SKUA_SCRIPTS_DIR` env var | all characters share one auqw/Scripts checkout |
| 3 | same | `SKUA_OPTIONS_DIR` env var | one shared options folder, like one Skua install (army sync files live there) |
| 4 | `Skua.Core/AppStartup/Services.cs` (CreateCompiler) | also reference the whole shared framework + the WinForms stand-in | the WPF app happens to have `Process`, `TcpClient`, `Dns`, `Registry`… loaded when scripts compile; a headless host does not |
| 5-8 | `Skua.Core/Scripts/ScriptManager.cs` | script sources read through `SeraphSourceFilter.Read` | removes CoreBots' April Fools pranks (Notepad, YouTube, a .bat) from unattended bots |
| 9 | `Skua.Core/Scripts/ScriptManager.cs` (5×) | `Path.Combine(SkuaScriptsDIR, parts[1]…)` wrapped in `SeraphSourceFilter.Resolve` | includes written with another letter case than the file (`Scripts/Good/BLOD/CoreBLOD.cs` for `Good/BLoD`) only resolve on Windows; ~20 library scripts failed to compile on Linux (2026-09-19) |
| 10 | same (1×) | the `includePath` variant of the same | same |
| 11 | `Skua.Core/Scripts/ScriptInterface.cs` (`ct`) | skip the packet while `Player.Username` is empty | a combat turn between login and the name arriving threw inside the Flash-call handler |
| 12 | same (`addItems`) | stop when the item is in neither bag nor bank | `invItem.Quantity` on a null threw and took the whole handler with it, so that item raised no ItemDropped event (31 a day on the laptop, 2026-09-20) |
| 13 | `Skua.Core/Scripts/ScriptSkill.cs` (`Start`) | with `SERAPH_ADAPTIVE_SKILLS=1`, a JSON rotation is replaced by `MasterSkillProvider` (a script's own custom provider is kept) | VibeSkua's function-based skills - per-class adaptive rules - inside Skua scripts, switched on per character (`adaptiveSkills` setting, 2026-09-21) |
| + | `Skua.Core/Skills/MasterSkillProvider.cs` | new file, from NinjaXz/VibeSkua c22da62 (MIT, notice kept in the file) | patch 13 |
| + | `Skua.Core/SeraphSourceFilter.cs` | new file | the filter above, `Resolve` (case-insensitive lookup, Linux only), and patch 14 |
| 14 | `Skua.Core/SeraphSourceFilter.cs` (`Fixed`, inside `Read`) | a library file listed in `SERAPH_FIXES_DIR/fixes.json` (app/script-fixes, same sha256 gate as lib/scriptfix.js) is served from Seraph's fixed copy | included files could not be fixed before (scriptfix only swapped the top-level script). First use: Core13LoC.cs skips the Kitsune chapter, whose quest 382 can no longer be done (2026-09-22). Since 2026-09-28 the manifest is `~/seraph/script-fixes-live` (patch-based fixes re-applied to each library version) |
| 15 | `Skua.Core/Scripts/Handlers/ScriptHandlers.cs` (6 edits) | one lock around the handler list; `CurrentHandlers` returns a copy | the script thread adds handlers while the handler timer copies the list (`ToList` in `RunScriptHandlers`): "Destination array was not long enough" (2026-09-28 audit) |
| 16 | `Skua.Core/AppStartup/Services.cs` (4×, incl. patch 4's line) | `MetadataReference.CreateFromFile(` → `SeraphSourceFilter.Reference(` (new method in SeraphSourceFilter.cs) | Roslyn's CreateFromFile copies every referenced image into the process; patch 4 references the whole shared framework, so each engine held ~100 MB of private copies even when every script came from Cached-Scripts. A memory-mapped reference is shared by all engines and only the metadata pages a compile reads are loaded. Laptop bench 2026-10-24: cached start 152 → 50 MB private, cold CoreBots compile 207 → 118 MB. `SERAPH_MAPPED_REFS=0` turns it off |
| 17 | `Skua.Core/Scripts/ScriptDrop.cs` (`HandleDrops`) | one second of back-off after an error in the drop loop | a loop that threw at once (InvalidOperationException from the shared PeriodicTimer after a restart) wrote 102,273 "Error in drop handler" lines in a second on the laptop (2026-10-25) |
| 18 | `Skua.Core/ScriptLoadContext.cs` (`Load`) | the cache DLL is read with shared access and retried up to 8 times (250 ms) | seven engines share one Cached-Scripts folder; a file another engine was rewriting failed to load with no message and the script died with "Could not load file or assembly 'DragonOfTime'" / 'ArchPaladin' (4x on 2026-10-25) |
| 19 | `Skua.Core/Scripts/ScriptDrop.cs` (`Stop`, `StopAsync`, 2 edits) | `Cancel()` wrapped in a catch for `ObjectDisposedException` | the script's own Drops.Stop and the ScriptStopped message race on the same source: 59 "Error in ScriptStopped handler: The CancellationTokenSource has been disposed" lines (2026-10-25) |
| 20 | `Skua.Core/Compiler.cs` (3 edits), `Skua.Core/ScriptLoadContext.cs` (`Load`) | cached include DLLs younger than 6 h are never deleted (`DeleteOldVersions`, the periodic cleanup); the loader waits up to 15 s for a DLL that is missing right now | up to eight engines share one Cached-Scripts folder: one engine's compile deleted the version another engine's running script still had to load - "Could not load file or assembly 'ArchPaladin'", 11 script crashes in a week (2026-10-28 audit) |

Not in vendor but part of the engine: `../host` (the headless host: IPC, IFlashUtil over IPC, no-UI
services) and `../winforms-shim` (a do-nothing `System.Windows.Forms` so CoreBots compiles without WinForms).
