import {test} from 'node:test';
import assert from 'node:assert/strict';

const {
	default: mod,
	tpsText,
	formatDuration,
	formatTokens,
	formatRate,
	formatPercent,
	cachePercent,
	parseUsageBlock,
	modelLabel,
} = await import('../status-metrics.ts');

function createHarness() {
	const handlers = new Map<string, Array<(event: any) => void>>();
	const overrides = new Map<string, (props: any, next?: () => any) => any>();
	const panes = new Map<string, any>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	let widgetRefreshes = 0;

	const record = (id: string, data: any) => {
		const history = ((createHarness as any).sessions ??= new Map()).get(id) ?? [];
		history.push(data);
	};

	const cmd: any = {
		on: (type: string, handler: (event: any) => void) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
			return {dispose() {}};
		},
		hooks: (hooks: any) => {
			(createHarness as any).hooks = hooks;
			return {dispose() {}};
		},
		addCommand: (command: any) => {
			commands.set(command.name, command);
			return {dispose() {}};
		},
		ui: {
			capabilities: {surface: true, status: true},
			override: (component: string, render: any) => {
				overrides.set(component, render);
				return {dispose() {}};
			},
			pane: (pane: any) => {
				panes.set(pane.id, pane);
				return {dispose() {}};
			},
			openPane: (id: string) => {
				(createHarness as any).openedPane = id;
			},
			closePane: () => {},
			notify: (message: string) => notices.push(message),
			refreshWidgets: () => {},
		},
		state: (() => {
			const values = new Map<string, unknown>();
			return {
				get: (key: string) => values.get(key),
				set: (key: string, value: unknown) => {
					values.set(key, value);
					widgetRefreshes += 1;
				},
			};
		})(),
	};

	mod(cmd);

	return {
		emit(type: string, event: any = {type}) {
			for (const handler of handlers.get(type) ?? []) handler({type, ...event});
		},
		spinner(tokens = 0) {
			const render = overrides.get('spinner')!;
			return render({status: 'working', elapsedMs: 0, tokens}, undefined) ?? [];
		},
		pane(id = 'metrics') {
			return panes.get(id)!.render({width: 80});
		},
		command(name = 'metrics') {
			return commands.get(name)!.handler({args: '', ui: cmd.ui, cwd: '/tmp', exec: async () => ({stdout: '', stderr: '', code: 0})});
		},
		notices,
		get widgetRefreshes() {
			return widgetRefreshes;
		},
		openedPane: () => (createHarness as any).openedPane,
		hooks: () => (createHarness as any).hooks,
		record,
	};
}

const flat = (nodes: any[]): string =>
	nodes
		.map(node => (node.children ? flat(node.children) : (node.text ?? '')))
		.join(' | ');

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;
const advance = (ms: number) => {
	clock += ms;
};

test.after(() => {
	Date.now = realNow;
});

test('tpsText formats TPS label', () => {
	assert.equal(tpsText(12.4), 'TPS 12');
	assert.equal(tpsText(3.14), 'TPS 3.1');
});

test('formatDuration, formatTokens and formatRate', () => {
	assert.equal(formatDuration(420), '0.42s');
	assert.equal(formatDuration(2_340), '2.3s');
	assert.equal(formatDuration(61_000), '1m01s');
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(12_345), '12k');
	assert.equal(formatTokens(1_500_000), '1.5M');
	assert.equal(formatRate(undefined), '—');
	assert.equal(formatRate(9.04), '9 t/s');
	assert.equal(formatRate(24.6), '25 t/s');
	assert.equal(formatRate(2_400), '2.4k t/s');
});

test('modelLabel keeps the tail of a routed model id', () => {
	assert.equal(modelLabel('nexrouter/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
	assert.equal(modelLabel('claude-sonnet-4'), 'claude-sonnet-4');
});

test('parseUsageBlock reads the sub-agent usage block', () => {
	const text = 'All done.\n\n<usage>total_tokens: 20370\ntool_uses: 1\nturns: 2\nduration_ms: 1234</usage>';
	assert.deepEqual(parseUsageBlock(text), {
		durationMs: 1234,
		totalTokens: 20_370,
		turns: 2,
		toolUses: 1,
	});
	assert.deepEqual(parseUsageBlock('no usage here'), {});
});

test('spinner shows live TPS, TTFT and elapsed for the active request', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'nexrouter/deepseek-v4.1-flash'});

	advance(400);
	h.emit('thinking_delta', {delta: 'think'});
	assert.equal(flat(h.spinner(0)), 'TTFT 0.40s | 0.40s');

	advance(800);
	const nodes = h.spinner(50);
	assert.match(flat(nodes), /TPS \d/);

	advance(100);
	h.emit('text_delta', {delta: 'hi'});
	const text = flat(h.spinner(120));
	assert.match(text, /TPS/);
	assert.match(text, /TTFT 0\.40s/);
	assert.match(text, /1\.3s$/);
});

test('model_request_end records TTFT, duration, tokens and TPS', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'nexrouter/deepseek-v4.1-flash'});
	advance(400);
	h.emit('text_delta', {delta: 'a'});
	advance(600);
	h.emit('model_request_end', {
		model: 'nexrouter/deepseek-v4.1-flash',
		usage: {inputTokens: 100, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0},
		stopReason: 'end_turn',
	});

	const paneText = flat(h.pane());
	assert.match(paneText, /#1/);
	assert.match(paneText, /deepseek-v4\.1-flash/);
	assert.match(paneText, /TTFT 0\.40s/);
	assert.match(paneText, /⏱ 1\.0s/);
	assert.match(paneText, /90 tok/);
	assert.match(paneText, /150 t\/s/);
	assert.match(paneText, /end_turn/);
});

test('spinner falls back to the last completed request between requests', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(250);
	h.emit('text_delta', {delta: 'x'});
	advance(750);
	h.emit('model_request_end', {usage: {outputTokens: 40}, stopReason: 'end_turn'});

	const text = flat(h.spinner(0));
	assert.match(text, /⏱ 1\.0s · TTFT 0\.25s/);
	assert.match(text, /t\/s/);
});

test('each completed request gets its own row in order', () => {
	const h = createHarness();
	h.emit('run_start');
	for (const [index, model] of ['a/one', 'b/two', 'c/three'].entries()) {
		h.emit('model_request_start', {model});
		advance(100);
		h.emit('text_delta', {delta: 't'});
		advance(100);
		h.emit('model_request_end', {usage: {outputTokens: 10 + index}});
	}
	const text = flat(h.pane());
	assert.match(text, /#1 \| one/);
	assert.match(text, /#2 \| two/);
	assert.match(text, /#3 \| three/);
});

test('subagent TTFT is spawn to first child activity, and TPS excludes it', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {
		toolCallId: 'call_1',
		subagentType: 'explore',
		description: 'Find auth code',
	});
	advance(500);
	h.emit('subagent_progress', {toolCallId: 'call_1', tokensUsed: 1_200, toolName: 'grep'});
	const running = flat(h.pane());
	assert.match(running, /⑂explore/);
	assert.match(running, /Find auth code/);
	assert.match(running, /TTFT 0\.50s/);
	assert.match(running, /⏱ 0\.50s/);
	assert.match(running, /1 tool call/);

	advance(1_500);
	h.emit('subagent_stop', {toolCallId: 'call_1', tokensUsed: 20_370});
	const finished = flat(h.pane());
	assert.match(finished, /✓ \| ⑂explore/);
	assert.match(finished, /TTFT 0\.50s/);
	assert.match(finished, /⏱ 2\.0s/);
	assert.match(finished, /20k tok/);
	assert.match(finished, /13\.6k t\/s/);
});

test('running subagents appear on the spinner line', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'plan', description: 'Design'});
	advance(1_500);
	h.emit('subagent_start', {toolCallId: 'c2', subagentType: 'explore', description: 'Search'});
	advance(250);
	const text = flat(h.spinner(0));
	assert.match(text, /⑂plan 1\.8s/);
	assert.match(text, /⑂explore 0\.25s/);

	h.emit('subagent_stop', {toolCallId: 'c1', tokensUsed: 10});
	assert.doesNotMatch(flat(h.spinner(0)), /⑂plan/);
});

test('agent tool usage block refines the sub-agent duration and tokens', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'c9', subagentType: 'general', description: 'work'});
	advance(100);
	h.emit('subagent_stop', {toolCallId: 'c9', tokensUsed: 10});
	h.emit('tool_completed', {
		toolCallId: 'c9',
		toolName: 'agent',
		result: [
			{
				type: 'text',
				text: '<usage>total_tokens: 20370\ntool_uses: 1\nturns: 2\nduration_ms: 3000</usage>',
			},
		],
	});
	const text = flat(h.pane());
	assert.match(text, /⏱ 3\.0s/);
	assert.match(text, /20k tok/);
	assert.match(text, /7\.0k t\/s/);
});

test('background sub-agent stop carries status', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('subagent_start', {toolCallId: 'bg1', subagentType: 'general', description: 'bg'});
	advance(200);
	h.emit('subagent_stop', {toolCallId: 'bg1', tokensUsed: 0, status: 'completed'});
	assert.match(flat(h.pane()), /completed/);
});

test('run_start clears history and sub-agents', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.emit('subagent_start', {toolCallId: 'c1', subagentType: 'general', description: 'd'});
	assert.match(flat(h.pane()), /#1/);

	h.emit('run_start');
	const text = flat(h.pane());
	assert.doesNotMatch(text, /#1/);
	assert.doesNotMatch(text, /⑂/);
});

test('/metrics opens the pane and reports a summary', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(200);
	h.emit('text_delta', {delta: 'x'});
	advance(200);
	h.emit('model_request_end', {usage: {outputTokens: 20}});

	const result = h.command();
	assert.equal(h.openedPane(), 'metrics');
	assert.match(result.message, /1 request/);
	assert.match(result.message, /avg .*t\/s/);
	assert.match(result.message, /avg TTFT 0\.20s/);
});

test('run_end notifies the summary', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.emit('run_end', {});
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /1 request/);
});

test('session hooks reset state', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {outputTokens: 5}});
	h.hooks().onSessionStart({source: 'startup'});
	assert.doesNotMatch(flat(h.pane()), /#1/);
});

test('a cancelled or failed request leaves no stale live state', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('run_end', {});
	h.emit('run_start');
	assert.doesNotMatch(flat(h.pane()), /▶/);
});

test('cachePercent is cache reads over total prompt tokens', () => {
	// inputTokens already counts cached tokens (the cost path subtracts them back out).
	assert.equal(Math.round(cachePercent({inputTokens: 27_947, outputTokens: 123, cacheReadTokens: 14_336})!), 51);
	assert.equal(cachePercent({inputTokens: 1_000, cacheReadTokens: 1_000}), 100);
	assert.equal(cachePercent({inputTokens: 1_000, cacheReadTokens: 0}), 0);
	assert.equal(cachePercent({inputTokens: 0, cacheReadTokens: 0}), undefined);
	assert.equal(cachePercent(undefined), undefined);
	assert.equal(cachePercent({inputTokens: 100, cacheReadTokens: 500}), 100);
});

test('formatPercent keeps a decimal only for small non-zero values', () => {
	assert.equal(formatPercent(undefined), '—');
	assert.equal(formatPercent(0), '0%');
	assert.equal(formatPercent(4.26), '4.3%');
	assert.equal(formatPercent(51.32), '51%');
	assert.equal(formatPercent(100), '100%');
});

test('a request row reports its cache percentage', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	advance(100);
	h.emit('model_request_end', {
		usage: {inputTokens: 20_000, outputTokens: 50, cacheReadTokens: 15_000, cacheWriteTokens: 0},
		stopReason: 'end_turn',
	});
	assert.match(flat(h.pane()), /cache 75%/);
	// Between requests the spinner carries the last request's hit rate too.
	assert.match(flat(h.spinner(0)), /cache 75%/);
});

test('session cache rate is token-weighted, not an average of percentages', () => {
	const h = createHarness();
	h.emit('run_start');
	// A tiny cold request and a huge warm one: averaging percentages would give ~50%,
	// the honest token-weighted rate is 9900/10100 = 98%.
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 100, outputTokens: 5, cacheReadTokens: 0}});
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 10_000, outputTokens: 5, cacheReadTokens: 9_900}});
	const message = h.command().message;
	assert.match(message, /cache 98%/);
	assert.doesNotMatch(message, /cache 50%/);
});

test('a request with no usage reports no cache figure', () => {
	const h = createHarness();
	h.emit('run_start');
	h.emit('model_request_start', {model: 'm/one'});
	advance(100);
	h.emit('text_delta', {delta: 'x'});
	h.emit('model_request_end', {usage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0}});
	assert.match(flat(h.pane()), /cache —/);
});
