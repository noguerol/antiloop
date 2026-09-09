// antiloop — config load/save. Lightweight: only file I/O at session_start.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AntiloopConfig } from "./types.ts";

export const CONFIG_FILE = "antiloop.json";

export const DEFAULT_CONFIG: AntiloopConfig = {
	enabled: true,
	warningThreshold: 2,
	forceBreakThreshold: 3,
	abortThreshold: 0,
	ignoredSteerLimit: 2,
	similarityThreshold: 0.75,
	toolSimilarityThreshold: 0.95,
	minToolRepeatCount: 2,
	resultSimilarityThreshold: 0.8,
	detectDegenerate: true,
	degenerateMinTokens: 50,
	degenerateMaxRun: 16,
	degenerateMaxFreq: 60,
	degenerateMaxShare: 0.4,
	degenerateTurnWeight: 2,
	blockDegenerateBash: true,
	detectOutcomeLoops: true,
	outcomeMinRepeats: 8,
	outcomeArgSimilarity: 0.85,
	outcomeSigThreshold: 0.7,
	detectTaskStreams: true,
	taskStreamMinCalls: 3,
	taskStreamTwinThreshold: 0.99,
	detectToolLoops: true,
	detectThinkingLoops: true,
	detectTextLoops: true,
	notifyOnDetection: true,
	maxHistoryEntries: 100,
	detectionWindow: 10,
	// Custom footer replaces the built-in one while active. Off by default:
	// pi restores its own footer right after boot anyway, so installing a
	// look-alike at session_start only produced a transient duplicated-footer
	// artifact. The 🔄 on/off status still shows via setStatus in the built-in footer.
	interactiveFooter: false,
	toggleShortcut: "esc+a",
};

export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

export function loadConfig(): AntiloopConfig {
	const p = getConfigPath();
	if (existsSync(p)) {
		try {
			return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) };
		} catch (e) {
			console.error(`[antiloop] config load error: ${e}`);
		}
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: AntiloopConfig): void {
	try {
		writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
	} catch (e) {
		console.error(`[antiloop] config save error: ${e}`);
	}
}
