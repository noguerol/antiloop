// antiloop — shared types. Zero runtime cost.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AntiloopConfig {
	enabled: boolean;
	warningThreshold: number;
	forceBreakThreshold: number;
	abortThreshold: number;
	similarityThreshold: number;
	detectToolLoops: boolean;
	detectThinkingLoops: boolean;
	detectTextLoops: boolean;
	notifyOnDetection: boolean;
	maxHistoryEntries: number;
	detectionWindow: number;
}

export type LoopKind = "text" | "tool" | "thinking" | "structural";

export interface LoopDetection {
	type: LoopKind;
	similarity: number;
	messageIndices: number[];
	description: string;
	timestamp: number;
}

export interface TrackedMessage {
	content: string;
	thinking?: string;
	toolCalls?: Array<{ name: string; args: string }>;
	timestamp: number;
	turnIndex: number;
}

export interface AntiloopState {
	recentMessages: TrackedMessage[];
	detections: LoopDetection[];
	currentLevel: 0 | 1 | 2 | 3;
	consecutiveDetections: number;
	inForcedBreak: boolean;
	totalDetections: number;
	lastUserMessageTime: number;
}

export interface Runtime {
	config: AntiloopConfig;
	state: AntiloopState;
	pendingIntervention: string | null;
	updateStatus(ctx: ExtensionContext): void;
}
