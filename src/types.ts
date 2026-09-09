// antiloop — shared types. Zero runtime cost.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AntiloopConfig {
	enabled: boolean;
	warningThreshold: number;
	forceBreakThreshold: number;
	abortThreshold: number;
	similarityThreshold: number;
	/**
	 * How many ESSENTIALLY IDENTICAL repeats (≥98% similar text / identical tool
	 * loops) the model may produce AFTER the force-break message before antiloop
	 * hard-stops the run (ctx.abort). Guards the force break: if the model ignores
	 * the break instruction and keeps repeating verbatim, the run is cut instead of
	 * burning context forever. Only verbatim repeats count — a model that changes
	 * its output (even while still similar) gets room to escape on its own.
	 */
	ignoredSteerLimit: number;
	/**
	 * Intra-message degenerate repetition (the "noguerol \u00d75145" meltdown class): a model
	 * stuck emitting the same token hundreds of times INSIDE one message / tool call.
	 * Unlike the other detectors it needs no peer message: one pathological payload is
	 * already conclusive. Fires on the first occurrence; each degenerate turn is weighted
	 * (degenerateTurnWeight, default 2) so a single meltdown reaches the warning level.
	 */
	detectDegenerate: boolean;
	/** Minimum normalized tokens in a payload before it is scanned (shorter = not conclusive). */
	degenerateMinTokens: number;
	/** Longest run of ONE identical word that flags a payload as degenerate. */
	degenerateMaxRun: number;
	/** Total occurrences of one word (anywhere, interleaved) that flags when combined with share. */
	degenerateMaxFreq: number;
	/** Word frequency share (freq/total) needed together with degenerateMaxFreq. */
	degenerateMaxShare: number;
	/** How many consecutive-detection points ONE degenerate turn adds (2 = warn on first sight). */
	degenerateTurnWeight: number;
	/** Block a bash tool call whose command shows degenerate repetition BEFORE it executes. */
	blockDegenerateBash: boolean;
	/**
	 * No-progress outcome runs (v1.6.1): a model that keeps re-running the SAME
	 * experiment with cosmetic mutations (labels/permutations) while the outcome
	 * stays the SAME FAILURE — the real NFS session where ~90 near-identical
	 * ssh exportfs/mount tests (test A … test QQQ) all failed rc=32. The
	 * tool-loop detector can't see it: args mutate every turn so the same call
	 * never recurs (labels differ), and results only VETO tool loops today.
	 * Signal: >= outcomeMinRepeats PRIOR attempts inside the window whose args
	 * are >= outcomeArgSimilarity similar AND whose captured result is the same
	 * outcome (>= resultSimilarityThreshold), all after the last real user input.
	 */
	detectOutcomeLoops: boolean;
	outcomeMinRepeats: number;
	outcomeArgSimilarity: number;
	/** Same-FAILURE gate for the outcome detector: minimum similarity between the
	 * digit-stripped error signatures of two failing attempts to count as the
	 * SAME failure. Looser than the veto threshold on purpose: the signature
	 * repeats across attempts of the same wall even when legitimately varying
	 * words (mount targets) sit inside it. */
	outcomeSigThreshold: number;
	/**
	 * How close tool-call arguments must be (0..1) to count as the SAME call.
	 * High by default: long bash commands share scaffolding (env setup, flags,
	 * paths) even when they are different operations — a parameter sweep or a
	 * retry after a fix is NOT a loop. Only near-identical repeats qualify.
	 */
	toolSimilarityThreshold: number;
	/**
	 * How many PRIOR occurrences of a near-identical tool-call set must exist
	 * in the window before a tool loop is flagged. 2 = the same call seen 3x.
	 */
	minToolRepeatCount: number;
	/**
	 * Result-aware veto: when both runs have a captured result, the normalized
	 * result tails must be at least this similar for the pair to count as a
	 * loop. Same command + different outcome = progress, not a loop.
	 */
	resultSimilarityThreshold: number;
	/**
	 * Task-stream recognition (batch work). Extensions like punched (append
	 * lines to pi.md) or plan (add tasks) make the model call the SAME tool
	 * many times with DIFFERENT content — N distinct tasks of the same type,
	 * not a loop. When the same tool appears at least taskStreamMinCalls times
	 * in the window and no two calls are "twins" (args ≥ taskStreamTwinThreshold
	 * similar), antiloop treats that tool as an active task stream and does not
	 * flag repetitions of it, nor text/thinking/structural patterns that only
	 * involve those batch messages.
	 */
	detectTaskStreams: boolean;
	taskStreamMinCalls: number;
	taskStreamTwinThreshold: number;
	detectToolLoops: boolean;
	detectThinkingLoops: boolean;
	detectTextLoops: boolean;
	notifyOnDetection: boolean;
	maxHistoryEntries: number;
	detectionWindow: number;
	/**
	 * Show the antiloop indicator as a custom interactive footer in TUI mode
	 * (replaces the built-in footer). When false, the indicator is still shown
	 * as a status line in the built-in footer via ctx.ui.setStatus.
	 */
	interactiveFooter: boolean;
	/**
	 * Key sequence that toggles antiloop from the footer (raw terminal input).
	 * Format: "esc+a" (escape followed by `a`) or "off" to disable.
	 */
	toggleShortcut: string;
}

export type LoopKind = "text" | "tool" | "thinking" | "structural" | "degenerate" | "outcome";

export interface LoopDetection {
	type: LoopKind;
	similarity: number;
	messageIndices: number[];
	description: string;
	timestamp: number;
}

export interface TrackedToolCall {
	name: string;
	args: string;
	/** toolCallId — used to attach the execution result at turn_end. */
	id?: string;
	/**
	 * Normalized tail of the tool result ("err|" / "ok|" prefix + last chars).
	 * Only set when the turn completed and a result was captured. When both
	 * sides of a comparison have one, a mismatch vetoes the loop.
	 */
	result?: string;
}

export interface TrackedMessage {
	content: string;
	thinking?: string;
	toolCalls?: TrackedToolCall[];
	timestamp: number;
	/** Monotonic push sequence (state.turnSeq++), NOT the window index: the
	 * recent-messages array is trimmed to detectionWindow+5, so an array-length
	 * based index would collide after trimming and make the turn_end dedupe
	 * guard skip every later message (antiloop going blind mid-session). */
	turnIndex: number;
}

export interface TaskStreamInfo {
	tool: string;
	count: number;
}

export interface AntiloopState {
	recentMessages: TrackedMessage[];
	detections: LoopDetection[];
	/** Tools currently being used as a homogeneous batch (N tasks, same type).
	 * Recomputed at turn_end; shown in the footer/status so a quiet antiloop is
	 * explainable. */
	activeTaskStreams: TaskStreamInfo[];
	currentLevel: 0 | 1 | 2 | 3;
	consecutiveDetections: number;
	inForcedBreak: boolean;
	totalDetections: number;
	lastUserMessageTime: number;
	/** turnIndex of the last tracked message detection already ran on. */
	lastDetectedTurnIndex: number;
	/** Monotonic sequence for the next tracked message's turnIndex (see
	 * TrackedMessage.turnIndex). Persists across trims; reset on /reset and at
	 * session start. */
	turnSeq: number;
	/** True once the force-break user message was steered into the current episode.
	 * One steer per episode: repeated steering would spam the conversation. Cleared
	 * when the episode decays (currentLevel back to 0) or on real user input. */
	steerDelivered: boolean;
	/** Verbatim repeats counted AFTER the steer. When this reaches
	 * config.ignoredSteerLimit the run is hard-stopped (aborted). */
	ignoredSteerCount: number;
}

export interface Runtime {
	config: AntiloopConfig;
	state: AntiloopState;
	updateStatus(ctx: ExtensionContext): void;
	/** Re-install the interactive footer (after config changes). */
	refreshFooter?(ctx: ExtensionContext): void;
}
