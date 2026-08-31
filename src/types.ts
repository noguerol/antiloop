// antiloop — shared types. Zero runtime cost.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AntiloopConfig {
	enabled: boolean;
	warningThreshold: number;
	forceBreakThreshold: number;
	abortThreshold: number;
	similarityThreshold: number;
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

export type LoopKind = "text" | "tool" | "thinking" | "structural";

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
}

export interface Runtime {
	config: AntiloopConfig;
	state: AntiloopState;
	pendingIntervention: string | null;
	updateStatus(ctx: ExtensionContext): void;
	/** Re-install the interactive footer (after config changes). */
	refreshFooter?(ctx: ExtensionContext): void;
}
