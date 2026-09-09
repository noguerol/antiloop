<div align="center">

![Antiloop banner](https://raw.githubusercontent.com/noguerol/antiloop/main/docs/banner.jpeg)

</div>

# Antiloop — Loop Detection and Break for pi

**Antiloop watches every assistant message, tool call and thinking block, and forces the model out of reasoning loops before they eat your context and your patience.** Six simultaneous detection strategies (text similarity, tool-call sequences, thinking content, structural openings, degenerate repetition, no-progress outcome runs) find loops that humans miss — and progressive intervention (warning → force break → abort) tells the model to take a different approach, without you having to babysit it.

---

## Features

- **Six detection strategies** — text repetition (trigram Jaccard + Levenshtein), tool-call sequences (name + near-identical arguments + same outcome — result-aware, so retries that make progress don't false-positive), thinking blocks, structural opening-phrase patterns, **degenerate repetition** (a single message/call stuck repeating one word hundreds of times — the `noguerol ×5145` meltdown — caught at `message_end` with no repeated peer needed, and degenerate bash commands blocked before they execute), and **no-progress outcome runs** (the NFS `test A…QQQ` class: dozens of near-identical re-runs of the same experiment, every one ending in the *same failing outcome* — args mutate so tool-loop can't see it; the repeated failure signature can)
- **Stays alive in long sessions** — tracked messages carry a monotonic sequence number, so trimming the sliding window can never make the dedupe guard skip later messages (a bug that silently blinded antiloop after ~15 tracked messages)
- **Task-stream recognition (batch work)** — when another extension (e.g. `punched` appending lines to pi.md, or `plan` adding tasks) makes the model call the *same* tool many times with *different* content, antiloop recognizes it as N distinct tasks of one type and stays silent — no warning, no force break. A genuine loop (the *same* call repeated verbatim) is still caught
- **Progressive intervention** — `warning` reminds the model to vary its approach; `force break` steers a real break message into the running agent before its next LLM call; `abort` stops the run entirely
- **Configurable thresholds** — independent dials for similarity cutoff, warning/force-break/abort counts, detection window, and which strategies are on
- **Sliding window** — only the last N messages are compared, so detection is O(N) in the window size, not in the full session
- **Live footer indicator** — `🔄 antiloop(on|off)` in the footer, per spec, with the current level (`⚠️/🛑/🚨`) and consecutive count; an interactive TUI footer adds a keyboard toggle (`esc+a` by default, configurable/off, honored only while idle) and preserves the built-in footer's pwd/branch/context/model info
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

That's it. Antiloop is on by default. If the model ever starts repeating itself, you'll see a `⚠️` warning; if it keeps looping past the force-break threshold, antiloop steers a break message into the *running* agent before its next tool call — and if the model ignores it and keeps repeating verbatim, antiloop aborts the run. Loops always terminate.

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
  Degenerate: ✅
  Outcome (no-progress): ✅

Recent detections:
  [text] Text similarity 85% with message 3 (2m ago)
  [tool] repeated 3x: bash (5m ago)
  [degenerate] bash command: degenerate repetition — "noguerol" ×5145 (5m ago)
  [outcome] no progress: 9 near-identical bash attempts with the same failing outcome (5m ago)
```

### `/antiloop config`

Grouped interactive menu showing the current value in each option:

**🎛️ General**
- **🟢/🔴 enable/disable** — turn detection on or off
- **⏳ window** — `5 / 10 / 15 / 20` — how many recent messages are analyzed (default 10)
- **🔔 notifications** — on/off — show a warning when a loop is detected
- **📊 interactive footer** — on/off — experimental: replaces pi's footer and captures keystrokes for the toggle shortcut (leave it off if it misbehaves)
- **⌨️ shortcut** — `esc+a` or off — key press to toggle without typing a command

**🎯 Detection**
- **⚠️ warn threshold** — `1 / 2 / 3 / 5` — repetitions before antiloop warns you (default 2)
- **🛑 force break threshold** — `2 / 3 / 5 / 8` — repetitions before forcing a change of approach (default 3)
- **🚨 abort threshold** — `off / 5 / 8 / 10 / 15` — repetitions before aborting (0 = disabled)
- **📏 text similarity** — `50 / 60 / 70 / 75 / 80 / 90%` — how similar two messages must be to count as a loop (default 75%)
- **🔧 call similarity** — `99 / 95 / 90 / 80%` — how identical tool-call *arguments* must be to count as the same call (default 95%: only near-identical repeats loop)
- **🔁 call repeats** — `1 / 2 / 3` — how many times the same call must repeat before it flags (default 2)
- **🧾 result similarity** — `95 / 80 / 60%` — how similar captured results must be to count as the *same outcome*; a repeated command that starts producing a different result is progress, not a loop (default 80%)
- **🌀 degenerate run** — `8 / 16 / 24 / 48` — identical words in a row inside ONE message/call before it counts as stuck generation (default 16; the `noguerol ×5145` class)
- **⛔ block degenerate bash** — on/off — refuse a degenerate bash command before it executes, feeding the reason back to the model (default on)
- **📉 no-progress after** — `4 / 6 / 8 / 12` — same failing outcome repeated this many times (near-identical args) before flagging (default 8; the NFS `test A…QQQ` class)

**📋 Task streams** — batch work (punched_log, plan_manager, …) is N tasks of one type, not a loop
- **📋 task streams** — on/off — recognize that batch work and stay silent
- **📋 stream min calls** — `2 / 3 / 4 / 5` — same-tool calls required before a batch is recognized (default 3)
- **📋 twin threshold** — `99 / 95 / 90%` — calls more similar than this count as the *same task* repeated; one twin invalidates the batch and normal detection resumes (default 99%)

**🔍 Detectors**
- **📝 text** — on/off — detect repeated text messages
- **🔧 tools** — on/off — detect repeated tool calls
- **🧠 thinking** — on/off — detect repeated internal reasoning
- **🌀 degenerate** — on/off — detect one message stuck repeating a single word/token (no repeated peer needed)
- **📉 outcome** — on/off — detect many near-identical attempts all ending in the same failing outcome (no progress)

**🧹 reset state** — clear all counters and history

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
degenerate first sight   → degenerate (bash command: "noguerol" ×402 …) ✅   ← v1.6: ONE meltdown message, no peer
degenerate legit cmd      → ok (exp ok) ✅
degenerate interleaved    → flag (noguerol ×150) (exp flag — freq/share clause) ✅
degenerate glued token    → flag (noguerol ×300) (exp flag — perfect power) ✅
degenerate turn weight    → degenerate 2, text 1 (exp 2, 1) ✅
outcome fires on 9th      → outcome (9 near-identical bash attempts, same failing outcome) ✅   ← v1.6.1: NFS test-A…QQQ class
outcome needs 8 prior     → silent (exp silent at 5 attempts) ✅
outcome converging sweep  → silent (exp silent — outcomes differ = progress) ✅
outcome diff failures     → silent (exp silent — error changed = progress) ✅
outcome identical OKs     → silent (exp silent — success repeats ≠ loop) ✅
```

## How It Works

### Detection pipeline

After every assistant `message_end` event, antiloop extracts the new content (text, thinking, tool calls — including their ids) and pushes it onto a sliding window of the last `detectionWindow + 5` messages. Detection itself runs at `turn_end`, once the tool results are known: results are fingerprinted and attached to the tracked calls, then the active detection strategies run against the window. The one exception is the **degenerate** strategy: a single stuck message needs no peer and no tool result, so it is evaluated right at `message_end` — the only point before the message's own tool calls execute — and degenerate `bash` calls are also blocked at the `tool_call` hook.

| Strategy | What it compares | Algorithm |
|----------|------------------|-----------|
| Text | Full assistant message text | n-gram Jaccard (≥ 100 chars) or Levenshtein (shorter) |
| Tool | Tool name + arguments (+ captured result) | Sequence match + near-identical args (≥ `toolSimilarityThreshold`, default 95%) *and* ≥ `minToolRepeatCount` prior recurrences. **Result veto:** if both runs captured a result and the outcomes differ, it's progress, not a loop |
| Thinking | Internal reasoning/thinking blocks | Same as text |
| Structural | First 10 words of each message | Opening-phrase similarity ≥ 90% across ≥ 3 messages |
| Degenerate | One single message/call (no peer needed) | Run-length + frequency of identical words inside the payload: ≥ `degenerateMaxRun` (default 16) consecutive identical words, or one word ≥ `degenerateMaxFreq`× at ≥ `degenerateMaxShare` of all tokens; plus a perfect-power check for glued no-space tokens. Scanned at `message_end` — before the tool calls execute — and on every `bash` `tool_call` (blocking gate) |
| Outcome | Single tool calls across the window, after the last user input | ≥ `outcomeMinRepeats` (default 8) PRIOR attempts with args ≥ `outcomeArgSimilarity` (0.85) similar AND the same *failing* outcome (failure signatures compared at ≥ `outcomeSigThreshold`, 0.7; identical OK results never count — they're the norm for batches). Catches mutated re-run loops the tool detector can't see (labels/permutations change every turn) |
| Task stream | Same tool, many calls | When a tool appears ≥ `taskStreamMinCalls` times (default 3) in the window and *no two* calls are near-identical (`taskStreamTwinThreshold`, default 99%), the tool is an active batch: N different tasks of one type (e.g. `punched_log` appends, `plan_manager` task adds). Those calls are exempt from tool-loop detection, and text/thinking/structural patterns that only involve those batch messages are suppressed too. If even one call pair is a twin (the same task repeated), the tool is *not* a stream and detection proceeds normally |

Each detected pair becomes a `LoopDetection { type, similarity, messageIndices, description }` and the consecutive counter increases (a degenerate turn counts `degenerateTurnWeight`, default 2 — warning on first sight).

### Intervention levels

| Level | Trigger | Behavior |
|-------|---------|----------|
| 0 (no loop) | — | Silent — passes the message through |
| 1 (warning) | `consecutiveDetections >= warningThreshold` | Notifies the user (`⚠️`) — no message is injected into the conversation, so the model's generation is never interrupted by the warning itself |
| 2 (force break) | `consecutiveDetections >= forceBreakThreshold` | Steers a real break message into the running agent (`pi.sendUserMessage`, delivered right before its next LLM call) telling it to stop repeating and change approach |
| 3 (abort) | `consecutiveDetections >= abortThreshold` | (Disabled by default) Stops the run outright via `ctx.abort()` |

The level never de-escalates during an active loop; user input decays the consecutive counter naturally so a fresh prompt can break the cycle.

**Degenerate turns are handled earlier than the ladder:** the meltdown is detected at `message_end` (the same moment the text/tool-call payload is complete, *before* pi preflights and executes its tools). A single degenerate turn already adds `degenerateTurnWeight` (2) consecutive points → warning on first sight; the second consecutive meltdown → force break steer; after the steer, further degenerate output counts against `ignoredSteerLimit` → hard stop. Degenerate `bash` calls are additionally refused by the `tool_call` gate (`blockDegenerateBash`) — the command never runs, and the block reason is fed back to the model as the tool error so it can still change approach.

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

### Degenerate repetition: ONE message stuck on a word ≠ a reasoning loop

All strategies above need at least two similar messages — they detect a model
*repeating itself across turns*. There is a different, equally destructive
failure mode they cannot see: the model's decoder **anchors on a token and
stops producing new output**, repeating the same word hundreds of times
*inside a single message or tool call*. Real case (session `2026-09-09T15-43`,
/home/j — Qwen3.8-27B on llama.cpp): one 46 KB `bash` call whose SSH
username wordlist repeated `noguerol` **5145 times** (a run of 5140 — 99% of
the payload). Every cross-message detector stayed silent (nothing to compare
against — it happened exactly once), and only a manual ESC stopped it.

Antiloop v1.6 detects this **degenerate repetition** directly, on the first
occurrence, with no peer message:

- **Run-length** — a payload of ≥ `degenerateMinTokens` (50) normalized words
  containing ≥ `degenerateMaxRun` (16) *consecutive identical* words is a
  meltdown.
- **Frequency share** — one word appearing ≥ `degenerateMaxFreq` (60) times
  with ≥ `degenerateMaxShare` (40%) of all tokens catches interleaved
  meltdowns (`A B A B A B…`) that have no long run.
- **Perfect power** — a single giant token with no separators at all
  (`noguerolnoguerol…`) is checked for periodicity.

Tokenization uses runs of letters (unicode), so JSON stringification noise
(escaped `\n` in stored tool args, punctuation, digits, code symbols) never
fragments the repeated word — and legit payloads full of numbers or code
symbols don't false-positive. 1-letter tokens are ignored as candidates
(`{"a":1}` JSON keys can't trigger).

Because the signal is conclusive, it acts **before the tools run**: the
meltdown is caught at `message_end` (pi emits it once the assistant message is
complete, before tool preflight), escalates immediately (one degenerate turn =
`degenerateTurnWeight` = 2 consecutive points → warning on first sight, force
steer on the second consecutive meltdown), and any degenerate `bash` command
is **blocked in the `tool_call` hook** (`blockDegenerateBash`) — the 46 KB
brute-force style command never executes. The block reason is returned to the
model as the tool error, so the next LLM call can still change approach; only
if it keeps melting does antiloop steer and then hard-stop the run.

Legit commands are safe: real scripts never repeat one word 16+ times in a
row inside a ≥ 50-token payload (verified against the actual sequential bash
sweeps that motivated the tool-loop threshold). Only `bash` gets the blocking
gate — writing a repetitive *file* (e.g. a user-requested padding fixture) is
alerted and escalated, not refused.

### No-progress outcome runs: mutated re-runs, same wall

A subtler meltdown than the degenerate one: the model re-runs the SAME
experiment over and over, mutating a cosmetic label or permutation each time
so no call ever repeats verbatim — while the outcome stays the SAME FAILURE.
Real case (same session, rows 95–249): ~90 ssh `exportfs`/`mount` tests,
labels `test A` … `test QQQ`, targets alternating Javi/Compartido — every one
ending `access denied` / `rc=32`, with fresh journalctl noise per attempt.
The tool-loop detector is blind to it BY DESIGN (args mutate every turn:
mean adjacent trigram similarity 0.93, but the label always changes, so the
same call never recurs `minToolRepeatCount` times) and results only *veto*
tool loops today — nothing used "same outcome repeated" as a positive signal.

Antiloop v1.6.1's **outcome detector** closes exactly that gap, conservatively:

- the LAST turn's single tool call must have a captured result that is a
  FAILURE (fingerprints carry an error signature — `ok|fail|sig|…` — extracted
  around the first failure marker over the FULL output, because a tool run can
  fail with `isError=false`: the ssh pipeline exits 0 while `rc=32` lives
  inside the text);
- at least `outcomeMinRepeats` (default 8) PRIOR single-call turns (all after
  the last real user message) must share BOTH args ≥ `outcomeArgSimilarity`
  (0.85 — the same experiment reshuffled) AND the same failure signature
  (digit-stripped signatures compared at `outcomeSigThreshold`, 0.7 — mount
  targets that legitimately vary between attempts survive, journalctl noise
  doesn't).

Guarantees preserved: converging sweeps change outcome → silent; different
failures = evolving diagnosis → silent; identical OKs (task-stream batches,
file writes, idempotent verifications) never count as failures → silent;
user-steered turns don't count → only the autonomous stretch is judged.
Because the signal is proven no-progress, one such turn adds
`degenerateTurnWeight` (2) points → warning on the crossing turn, force-break
steer on the next, hard stop shortly after if the same wall persists. On the
real session this fires at `test MM` (warn) → `NN` (steer) → `PP` (abort) —
~50 wasted experiment turns cut.

Tunables: `detectOutcomeLoops`, `outcomeMinRepeats` (lower = earlier cutoff),
`outcomeArgSimilarity`, `outcomeSigThreshold`.
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
  "detectDegenerate": true,
  "degenerateMinTokens": 50,
  "degenerateMaxRun": 16,
  "degenerateMaxFreq": 60,
  "degenerateMaxShare": 0.4,
  "degenerateTurnWeight": 2,
  "blockDegenerateBash": true,
  "detectOutcomeLoops": true,
  "outcomeMinRepeats": 8,
  "outcomeArgSimilarity": 0.85,
  "outcomeSigThreshold": 0.7,
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
| `detectDegenerate` | `true` | Detect intra-message degenerate repetition — one message/call stuck repeating a single word (the `noguerol ×5145` class). Needs no repeated peer message; scanned at `message_end` and on every bash `tool_call` |
| `degenerateMinTokens` | `50` | Minimum normalized tokens in a payload before it is scanned for degenerate repetition (shorter payloads aren't conclusive) |
| `degenerateMaxRun` | `16` | Consecutive identical words inside one payload that flag it as degenerate |
| `degenerateMaxFreq` | `60` | One word's total occurrences (with `degenerateMaxShare` of the payload) that flags interleaved meltdowns |
| `degenerateMaxShare` | `0.4` | Frequency share (freq/total tokens) required together with `degenerateMaxFreq` |
| `degenerateTurnWeight` | `2` | Consecutive-detection points added by one degenerate turn (2 = warning on first sight) |
| `blockDegenerateBash` | `true` | Block a degenerate `bash` command in the `tool_call` hook before it executes; the reason is fed back to the model as the tool error |
| `detectOutcomeLoops` | `true` | No-progress outcome runs: ≥ `outcomeMinRepeats` near-identical attempts (args ≥ `outcomeArgSimilarity`) all ending in the *same failing outcome* — the NFS `test A…QQQ` class |
| `outcomeMinRepeats` | `8` | Prior same-failure attempts (inside the window, after the last user input) required before the outcome detector fires |
| `outcomeArgSimilarity` | `0.85` | How similar args must be to count as the *same experiment reshuffled* (mutations of labels/permutations stay under it — distinct tasks don't) |
| `outcomeSigThreshold` | `0.7` | Minimum similarity between digit-stripped failure signatures to count as the *same failure* |
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
| `toggleShortcut` | `esc+a` | Key sequence that toggles antiloop from the footer (`esc+a` or `off`). Honored only while pi is idle (ESC is also pi's interrupt key — typing `a` right after cancelling a stuck run must not silently switch antiloop off). The input is never consumed, so typing is unaffected |

## Best Practices

1. **Start with defaults** — `warning=2 / force-break=3 / similarity=75% / tool-sim=95%` works well for most models.
2. **Adjust sensitivity to the model** — small/local models loop more, so lower `warningThreshold` and `similarityThreshold` to catch them early. Big cloud models rarely loop, so you can raise them to avoid false positives.
3. **Tool loops are strict on purpose** — a long bash command with env setup + flags scores 80–94% similar to the *next, different* command. Antiloop only flags tool calls that are near-identical (≥ 95%) *and* repeated ≥ `minToolRepeatCount` times, *and* — when results are captured — produced the same outcome. If you still see false positives on sequential operations, raise `toolSimilarityThreshold` (or `minToolRepeatCount`, or `resultSimilarityThreshold`) via `/antiloop config` — don't disable the detector.
4. **Per-strategy toggles** — if the model's reasoning legitimately repeats (e.g. it's working through a checklist), disable `thinking` detection and leave text/tool on.
5. **Watch the log** — `/antiloop log` shows what's actually triggering. If you see false positives, raise `similarityThreshold` instead of disabling the strategy entirely.
6. **Let user input clear state** — each user message decays the consecutive counter by 2, so a fresh prompt naturally resets without `/antiloop reset`.
7. **Degenerate detector needs no tuning for most setups** — a run of ≥ 16 identical words (or one word ≥ 40% of a ≥ 50-token payload) inside a single message is conclusive stuck generation; the 46 KB `noguerol ×5145` SSH-wordlist meltdown is caught on first sight (warning), its bash never executes (`blockDegenerateBash`), and a second consecutive meltdown gets the force-break steer. If a model legitimately writes repetitive payloads, raise `degenerateMaxRun` / `degenerateMaxFreq` via `/antiloop config` — don't disable the detector.
8. **Outcome detector catches mutated re-run loops** — a model that re-issues the same experiment with cosmetic changes (labels, permutations) while every attempt fails identically gets a warning after `outcomeMinRepeats` (8) same-failure attempts, a steer on the next, and a hard stop shortly after. Converging sweeps, evolving failures and repeated successes stay silent by design. Lower `outcomeMinRepeats` if you want earlier cutoffs.
9. **`/antiloop test`** — runs the real detection engine (text + tool-call + task-stream + degenerate + outcome regression cases) to verify calibration after any change.

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
- **Early bail** — short messages and empty tool calls skip similarity computation entirely; the degenerate scan is a single linear tokenization pass
- **TUI integration** — uses `ctx.ui.select` for the config menu and the log viewer; `ctx.ui.notify` for state notifications; `ctx.ui.setStatus` + a custom `ctx.ui.setFooter` component for the persistent footer indicator, live level info, and the `esc+a` keyboard toggle (`ctx.ui.onTerminalInput`, never consumes input)
- **Hooks** — `message_end` (track messages + tool call ids with a monotonic sequence so the sliding-window trim can never collide turn indices, and pre-handle degenerate meltdowns — the message is complete but its tools haven't executed yet), `tool_call` (block degenerate `bash` commands before they run), `turn_end` (attach result fingerprints with failure signatures, detect — including no-progress outcome runs — and intervene: steer the force break / abort the run), `input` (decay on real user messages only), `session_start` (load config + install footer + reset), `session_shutdown` (restore built-in footer)
- **Intervention runs on the turn loop, not on user prompts** — escalation is decided at `turn_end` (and at `message_end` for the self-contained degenerate signal), the break is steered into the running agent before its next LLM call, and the guaranteed hard stop aborts the run (`ctx.abort`, fire-and-forget — never awaited, so the hook can't deadlock). No custom-role messages are injected into the conversation at any level (steering a real user message + aborting are the only levers; custom-role injections were removed because a model can stall on an unexpected injected message)

## License

[MIT](LICENSE) © Javier Noguerol
