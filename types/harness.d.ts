// harness.d.ts — the slice of the bundled @commandcode/harness API this mod compiles against.
//
// exports: ModApi | ModUi | ModStoreApi | ModStateApi | ModHooks | AgentEvent | AgentUsage | ModFactory
// used_by: status-metrics.ts → ModApi [cascade]
// related: tsconfig.json includes this file so tsc checks the mod against the real surface.
// rules:   mirror only what the mod uses; never invent a field the CLI does not provide.
// agent:   claude-sonnet-4 | anthropic | 2026-11-02 | code-review | added the L1 header
declare module '@commandcode/harness' {
	export interface ModContext {
		emit(event: {type: string}): void;
		signal?: AbortSignal;
		cwd: string;
	}

	export interface AgentUsage {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	}

	export type AgentEvent =
		| {type: 'run_start'; sessionId: string}
		| {type: 'run_end'; result: unknown}
		| {type: 'turn_start'; turnNumber: number}
		| {type: 'turn_end'; turnNumber: number; hadToolCalls: boolean; usage: AgentUsage}
		| {type: 'message_start'}
		| {type: 'message_end'; content: unknown}
		| {type: 'message_update'; content: unknown}
		| {type: 'model_request_start'; model: string}
		| {type: 'model_request_end'; model: string; usage: AgentUsage; stopReason: string}
		| {type: 'text_delta'; delta: string}
		| {type: 'thinking_start'}
		| {type: 'thinking_delta'; delta: string}
		| {type: 'thinking_end'; text: string}
		| {type: 'tool_queued'; toolCallId: string; toolName: string; input: unknown}
		| {type: 'tool_running'; toolCallId: string; toolName: string; description: string}
		| {type: 'tool_completed'; toolCallId?: string; toolName?: string; result: unknown}
		| {type: 'tool_errored'; toolCallId: string; error: string}
		| {
				type: 'subagent_start';
				toolCallId: string;
				subagentType: string;
				description?: string;
				background?: boolean;
				showOutput?: boolean;
		  }
		| {
				type: 'subagent_progress';
				toolCallId: string;
				subagentType: string;
				toolName: string;
				toolInput: unknown;
				tokensUsed: number;
		  }
		| {type: 'subagent_stop'; toolCallId: string; subagentType: string; tokensUsed: number}
		| {type: 'notice'; level: string; message: string}
		| {type: 'interrupted'}
		| {type: 'run_error'; error?: unknown}
		| {type: 'mod_error'; modId: string; hook: string; error: string};

	export interface TextEl {
		type: 'text';
		text: string;
		color?: string;
		bold?: boolean;
		dim?: boolean;
	}
	export interface RowEl {
		type: 'row';
		children: readonly unknown[];
	}
	export interface ButtonEl {
		type: 'button';
		label: string;
		hotkey?: string;
		key?: string;
		onPress: () => void;
	}
	export type ModUiNode = TextEl | RowEl | ButtonEl | string;

	export interface ModUiOverrideProps {
		spinner: {status: string; elapsedMs: number; tokens: number};
	}

	export interface ModUi {
		// Rules:   optional on purpose — hosts before cmdc 1.10.0 have no capabilities property at
		// all, so an unguarded read throws instead of degrading.
		readonly capabilities?: {status: boolean; surface: boolean};
		notify(message: string, level?: 'info' | 'warning' | 'error'): void;
		toast(text: string, options?: {level?: string; durationMs?: number}): void;
		setStatus(text: string | null): {dispose(): void};
		widget(widget: {
			placement: 'above-editor' | 'below-editor';
			render: () => readonly ModUiNode[];
		}): {dispose(): void};
		refreshWidgets(): void;
		pane(pane: {id: string; title?: string; render: () => readonly ModUiNode[]}): {
			dispose(): void;
		};
		openPane(id: string, options?: {focus?: boolean}): void;
		closePane(id: string): void;
		override<K extends keyof ModUiOverrideProps>(
			component: K,
			render: (
				props: ModUiOverrideProps[K],
				next?: () => readonly ModUiNode[] | undefined,
			) => readonly ModUiNode[] | undefined,
		): {dispose(): void};
	}

	export interface ModStateApi {
		get<T>(key: string): T | undefined;
		set<T>(key: string, value: T): void;
		subscribe<T>(key: string, listener: (value: T) => void): {dispose(): void};
	}

	export interface ModStoreApi {
		get<T>(key: string): T | undefined;
		set<T>(key: string, value: T): Promise<void>;
		delete(key: string): Promise<void>;
	}

	export interface ModHooks {
		onSessionStart?(input: {source: string; sessionId?: string}): void;
		onSessionEnd?(input: {reason: string}): void;
		onTurnEnd?(input: {
			state: unknown;
			turnNumber: number;
			hadToolCalls: boolean;
			usage: AgentUsage;
		}): unknown;
		afterToolCall?(input: {
			toolCallId: string;
			toolName: string;
			input: unknown;
			result: unknown;
			isError: boolean;
			state: unknown;
		}): unknown;
		onStop?(input: {
			state: unknown;
			stopReason: string;
			turnNumber: number;
			lastAssistantText: string;
		}): {continue?: boolean; reason?: string} | undefined;
	}

	export type ModCommandResult = {message?: string; prompt?: string} | undefined;

	export interface ModCommandContext {
		args: string;
		ui: ModUi;
		cwd: string;
		exec(input: {command: string; args?: string[]}): Promise<{
			stdout: string;
			stderr: string;
			code: number;
		}>;
	}

	export interface ModApi {
		readonly name: string;
		readonly cwd: string;
		readonly ui: ModUi;
		readonly state: ModStateApi;
		readonly store: ModStoreApi;
		on<K extends AgentEvent['type']>(
			event: K,
			handler: (event: Extract<AgentEvent, {type: K}>) => void,
		): {dispose(): void};
		on(event: 'session_start' | 'session_shutdown', handler: (payload: unknown) => void): {
			dispose(): void;
		};
		hooks(hooks: ModHooks): {dispose(): void};
		addCommand(command: {
			name: string;
			description?: string;
			argumentHint?: string;
			handler: (context: ModCommandContext) => ModCommandResult | Promise<ModCommandResult>;
		}): {dispose(): void};
		showEntry(customType: string, data?: unknown): void;
		refreshWidgets?(): void;
	}

	export type ModFactory = (cmd: ModApi) => void | Promise<void>;
}
