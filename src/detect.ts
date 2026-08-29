// antiloop — similarity + detection engine. Lazy-loaded on first message_end.

import type { AntiloopConfig, AntiloopState, LoopDetection } from "./types.ts";

const MIN_CONTENT_LENGTH = 50;

function normalizeText(t: string): string {
	return t.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

function levenshtein(a: string, b: string): number {
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const m: number[][] = [];
	for (let i = 0; i <= b.length; i++) m[i] = [i];
	for (let j = 0; j <= a.length; j++) m[0][j] = j;
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
				? m[i - 1][j - 1]
				: Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
		}
	}
	return m[b.length][a.length];
}

function ngrams(text: string, n: number): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i <= text.length - n; i++) out.add(text.substring(i, i + n));
	return out;
}

function opening(text: string, n = 10): string {
	return normalizeText(text.split(/\s+/).slice(0, n).join(" "));
}

function similarity(a: string, b: string): number {
	if (a.length < MIN_CONTENT_LENGTH || b.length < MIN_CONTENT_LENGTH) return 0;
	if (a === b) return 1;
	const na = normalizeText(a);
	const nb = normalizeText(b);
	if (na.length < 20 || nb.length < 20) return 0;
	if (na === nb) return 1;
	if (na.length < 100 && nb.length < 100) {
		const max = Math.max(na.length, nb.length);
		return 1 - levenshtein(na, nb) / max;
	}
	const ga = ngrams(na, 3);
	const gb = ngrams(nb, 3);
	let inter = 0;
	for (const x of ga) if (gb.has(x)) inter++;
	const uni = ga.size + gb.size - inter;
	return inter / uni;
}

function toolCallsSimilar(
	c1: Array<{ name: string; args: string }>,
	c2: Array<{ name: string; args: string }>,
): boolean {
	if (c1.length !== c2.length) return false;
	if (!c1.length) return true;
	for (let i = 0; i < c1.length; i++) {
		if (c1[i].name !== c2[i].name) return false;
		if (similarity(c1[i].args, c2[i].args) < 0.8) return false;
	}
	return true;
}

export function detectLoops(state: AntiloopState, config: AntiloopConfig): LoopDetection[] {
	const out: LoopDetection[] = [];
	const msgs = state.recentMessages;
	if (msgs.length < 2) return out;
	const start = Math.max(0, msgs.length - config.detectionWindow);
	const win = msgs.slice(start);
	const now = Date.now();

	if (config.detectTextLoops) {
		const last = win[win.length - 1];
		if (last.content.length >= MIN_CONTENT_LENGTH) {
			for (let i = 0; i < win.length - 1; i++) {
				if (win[i].content.length < MIN_CONTENT_LENGTH) continue;
				const s = similarity(last.content, win[i].content);
				if (s >= config.similarityThreshold) {
					out.push({
						type: "text",
						similarity: s,
						messageIndices: [start + i, msgs.length - 1],
						description: `text similarity ${(s * 100).toFixed(0)}% with msg ${start + i + 1}`,
						timestamp: now,
					});
				}
			}
		}
		if (win.length >= 3) {
			const opens = win.map((m, idx) => ({ o: opening(m.content), idx }))
				.filter((x) => x.o.length >= 20);
			if (opens.length >= 3) {
				const last = opens[opens.length - 1].o;
				let n = 0;
				for (let i = 0; i < opens.length - 1; i++) {
					if (similarity(last, opens[i].o) > 0.8) n++;
				}
				if (n >= 2) {
					out.push({
						type: "structural",
						similarity: 0.9,
						messageIndices: [msgs.length - 1],
						description: `repeated opening (${n + 1} similar starts)`,
						timestamp: now,
					});
				}
			}
		}
	}

	if (config.detectToolLoops) {
		const last = win[win.length - 1];
		const lastCalls = last.toolCalls;
		if (lastCalls && lastCalls.length) {
			for (let i = 0; i < win.length - 1; i++) {
				const prev = win[i].toolCalls;
				if (prev && toolCallsSimilar(lastCalls, prev)) {
					out.push({
						type: "tool",
						similarity: 1,
						messageIndices: [start + i, msgs.length - 1],
						description: `repeated: ${lastCalls.map((t) => t.name).join(", ")}`,
						timestamp: now,
					});
				}
			}
		}
	}

	if (config.detectThinkingLoops) {
		const last = win[win.length - 1];
		if (last.thinking && last.thinking.length > 50) {
			for (let i = 0; i < win.length - 1; i++) {
				if (win[i].thinking && win[i].thinking!.length > 50) {
					const s = similarity(last.thinking, win[i].thinking!);
					if (s >= config.similarityThreshold) {
						out.push({
							type: "thinking",
							similarity: s,
							messageIndices: [start + i, msgs.length - 1],
							description: `thinking similarity ${(s * 100).toFixed(0)}%`,
							timestamp: now,
						});
					}
				}
			}
		}
	}

	return out;
}

export function interventionMessage(level: 1 | 2 | 3, detections: LoopDetection[]): string {
	const det = detections.map((d) => `- ${d.description}`).join("\n");
	if (level === 1) {
		return `[antiloop] ⚠️ loop warning\n${det}\nvary approach — try a different strategy.`;
	}
	if (level === 2) {
		return `[antiloop] 🛑 stuck in loop\n${det}\nstop, change approach, do NOT repeat previous tool calls or reasoning.`;
	}
	return `[antiloop] 🚨 persistent loop\n${det}\nunable to break automatically — provide new instructions.`;
}
