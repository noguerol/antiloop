<div align="center">

![Antiloop banner](https://raw.githubusercontent.com/noguerol/antiloop/main/docs/banner.jpeg)

</div>

# Antiloop — Loop Detection and Break for pi

**Antiloop watches every assistant message, tool call and thinking block, and forces the model out of reasoning loops before they eat your context and your patience.** Four simultaneous detection strategies (text similarity, tool-call sequences, thinking content, structural openings) find loops that humans miss — and progressive intervention (warning → force break → abort) tells the model to take a different approach, without you having to babysit it.

---

## Features

- **Four detection strategies** — text repetition (trigram Jaccard + Levenshtein), tool-call sequences (name + near-identical arguments + same outcome — result-aware, so retries that make progress don't false-positive), thinking blocks, and structural opening-phrase patterns
- **Task-stream recognition (batch work)** — when another extension (e.g. `punched` appending lines to pi.md, or `plan` adding tasks) makes the model call the *same* tool many times with *different* content, antiloop recognizes it as N distinct tasks of one type and stays silent — no warning, no force break. A genuine loop (the *same* call repeated verbatim) is still caught
- **Progressive intervention** — `warning` reminds the model to vary its approach; `force break` injects explicit anti-loop instructions and modifies context; `abort` stops the run entirely
- **Configurable thresholds** — independent dials for similarity cutoff, warning/force-break/abort counts, detection window, and which strategies are on
- **Sliding window** — only the last N messages are compared, so detection is O(N) in the window size, not in the full session
- **Live footer indicator** — `🔄 antiloop(on|off)` in the footer, per spec, with the current level (`⚠️/🛑/🚨`) and consecutive count; an interactive TUI footer adds a keyboard toggle (`esc+a` by default, configurable/off) and preserves the built-in footer's pwd/branch/context/model info
- **Detection log** — timestamped history with similarity scores, filterable through the native pi menu
- **Self-test** — `/antiloop test` runs built-in cases to verify the similarity engine is calibrated
- **User input softens detection** — each new user message decays the consecutive counter so a fresh prompt can resolve the loop without manual reset
- **Bilingual-friendly** — no language assumptions in the comparison (only whitespace + punctuation normalization)

## Install

Antiloop is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) declared in `package.json`.

```bash
# From GitHub
pi install git:github.com/noguerol/antiloop

# Pin a tag/commit
pi install git:github.com/noguerol/antiloop@v1.0.0

# From npm
pi install npm:pi-antiloop

# Local checkout (development)
pi install /path/to/antiloop

# Try it for one run only
pi -e git:github.com/noguerol/antiloop
```

```bash
pi list                    # show installed packages
pi remove npm:pi-antiloop
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code. Install only packages you trust and review the source.

**Requirements:** a working pi installation. Works with every model — including small local ones that get stuck easily. Zero external dependencies.

## Quick Start

```
/antiloop            # toggle on (enabled by default)
/antiloop status     # check state, configuration, recent detections
/antiloop config     # adjust thresholds to taste
```

That's it. Antiloop is on by default. If the model ever starts repeating itself, you'll see a `⚠️ antiloop(N)` warning; if it keeps looping past the force-break threshold, antiloop injects an "abort this pattern now" instruction into the context.

## Commands

| Command | Description |
|---------|-------------|
| `/antiloop` | Toggle on/off |
| `/antiloop enable` / `/antiloop disable` | Explicit enable/disable |
| `/antiloop status` | Show current state, configuration, and recent detections |
| `/antiloop config` | Open interactive configuration menu |
| `/antiloop log` | Show detection history (last 30, newest first) |
| `/antiloop reset` | Clear all counters and history |
| `/antiloop test` | Run a self-test of the similarity engine |

### `/antiloop status`

Example output:

```
State: ✅ ENABLED
Current level: warning
Consecutive detections: 2
Total detections: 5
Messages tracked: 8
In forced break: no

Configuration:
  Warning threshold: 2 similar messages
  Force break threshold: 3 similar messages
  Abort threshold: disabled
  Similarity threshold: 75%
  Detection window: 10 messages

Detection strategies:
  Text loops: ✅
  Tool loops: ✅
  Thinking loops: ✅

Recent detections:
  [text] Text similarity 85% with message 3 (2m ago)
  [tool] repeated 3x: bash (5m ago)
```

### `/antiloop config`

Interactive menu with current values:

- **Enable/disable**
- **Warning threshold** — similar messages before warning (default 2)
- **Force break threshold** — similar messages before force break (default 3)
- **Abort threshold** — similar messages before abort (0 = disabled)
- **Similarity threshold** — `0.5 / 0.6 / 0.7 / 0.75 / 0.8 / 0.9` — how close two messages must be to count as looping
- **Tool similarity** — `0.99 / 0.95 / 0.9 / 0.8` — how close tool-call *arguments* must be to count as the same call (95% default: only near-identical repeats loop)
- **Tool repeat** — `1 / 2 / 3` — prior occurrences of the same call set required before a tool loop flags
- **Result similarity** — `0.95 / 0.8 / 0.6` — how similar captured results must be to count as the *same outcome* (veto when a repeated command starts succeeding/differing)
- **Task streams** — on/off — recognize homogeneous batch work (same extension tool, distinct content) as N tasks of one type, not a loop
- **Stream min calls** — `2 / 3 / 4 / 5` — same-tool calls required inside the window before batch recognition kicks in (default 3)
- **Stream twin threshold** — `99% / 95% / 90%` — arguments this similar count as the *same task*; a twin invalidates the stream and re-enables normal detection (default 99%)
- **Detection window** — `5 / 10 / 15 / 20` — number of recent messages to analyze
- **Per-strategy toggles** — text / tool / thinking detection
- **Notifications** — show detection notifications
- **Reset state** — clear all counters and history

### `/antiloop log`

Shows the most recent 30 detections with similarity scores and timestamps, newest first.

### `/antiloop test`

Runs the real detection engine (not a copy) — text similarity plus tool-call regression cases:

```
text identical      → 100% (exp 100%) ✅
text near-identical → 91% (exp ≥ 80%) ✅
text unrelated      → 19% (exp < 50%) ✅
tool identical cmd  → match (exp match) ✅
tool sweep (flags)  → no match @95% (exp no match) ✅   ← regression: 0.8–0.94 overlap is NOT a loop
tool sweep (old 80%)→ match @80% (exp match — was the false positive) ✅
tool different tool → no match (exp no match) ✅
tool empty lists    → no match (exp no match) ✅
result same outcome  → match (exp match — PID noise ok) ✅
result diff outcome  → no match (exp no match — error→success is progress) ✅
batch stream detected  → punched_log×3 (exp punched_log×3) ✅   ← task streams: N tasks of one type
batch no detections    → silent (exp silent — 98.9% args would match without gate) ✅
loop still detected     → tool (exp tool — identical repeats are NOT a stream) ✅
loop survives batch gate→ tool (exp tool — bash repeats are real) ✅
stream needs ≥3 calls   → no stream (exp no stream at 2 calls) ✅
```

## How It Works

### Detection pipeline

After every assistant `message_end` event, antiloop extracts the new content (text, thinking, tool calls — including their ids) and pushes it onto a sliding window of the last `detectionWindow + 5` messages. Detection itself runs at `turn_end`, once the tool results are known: results are fingerprinted and attached to the tracked calls, then the active detection strategies run against the window:

| Strategy | What it compares | Algorithm |
|----------|------------------|-----------|
| Text | Full assistant message text | n-gram Jaccard (≥ 100 chars) or Levenshtein (shorter) |
| Tool | Tool name + arguments (+ captured result) | Sequence match + near-identical args (≥ `toolSimilarityThreshold`, default 95%) *and* ≥ `minToolRepeatCount` prior recurrences. **Result veto:** if both runs captured a result and the outcomes differ, it's progress, not a loop |
| Thinking | Internal reasoning/thinking blocks | Same as text |
| Structural | First 10 words of each message | Opening-phrase similarity ≥ 90% across ≥ 3 messages |
| Task stream | Same tool, many calls | When a tool appears ≥ `taskStreamMinCalls` times (default 3) in the window and *no two* calls are near-identical (`taskStreamTwinThreshold`, default 99%), the tool is an active batch: N different tasks of one type (e.g. `punched_log` appends, `plan_manager` task adds). Those calls are exempt from tool-loop detection, and text/thinking/structural patterns that only involve those batch messages are suppressed too. If even one call pair is a twin (the same task repeated), the tool is *not* a stream and detection proceeds normally |

Each detected pair becomes a `LoopDetection { type, similarity, messageIndices, description }` and the consecutive counter increases.

### Intervention levels

| Level | Trigger | Behavior |
|-------|---------|----------|
| 0 (no loop) | — | Silent — passes the message through |
| 1 (warning) | `consecutiveDetections >= warningThreshold` | Notifies the user (`⚠️`) — no message is injected into the conversation, so the model's generation is never interrupted by the warning itself |
| 2 (force break) | `consecutiveDetections >= forceBreakThreshold` | Injects mandatory anti-loop instructions + appends a context message to the last assistant message |
| 3 (abort) | `consecutiveDetections >= abortThreshold` | (Disabled by default) Surfaces an error asking the user for new instructions |

The level never de-escalates during an active loop; user input decays the consecutive counter naturally so a fresh prompt can break the cycle.

### Similarity scoring

```
For short texts (< 100 chars):  Levenshtein distance
  "Hello world" vs "Hello World!" → 95% (1 char edit on 11 chars)

For longer texts:  Character trigram Jaccard
  "I will read the file first to understand the structure..."
  "I will read the file first to understand the codebase..."
  → ~85% (many shared 3-grams)

For tool calls:  sequence + per-call argument similarity ≥ 95% (default)
  [bash("setsid ./llama-server -m … -b 2048 -ctk q8_0 …")]
  [bash("setsid ./llama-server -m … -b 2048 -ctk q8_0 …")]      → matched (identical)

  …but a parameter sweep is NOT a loop, even at 80–94% similarity:
  [bash("… -b 2048 -ctk q8_0 -ctv turbo4 > /tmp/sweep-turbo4.log …")]
  [bash("… -b 8192 -ctk f16  -ctv f16  > /tmp/sweep-b8192.log …")]  → not matched

  Long bash commands share scaffolding (env setup, model path, most flags),
  so 80% overlap is normal for *different* sequential operations. Only
  near-identical repeats — the same call set seen `minToolRepeatCount` times
  inside the window — count as a tool loop.

Result veto (tool loops):  detection runs at `turn_end`, where the tool
results are known. Each captured result becomes a normalized tail fingerprint
("err|" / "ok|" prefix + last 400 chars, so PID/timestamp noise is tolerated).
If the same command produced a *different* outcome, the pair is progress:

  [bash("...")] → err|error: invalid argument: ROCm0        (attempt 1)
  [bash("...")] → ok|model loaded / listening on :8093      (attempt 2)
  → NOT a loop — the retry fixed the problem

  [bash("...")] → err|failed to create context …            (attempt 1)
  [bash("...")] → err|failed to create context …            (attempt 2)
  → loop signal (same command, same outcome, repeated)

Results only veto; they never trigger on their own, and calls without a
captured result fall back to argument matching alone.

### Task streams: N tasks of one type ≠ a loop

Extensions push homogeneous work into the model's hands. `punched` appends
lines to pi.md one at a time; `plan` adds tasks one at a time; `obsidian_*`
writes/edits notes file by file. Each call is a *different* task — "add line 1",
"add line 2", "add line 3" — of the *same type*, and the narration around it
sounds similar ("now appending the next entry…"). That is not a reasoning
loop; flagging it would interrupt legitimate multi-step work.

Antiloop recognizes this as a **task stream**: if the same tool name appears at
least `taskStreamMinCalls` times (default 3) inside the detection window and
no two calls are "twins" (arguments ≥ `taskStreamTwinThreshold` similar,
default 99% — any real content difference counts as a distinct task), the
tool is treated as an active batch:

- tool-loop detection skips messages whose calls are all stream tools;
- text / thinking / structural detections that only involve those batch
  messages are suppressed (identical narration while adding N entries is
  expected, not looping);
- the footer shows it: `🔄 antiloop(on) · batch: punched_log×4`.

Crucially, the exemption requires **no twins**: the moment the same call
repeats verbatim (or near-verbatim), the stream is invalid and normal loop
detection takes over — so a model stuck re-logging the *same* line still gets
caught. The check is name-agnostic: any extension tool used as a batch is
covered, no allow-list needed. If a genuine loop coexists with a batch (e.g.
the same `bash` command re-run while appending different notes), the loop is
still flagged.

Tunables: `detectTaskStreams` (master switch), `taskStreamMinCalls` (batch
size needed before recognition), `taskStreamTwinThreshold` (how similar args
must be to count as *the same task* — lower it to treat near-duplicate
entries as loops again).
```

### Sliding window

Only the last `detectionWindow` messages participate in comparisons, so detection cost stays bounded: O(N × W) where N is the window size and W is the message size. The window is trimmed to `detectionWindow + 5` to keep a small buffer past the analysis range, avoiding edge artifacts.

## Configuration

Persisted as JSON at `~/.pi/agent/antiloop.json`:

```json
{
  "enabled": true,
  "warningThreshold": 2,
  "forceBreakThreshold": 3,
  "abortThreshold": 0,
  "similarityThreshold": 0.75,
  "toolSimilarityThreshold": 0.95,
  "minToolRepeatCount": 2,
  "resultSimilarityThreshold": 0.8,
  "detectTaskStreams": true,
  "taskStreamMinCalls": 3,
  "taskStreamTwinThreshold": 0.99,
  "detectToolLoops": true,
  "detectThinkingLoops": true,
  "detectTextLoops": true,
  "notifyOnDetection": true,
  "maxHistoryEntries": 100,
  "detectionWindow": 10,
  "interactiveFooter": true,
  "toggleShortcut": "esc+a"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch |
| `warningThreshold` | `2` | Consecutive detections before warning |
| `forceBreakThreshold` | `3` | Consecutive detections before force break |
| `abortThreshold` | `0` | Consecutive detections before abort (0 = disabled) |
| `similarityThreshold` | `0.75` | Minimum similarity (0.0–1.0) to count a text/thinking pair as looping |
| `toolSimilarityThreshold` | `0.95` | How close tool-call arguments must be (0.0–1.0) to count as the *same* call — see [tool loops](#how-it-works) |
| `minToolRepeatCount` | `2` | Prior occurrences of a near-identical call set required before a tool loop is flagged (2 = same call seen 3×) |
| `resultSimilarityThreshold` | `0.8` | Minimum similarity between captured result tails to still count as the *same outcome*; below this, a repeated command is treated as progress, not a loop |
| `detectTaskStreams` | `true` | Recognize homogeneous batch work (same tool called with distinct content — e.g. punched/plan/obsidian extensions) and stay silent; see [task streams](#task-streams-n-tasks-of-one-type--a-loop) |
| `taskStreamMinCalls` | `3` | Same-tool calls required inside the window before a task stream is recognized |
| `taskStreamTwinThreshold` | `0.99` | Arguments this similar (or identical) count as *the same task* — a twin invalidates the stream and re-enables normal loop detection |
| `detectTextLoops` | `true` | Detect full-text repetition |
| `detectToolLoops` | `true` | Detect tool-call sequence + argument repetition |
| `detectThinkingLoops` | `true` | Detect repeated thinking/reasoning content |
| `notifyOnDetection` | `true` | Show a notification on every detection |
| `maxHistoryEntries` | `100` | Max detection history entries |
| `detectionWindow` | `10` | Number of recent messages to analyze |
| `interactiveFooter` | `true` | TUI footer replaces the built-in one with an antiloop indicator + toggle shortcut (set `false` to keep the built-in footer and only the `setStatus` line) |
| `toggleShortcut` | `esc+a` | Key sequence that toggles antiloop from the footer (`esc+a` or `off`). The input is never consumed, so typing is unaffected |

## Best Practices

1. **Start with defaults** — `warning=2 / force-break=3 / similarity=75% / tool-sim=95%` works well for most models.
2. **Adjust sensitivity to the model** — small/local models loop more, so lower `warningThreshold` and `similarityThreshold` to catch them early. Big cloud models rarely loop, so you can raise them to avoid false positives.
3. **Tool loops are strict on purpose** — a long bash command with env setup + flags scores 80–94% similar to the *next, different* command. Antiloop only flags tool calls that are near-identical (≥ 95%) *and* repeated ≥ `minToolRepeatCount` times, *and* — when results are captured — produced the same outcome. If you still see false positives on sequential operations, raise `toolSimilarityThreshold` (or `minToolRepeatCount`, or `resultSimilarityThreshold`) via `/antiloop config` — don't disable the detector.
4. **Per-strategy toggles** — if the model's reasoning legitimately repeats (e.g. it's working through a checklist), disable `thinking` detection and leave text/tool on.
5. **Watch the log** — `/antiloop log` shows what's actually triggering. If you see false positives, raise `similarityThreshold` instead of disabling the strategy entirely.
6. **Let user input clear state** — each user message decays the consecutive counter by 2, so a fresh prompt naturally resets without `/antiloop reset`.
7. **`/antiloop test`** — runs the real detection engine (text + tool-call regression cases) to verify calibration after any change.

## Architecture

```
antiloop/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
├── docs/
│   ├── banner.jpeg      # wide README header
│   └── preview.jpeg     # npm pi.dev preview card
└── src/
    ├── index.ts        # hooks + intervention pipeline
    ├── detect.ts       # similarity engine, detection strategies, self-test
    ├── commands.ts     # /antiloop command handlers + config menu
    ├── config.ts       # config load/save
    ├── types.ts        # shared types
    └── ui.ts           # UI helpers (select, duration)
```

Modular extension with zero external dependencies (only pi's bundled `@earendil-works/pi-coding-agent` + Node built-ins):

- **Levenshtein + trigram Jaccard** hybrid — small texts use edit distance, large texts use n-gram overlap (each is O(N) in text length)
- **Sliding window** — only the last `detectionWindow` messages participate, capping memory at O(W × message_size)
- **Early bail** — short messages and empty tool calls skip similarity computation entirely
- **TUI integration** — uses `ctx.ui.select` for the config menu and the log viewer; `ctx.ui.notify` for state notifications; `ctx.ui.setStatus` + a custom `ctx.ui.setFooter` component for the persistent footer indicator, live level info, and the `esc+a` keyboard toggle (`ctx.ui.onTerminalInput`, never consumes input)
- **Hooks** — `message_end` (track messages + tool call ids), `turn_end` (attach result fingerprints + detect), `input` (decay), `before_agent_start` (inject intervention — force/abort only), `context` (modify context in force-break mode), `session_start` (load config + install footer + reset), `session_shutdown` (restore built-in footer)

## License

[MIT](LICENSE) © Javier Noguerol
