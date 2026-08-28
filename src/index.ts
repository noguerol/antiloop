/**
 * antiloop Extension for pi
 *
 * Detects reasoning/processing loops in any model and forces a break with
 * explicit instructions to take a different approach.
 *
 * Detection strategies:
 *   1. Text repetition — similar assistant messages across turns
 *   2. Tool call loops — same tool called with same/similar arguments
 *   3. Thinking loops — similar thinking/reasoning content
 *   4. Structural patterns — similar opening phrases, sentence structures
 *
 * Intervention levels:
 *   1. Warning — inject a gentle reminder to vary approach
 *   2. Force break — inject explicit instruction to stop looping
 *   3. Abort — stop the agent entirely (configurable)
 *
 * Commands:
 *   /antiloop              - Toggle on/off
 *   /antiloop enable       - Enable antiloop
 *   /antiloop disable      - Disable antiloop
 *   /antiloop status       - Show current state and detection stats
 *   /antiloop config       - Open interactive config menu
 *   /antiloop log          - Show loop detection history
 *   /antiloop reset        - Reset all counters and history
 *   /antiloop test         - Run a self-test with sample patterns
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AntiloopConfig {
  enabled: boolean;
  /** Number of similar messages before triggering warning */
  warningThreshold: number;
  /** Number of similar messages before forcing a break */
  forceBreakThreshold: number;
  /** Number of similar messages before aborting (0 = disabled) */
  abortThreshold: number;
  /** Similarity score threshold (0.0-1.0) to consider messages as looping */
  similarityThreshold: number;
  /** Enable detection of tool call loops */
  detectToolLoops: boolean;
  /** Enable detection of thinking/reasoning loops */
  detectThinkingLoops: boolean;
  /** Enable detection of text pattern loops */
  detectTextLoops: boolean;
  /** Show notifications when loops are detected */
  notifyOnDetection: boolean;
  /** Maximum history entries to keep */
  maxHistoryEntries: number;
  /** Window size for pattern detection (number of recent messages to analyze) */
  detectionWindow: number;
}

interface LoopDetection {
  type: "text" | "tool" | "thinking" | "structural";
  similarity: number;
  messageIndices: number[];
  description: string;
  timestamp: number;
}

interface AntiloopState {
  /** Recent assistant message contents for comparison */
  recentMessages: Array<{
    content: string;
    thinking?: string;
    toolCalls?: Array<{ name: string; args: string }>;
    timestamp: number;
    turnIndex: number;
  }>;
  /** Detection history */
  detections: LoopDetection[];
  /** Current intervention level (0=none, 1=warning, 2=force, 3=abort) */
  currentLevel: number;
  /** Number of consecutive loop detections */
  consecutiveDetections: number;
  /** Whether we're currently in a forced break */
  inForcedBreak: boolean;
  /** Total detections this session */
  totalDetections: number;
  /** Last user message timestamp (resets loop tracking) */
  lastUserMessageTime: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONFIG_FILE = "antiloop.json";

const DEFAULT_CONFIG: AntiloopConfig = {
  enabled: true,
  warningThreshold: 2,
  forceBreakThreshold: 3,
  abortThreshold: 0, // disabled by default
  similarityThreshold: 0.75,
  detectToolLoops: true,
  detectThinkingLoops: true,
  detectTextLoops: true,
  notifyOnDetection: true,
  maxHistoryEntries: 100,
  detectionWindow: 10,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function loadConfig(): AntiloopConfig {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, "utf-8")) };
    } catch (err) {
      console.error(`[antiloop] Config load error: ${err}`);
    }
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: AntiloopConfig): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[antiloop] Config save error: ${err}`);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Select helper: presents labeled strings to ctx.ui.select(), returns the
 * matched value from the items array. Returns undefined if cancelled.
 */
function selectFrom<T>(
  ctx: ExtensionContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>
): Promise<T | undefined> {
  const strings = items.map((it) =>
    it.description ? `${it.label} — ${it.description}` : it.label
  );
  return ctx.ui.select(title, strings).then((picked) => {
    if (picked === undefined) return undefined;
    const idx = strings.indexOf(picked);
    return idx >= 0 ? items[idx].value : undefined;
  });
}

// ─── Similarity Detection Engine ────────────────────────────────────────────

/**
 * Normalize text for comparison: lowercase, collapse whitespace, remove punctuation
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score between two strings (0.0 to 1.0)
 * Uses a combination of:
 * - Levenshtein distance (for short texts)
 * - N-gram Jaccard similarity (for longer texts)
 * - Opening phrase matching (for structural detection)
 */
/** Minimum content length to be considered for comparison */
const MIN_CONTENT_LENGTH = 50;

function calculateSimilarity(a: string, b: string): number {
  // Reject empty or very short strings
  if (a.length < MIN_CONTENT_LENGTH || b.length < MIN_CONTENT_LENGTH) return 0.0;
  if (a === b) return 1.0;

  const normA = normalizeText(a);
  const normB = normalizeText(b);

  // After normalization, check again
  if (normA.length < 20 || normB.length < 20) return 0.0;
  if (normA === normB) return 1.0;

  // For very short texts, use Levenshtein
  if (normA.length < 100 && normB.length < 100) {
    const maxLen = Math.max(normA.length, normB.length);
    const distance = levenshteinDistance(normA, normB);
    return 1.0 - (distance / maxLen);
  }

  // For longer texts, use n-gram Jaccard similarity
  const ngramsA = getNgrams(normA, 3);
  const ngramsB = getNgrams(normB, 3);

  const intersection = new Set([...ngramsA].filter(x => ngramsB.has(x)));
  const union = new Set([...ngramsA, ...ngramsB]);

  return intersection.size / union.size;
}

/**
 * Extract character n-grams from text
 */
function getNgrams(text: string, n: number): Set<string> {
  const ngrams = new Set<string>();
  for (let i = 0; i <= text.length - n; i++) {
    ngrams.add(text.substring(i, i + n));
  }
  return ngrams;
}

/**
 * Extract opening phrase (first N words) for structural comparison
 */
function getOpeningPhrase(text: string, wordCount: number = 10): string {
  const words = text.split(/\s+/).slice(0, wordCount).join(" ");
  return normalizeText(words);
}

/**
 * Detect if two tool call sequences are similar
 */
function areToolCallsSimilar(
  calls1: Array<{ name: string; args: string }>,
  calls2: Array<{ name: string; args: string }>
): boolean {
  if (calls1.length !== calls2.length) return false;
  if (calls1.length === 0) return true;

  // Check if tools are called in the same order with similar args
  for (let i = 0; i < calls1.length; i++) {
    if (calls1[i].name !== calls2[i].name) return false;
    const argSimilarity = calculateSimilarity(calls1[i].args, calls2[i].args);
    if (argSimilarity < 0.8) return false;
  }

  return true;
}

/**
 * Main loop detection function
 * Analyzes recent messages and returns detected loops
 */
function detectLoops(
  state: AntiloopState,
  config: AntiloopConfig
): LoopDetection[] {
  const detections: LoopDetection[] = [];
  const messages = state.recentMessages;

  if (messages.length < 2) return detections;

  // Only analyze within the detection window
  const windowStart = Math.max(0, messages.length - config.detectionWindow);
  const window = messages.slice(windowStart);

  // Strategy 1: Text repetition detection
  if (config.detectTextLoops) {
    const lastMsg = window[window.length - 1];
    
    // Skip if current message is too short
    if (lastMsg.content.length >= MIN_CONTENT_LENGTH) {
      for (let i = 0; i < window.length - 1; i++) {
        // Skip comparison with messages that are too short
        if (window[i].content.length < MIN_CONTENT_LENGTH) continue;
        
        const similarity = calculateSimilarity(lastMsg.content, window[i].content);

        if (similarity >= config.similarityThreshold) {
          detections.push({
            type: "text",
            similarity,
            messageIndices: [windowStart + i, messages.length - 1],
            description: `Text similarity ${(similarity * 100).toFixed(0)}% with message ${windowStart + i + 1}`,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Structural pattern detection (opening phrases)
    if (window.length >= 3) {
      // Only check messages with sufficient content
      const validOpenings = window
        .map((m, idx) => ({ opening: getOpeningPhrase(m.content), idx }))
        .filter(o => o.opening.length >= 20);
      
      if (validOpenings.length >= 3) {
        const lastOpening = validOpenings[validOpenings.length - 1].opening;
        let matchCount = 0;
        for (let i = 0; i < validOpenings.length - 1; i++) {
          if (calculateSimilarity(lastOpening, validOpenings[i].opening) > 0.8) {
            matchCount++;
          }
        }
        if (matchCount >= 2) {
          detections.push({
            type: "structural",
            similarity: 0.9,
            messageIndices: [messages.length - 1],
            description: `Repeated opening pattern detected (${matchCount + 1} similar starts)`,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // Strategy 2: Tool call loop detection
  if (config.detectToolLoops) {
    const lastMsg = window[window.length - 1];
    if (lastMsg.toolCalls && lastMsg.toolCalls.length > 0) {
      for (let i = 0; i < window.length - 1; i++) {
        if (window[i].toolCalls && areToolCallsSimilar(lastMsg.toolCalls, window[i].toolCalls)) {
          detections.push({
            type: "tool",
            similarity: 1.0,
            messageIndices: [windowStart + i, messages.length - 1],
            description: `Same tool calls repeated: ${lastMsg.toolCalls.map(t => t.name).join(", ")}`,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // Strategy 3: Thinking loop detection
  if (config.detectThinkingLoops) {
    const lastMsg = window[window.length - 1];
    if (lastMsg.thinking && lastMsg.thinking.length > 50) {
      for (let i = 0; i < window.length - 1; i++) {
        if (window[i].thinking && window[i].thinking.length > 50) {
          const similarity = calculateSimilarity(lastMsg.thinking, window[i].thinking);
          if (similarity >= config.similarityThreshold) {
            detections.push({
              type: "thinking",
              similarity,
              messageIndices: [windowStart + i, messages.length - 1],
              description: `Thinking content similarity ${(similarity * 100).toFixed(0)}%`,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  }

  return detections;
}

/**
 * Generate intervention message based on detection level
 */
function getInterventionMessage(
  level: number,
  detections: LoopDetection[],
  config: AntiloopConfig
): string {
  const detectionSummary = detections
    .map(d => `- ${d.description}`)
    .join("\n");

  switch (level) {
    case 1: // Warning
      return [
        "[antiloop] ⚠️ LOOP WARNING: I notice I may be repeating myself.",
        "Detected patterns:",
        detectionSummary,
        "",
        "Please vary my approach and try a different strategy.",
        "Consider: alternative algorithms, different file locations, new angles of analysis.",
      ].join("\n");

    case 2: // Force break
      return [
        "[antiloop] 🛑 LOOP DETECTED: I am stuck in a reasoning loop.",
        "Detected patterns:",
        detectionSummary,
        "",
        "MANDATORY: I must immediately stop my current approach and try something completely different.",
        "Required actions:",
        "1. Stop the current line of reasoning entirely",
        "2. Consider what assumptions I've been making",
        "3. Try an alternative approach or ask the user for guidance",
        "4. Do NOT repeat any previous tool calls or reasoning patterns",
      ].join("\n");

    case 3: // Abort
      return [
        "[antiloop] 🚨 LOOP ABORT: Persistent loop detected despite interventions.",
        "Detected patterns:",
        detectionSummary,
        "",
        "The agent is unable to break out of this loop automatically.",
        "User intervention required. Please provide new instructions or context.",
      ].join("\n");

    default:
      return "";
  }
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function antiloopExtension(pi: ExtensionAPI) {
  let config: AntiloopConfig = loadConfig();

  const state: AntiloopState = {
    recentMessages: [],
    detections: [],
    currentLevel: 0,
    consecutiveDetections: 0,
    inForcedBreak: false,
    totalDetections: 0,
    lastUserMessageTime: 0,
  };

  let pendingIntervention: string | null = null;

  // ─── Core: process detections and determine intervention ────────────────

  function processDetections(detections: LoopDetection[]): void {
    if (detections.length === 0) {
      // No loops detected, reset consecutive count
      if (state.consecutiveDetections > 0) {
        state.consecutiveDetections = Math.max(0, state.consecutiveDetections - 1);
      }
      if (state.currentLevel > 0 && state.consecutiveDetections === 0) {
        state.currentLevel = 0;
        state.inForcedBreak = false;
      }
      return;
    }

    state.consecutiveDetections++;
    state.totalDetections++;

    // Add to history
    state.detections.push(...detections);
    if (state.detections.length > config.maxHistoryEntries) {
      state.detections = state.detections.slice(-config.maxHistoryEntries);
    }

    // Determine intervention level
    let newLevel = 0;
    if (state.consecutiveDetections >= config.abortThreshold && config.abortThreshold > 0) {
      newLevel = 3;
    } else if (state.consecutiveDetections >= config.forceBreakThreshold) {
      newLevel = 2;
    } else if (state.consecutiveDetections >= config.warningThreshold) {
      newLevel = 1;
    }

    // Only escalate, never de-escalate automatically
    if (newLevel > state.currentLevel) {
      state.currentLevel = newLevel;
    }

    // Generate intervention message if needed
    if (state.currentLevel > 0) {
      pendingIntervention = getInterventionMessage(state.currentLevel, detections, config);
      state.inForcedBreak = state.currentLevel >= 2;
    }
  }

  // ─── Hook 1: Track assistant messages ───────────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (!config.enabled) return;

    const msg = event.message;
    if (msg.role !== "assistant") return;

    // Extract message content
    let content = "";
    let thinking = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          content += part.text;
        } else if (part.type === "thinking") {
          thinking += part.thinking;
        }
      }
    }

    // Extract tool calls
    const toolCalls: Array<{ name: string; args: string }> = [];
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          toolCalls.push({
            name: part.name,
            args: JSON.stringify(part.arguments ?? {}),
          });
        }
      }
    }

    // Add to recent messages (skip empty or very short messages)
    if (content.length >= MIN_CONTENT_LENGTH || toolCalls.length > 0) {
      state.recentMessages.push({
        content,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: Date.now(),
        turnIndex: state.recentMessages.length,
      });
    }

    // Trim to window size + buffer
    if (state.recentMessages.length > config.detectionWindow + 5) {
      state.recentMessages = state.recentMessages.slice(-(config.detectionWindow + 5));
    }

    // Run detection
    const detections = detectLoops(state, config);
    processDetections(detections);

    // Notify if configured
    if (config.notifyOnDetection && detections.length > 0 && state.currentLevel > 0) {
      const levelNames = ["", "warning", "force break", "abort"];
      ctx.ui.notify(
        `🔄 antiloop: ${levelNames[state.currentLevel]} — ${detections[0].description}`,
        state.currentLevel >= 2 ? "error" : "warning"
      );
    }
  });

  // ─── Hook 2: Track user messages (resets loop state) ────────────────────

  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return;

    // User input resets the loop detection
    state.lastUserMessageTime = Date.now();

    // Don't reset completely, but reduce consecutive count
    if (state.consecutiveDetections > 0) {
      state.consecutiveDetections = Math.max(0, state.consecutiveDetections - 2);
    }
    if (state.consecutiveDetections < config.warningThreshold) {
      state.currentLevel = 0;
      state.inForcedBreak = false;
    }

    return { action: "continue" };
  });

  // ─── Hook 3: Inject intervention before agent starts ────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.enabled) return;
    if (!pendingIntervention) return;

    const msg = pendingIntervention;
    pendingIntervention = null;

    return {
      message: {
        customType: "antiloop-intervention",
        content: msg,
        display: true,
      },
    };
  });

  // ─── Hook 4: Context modification for persistent anti-loop instructions ──

  pi.on("context", async (event, ctx) => {
    if (!config.enabled) return;
    if (state.currentLevel < 2) return;

    // When in force-break mode, add anti-loop instructions to context
    const messages = [...event.messages];

    // Find the last assistant message and append instructions
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const msg = messages[i] as any;
        if (typeof msg.content === "string") {
          msg.content += "\n\n[antiloop] I must break out of this loop. Trying a completely different approach.";
        } else if (Array.isArray(msg.content)) {
          msg.content.push({
            type: "text",
            text: "\n\n[antiloop] I must break out of this loop. Trying a completely different approach.",
          });
        }
        break;
      }
    }

    return { messages };
  });

  // ─── Hook 5: Track turns for timing ────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!config.enabled) return;

    // Update status bar
    updateStatus(ctx);
  });

  // ─── Status bar ─────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    if (!config.enabled) {
      ctx.ui.setStatus("antiloop", undefined);
      return;
    }

    if (state.currentLevel === 0) {
      ctx.ui.setStatus("antiloop", "🔄 antiloop");
    } else {
      const levelIcons = ["", "⚠️", "🛑", "🚨"];
      ctx.ui.setStatus(
        "antiloop",
        `${levelIcons[state.currentLevel]} antiloop(${state.consecutiveDetections})`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── /antiloop [subcommand] ──────────────────────────────────────────────

  pi.registerCommand("antiloop", {
    description: "Antiloop: detect and break reasoning loops",
    getArgumentCompletions: (prefix) => {
      const subs = ["enable", "disable", "status", "config", "log", "reset", "test"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase() ?? "";
      switch (sub) {
        case "enable":
          config.enabled = true;
          saveConfig(config);
          ctx.ui.notify("🔄 antiloop: ENABLED", "info");
          updateStatus(ctx);
          break;
        case "disable":
          config.enabled = false;
          saveConfig(config);
          ctx.ui.notify("🔄 antiloop: DISABLED", "info");
          updateStatus(ctx);
          break;
        case "status":
          await showStatus(ctx);
          break;
        case "config":
          await showConfigMenu(pi, ctx);
          break;
        case "log":
          await showDetectionLog(ctx);
          break;
        case "reset":
          resetState();
          ctx.ui.notify("🔄 antiloop: All counters and history reset", "info");
          updateStatus(ctx);
          break;
        case "test":
          await runSelfTest(ctx);
          break;
        default:
          config.enabled = !config.enabled;
          saveConfig(config);
          ctx.ui.notify(`🔄 antiloop: ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
          updateStatus(ctx);
          break;
      }
    },
  });

  // ─── /antiloop status ────────────────────────────────────────────────────

  async function showStatus(ctx: ExtensionContext) {
    const levelNames = ["none", "warning", "force break", "abort"];
    const recentDetections = state.detections.slice(-5);

    const lines = [
      `State: ${config.enabled ? "✅ ENABLED" : "❌ DISABLED"}`,
      `Current level: ${levelNames[state.currentLevel]}`,
      `Consecutive detections: ${state.consecutiveDetections}`,
      `Total detections: ${state.totalDetections}`,
      `Messages tracked: ${state.recentMessages.length}`,
      `In forced break: ${state.inForcedBreak ? "yes" : "no"}`,
      "",
      "Configuration:",
      `  Warning threshold: ${config.warningThreshold} similar messages`,
      `  Force break threshold: ${config.forceBreakThreshold} similar messages`,
      `  Abort threshold: ${config.abortThreshold > 0 ? config.abortThreshold : "disabled"}`,
      `  Similarity threshold: ${(config.similarityThreshold * 100).toFixed(0)}%`,
      `  Detection window: ${config.detectionWindow} messages`,
      "",
      "Detection strategies:",
      `  Text loops: ${config.detectTextLoops ? "✅" : "❌"}`,
      `  Tool loops: ${config.detectToolLoops ? "✅" : "❌"}`,
      `  Thinking loops: ${config.detectThinkingLoops ? "✅" : "❌"}`,
    ];

    if (recentDetections.length > 0) {
      lines.push("", "Recent detections:");
      for (const d of recentDetections) {
        lines.push(`  [${d.type}] ${d.description} (${formatDuration(Date.now() - d.timestamp)} ago)`);
      }
    }

    ctx.ui.notify(lines.join("\n"), "info");
  }

  // ─── /antiloop config ────────────────────────────────────────────────────

  async function showConfigMenu(pi: ExtensionAPI, ctx: ExtensionContext) {
    const enabledLabel = config.enabled ? "🟢 Disable antiloop" : "🔴 Enable antiloop";

    const action = await selectFrom(ctx, "🔄 Antiloop Config", [
      { value: "toggle", label: enabledLabel, description: `Currently: ${config.enabled ? "enabled" : "disabled"}` },
      { value: "warning", label: `⚠️  Warning threshold: ${config.warningThreshold}`, description: "Similar messages before warning" },
      { value: "force", label: `🛑 Force break threshold: ${config.forceBreakThreshold}`, description: "Similar messages before force break" },
      { value: "abort", label: `🚨 Abort threshold: ${config.abortThreshold > 0 ? config.abortThreshold : "disabled"}`, description: "Similar messages before abort (0=disabled)" },
      { value: "similarity", label: `📊 Similarity: ${(config.similarityThreshold * 100).toFixed(0)}%`, description: "How similar messages must be to count as looping" },
      { value: "window", label: `🪟 Detection window: ${config.detectionWindow}`, description: "Number of recent messages to analyze" },
      { value: "text", label: `📝 Text detection: ${config.detectTextLoops ? "on" : "off"}`, description: "Detect text repetition loops" },
      { value: "tool", label: `🔧 Tool detection: ${config.detectToolLoops ? "on" : "off"}`, description: "Detect tool call loops" },
      { value: "thinking", label: `🧠 Thinking detection: ${config.detectThinkingLoops ? "on" : "off"}`, description: "Detect thinking/reasoning loops" },
      { value: "notify", label: `🔔 Notifications: ${config.notifyOnDetection ? "on" : "off"}`, description: "Show notifications on detection" },
      { value: "reset", label: "🔃 Reset state", description: "Clear all counters and history" },
    ]);

    if (!action) return;

    switch (action) {
      case "toggle":
        config.enabled = !config.enabled;
        saveConfig(config);
        ctx.ui.notify(`antiloop: ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
        updateStatus(ctx);
        break;

      case "warning": {
        const picked = await selectFrom(ctx, "Warning threshold", [
          { value: 1, label: "1 (very sensitive)" },
          { value: 2, label: "2 (default)" },
          { value: 3, label: "3" },
          { value: 5, label: "5 (less sensitive)" },
        ]);
        if (picked !== undefined) {
          config.warningThreshold = picked;
          saveConfig(config);
          ctx.ui.notify(`Warning threshold set to ${picked}`, "info");
        }
        break;
      }

      case "force": {
        const picked = await selectFrom(ctx, "Force break threshold", [
          { value: 2, label: "2 (very sensitive)" },
          { value: 3, label: "3 (default)" },
          { value: 5, label: "5" },
          { value: 8, label: "8 (less sensitive)" },
        ]);
        if (picked !== undefined) {
          config.forceBreakThreshold = picked;
          saveConfig(config);
          ctx.ui.notify(`Force break threshold set to ${picked}`, "info");
        }
        break;
      }

      case "abort": {
        const picked = await selectFrom(ctx, "Abort threshold (0=disabled)", [
          { value: 0, label: "0 (disabled)" },
          { value: 5, label: "5" },
          { value: 8, label: "8" },
          { value: 10, label: "10" },
          { value: 15, label: "15" },
        ]);
        if (picked !== undefined) {
          config.abortThreshold = picked;
          saveConfig(config);
          ctx.ui.notify(`Abort threshold set to ${picked > 0 ? picked : "disabled"}`, "info");
        }
        break;
      }

      case "similarity": {
        const picked = await selectFrom(ctx, "Similarity threshold", [
          { value: 0.5, label: "50% (very sensitive)" },
          { value: 0.6, label: "60%" },
          { value: 0.7, label: "70%" },
          { value: 0.75, label: "75% (default)" },
          { value: 0.8, label: "80%" },
          { value: 0.9, label: "90% (less sensitive)" },
        ]);
        if (picked !== undefined) {
          config.similarityThreshold = picked;
          saveConfig(config);
          ctx.ui.notify(`Similarity threshold set to ${(picked * 100).toFixed(0)}%`, "info");
        }
        break;
      }

      case "window": {
        const picked = await selectFrom(ctx, "Detection window", [
          { value: 5, label: "5 messages" },
          { value: 10, label: "10 messages (default)" },
          { value: 15, label: "15 messages" },
          { value: 20, label: "20 messages" },
        ]);
        if (picked !== undefined) {
          config.detectionWindow = picked;
          saveConfig(config);
          ctx.ui.notify(`Detection window set to ${picked} messages`, "info");
        }
        break;
      }

      case "text":
        config.detectTextLoops = !config.detectTextLoops;
        saveConfig(config);
        ctx.ui.notify(`Text detection: ${config.detectTextLoops ? "ON" : "OFF"}`, "info");
        break;

      case "tool":
        config.detectToolLoops = !config.detectToolLoops;
        saveConfig(config);
        ctx.ui.notify(`Tool detection: ${config.detectToolLoops ? "ON" : "OFF"}`, "info");
        break;

      case "thinking":
        config.detectThinkingLoops = !config.detectThinkingLoops;
        saveConfig(config);
        ctx.ui.notify(`Thinking detection: ${config.detectThinkingLoops ? "ON" : "OFF"}`, "info");
        break;

      case "notify":
        config.notifyOnDetection = !config.notifyOnDetection;
        saveConfig(config);
        ctx.ui.notify(`Notifications: ${config.notifyOnDetection ? "ON" : "OFF"}`, "info");
        break;

      case "reset":
        resetState();
        ctx.ui.notify("State reset", "info");
        updateStatus(ctx);
        break;
    }
  }

  // ─── /antiloop log ───────────────────────────────────────────────────────

  async function showDetectionLog(ctx: ExtensionContext) {
    if (state.detections.length === 0) {
      ctx.ui.notify("No loop detections recorded this session", "info");
      return;
    }

    const items = state.detections.slice(-30).reverse().map((d) => ({
      value: "",
      label: `[${d.type}] ${d.description}`,
      description: `${(d.similarity * 100).toFixed(0)}% similar · ${formatDuration(Date.now() - d.timestamp)} ago`,
    }));

    await selectFrom(ctx, `🔄 Detection log (${state.detections.length} total)`, items);
  }

  // ─── /antiloop reset ─────────────────────────────────────────────────────

  function resetState(): void {
    state.recentMessages = [];
    state.detections = [];
    state.currentLevel = 0;
    state.consecutiveDetections = 0;
    state.inForcedBreak = false;
    state.totalDetections = 0;
    pendingIntervention = null;
  }

  // ─── /antiloop test ──────────────────────────────────────────────────────

  async function runSelfTest(ctx: ExtensionContext) {
    ctx.ui.notify("🧪 Running antiloop self-test...", "info");

    const testCases: Array<{ a: string; b: string; expected: string }> = [
      { a: "Hello world", b: "Hello world", expected: "identical" },
      { a: "Hello world", b: "Hello World!", expected: "very similar" },
      { a: "The quick brown fox", b: "The quick brown fox jumps over the lazy dog", expected: "similar" },
      { a: "Hello world", b: "Goodbye universe", expected: "different" },
      { a: "I will read the file first", b: "I will read the file first to understand", expected: "similar" },
    ];

    const results: string[] = [];
    for (const tc of testCases) {
      const similarity = calculateSimilarity(tc.a, tc.b);
      const normalized = normalizeText(tc.a);
      const normalizedB = normalizeText(tc.b);
      results.push(
        `"${tc.a}" vs "${tc.b}"\n  Similarity: ${(similarity * 100).toFixed(1)}% (expected: ${tc.expected})`
      );
    }

    // Test tool call detection
    const toolCalls1 = [{ name: "read", args: '{"path":"/test"}' }];
    const toolCalls2 = [{ name: "read", args: '{"path":"/test"}' }];
    const toolCalls3 = [{ name: "write", args: '{"path":"/other"}' }];

    results.push(
      `\nTool call tests:`,
      `  Same calls: ${areToolCallsSimilar(toolCalls1, toolCalls2)} (expected: true)`,
      `  Different calls: ${areToolCallsSimilar(toolCalls1, toolCalls3)} (expected: false)`,
    );

    ctx.ui.notify(`🧪 Self-test results:\n${results.join("\n")}`, "info");
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    resetState();
    updateStatus(ctx);
  });
}
