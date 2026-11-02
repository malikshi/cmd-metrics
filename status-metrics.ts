// status-metrics — per-request TPS, TTFT, duration and prompt-cache hit rate on the
// spinner line, the same numbers for every spawned sub-agent, and a /metrics pane with
// the request history.

import type {ModApi} from '@commandcode/harness';

const TPS_WINDOW_MS = 2_000;
const TPS_MIN_WINDOW_MS = 800;
const TPS_PAUSE_MS = 1_500;
const TPS_MAX = 1_000;
const TPS_SMOOTHING = 0.25;
const HISTORY_LIMIT = 50;
const SPINNER_SUBAGENTS = 3;
const PANE_ID = 'metrics';

interface Usage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

interface RequestRecord {
	model: string;
	startedAt: number;
	firstTokenAt?: number;
	endedAt?: number;
	durationMs?: number;
	ttftMs?: number;
	outputTokens?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cachePercent?: number;
	tps?: number;
	stopReason?: string;
}

interface SubagentRecord {
	toolCallId: string;
	type: string;
	description: string;
	startedAt: number;
	firstActivityAt?: number;
	lastActivityAt?: number;
	endedAt?: number;
	durationMs?: number;
	ttftMs?: number;
	toolCalls: number;
	tokens: number;
	tokensUsed?: number;
	tps?: number;
	status?: string;
}

interface RequestMetric {
	ttftMs?: number;
	tps?: number;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
}

interface SubagentMetric {
	tokens?: number;
	tokensUsed?: number;
}

export interface SessionAverages {
	requests: number;
	subagents: number;
	avgTtftMs?: number;
	avgTps?: number;
	avgDurationMs?: number;
	cachePercent?: number;
	totalTokens: number;
}

interface TextNode {
	type: 'text';
	text: string;
	color?: string;
	dim?: boolean;
	bold?: boolean;
}

interface RowNode {
	type: 'row';
	children: TextNode[];
}

interface ButtonNode {
	type: 'button';
	label: string;
	hotkey?: string;
	onPress: () => void;
}

type Line = TextNode | RowNode | ButtonNode;

export function tpsText(tps: number): string {
	const value = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	return `TPS ${value}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1_000) return `${(ms / 1_000).toFixed(2)}s`;
	if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1_000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return '0';
	if (tokens < 1_000) return String(Math.round(tokens));
	if (tokens < 1_000_000) {
		const value = tokens / 1_000;
		return `${value < 10 ? value.toFixed(1) : Math.round(value)}k`;
	}
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatRate(tps: number | undefined): string {
	if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return '—';
	if (tps >= 1_000) return `${(tps / 1_000).toFixed(1)}k t/s`;
	return `${tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10} t/s`;
}

// inputTokens counts the whole prompt, cache reads AND cache writes included: the cost
// estimate subtracts both back out before pricing uncached input. So the cache hit rate is
// cacheReadTokens ÷ inputTokens, and a cache write is not a hit but the write is still a
// portion of the prompt that never had to be billed as fresh input.
export function cachePercent(usage: Usage | undefined): number | undefined {
	const inputTokens = Number(usage?.inputTokens ?? 0);
	if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
	const cacheReadTokens = Number(usage?.cacheReadTokens ?? 0) || 0;
	const percent = (cacheReadTokens / inputTokens) * 100;
	if (!Number.isFinite(percent) || percent < 0) return undefined;
	return Math.min(100, percent);
}

export function formatPercent(percent: number | undefined): string {
	if (percent === undefined || !Number.isFinite(percent)) return '—';
	if (percent > 0 && percent < 10) return `${percent.toFixed(1)}%`;
	return `${Math.round(percent)}%`;
}

const averageOf = (values: number[]): number | undefined =>
	values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

// Session aggregates. TTFT, TPS and duration average the parent model requests only, so the
// approximate sub-agent TTFT (spawn → first forwarded event) cannot dilute a measured one.
// The cache rate is token-weighted and request-only; a child carries no prompt accounting.
// totalTokens sums every usage figure seen in the session, parent requests and sub-agents
// alike, because each is its own inference call billed on its own tokens.
export function sessionAverages(
	requests: RequestMetric[],
	subagents: SubagentMetric[] = [],
): SessionAverages {
	const totalInput = requests.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0);
	const totalCacheRead = requests.reduce((sum, record) => sum + (record.cacheReadTokens ?? 0), 0);
	const requestTokens = requests.reduce(
		(sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
		0,
	);
	const subagentTokens = subagents.reduce(
		(sum, subagent) => sum + (subagent.tokensUsed ?? subagent.tokens ?? 0),
		0,
	);
	const averages: SessionAverages = {
		requests: requests.length,
		subagents: subagents.length,
		totalTokens: requestTokens + subagentTokens,
	};
	const avgTtftMs = averageOf(
		requests.map(record => record.ttftMs).filter((ttft): ttft is number => ttft !== undefined),
	);
	if (avgTtftMs !== undefined) averages.avgTtftMs = avgTtftMs;
	const avgTps = averageOf(
		requests.map(record => record.tps).filter((tps): tps is number => tps !== undefined),
	);
	if (avgTps !== undefined) averages.avgTps = avgTps;
	const avgDurationMs = averageOf(
		requests
			.map(record => record.durationMs)
			.filter((duration): duration is number => duration !== undefined),
	);
	if (avgDurationMs !== undefined) averages.avgDurationMs = avgDurationMs;
	if (totalInput > 0) averages.cachePercent = (totalCacheRead / totalInput) * 100;
	return averages;
}

export function parseUsageBlock(text: string): {
	durationMs?: number;
	totalTokens?: number;
	turns?: number;
	toolUses?: number;
} {
	const block = /<usage>([\s\S]*?)<\/usage>/.exec(text);
	if (!block) return {};
	const read = (key: string): number | undefined => {
		const match = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(block[1]);
		return match ? Number(match[1]) : undefined;
	};
	return {
		durationMs: read('duration_ms'),
		totalTokens: read('total_tokens'),
		turns: read('turns'),
		toolUses: read('tool_uses'),
	};
}

export function modelLabel(model: string): string {
	const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
	return tail.length > 0 ? tail : model;
}

function resultText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (!Array.isArray(result)) return '';
	return result
		.map(part => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object') {
				const text = (part as {text?: unknown}).text;
				if (typeof text === 'string') return text;
			}
			return '';
		})
		.join('\n');
}

export default function (cmd: ModApi): void {
	let current: RequestRecord | undefined;
	let history: RequestRecord[] = [];
	const subagents = new Map<string, SubagentRecord>();
	let samples: {at: number; tokens: number}[] = [];
	let smoothed: number | undefined;
	let lastTokenAt = 0;

	const resetRate = (): void => {
		samples = [];
		smoothed = undefined;
		lastTokenAt = 0;
	};

	const reset = (): void => {
		current = undefined;
		resetRate();
	};

	const rateFor = (now: number, tokens: number): number | undefined => {
		// A short rolling window, never a cumulative average, so a pause does not drag
		// the number down and a burst does not inflate it forever.
		if (samples.length > 0 && tokens < samples[samples.length - 1].tokens) resetRate();
		if (samples.length === 0) {
			samples.push({at: now, tokens});
			lastTokenAt = now;
			return undefined;
		}

		const previous = samples[samples.length - 1];
		if (tokens > previous.tokens) lastTokenAt = now;
		samples.push({at: now, tokens});
		while (samples.length > 1 && now - samples[0].at > TPS_WINDOW_MS) samples.shift();

		if (now - lastTokenAt > TPS_PAUSE_MS) {
			// Thinking or stalled: no rate to show, and the next burst starts from a
			// fresh window.
			samples = [{at: now, tokens}];
			smoothed = undefined;
			return undefined;
		}

		const first = samples[0];
		const windowMs = now - first.at;
		if (windowMs < TPS_MIN_WINDOW_MS) return undefined;

		const delta = tokens - first.tokens;
		if (delta <= 0) return undefined;

		const rate = delta / (windowMs / 1_000);
		if (!Number.isFinite(rate) || rate <= 0 || rate > TPS_MAX) {
			// A counter jump, not generation: start over without a rate.
			samples = [{at: now, tokens}];
			smoothed = undefined;
			lastTokenAt = now;
			return undefined;
		}

		smoothed =
			smoothed === undefined ? rate : smoothed * (1 - TPS_SMOOTHING) + rate * TPS_SMOOTHING;
		return smoothed;
	};

	const subagentRate = (subagent: SubagentRecord): number | undefined => {
		// Same formula as a parent request: tps = tokens ÷ (duration − ttft), so prefill and
		// thinking time do not dilute the generation rate. While the child is still running,
		// the window is spawn → last activity, not spawn → now.
		if (subagent.tps !== undefined) return subagent.tps;
		const end = subagent.endedAt ?? subagent.lastActivityAt;
		const ttft = subagent.ttftMs;
		const tokens = subagent.tokensUsed ?? subagent.tokens;
		if (end === undefined || ttft === undefined) return undefined;
		const generationMs = end - subagent.startedAt - ttft;
		if (tokens <= 0 || generationMs < 100) return undefined;
		return tokens / (generationMs / 1_000);
	};

	const runningSubagents = (): SubagentRecord[] =>
		[...subagents.values()].filter(subagent => subagent.endedAt === undefined);

	const spinnerNodes = (now: number, tokens: number): Line[] => {
		const nodes: TextNode[] = [];
		if (current) {
			const rate = rateFor(now, tokens);
			if (rate !== undefined) nodes.push({type: 'text', text: tpsText(rate), color: 'cyan'});
			const ttftMs =
				current.firstTokenAt === undefined ? undefined : current.firstTokenAt - current.startedAt;
			if (ttftMs !== undefined)
				nodes.push({type: 'text', text: `TTFT ${formatDuration(ttftMs)}`, color: 'green'});
			nodes.push({
				type: 'text',
				text: formatDuration(now - current.startedAt),
				dim: true,
			});
		} else {
			const last = history[history.length - 1];
			if (last) {
				nodes.push({
					type: 'text',
					text: `⏱ ${formatDuration(last.durationMs ?? 0)} · TTFT ${formatDuration(last.ttftMs ?? 0)} · ${formatRate(last.tps)} · cache ${formatPercent(last.cachePercent)}`,
					dim: true,
				});
			}
		}

		for (const subagent of runningSubagents().slice(0, SPINNER_SUBAGENTS)) {
			const ttft = subagent.ttftMs;
			nodes.push({
				type: 'text',
				text:
					ttft === undefined
						? `⑂${subagent.type} ${formatDuration(now - subagent.startedAt)}`
						: `⑂${subagent.type} TTFT ${formatDuration(ttft)} ${formatDuration(now - subagent.startedAt)}`,
				color: 'magenta',
			});
		}

		return nodes;
	};

	const summaryLine = (): string => {
		if (history.length === 0) return 'metrics: no completed model requests yet';
		const stats = sessionAverages(history, [...subagents.values()]);
		const parts = [`metrics: ${stats.requests} request(s)`];
		if (stats.avgTtftMs !== undefined) parts.push(`avg TTFT ${formatDuration(stats.avgTtftMs)}`);
		if (stats.avgTps !== undefined) parts.push(`avg ${formatRate(stats.avgTps)}`);
		if (stats.avgDurationMs !== undefined)
			parts.push(`avg duration ${formatDuration(stats.avgDurationMs)}`);
		if (stats.cachePercent !== undefined) parts.push(`cache ${formatPercent(stats.cachePercent)}`);
		parts.push(`total ${formatTokens(stats.totalTokens)} tok`);
		if (stats.subagents > 0) {
			const subagentTtfts = [...subagents.values()]
				.map(subagent => subagent.ttftMs)
				.filter((ttft): ttft is number => ttft !== undefined);
			const subagentRates = [...subagents.values()]
				.map(subagent => subagentRate(subagent))
				.filter((tps): tps is number => tps !== undefined);
			let subagentPart = `${stats.subagents} sub-agent(s)`;
			const subagentAvgTtft = averageOf(subagentTtfts);
			if (subagentAvgTtft !== undefined)
				subagentPart += ` avg TTFT ${formatDuration(subagentAvgTtft)}`;
			const subagentAvgRate = averageOf(subagentRates);
			if (subagentAvgRate !== undefined) subagentPart += ` avg ${formatRate(subagentAvgRate)}`;
			parts.push(subagentPart);
		}
		return parts.join(' · ');
	};

	const avgWidgetLines = (): Line[] => {
		if (history.length === 0) return [];
		const stats = sessionAverages(history, [...subagents.values()]);
		const nodes: TextNode[] = [{type: 'text', text: 'session', dim: true}];
		if (stats.avgTtftMs !== undefined)
			nodes.push({type: 'text', text: `TTFT ${formatDuration(stats.avgTtftMs)}`, color: 'green'});
		if (stats.avgTps !== undefined)
			nodes.push({type: 'text', text: formatRate(stats.avgTps), color: 'cyan'});
		if (stats.avgDurationMs !== undefined)
			nodes.push({type: 'text', text: `⏱ ${formatDuration(stats.avgDurationMs)}`, color: 'white'});
		if (stats.cachePercent !== undefined)
			nodes.push({type: 'text', text: `cache ${formatPercent(stats.cachePercent)}`, color: 'yellow'});
		nodes.push({type: 'text', text: `${formatTokens(stats.totalTokens)} tok`, color: 'magenta'});
		return [{type: 'row', children: nodes}];
	};

	const requestLines = (): Line[] => {
		const lines: Line[] = [
			{type: 'text', text: 'Requests', bold: true},
			{
				type: 'text',
				text: 'TTFT = first streamed token · duration = model request wall time · t/s = output tokens ÷ generation time',
				dim: true,
			},
		];
		if (current) {
			const elapsed = Date.now() - current.startedAt;
			const ttft =
				current.firstTokenAt === undefined
					? 'TTFT —'
					: `TTFT ${formatDuration(current.firstTokenAt - current.startedAt)}`;
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: '▶', color: 'cyan'},
					{type: 'text', text: modelLabel(current.model), bold: true},
					{type: 'text', text: ttft, color: 'green'},
					{type: 'text', text: formatDuration(elapsed), dim: true},
				],
			});
		}
		if (history.length === 0 && !current) {
			lines.push({type: 'text', text: 'no model requests yet in this run', dim: true});
		}
		for (const [index, record] of history.entries()) {
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: `#${index + 1}`, dim: true},
					{type: 'text', text: modelLabel(record.model)},
					{type: 'text', text: `TTFT ${formatDuration(record.ttftMs ?? 0)}`, color: 'green'},
					{type: 'text', text: `⏱ ${formatDuration(record.durationMs ?? 0)}`},
					{type: 'text', text: `${formatTokens(record.outputTokens ?? 0)} tok`, dim: true},
					{type: 'text', text: `cache ${formatPercent(record.cachePercent)}`, color: 'yellow'},
					{type: 'text', text: formatRate(record.tps), color: 'cyan'},
					...(record.stopReason ? [{type: 'text' as const, text: record.stopReason, dim: true}] : []),
				],
			});
		}
		return lines;
	};

	const subagentLines = (): Line[] => {
		if (subagents.size === 0) return [];
		const now = Date.now();
		const lines: Line[] = [
			{type: 'text', text: 'Sub-agents', bold: true},
			{
				type: 'text',
				text: 'TTFT = spawn → first child activity (the harness forwards no child token deltas) · t/s = tokens ÷ (duration − TTFT)',
				dim: true,
			},
		];
		for (const subagent of subagents.values()) {
			const running = subagent.endedAt === undefined;
			const rate = subagentRate(subagent);
			const ttft = subagent.ttftMs;
			const elapsedMs =
				subagent.durationMs ??
				(subagent.endedAt ?? subagent.lastActivityAt ?? now) - subagent.startedAt;
			lines.push({
				type: 'row',
				children: [
					{type: 'text', text: running ? '▶' : '✓', color: running ? 'magenta' : 'green'},
					{type: 'text', text: `⑂${subagent.type}`, bold: true},
					{type: 'text', text: subagent.description, dim: true},
					{
						type: 'text',
						text: ttft === undefined ? 'TTFT —' : `TTFT ${formatDuration(ttft)}`,
						color: 'green',
					},
					{
						type: 'text',
						text: `⏱ ${formatDuration(elapsedMs)}`,
					},
					{
						type: 'text',
						text: `${formatTokens(subagent.tokensUsed ?? subagent.tokens)} tok`,
						dim: true,
					},
					{
						type: 'text',
						text: rate === undefined ? '—' : formatRate(rate),
						color: 'magenta',
					},
					{
						type: 'text',
						text: `${subagent.toolCalls} tool call(s)`,
						dim: true,
					},
					...(subagent.status ? [{type: 'text' as const, text: subagent.status, dim: true}] : []),
				],
			});
		}
		return lines;
	};

	const repaint = (): void => {
		// A pane redraws on a state write (cmd.state.set repaints every widget and pane);
		// the counter is only there to make the write always look like a change.
		cmd.state.set('repaint', (cmd.state.get<number>('repaint') ?? 0) + 1);
	};

	cmd.ui.override('spinner', (props, next) => {
		const nodes = spinnerNodes(Date.now(), Number(props.tokens) || 0);
		if (nodes.length === 0) return undefined;
		return [...nodes, ...(next?.() ?? [])];
	});

	cmd.ui.widget({
		placement: 'below-editor',
		render: () => avgWidgetLines(),
	});

	cmd.ui.pane({
		id: PANE_ID,
		title: 'Request metrics',
		render: () => {
			const lines: Line[] = [...requestLines()];
			const subagentSection = subagentLines();
			if (subagentSection.length > 0) lines.push({type: 'text', text: ''}, ...subagentSection);
			lines.push(
				{type: 'text', text: ''},
				{
					type: 'button',
					label: 'Close',
					hotkey: 'c',
					onPress: () => cmd.ui.closePane(PANE_ID),
				},
			);
			return lines;
		},
	});

	cmd.addCommand({
		name: 'metrics',
		description: 'Show TPS, TTFT, and duration for each model request and sub-agent',
		handler: () => {
			if (cmd.ui.capabilities.surface) cmd.ui.openPane(PANE_ID);
			return {message: summaryLine()};
		},
	});

	// A run is one submitted prompt, not one session: clearing the aggregates here would
	// blank the below-editor line every time a prompt is sent and make "session" means "this
	// prompt". Only the live request state is per-run; totals reset in the session hooks.
	cmd.on('run_start', () => {
		reset();
	});

	cmd.on('model_request_start', event => {
		const payload = event as {model?: unknown};
		resetRate();
		current = {
			model: typeof payload.model === 'string' ? payload.model : '',
			startedAt: Date.now(),
		};
	});

	const markFirstToken = (): void => {
		if (current && current.firstTokenAt === undefined) current.firstTokenAt = Date.now();
	};
	cmd.on('thinking_start', markFirstToken);
	cmd.on('thinking_delta', markFirstToken);
	cmd.on('text_delta', markFirstToken);
	// Some replies stream only as accumulated message updates (a tool-call-only turn often
	// has no text block at all); without this the first token would be missed entirely.
	cmd.on('message_update', markFirstToken);

	cmd.on('model_request_end', event => {
		if (!current) return;
		const payload = event as {usage?: Usage; stopReason?: unknown};
		const endedAt = Date.now();
		const durationMs = endedAt - current.startedAt;
		const ttftMs =
			current.firstTokenAt === undefined
				? durationMs
				: current.firstTokenAt - current.startedAt;
		const outputTokens = Number(payload.usage?.outputTokens ?? 0) || 0;
		const generationMs = durationMs - ttftMs;
		const tps =
			outputTokens > 0 && generationMs > 0 ? outputTokens / (generationMs / 1_000) : undefined;
		const record: RequestRecord = {
			...current,
			endedAt,
			durationMs,
			ttftMs,
			outputTokens,
		};
		const inputTokens = Number(payload.usage?.inputTokens ?? 0) || 0;
		if (inputTokens > 0) record.inputTokens = inputTokens;
		const cacheReadTokens = Number(payload.usage?.cacheReadTokens ?? 0) || 0;
		if (cacheReadTokens > 0) record.cacheReadTokens = cacheReadTokens;
		const cacheWriteTokens = Number(payload.usage?.cacheWriteTokens ?? 0) || 0;
		if (cacheWriteTokens > 0) record.cacheWriteTokens = cacheWriteTokens;
		const cached = cachePercent(payload.usage);
		if (cached !== undefined) record.cachePercent = cached;
		if (tps !== undefined) record.tps = tps;
		if (typeof payload.stopReason === 'string') record.stopReason = payload.stopReason;
		history.push(record);
		if (history.length > HISTORY_LIMIT) history.shift();
		current = undefined;
		resetRate();
		repaint();
	});

	cmd.on('subagent_start', event => {
		const payload = event as {
			toolCallId?: unknown;
			subagentType?: unknown;
			description?: unknown;
		};
		if (typeof payload.toolCallId !== 'string') return;
		const startedAt = Date.now();
		subagents.set(payload.toolCallId, {
			toolCallId: payload.toolCallId,
			type: typeof payload.subagentType === 'string' ? payload.subagentType : 'agent',
			description: typeof payload.description === 'string' ? payload.description : '',
			startedAt,
			toolCalls: 0,
			tokens: 0,
		});
		repaint();
	});

	cmd.on('subagent_progress', event => {
		const payload = event as {toolCallId?: unknown; tokensUsed?: unknown};
		if (typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		const now = Date.now();
		const tokens = Number(payload.tokensUsed);
		if (Number.isFinite(tokens) && tokens > subagent.tokens) subagent.tokens = tokens;
		// subagent_progress is the first child signal the harness forwards: child text_delta
		// and thinking_delta are counted by its translator and never re-emitted, so the
		// child's own first token is not observable. The first forwarded child event is the
		// earliest measurable point on the child's timeline, and is what TTFT is measured to.
		subagent.firstActivityAt ??= now;
		subagent.ttftMs ??= now - subagent.startedAt;
		subagent.lastActivityAt = now;
		subagent.toolCalls += 1;
		repaint();
	});

	// Finalises TTFT and TPS once a child is done. TTFT is the first forwarded child event;
	// a child that never emitted one is measured from spawn (its whole wait is prefill).
	const finalizeSubagent = (subagent: SubagentRecord): void => {
		if (subagent.endedAt === undefined) return;
		const durationMs =
			subagent.durationMs ?? subagent.endedAt - subagent.startedAt;
		subagent.durationMs = durationMs;
		subagent.ttftMs ??= subagent.firstActivityAt
			? subagent.firstActivityAt - subagent.startedAt
			: durationMs;
		const tokens = subagent.tokensUsed ?? subagent.tokens;
		const generationMs = durationMs - subagent.ttftMs;
		if (tokens > 0 && generationMs > 0) subagent.tps = tokens / (generationMs / 1_000);
	};

	cmd.on('subagent_stop', event => {
		const payload = event as {toolCallId?: unknown; tokensUsed?: unknown; status?: unknown};
		if (typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		subagent.endedAt = Date.now();
		const tokens = Number(payload.tokensUsed);
		if (Number.isFinite(tokens) && tokens > 0) subagent.tokensUsed = tokens;
		if (typeof payload.status === 'string') subagent.status = payload.status;
		finalizeSubagent(subagent);
		repaint();
	});

	cmd.on('tool_completed', event => {
		const payload = event as {toolCallId?: unknown; toolName?: unknown; result?: unknown};
		if (payload.toolName !== 'agent' || typeof payload.toolCallId !== 'string') return;
		const subagent = subagents.get(payload.toolCallId);
		if (!subagent) return;
		const usage = parseUsageBlock(resultText(payload.result));
		if (usage.durationMs !== undefined) subagent.durationMs = usage.durationMs;
		if (usage.totalTokens !== undefined) subagent.tokensUsed = usage.totalTokens;
		subagent.endedAt ??= subagent.startedAt + (subagent.durationMs ?? 0);
		finalizeSubagent(subagent);
		repaint();
	});

	cmd.on('run_end', () => {
		if (history.length > 0) cmd.ui.notify(summaryLine());
	});

	cmd.hooks({
		onSessionStart: () => {
			history = [];
			subagents.clear();
			reset();
		},
		onSessionEnd: () => {
			history = [];
			subagents.clear();
			reset();
		},
	});
}
