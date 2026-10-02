import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "antiloop-test-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
// Stub only the host boundary; load the real config, hooks, commands and detectors.
const hostModules = {
	"@earendil-works/pi-coding-agent": `
		export const getAgentDir = () => ${JSON.stringify(agentDir)};
		export const isToolCallEventType = (name, event) => event.toolName === name;
	`,
	"@earendil-works/pi-tui": "export const truncateToWidth = (text) => text;",
};
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier in hostModules) {
			return { url: `data:text/javascript,${encodeURIComponent(hostModules[specifier])}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { default: extension } = await import("../src/index.ts");

async function start(config) {
	writeFileSync(join(agentDir, "antiloop.json"), JSON.stringify(config));
	const hooks = new Map();
	const statuses = new Map();
	const notifications = [];
	const steers = [];
	const footers = [];
	let command;
	let footer;
	let aborted = false;
	const ctx = {
		mode: "tui", signal: new AbortController().signal,
		abort() { aborted = true; },
		ui: {
			setStatus(key, value) { statuses.set(key, value); },
			setFooter(value) {
				footers.push(value);
				footer?.dispose?.();
				footer = value?.({ requestRender() {} }, {}, {});
			},
			notify(...args) { notifications.push(args); },
			async select(_title, items) { return items.find((item) => item.includes("hide status:")); },
		},
	};
	extension({
		on(name, handler) { hooks.set(name, handler); },
		registerCommand(_name, options) { command = options.handler; },
		sendUserMessage(...args) { steers.push(args); },
	});
	await hooks.get("session_start")({}, ctx);
	return {
		statuses, footers, notifications, steers,
		get aborted() { return aborted; },
		emit: (name, event = {}) => hooks.get(name)(event, ctx),
		command: (args) => command(args, ctx),
		replaceFooter: (factory) => ctx.ui.setFooter(factory),
	};
}

test("default keeps the status visible; enable/disable still updates it", async () => {
	const app = await start({});
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
	await app.command("disable");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:off");
	await app.command("enable");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
});

test("hidden status stays absent across lifecycle and commands without claiming a footer", async () => {
	for (const interactiveFooter of [false, true]) {
		const app = await start({ hideStatus: true, interactiveFooter });
		for (const cmd of ["disable", "enable", "reset"]) await app.command(cmd);
		await app.emit("turn_end");
		await app.emit("session_shutdown");
		assert.equal(app.statuses.get("antiloop"), undefined);
		assert.deepEqual(app.footers, []);
	}
});

test("another extension's footer is not cleared after it replaces antiloop", async () => {
	const app = await start({ interactiveFooter: true });
	const other = () => ({ dispose() {} });
	app.replaceFooter(other);
	await app.command("config");
	await app.emit("session_shutdown");
	assert.equal(app.footers.at(-1), other);
});

test("hiding status leaves warning, force break, abort and bash blocking active", async () => {
	const app = await start({ hideStatus: true });
	const text = "lorem ".repeat(200);
	const message = { message: { role: "assistant", content: text } };
	await app.emit("message_end", message);
	assert.ok(app.notifications.some(([, level]) => level === "warning"));
	await app.emit("message_end", message);
	assert.equal(app.steers.length, 1);
	await app.emit("message_end", message);
	await app.emit("message_end", message);
	assert.equal(app.aborted, true);
	const blocked = await app.emit("tool_call", { toolName: "bash", input: { command: text } });
	assert.equal(blocked.block, true);
	assert.equal(app.statuses.get("antiloop"), undefined);
});

test("config menu hides and restores the indicator and persists the choice", async () => {
	const app = await start({ interactiveFooter: true });
	assert.equal(typeof app.footers.at(-1), "function");
	await app.command("config");
	assert.equal(app.statuses.get("antiloop"), undefined);
	assert.equal(app.footers.at(-1), undefined);
	await app.emit("session_start");
	assert.equal(app.statuses.get("antiloop"), undefined);
	await app.command("config");
	assert.equal(app.statuses.get("antiloop"), "🔄 a:on");
	assert.equal(typeof app.footers.at(-1), "function");
});
