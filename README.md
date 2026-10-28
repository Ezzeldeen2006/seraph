# Seraph

**A headless AdventureQuest Worlds party bot that runs [Skua](https://github.com/auqw/Skua) scripts on a Linux server: no Flash, no screen, no Windows.**

Seraph logs several AQW characters in at once with its own protocol client, and runs the real Skua engine
(`Skua.Core`) in a small .NET host on Linux for each character that needs a script. A JavaScript stand-in answers
every call a Skua script would normally make to the Flash game, so the community's thousands of Skua scripts run
unchanged. On top of that, Seraph manages the party: it gives each character work and ultra raids, calls the others
when one of them can't beat a boss, and has a web dashboard and a Discord bot to control it all.

> **Built on Skua.** Seraph is not a Skua replacement. The script engine is Skua's own `Skua.Core`, compiled for
> Linux with a small set of patches. The scripts are the [auqw/Scripts](https://github.com/auqw/Scripts) library. All
> credit for the engine and the scripts goes to their authors (see [Credits](#credits)).

> **Disclaimer.** This is an unofficial fan project, not affiliated with or endorsed by Artix Entertainment. Using
> bots in AdventureQuest Worlds may break the game's Terms of Service and can get accounts banned. Use it at your own
> risk, on accounts you own. Nothing here is meant to harm the game, its servers or other players: Seraph has rules
> that keep its characters out of other players' way (see `app/lib/manners.js`).

---

## What it does

- **Runs Skua scripts headless on Linux.** `Skua.Core` (the real engine: script compiler, `ScriptInterface`, every
  `Script*` class) runs in `engine/host`, a .NET 10 console host. Each character gets its own engine process.
- **Talks to AQW without Flash.** `app/lib/net/headless.js` speaks the game's socket protocol (login, rooms, combat,
  quests, shops, drops, banking...). `app/lib/skua/swfworld.js` is a stand-in for Skua's `skua.swf` bridge: it answers
  the bridge calls, game functions and object paths that Skua scripts use, from a model of the game world kept up to date
  from the server's packets.
- **Runs a whole party.** One hub (`app/lib/hub.js`) drives many characters:
  - a "brain" that picks each character's next goal
  - help calls, where the cheapest squad goes to whoever is stuck on a boss
  - crew rounds for daily bosses and army scripts
  - Ultras v3 raids, with saved line-ups that won before ("proven recipes")
  - the server hops, banking and backpack room that all of that needs
- **Gets out of the scripts' way.** A Skua script fighting a boss owns the fight: Seraph only steps in after a long time
  with nothing gained. Enhancement requests are served by putting on an owned item that already has the requested
  enhancement instead of buying a re-enhance (`app/script-fixes`, `CoreAdvanced` fix).
- **Fixes upstream scripts at load time.** Small, exact patches (`app/script-fixes/fixes.json`) are applied to the
  library file being loaded. If an upstream change moves the patched lines, the patch fails loudly; it never silently
  misapplies.
- **Dashboard and Discord.** `app/admin` is a password-protected web dashboard for the home network: party frames,
  orders, the raid planner, settings. `app/lib/discordbot.js` provides slash commands, alerts and a daily report.
- **Shares engines on small machines.** It has been run with eight characters on a 2-core, 3 GB laptop. Engine
  processes are time-shared, slots are admitted by CPU and memory pressure, and compiled scripts are cached and
  shared between engines.

## Architecture

```
            ┌──────────────────────── Linux server ─────────────────────────┐
            │                                                               │
 Discord ◄──┤  app/headless.js  (Node 22)                                   │
            │   ├─ hub.js        party, brain, raids, crews, help calls      │
 browser ◄──┤   ├─ admin/        dashboard (home network only)              │
            │   ├─ bot.js ×N     one per character: tasks, gear, banking    │
            │   │   └─ net/headless.js ──── AQW socket protocol ──────► AQW servers
            │   └─ skua/engine.js ─ IPC (stdin/stdout JSON) ─┐              │
            │        skua/swfworld.js (the skua.swf stand-in)│              │
            │                                                ▼              │
            │  engine/host  (.NET 10)   SeraphSkua host                     │
            │   └─ Skua.Core + patches ── compiles & runs auqw/Scripts       │
            └───────────────────────────────────────────────────────────────┘
```

## Requirements

- Linux (developed on Ubuntu 26.04) or Windows.
- [Node.js](https://nodejs.org) 22 or newer.
- [.NET 10 SDK](https://dotnet.microsoft.com/download), or `dotnet-install.sh` per user.
- `git`.

## Setup

```bash
git clone https://github.com/Ezzeldeen2006/seraph.git && cd seraph

# 1. Skua's engine, at the commit Seraph's patches are made for (Seraph does not ship Skua's code)
git clone https://github.com/auqw/Skua.git engine/skua-src
git -C engine/skua-src checkout "$(cat engine/SKUA_COMMIT)"
node engine/sync-skua.js          # engine/vendor = Skua.Core + Seraph's patches (see engine/PATCHES.md)

# 2. Build the engine host (Linux; engine\build.bat on Windows)
bash engine/build.sh              # -> app/engine/linux-x64

# 3. The Skua script library, and the Ultras v3 raid scripts
mkdir -p ~/seraph
git clone https://github.com/auqw/Scripts.git ~/seraph/Scripts
git clone -b Skua https://github.com/noelrohi/Scripts.git ~/ultras-src
node app/tools/vendor-ultras.js ~/ultras-src/Ultrasv3

# 4. Configure (see examples/) and start
cp examples/accounts.example.json ~/seraph/accounts.json      # your characters
cp examples/login.example.txt ~/seraph/logins.txt             # their usernames/passwords (keep this file private)
node app/headless.js
```

Everything Seraph writes goes under `SERAPH_ROOT` (default `~/seraph`): `accounts.json`, the per-character folders
`accounts/<id>/` (journal, logs, queue), `hub.json` (settings), `discord.json`, `admin.json`. Useful variables:

| Variable | Default | Meaning |
|---|---|---|
| `SERAPH_ROOT` | `~/seraph` | data folder |
| `SERAPH_SCRIPTS` | `$SERAPH_ROOT/Scripts` | the auqw/Scripts checkout |
| `SERAPH_PORT` | `47101` | local control API |
| `SERAPH_ADMIN_PORT` | `47180` | dashboard |
| `SKUA_SRC` | `engine/skua-src` | Skua source for `sync-skua.js` |

To run it as a service, `app/deploy/` has systemd units (`seraph-bots`, `seraph-admin`) and a logrotate file. Edit
the user and paths before you install them.

### Dashboard

`node app/admin/server.js` starts the dashboard on port 47180. It accepts connections from the local network only.
The first start writes a random password to `$SERAPH_ROOT/admin-password.txt`.

### Discord (optional)

Put a `discord.json` next to `accounts.json` (see `examples/discord.example.json`): a channel webhook, and/or a bot
token for slash commands and direct messages. DMs are reserved for things that need the owner (all bots offline, the
service crashing, an AQW game update). Everything else goes to the channel.

## Tests

```bash
cd app && node tests/run.js            # ~600 tests, a few minutes
node tests/run.js "crew"               # only tests whose name contains "crew"
```

The tests read the Skua script library from `~/seraph/Scripts` (setup step 3) or `SERAPH_SCRIPTS`. Tests that need
something this repository does not ship (the vendored Ultras v3 scripts, look data, the community forge sheet) are
skipped, and the reason is printed. `engine/tests/flashscan.js` lists every Flash call, game function and object path
the Skua library uses that the stand-in does not answer.

## Project layout

```
app/
  headless.js        the Linux entry point (no Electron, no Flash)
  main.js, ui/       the optional Windows desktop app (Electron + the real Flash game)
  lib/               hub, bots, brain, raids, crews, gear, banking, Discord...
  lib/net/           the AQW protocol client
  lib/skua/          the Skua engine bridge and the skua.swf stand-in
  admin/             the dashboard
  script-fixes/      patches applied to library scripts when they load
  tests/             unit and integration tests (a fake AQW server included)
  tools/             vendor-ultras.js, lookbook.js, timeuse.js
  deploy/            systemd units
engine/
  host/              the .NET host that runs Skua.Core headless
  winforms-shim/     a tiny System.Windows.Forms stand-in so Skua.Core loads on Linux
  sync-skua.js       builds engine/vendor from a Skua checkout + the patches in PATCHES.md
  skua-additions/    files Seraph adds to Skua.Core (SeraphSourceFilter, MasterSkillProvider)
  tests/             engine smoke tests, flashscan.js
```

## Credits

Seraph exists because of these projects and people:

- **[Skua](https://github.com/auqw/Skua)** by the auqw team. Seraph's script engine is Skua's `Skua.Core`, built for
  Linux. Seraph does not redistribute Skua's code: `engine/sync-skua.js` takes it from your own checkout and applies the
  changes listed in [`engine/PATCHES.md`](engine/PATCHES.md).
- **[auqw/Scripts](https://github.com/auqw/Scripts)**, the Skua script library and its many authors. Every bot task
  Seraph runs is one of these scripts.
- **[Ultras v3](https://github.com/noelrohi/Scripts)** (noelrohi's fork of the Scripts, branch `Skua`), the ultra raid
  and army scripts that Seraph's raids and crews run.
- **[VibeSkua](https://github.com/NinjaXz/VibeSkua)** by NinjaXz, for the adaptive skill provider
  (`engine/skua-additions/Skua.Core/Skills/MasterSkillProvider.cs`, MIT, notice kept in the file) and for ideas.
- The **[AQW Wiki](https://aqwwiki.wikidot.com)** editors, for boss mechanics, drop rates and item data.
- **Artix Entertainment** for AdventureQuest Worlds. AQW and its assets belong to Artix Entertainment; none are
  included here.
- Fonts: IBM Plex Sans/Mono and Space Grotesk, under the SIL Open Font License.

## License

Seraph's own code is under the [MIT License](LICENSE). The projects above keep their own licenses and copyrights, and
their code is not part of this repository.
