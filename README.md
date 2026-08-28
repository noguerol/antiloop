# Antiloop — Loop Detection and Break for pi

**Antiloop watches every assistant message, tool call and thinking block, and forces the model out of reasoning loops before they eat your context and your patience.** Three simultaneous detection strategies (text similarity, tool-call sequences, thinking content) find loops that humans miss — and progressive intervention (warning → force break → abort) tells the model to take a different approach, without you having to babysit it.

---

## Features

- **Four detection strategies** — text repetition (trigram Jaccard + Levenshtein), tool-call sequences (name + argument matching), thinking blocks, and structural opening-phrase patterns
- **Progressive intervention** — `warning` reminds the model to vary its approach; `force break` injects explicit anti-loop instructions and modifies context; `abort` stops the run entirely
- **Configurable thresholds** — independent dials for similarity cutoff, warning/force-break/abort counts, detection window, and which strategies are on
- **Sliding window** — only the last N messages are compared, so detection is O(N) in the window size, not in the full session
- **Live status bar** — `🔄 antiloop`, `⚠️ antiloop(N)`, `🛑 antiloop(N)`, `🚨 antiloop(N)` reflect the current intervention level
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
  [tool] Same tool calls repeated: read, edit (5m ago)
```

### `/antiloop config`

Interactive menu with current values:

- **Enable/disable**
- **Warning threshold** — similar messages before warning (default 2)
- **Force break threshold** — similar messages before force break (default 3)
- **Abort threshold** — similar messages before abort (0 = disabled)
- **Similarity threshold** — `0.5 / 0.6 / 0.7 / 0.75 / 0.8 / 0.9` — how close two messages must be to count as looping
- **Detection window** — `5 / 10 / 15 / 20` — number of recent messages to analyze
- **Per-strategy toggles** — text / tool / thinking detection
- **Notifications** — show detection notifications
- **Reset state** — clear all counters and history

### `/antiloop log`

Shows the most recent 30 detections with similarity scores and timestamps, newest first.

### `/antiloop test`

Runs five built-in cases plus a tool-call equality check to verify the similarity engine is working correctly:

```
"Hello world" vs "Hello world"
  Similarity: 100.0% (expected: identical)
"Hello world" vs "Hello World!"
  Similarity: 95.0% (expected: very similar)
"I will read the file first" vs "I will read the file first to understand"
  Similarity: 85.0% (expected: similar)
...
```

## How It Works

### Detection pipeline

After every `message_end` event, antiloop extracts the new assistant content (text, thinking, tool calls) and pushes it onto a sliding window of the last `detectionWindow + 5` messages. Then it runs the active detection strategies against the current window:

| Strategy | What it compares | Algorithm |
|----------|------------------|-----------|
| Text | Full assistant message text | n-gram Jaccard (≥ 100 chars) or Levenshtein (shorter) |
| Tool | Tool name + arguments | Sequence match + ≥ 80% args similarity |
| Thinking | Internal reasoning/thinking blocks | Same as text |
| Structural | First 10 words of each message | Opening-phrase similarity ≥ 80% across ≥ 3 messages |

Each detected pair becomes a `LoopDetection { type, similarity, messageIndices, description }` and the consecutive counter increases.

### Intervention levels

| Level | Trigger | Behavior |
|-------|---------|----------|
| 0 (no loop) | — | Silent — passes the message through |
| 1 (warning) | `consecutiveDetections >= warningThreshold` | Injects a soft reminder asking the model to vary its approach |
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

For tool calls:  sequence + per-call argument similarity ≥ 80%
  [read({path:"/src/x.ts"}), edit({path:"/src/x.ts",...})]
  [read({path:"/src/x.ts"}), edit({path:"/src/x.ts",...})]
  → matched
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
  "detectToolLoops": true,
  "detectThinkingLoops": true,
  "detectTextLoops": true,
  "notifyOnDetection": true,
  "maxHistoryEntries": 100,
  "detectionWindow": 10
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch |
| `warningThreshold` | `2` | Consecutive detections before warning |
| `forceBreakThreshold` | `3` | Consecutive detections before force break |
| `abortThreshold` | `0` | Consecutive detections before abort (0 = disabled) |
| `similarityThreshold` | `0.75` | Minimum similarity (0.0–1.0) to count a pair as looping |
| `detectTextLoops` | `true` | Detect full-text repetition |
| `detectToolLoops` | `true` | Detect tool-call sequence + argument repetition |
| `detectThinkingLoops` | `true` | Detect repeated thinking/reasoning content |
| `notifyOnDetection` | `true` | Show a notification on every detection |
| `maxHistoryEntries` | `100` | Max detection history entries |
| `detectionWindow` | `10` | Number of recent messages to analyze |

## Best Practices

1. **Start with defaults** — `warning=2 / force-break=3 / similarity=75%` works well for most models.
2. **Adjust sensitivity to the model** — small/local models loop more, so lower `warningThreshold` and `similarityThreshold` to catch them early. Big cloud models rarely loop, so you can raise them to avoid false positives.
3. **Per-strategy toggles** — if the model's reasoning legitimately repeats (e.g. it's working through a checklist), disable `thinking` detection and leave text/tool on.
4. **Watch the log** — `/antiloop log` shows what's actually triggering. If you see false positives, raise `similarityThreshold` instead of disabling the strategy entirely.
5. **Let user input clear state** — each user message decays the consecutive counter by 2, so a fresh prompt naturally resets without `/antiloop reset`.
6. **`/antiloop test`** — if you ever change the similarity engine, run the self-test to verify it still produces expected scores.

## Architecture

```
antiloop/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
├── docs/
│   ├── banner.png      # wide README header
│   └── preview.png     # npm pi.dev preview card
├── screenshot.png      # full-res master
└── src/
    └── index.ts        # full extension (≈975 lines)
```

Single-file extension with zero external dependencies (only pi's bundled `@earendil-works/pi-coding-agent` + Node built-ins):

- **Levenshtein + trigram Jaccard** hybrid — small texts use edit distance, large texts use n-gram overlap (each is O(N) in text length)
- **Sliding window** — only the last `detectionWindow` messages participate, capping memory at O(W × message_size)
- **Early bail** — short messages and empty tool calls skip similarity computation entirely
- **TUI integration** — uses `ctx.ui.select` for the config menu and the log viewer; `ctx.ui.notify` for state notifications; `ctx.ui.setStatus` for the persistent status bar
- **Hooks** — `message_end` (track + detect), `input` (decay), `before_agent_start` (inject intervention), `context` (modify context in force-break mode), `turn_end` (refresh status), `session_start` (load config + reset)

## License

[MIT](LICENSE) © Javier Noguerol
