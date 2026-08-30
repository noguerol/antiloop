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
	similarityThreshold: 0.75,
	toolSimilarityThreshold: 0.95,
	minToolRepeatCount: 2,
	resultSimilarityThreshold: 0.8,
	detectToolLoops: true,
	detectThinkingLoops: true,
	detectTextLoops: true,
	notifyOnDetection: true,
	maxHistoryEntries: 100,
	detectionWindow: 10,
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
