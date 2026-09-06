// antiloop — command handlers. Lazy-loaded on /antiloop.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "./config.ts";
import type { AntiloopState, Runtime } from "./types.ts";
import { formatDuration, selectFrom } from "./ui.ts";

export async function handleCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	rt: Runtime,
): Promise<void> {
	const sub = (args ?? "").trim().toLowerCase();
	switch (sub) {
		case "enable":
			rt.config.enabled = true;
			saveConfig(rt.config);
			ctx.ui.notify("antiloop: ON", "info");
			rt.updateStatus(ctx);
			return;
		case "disable":
			rt.config.enabled = false;
			saveConfig(rt.config);
			ctx.ui.notify("antiloop: OFF", "info");
			rt.updateStatus(ctx);
			return;
		case "status":
			return showStatus(ctx, rt);
		case "config":
			return showConfigMenu(ctx, rt);
		case "log":
			return showLog(ctx, rt);
		case "reset":
			resetState(rt.state);
			rt.pendingIntervention = null;
			ctx.ui.notify("antiloop: reset", "info");
			rt.updateStatus(ctx);
			return;
		case "test":
			return runSelfTest(ctx);
		default:
			rt.config.enabled = !rt.config.enabled;
			saveConfig(rt.config);
			ctx.ui.notify(`antiloop: ${rt.config.enabled ? "ON" : "OFF"}`, "info");
			rt.updateStatus(ctx);
			return;
	}
}

async function showStatus(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	const lvl = ["none", "warn", "force", "abort"][rt.state.currentLevel];
	const recent = rt.state.detections.slice(-5);
	const lines = [
		`state: ${rt.config.enabled ? "ON" : "OFF"} · level: ${lvl} · consecutive: ${rt.state.consecutiveDetections}`,
		`total: ${rt.state.totalDetections} · tracked: ${rt.state.recentMessages.length} · forced: ${rt.state.inForcedBreak ? "yes" : "no"}`,
		"",
		"thresholds:",
		`  warn: ${rt.config.warningThreshold}  force: ${rt.config.forceBreakThreshold}  abort: ${rt.config.abortThreshold || "off"}`,
		`  similarity: ${(rt.config.similarityThreshold * 100).toFixed(0)}%  window: ${rt.config.detectionWindow}`,
		`  tool sim: ${(rt.config.toolSimilarityThreshold * 100).toFixed(0)}%  tool repeat: ${rt.config.minToolRepeatCount}+ prior`,
		`  result sim: ${(rt.config.resultSimilarityThreshold * 100).toFixed(0)}%  (same cmd + diff outcome = no loop)`,
		`  task streams: ${yn(rt.config.detectTaskStreams)} (min ${rt.config.taskStreamMinCalls} calls, twins ≥ ${(rt.config.taskStreamTwinThreshold * 100).toFixed(0)}%)`,
		"",
		`detectors: text ${yn(rt.config.detectTextLoops)} · tool ${yn(rt.config.detectToolLoops)} · think ${yn(rt.config.detectThinkingLoops)}`,
		`footer: interactive ${yn(rt.config.interactiveFooter)} · toggle: ${rt.config.toggleShortcut}`,
	];
	if (rt.state.activeTaskStreams.length) {
		lines.push("", `active batch: ${rt.state.activeTaskStreams.map((x) => `${x.tool}×${x.count}`).join(", ")}`);
	}
	if (recent.length) {
		lines.push("", "recent:");
		for (const d of recent) lines.push(`  [${d.type}] ${d.description} · ${formatDuration(Date.now() - d.timestamp)} ago`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function showConfigMenu(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	const c = rt.config;
	const picked = await selectFrom(ctx, "⚙️ antiloop config", [
		// ── 🎛️ General ──────────────────────────────────────────────
		{ value: "toggle" as const, label: c.enabled ? "🟢 desactivar" : "🔴 activar", description: "enciende o apaga la detección" },
		{ value: "window" as const, label: `⏳ ventana: ${c.detectionWindow} msgs`, description: "cuántos mensajes recientes se analizan" },
		{ value: "notify" as const, label: `🔔 avisos: ${yn(c.notifyOnDetection)}`, description: "avisa cuando detecta un bucle" },
		{ value: "footer" as const, label: `📊 pie interactivo: ${yn(c.interactiveFooter)}`, description: "experimental: reemplaza el pie de pi y captura el teclado (si da problemas, déjalo en off)" },
		{ value: "shortcut" as const, label: `⌨️ atajo: ${c.toggleShortcut}`, description: "esc+a o desactivado" },
		// ── 🎯 Detección ────────────────────────────────────────────
		{ value: "warn" as const, label: `⚠️ umbral aviso: ${c.warningThreshold}`, description: "repeticiones antes de avisar" },
		{ value: "force" as const, label: `🛑 umbral corte: ${c.forceBreakThreshold}`, description: "repeticiones antes de forzar un cambio de rumbo" },
		{ value: "abort" as const, label: `🚨 umbral abortar: ${c.abortThreshold || "off"}`, description: "repeticiones antes de abortar (0 = desactivado)" },
		{ value: "sim" as const, label: `📏 parecido mínimo: ${(c.similarityThreshold * 100).toFixed(0)}%`, description: "qué tan parecidos deben ser dos mensajes para contar como bucle" },
		{ value: "toolSim" as const, label: `🔧 parecido de llamadas: ${(c.toolSimilarityThreshold * 100).toFixed(0)}%`, description: "qué tan idénticas deben ser las llamadas para contar como la misma" },
		{ value: "toolRepeat" as const, label: `🔁 repeticiones de llamada: ${c.minToolRepeatCount}+`, description: "cuántas veces se repite la misma llamada antes de marcarla" },
		{ value: "resultSim" as const, label: `🧾 parecido de resultados: ${(c.resultSimilarityThreshold * 100).toFixed(0)}%`, description: "mismo comando + resultado distinto = progreso, no bucle" },
		// ── 📋 Task streams ─────────────────────────────────────────
		{ value: "streams" as const, label: `📋 lotes de tareas: ${yn(c.detectTaskStreams)}`, description: "trabajo en lote (punched_log / plan_manager / …) no es un bucle" },
		{ value: "streamMin" as const, label: `📋 llamadas mínimas: ${c.taskStreamMinCalls}`, description: "llamadas de la misma herramienta antes de reconocer un lote" },
		{ value: "streamTwin" as const, label: `📋 gemelos: ${(c.taskStreamTwinThreshold * 100).toFixed(0)}%`, description: "llamadas más parecidas que esto = la misma tarea repetida, no un lote" },
		// ── 🔍 Detectores ───────────────────────────────────────────
		{ value: "text" as const, label: `📝 texto: ${yn(c.detectTextLoops)}`, description: "detecta mensajes de texto repetidos" },
		{ value: "tool" as const, label: `🔧 herramientas: ${yn(c.detectToolLoops)}`, description: "detecta llamadas repetidas a herramientas" },
		{ value: "think" as const, label: `🧠 pensamiento: ${yn(c.detectThinkingLoops)}`, description: "detecta razonamiento interno repetido" },
		// ── 🧹 ──────────────────────────────────────────────────────
		{ value: "reset" as const, label: "🧹 reiniciar estado", description: "borra contadores e historial" },
	]);
	if (!picked) return;
	switch (picked) {
		case "toggle":
			c.enabled = !c.enabled;
			saveConfig(c);
			ctx.ui.notify(`antiloop: ${c.enabled ? "ON" : "OFF"}`, "info");
			rt.updateStatus(ctx);
			break;
		case "window": {
			const v = await selectFrom(ctx, "⏳ ventana (mensajes a analizar)", [
				{ value: 5, label: "5" },
				{ value: 10, label: "10 (por defecto)" },
				{ value: 15, label: "15" },
				{ value: 20, label: "20" },
			]);
			if (v !== undefined) { c.detectionWindow = v; saveConfig(c); ctx.ui.notify(`ventana: ${v}`, "info"); }
			break;
		}
		case "notify":
			c.notifyOnDetection = !c.notifyOnDetection; saveConfig(c);
			ctx.ui.notify(`avisos: ${yn(c.notifyOnDetection)}`, "info"); break;
		case "footer":
			c.interactiveFooter = !c.interactiveFooter; saveConfig(c);
			ctx.ui.notify(`pie interactivo: ${yn(c.interactiveFooter)}`, "info");
			rt.refreshFooter?.(ctx);
			rt.updateStatus(ctx);
			break;
		case "shortcut": {
			const v = await selectFrom(ctx, "⌨️ atajo para activar/apagar", [
				{ value: "esc+a" as const, label: "⌨️ esc+a (por defecto)", description: "pulsa ESC y luego a" },
				{ value: "off" as const, label: "🚫 desactivado" },
			]);
			if (v !== undefined) { c.toggleShortcut = v; saveConfig(c); rt.refreshFooter?.(ctx); ctx.ui.notify(`atajo: ${v}`, "info"); }
			break;
		}
		case "warn": {
			const v = await selectFrom(ctx, "⚠️ umbral de aviso", [
				{ value: 1, label: "⚡ 1 (sensible)" },
				{ value: 2, label: "🎯 2 (por defecto)" },
				{ value: 3, label: "3" },
				{ value: 5, label: "🐢 5 (relajado)" },
			]);
			if (v !== undefined) { c.warningThreshold = v; saveConfig(c); ctx.ui.notify(`aviso: ${v}`, "info"); }
			break;
		}
		case "force": {
			const v = await selectFrom(ctx, "🛑 umbral de corte", [
				{ value: 2, label: "⚡ 2 (sensible)" },
				{ value: 3, label: "🎯 3 (por defecto)" },
				{ value: 5, label: "5" },
				{ value: 8, label: "🐢 8 (relajado)" },
			]);
			if (v !== undefined) { c.forceBreakThreshold = v; saveConfig(c); ctx.ui.notify(`corte: ${v}`, "info"); }
			break;
		}
		case "abort": {
			const v = await selectFrom(ctx, "🚨 umbral de aborto (0 = desactivado)", [
				{ value: 0, label: "🚫 desactivado" },
				{ value: 5, label: "5" },
				{ value: 8, label: "8" },
				{ value: 10, label: "10" },
				{ value: 15, label: "15" },
			]);
			if (v !== undefined) { c.abortThreshold = v; saveConfig(c); ctx.ui.notify(`aborto: ${v || "desactivado"}`, "info"); }
			break;
		}
		case "sim": {
			const v = await selectFrom(ctx, "📏 parecido mínimo entre mensajes", [
				{ value: 0.5, label: "⚡ 50% (sensible)" },
				{ value: 0.6, label: "60%" },
				{ value: 0.7, label: "70%" },
				{ value: 0.75, label: "🎯 75% (por defecto)" },
				{ value: 0.8, label: "80%" },
				{ value: 0.9, label: "🐢 90% (relajado)" },
			]);
			if (v !== undefined) { c.similarityThreshold = v; saveConfig(c); ctx.ui.notify(`parecido: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolSim": {
			const v = await selectFrom(ctx, "🔧 parecido de las llamadas (argumentos)", [
				{ value: 0.99, label: "⚡ 99% (estricto)" },
				{ value: 0.95, label: "🎯 95% (por defecto)" },
				{ value: 0.9, label: "90%" },
				{ value: 0.8, label: "🐢 80% (sensible)" },
			]);
			if (v !== undefined) { c.toolSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`parecido de llamadas: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "toolRepeat": {
			const v = await selectFrom(ctx, "🔁 repeticiones de la misma llamada", [
				{ value: 1, label: "⚡ 1 (sensible)" },
				{ value: 2, label: "🎯 2 (por defecto)" },
				{ value: 3, label: "🐢 3 (relajado)" },
			]);
			if (v !== undefined) { c.minToolRepeatCount = v; saveConfig(c); ctx.ui.notify(`repeticiones: ${v}+`, "info"); }
			break;
		}
		case "resultSim": {
			const v = await selectFrom(ctx, "🧾 parecido de resultados (veto de progreso)", [
				{ value: 0.95, label: "⚡ 95% (estricto — solo resultados casi idénticos cuentan como igual)" },
				{ value: 0.8, label: "🎯 80% (por defecto)" },
				{ value: 0.6, label: "🐢 60% (relajado — tolera más ruido de salida)" },
			]);
			if (v !== undefined) { c.resultSimilarityThreshold = v; saveConfig(c); ctx.ui.notify(`parecido de resultados: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "streams":
			c.detectTaskStreams = !c.detectTaskStreams; saveConfig(c);
			ctx.ui.notify(`lotes de tareas: ${yn(c.detectTaskStreams)}`, "info"); break;
		case "streamMin": {
			const v = await selectFrom(ctx, "📋 llamadas mínimas para reconocer un lote", [
				{ value: 2, label: "⚡ 2 (sensible)" },
				{ value: 3, label: "🎯 3 (por defecto)" },
				{ value: 4, label: "4" },
				{ value: 5, label: "🐢 5 (conservador)" },
			]);
			if (v !== undefined) { c.taskStreamMinCalls = v; saveConfig(c); ctx.ui.notify(`llamadas mínimas: ${v}`, "info"); }
			break;
		}
		case "streamTwin": {
			const v = await selectFrom(ctx, "📋 umbral de gemelos (argumentos)", [
				{ value: 0.99, label: "🎯 99% (por defecto — cualquier diferencia real = tarea distinta)" },
				{ value: 0.95, label: "95% (argumentos casi idénticos cuentan como la misma tarea)" },
				{ value: 0.9, label: "⚡ 90% (detección de bucles más agresiva)" },
			]);
			if (v !== undefined) { c.taskStreamTwinThreshold = v; saveConfig(c); ctx.ui.notify(`gemelos: ${(v * 100).toFixed(0)}%`, "info"); }
			break;
		}
		case "text":
			c.detectTextLoops = !c.detectTextLoops; saveConfig(c);
			ctx.ui.notify(`texto: ${yn(c.detectTextLoops)}`, "info"); break;
		case "tool":
			c.detectToolLoops = !c.detectToolLoops; saveConfig(c);
			ctx.ui.notify(`herramientas: ${yn(c.detectToolLoops)}`, "info"); break;
		case "think":
			c.detectThinkingLoops = !c.detectThinkingLoops; saveConfig(c);
			ctx.ui.notify(`pensamiento: ${yn(c.detectThinkingLoops)}`, "info"); break;
		case "reset":
			resetState(rt.state);
			rt.pendingIntervention = null;
			ctx.ui.notify("🧹 estado reiniciado", "info");
			rt.updateStatus(ctx);
			break;
	}
}

async function showLog(ctx: ExtensionCommandContext, rt: Runtime): Promise<void> {
	if (!rt.state.detections.length) {
		ctx.ui.notify("no hay detecciones en esta sesión", "info");
		return;
	}
	const items = rt.state.detections.slice(-30).reverse().map((d) => ({
		value: "" as const,
		label: `[${d.type}] ${d.description}`,
		description: `${(d.similarity * 100).toFixed(0)}% · ${formatDuration(Date.now() - d.timestamp)} ago`,
	}));
	await selectFrom(ctx, `🕵️ detecciones (${rt.state.detections.length} en total)`, items);
}

export function resetState(state: AntiloopState): void {
	state.recentMessages = [];
	state.detections = [];
	state.activeTaskStreams = [];
	state.currentLevel = 0;
	state.consecutiveDetections = 0;
	state.inForcedBreak = false;
	state.totalDetections = 0;
	state.lastDetectedTurnIndex = -1;
}

async function runSelfTest(ctx: ExtensionCommandContext): Promise<void> {
	const { runSelfTest } = await import("./detect.ts");
	ctx.ui.notify(`antiloop self-test\n${runSelfTest().join("\n")}`, "info");
}

function yn(b: boolean): string {
	return b ? "on" : "off";
}
