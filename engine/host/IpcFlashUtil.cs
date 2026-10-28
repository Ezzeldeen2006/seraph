using System.Collections.Concurrent;
using System.Dynamic;
using System.Xml.Linq;
using CommunityToolkit.Mvvm.Messaging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Skua.Core.Flash;
using Skua.Core.Interfaces;
using Skua.Core.Messaging;
using Skua.Core.Utils;

namespace Seraph.Skua;

/// <summary>
/// Skua's IFlashUtil with no Flash player behind it. Each call is sent to Seraph, which answers it the way
/// skua.swf would: from the real game on the desktop client, or from the headless client's world model on the
/// server. Return values are the same strings skua.swf returns (JSON for objects, "true"/"false" for checks).
/// </summary>
public sealed class IpcFlashUtil : IFlashUtil
{
    private readonly Ipc _ipc;
    private readonly Lazy<IScriptManager> _manager;
    private readonly IMessenger _messenger;

    public event FlashCallHandler? FlashCall;

    public IpcFlashUtil(Ipc ipc, IMessenger messenger, Lazy<IScriptManager> manager)
    {
        _ipc = ipc;
        _messenger = messenger;
        _manager = manager;
        _ipc.FlashEvent += (name, args) => FlashCall?.Invoke(name, args!);
    }

    public void InitializeFlash() { }

    public string? Call(string function, params object[] args) => Call<string>(function, args);

    public T? Call<T>(string function, params object[] args)
    {
        try
        {
            object? o = Call(function, typeof(T), args);
            return o is not null ? (T)o : (T?)DefaultProvider.GetDefault<T>(typeof(T));
        }
        catch
        {
            return (T?)DefaultProvider.GetDefault<T>(typeof(T));
        }
    }

    // Skua polls a few state checks from several threads (skill timer, waits, drops, quests) hundreds of times a
    // second: cheap in-process calls on the real Flash client, a round trip to Seraph here. The laptop's profile on
    // 2026-09-21 (a 2-core E1-2100 at load 9): 690,000 calls in 10 min for four characters, 70% of them these.
    // Their answers are reused for PollTtlMs; any call that is not a read (an action) forgets them all, so a read
    // right after an action is always fresh.
    private static readonly HashSet<string> Polled = new(StringComparer.Ordinal)
    {
        "isLoggedIn|", "isNull|world", "isNull|world.myAvatar", "getGameObjectS|serverIP",
        "getGameObject|world.myAvatar.dataLeaf.intState", "getGameObject|world.myAvatar.dataLeaf.intHP",
        "getGameObject|world.myAvatar.dataLeaf.intHPMax", "getGameObject|world.myAvatar.dataLeaf.intMP",
        "getGameObject|world.myAvatar.dataLeaf.intMPMax", "getGameObject|world.strMapName", "getGameObject|world.strFrame",
        "getGameObject|world.strPad", "getGameObject|world.myAvatar.dataLeaf.intLevel", "isNull|world.myAvatar.target",
        "getGameObject|world.myAvatar.objData.strClassName", "getGameObject|world.curRoom", "isNull|mcConnDetail.stage",
        "getTargetMonster|", "getGameObject|world.mapLoadInProgress",
    };
    // Big answers only a packet or an action can change (a full backpack is 40 KB of JSON, read over and over): kept
    // until the next packet that is not combat (Ipc.PacketGen) or the next action, and never longer than StableMaxMs.
    private static readonly HashSet<string> Stable = new(StringComparer.Ordinal)
    {
        "getGameObject|world.myAvatar.items", "getGameObject|world.myAvatar.tempitems", "getGameObject|world.myAvatar.houseitems",
        "getGameObject|world.bankinfo.items", "getGameObject|world.questTree", "getGameObject|world.shopinfo",
        "getGameObject|world.myAvatar.objData.iUpgDays", "getGameObject|world.myAvatar.objData.iRank",
        "getGameObject|world.myAvatar.items.length", "getGameObjectS|loginInfo.strUsername",
    };
    // Calls that look like actions but change nothing Skua polls: CoreBots re-applies these options every few seconds,
    // and these game functions only read. They must not throw the cached answers away (826 killLag calls in 10 min).
    private static readonly HashSet<string> Harmless = new(StringComparer.Ordinal)
    {
        "killLag", "infiniteRange", "skipCutscenes", "rejectExcept", "modEnable", "modDisable", "disableDeathAd",
        "callGameFunction0|world.myAvatar.pMC.artLoaded", "callGameFunction|world.isQuestInProgress",
        "callGameFunction|world.getQuestValue", "callGameFunction|world.maximumQuestTurnIns",
        // AQW 5.0 (2026-10-10): CoreBots asks the game for InvCat before every space check.
        "callGameFunction|loaderInfo.applicationDomain.hasDefinition", "callGameFunction|loaderInfo.applicationDomain.getDefinition",
    };

    private static bool IsHarmless(string function, object[] args) =>
        Harmless.Contains(function) || (args.Length > 0 && args[0] is string a0 && Harmless.Contains($"{function}|{a0}"));
    public static int StableMaxMs = int.TryParse(Environment.GetEnvironmentVariable("SERAPH_STABLE_MS"), out int sm) ? sm : 2000;
    private readonly ConcurrentDictionary<string, (long At, long Pkt, long Gen, string? Value)> _stable = new(StringComparer.Ordinal);
    public long StableHits;
    // SERAPH_POLL_MS: the Flash standby polls the real game, where each answer costs ~45 ms of its thread (default 100).
    public static int PollTtlMs = int.TryParse(Environment.GetEnvironmentVariable("SERAPH_POLL_MS"), out int pt) ? pt : 100;
    private readonly ConcurrentDictionary<string, (long At, string? Value)> _polled = new(StringComparer.Ordinal);
    public long PollHits, PollMisses;
    private long _gen;   // bumped whenever the polled answers are forgotten

    // Headless (2026-09-28 audit): Seraph pushes the model's revisions and polled values (Ipc.Revs / Ipc.Mirror), so
    // the big reads below stay cached until their own structure changes - not until the next skill cast or packet -
    // and the mirrored values need no round trip at all. Off on the desktop client, where Seraph pushes nothing.
    private static readonly Dictionary<string, string> RevOf = new(StringComparer.Ordinal)
    {
        ["getGameObject|world.myAvatar.items"] = "items", ["getGameObject|world.myAvatar.items.length"] = "items",
        ["getGameObject|world.myAvatar.tempitems"] = "temp", ["getGameObject|world.myAvatar.houseitems"] = "house",
        ["getGameObject|world.bankinfo.items"] = "bank", ["getGameObject|world.questTree"] = "quests", ["getGameObject|world.shopinfo"] = "shop",
    };
    public static int RevMaxMs = 60000;   // a safety net only: the revision is what keeps these right
    private readonly ConcurrentDictionary<string, (long At, long Rev, string? Value)> _revCache = new(StringComparer.Ordinal);
    public long RevHits, RevMisses, MirrorHits, LocalHits, CheckMismatches;
    // Tests (SERAPH_CACHE_CHECK=1): every mirrored or revision-cached answer is also fetched fresh and compared.
    private static readonly bool CacheCheck = Environment.GetEnvironmentVariable("SERAPH_CACHE_CHECK") == "1";

    // Option toggles CoreBots re-applies every few seconds that the headless model ignores (swfworld.js answers them
    // with null and changes nothing anyone reads): answered here. killLag and disableDeathAd set a flag, so each new
    // value still goes through once.
    private static readonly bool Headless = Environment.GetEnvironmentVariable("SERAPH_HEADLESS") == "1";
    private static readonly HashSet<string> LocalNoOp = new(StringComparer.Ordinal)
    {
        "infiniteRange", "skipCutscenes", "rejectExcept", "magnetize", "magnetise", "hidePlayers", "disableFX", "modEnable", "modDisable",
    };
    private static readonly HashSet<string> OnChange = new(StringComparer.Ordinal) { "killLag", "disableDeathAd" };
    private readonly ConcurrentDictionary<string, string> _lastSet = new(StringComparer.Ordinal);

    private static string? PlainKey(string function, object[] args) =>
        args.Length == 0 ? $"{function}|" : args.Length == 1 && args[0] is string a ? $"{function}|{a}" : null;

    // True when the call needs no round trip; `value` is then its answer.
    // The Flash standby (real game on the laptop): every bridge call costs ~45 ms of the game's thread, and CoreBots
    // re-sends these toggles every few seconds (35% of all Flash calls, 2026-10-11). The same call with the same
    // arguments within FlashThrottleMs is answered here; a different value, or later, still reaches the game (after a
    // class change infiniteRange must be applied again).
    private static readonly HashSet<string> FlashThrottled = new(StringComparer.Ordinal)
    {
        "infiniteRange", "skipCutscenes", "rejectExcept", "magnetize", "magnetise", "hidePlayers", "disableFX", "killLag", "disableDeathAd",
    };
    public static int FlashThrottleMs = int.TryParse(Environment.GetEnvironmentVariable("SERAPH_FLASH_THROTTLE_MS"), out int ft) ? ft : 10000;
    private readonly ConcurrentDictionary<string, long> _flashSent = new(StringComparer.Ordinal);

    private bool AnsweredHere(string function, object[] args, string? plain, out string? value)
    {
        value = null;
        if (!Headless && FlashThrottleMs > 0 && FlashThrottled.Contains(function))
        {
            string k = function + "|" + string.Join(",", args.Select(x => Convert.ToString(x, System.Globalization.CultureInfo.InvariantCulture)));
            long now = Environment.TickCount64;
            if (_flashSent.TryGetValue(k, out long at) && now - at < FlashThrottleMs)
            {
                Interlocked.Increment(ref LocalHits);
                value = function == "rejectExcept" ? "true" : null;   // skua.swf 1.4.5.0 answers rejectExcept with "true"
                return true;
            }
            _flashSent[k] = now;
            return false;
        }
        if (Headless && LocalNoOp.Contains(function))
        {
            Interlocked.Increment(ref LocalHits);
            return true;
        }
        if (Headless && OnChange.Contains(function))
        {
            string v = string.Join(",", args.Select(x => Convert.ToString(x, System.Globalization.CultureInfo.InvariantCulture)));
            if (_lastSet.TryGetValue(function, out string? last) && last == v)
            {
                Interlocked.Increment(ref LocalHits);
                return true;
            }
            _lastSet[function] = v;
            return false;
        }
        if (plain is not null && _ipc.MirrorOn && _ipc.Mirror.TryGetValue(plain, out value))
        {
            Interlocked.Increment(ref MirrorHits);
            if (CacheCheck && Ask(function, args, out string? fresh, out bool answered) && answered
                && _ipc.Mirror.TryGetValue(plain, out string? now) && now == value && fresh != value)
                Mismatch(plain, value, fresh);
            return true;
        }
        return false;
    }

    private void Mismatch(string key, string? cached, string? fresh)
    {
        Interlocked.Increment(ref CheckMismatches);
        _ipc.Log("debug", $"cache mismatch {key}: cached {Short(cached)} fresh {Short(fresh)}");
    }
    private static string Short(string? v) => v is null ? "null" : v.Length > 120 ? $"{v[..120]}... ({v.Length} chars)" : v;

    public object Stats() => new
    {
        mirrorHits = Interlocked.Read(ref MirrorHits), revHits = Interlocked.Read(ref RevHits), revMisses = Interlocked.Read(ref RevMisses),
        localHits = Interlocked.Read(ref LocalHits), pollHits = Interlocked.Read(ref PollHits), pollMisses = Interlocked.Read(ref PollMisses),
        stableHits = Interlocked.Read(ref StableHits), mirrorOn = _ipc.MirrorOn, revsOn = _ipc.RevsOn,
        checkMismatches = Interlocked.Read(ref CheckMismatches),
        parseHits = Interlocked.Read(ref ParseHits), parseMisses = Interlocked.Read(ref ParseMisses),
    };

    private static string? PollKey(string function, object[] args)
    {
        string key = args.Length == 0 ? $"{function}|" : args.Length == 1 && args[0] is string a ? $"{function}|{a}" : "";
        return key.Length > 0 && Polled.Contains(key) ? key : null;
    }

    private static string? StableKey(string function, object[] args)
    {
        if (args.Length != 1 || args[0] is not string a)
            return null;
        string key = $"{function}|{a}";
        return Stable.Contains(key) || key.StartsWith("getGameObject|litePreference.data.", StringComparison.Ordinal) ? key : null;
    }

    // Reads never change the game; everything else might (callGameFunction, useSkill, jumps, packets, set...).
    private static bool IsRead(string f) =>
        f.StartsWith("get", StringComparison.OrdinalIgnoreCase) || f.StartsWith("is", StringComparison.OrdinalIgnoreCase)
        || f.StartsWith("can", StringComparison.OrdinalIgnoreCase) || f.StartsWith("has", StringComparison.OrdinalIgnoreCase)
        || f.StartsWith("available", StringComparison.Ordinal) || f.StartsWith("rebuild", StringComparison.Ordinal)
        || f.StartsWith("inventory", StringComparison.Ordinal);   // skua.swf 1.4.5.0 Inventory.as: slot counts, pools, room

    public object? Call(string function, Type type, params object[] args)
    {
        // Same cancellation point as Skua's FlashUtil: a stopped script dies at its next game call.
        if (_manager.Value.ShouldExit && Thread.CurrentThread.Name == "Script Thread")
            _manager.Value.ScriptCts?.Token.ThrowIfCancellationRequested();
        try
        {
            string? plain = PlainKey(function, args);
            string? s;
            string? revKey = plain is not null && _ipc.RevsOn && RevOf.TryGetValue(plain, out string? rk) ? rk : null;
            if (AnsweredHere(function, args, plain, out s))
            {
                // mirrored, or an option the model ignores
            }
            else if (revKey is not null)
            {
                long rev = _ipc.Revs.TryGetValue(revKey, out long r) ? r : -1;
                if (_revCache.TryGetValue(plain!, out var rc) && rc.Rev == rev && Environment.TickCount64 - rc.At < RevMaxMs)
                {
                    Interlocked.Increment(ref RevHits);
                    s = rc.Value;
                    if (CacheCheck && Ask(function, args, out string? fresh, out bool answered) && answered
                        && (_ipc.Revs.TryGetValue(revKey, out long r3) ? r3 : -1) == rev && fresh != s)
                        Mismatch(plain!, s, fresh);
                }
                else
                {
                    Interlocked.Increment(ref RevMisses);
                    long asked = Environment.TickCount64;
                    if (!Ask(function, args, out s, out bool answered))
                        return null;
                    // Kept only if the structure did not move while it was being answered: then the answer is that revision.
                    if (answered && (_ipc.Revs.TryGetValue(revKey, out long r2) ? r2 : -1) == rev)
                        _revCache[plain!] = (asked, rev, s);
                }
            }
            else
            {
                string? key = PollKey(function, args);
                string? stableKey = key is null ? StableKey(function, args) : null;
                if (key is not null && _polled.TryGetValue(key, out var hit) && Environment.TickCount64 - hit.At < PollTtlMs)
                {
                    Interlocked.Increment(ref PollHits);
                    s = hit.Value;
                }
                else if (stableKey is not null && _stable.TryGetValue(stableKey, out var st) && st.Pkt == Interlocked.Read(ref _ipc.PacketGen)
                    && st.Gen == Interlocked.Read(ref _gen) && Environment.TickCount64 - st.At < StableMaxMs)
                {
                    Interlocked.Increment(ref StableHits);
                    s = st.Value;
                }
                else
                {
                    if (key is null && stableKey is null && !IsRead(function) && !IsHarmless(function, args))
                    {
                        Interlocked.Increment(ref _gen);
                        if (!_polled.IsEmpty)
                            _polled.Clear();
                        if (!_stable.IsEmpty)
                            _stable.Clear();
                    }
                    long asked = Environment.TickCount64;
                    long gen = Interlocked.Read(ref _gen);
                    long pkt = Interlocked.Read(ref _ipc.PacketGen);
                    if (!Ask(function, args, out s, out bool answered))
                        return null;
                    if (key is not null && answered)
                    {
                        Interlocked.Increment(ref PollMisses);
                        // An action that ran while this read was on its way makes the answer too old to keep.
                        if (Interlocked.Read(ref _gen) == gen)
                            _polled[key] = (asked, s);
                    }
                    // Kept only if no packet and no action came in while it was being answered.
                    if (stableKey is not null && answered && Interlocked.Read(ref _gen) == gen && Interlocked.Read(ref _ipc.PacketGen) == pkt)
                        _stable[stableKey] = (asked, pkt, gen, s);
                }
            }
            if (s is null)
                return null;
            if (type == typeof(string) || type == typeof(object))
                return s;
            return Convert.ChangeType(s, Nullable.GetUnderlyingType(type) ?? type, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception e)
        {
            _messenger.Send<FlashErrorMessage>(new(e, function, args));
            return null;
        }
    }

    // One round trip to Seraph. False when Seraph answered with an error (already reported); `answered` is false on a
    // timeout or a closed pipe, whose null must not be cached.
    private bool Ask(string function, object[] args, out string? s, out bool answered)
    {
        JToken? v = _ipc.Request(new { t = "c", f = function, a = args.Select(Wire).ToArray() });
        answered = v is not null;
        s = null;
        if (v is not null && v.Type == JTokenType.Object && v["error"] is JToken err)
        {
            _messenger.Send<FlashErrorMessage>(new(new Exception((string?)err), function, args));
            return false;
        }
        s = v is null || v.Type == JTokenType.Null ? null : v.Type == JTokenType.String ? (string)v! : v.ToString(Newtonsoft.Json.Formatting.None);
        return true;
    }

    // Arguments cross as plain JSON. ExpandoObjects and dynamic game objects serialize as objects.
    private static object? Wire(object? o) => o switch
    {
        null => null,
        string or bool or int or long or double or float or short or byte or decimal => o,
        _ => JToken.FromObject(o),
    };

    public object FromFlashXml(XElement el)
    {
        switch (el.Name.ToString())
        {
            case "number":
                return int.TryParse(el.Value, out int i) ? i : float.TryParse(el.Value, out float f) ? f : 0;
            case "true":
                return true;
            case "false":
                return false;
            case "null":
                return null!;
            case "array":
                return el.Elements().Select(e => FromFlashXml(e)).ToArray();
            case "object":
                IDictionary<string, object?> d = new ExpandoObject();
                foreach (XElement e in el.Elements())
                    d[e.Attribute("id")!.Value] = FromFlashXml(e.Elements().First());
                return d;
            default:
                return el.Value;
        }
    }

    // Parsed big answers (CPU profile of a laptop engine, 2026-10-21: 85-99% of every busy thread - the script thread,
    // both skill timers - was JsonConvert re-parsing the same bank and backpack JSON. CheckInventory reads Bank.Items
    // and Inventory.Items on every HuntMonster pass, and the skill timer reads Inventory.Items for Player.CurrentClass,
    // while the answer string itself came from the caches above unchanged). The same path, type and text give the same
    // list: each caller gets its own List over the parsed items, so adding or removing never reaches the next caller.
    // Small answers (a number, a flag) parse faster than they compare, so they are left alone.
    private readonly ConcurrentDictionary<(string Path, Type Type), (string Raw, System.Collections.IList List)> _parsed = new();
    public static int ParseMemoMinChars = int.TryParse(Environment.GetEnvironmentVariable("SERAPH_PARSE_MEMO_CHARS"), out int pm) ? pm : 1024;
    public long ParseHits, ParseMisses;

    T? IFlashUtil.GetGameObject<T>(string path, T? def) where T : default
    {
        try
        {
            string? raw = ((IFlashUtil)this).GetGameObject(path);
            if (raw is null || ParseMemoMinChars <= 0 || raw.Length < ParseMemoMinChars || !IsList(typeof(T)))
                return JsonConvert.DeserializeObject<T>(raw!) ?? def;
            (string, Type) key = (path, typeof(T));
            if (_parsed.TryGetValue(key, out var hit) && (ReferenceEquals(hit.Raw, raw) || string.Equals(hit.Raw, raw, StringComparison.Ordinal)))
            {
                Interlocked.Increment(ref ParseHits);
                return CopyList<T>(hit.List);
            }
            Interlocked.Increment(ref ParseMisses);
            T? v = JsonConvert.DeserializeObject<T>(raw);
            if (v is not System.Collections.IList list)
                return v ?? def;
            _parsed[key] = (raw, list);
            return CopyList<T>(list);
        }
        catch
        {
            return def;
        }
    }

    private static bool IsList(Type t) => t.IsGenericType && t.GetGenericTypeDefinition() == typeof(List<>);

    private static T CopyList<T>(System.Collections.IList from)
    {
        var to = (System.Collections.IList)Activator.CreateInstance(typeof(T), from.Count)!;
        foreach (object? o in from)
            to.Add(o);
        return (T)to;
    }

    public IFlashObject<T> CreateFlashObject<T>(string path) => new FlashObject<T>(Call<int>("lnkCreate", path), this);

    public void Dispose() { }
}
