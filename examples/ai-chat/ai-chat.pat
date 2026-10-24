<script lang="ts">
	import {
		models,
		respond,
		seedChats,
		suggestions,
		toolPart,
		tools,
		uid,
		type Chat,
		type Message,
		type Part,
		type Step,
		type ToolStep
	} from './scenarios.ts';

	type Streaming = { chatId: number; messageId: number };
	type Menu = { kind: 'model' | 'tools' | 'chat'; key: string; chatId?: number; trigger?: HTMLElement };

	let chats: Chat[] = $state(seedChats());
	let activeId: number | null = $state(null);
	let draft = $state('');
	let streaming = $state<Streaming | null>(null);
	let now = $state(0);
	let modelId = $state('atlas-2');
	let copiedId: number | null = $state(null);
	let hoveredChat: number | null = $state(null);
	let hoveredSuggestion: string | null = $state(null);
	let menu = $state<Menu | null>(null);
	let menuRow: string | null = $state(null);
	// Keep the newest message in view until the reader scrolls up.
	let follow = $state(true);

	let composer = $state<HTMLTextAreaElement>();
	let bottom = $state<HTMLDivElement>();
	let menuEl = $state<HTMLDivElement>();
	// What menus and the "Jump to latest" button are anchored to.
	let modelButton = $state<HTMLButtonElement>();
	let toolsButton = $state<HTMLButtonElement>();
	let composerBox = $state<HTMLDivElement>();

	let activeChat = $derived(chats.find((c) => c.id === activeId) ?? null);
	let model = $derived(models.find((m) => m.id === modelId) ?? models[0]);
	let canSend = $derived(draft.trim() !== '' && streaming === null);
	let streamingHere = $derived(streaming !== null && streaming.chatId === activeId);

	// Every playback gets a token; stopping or starting another one makes the
	// old playback's pending steps bail out.
	let run = 0;
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	function edit(chatId: number, messageId: number, fn: (m: Message) => Message) {
		chats = chats.map((c) =>
			c.id !== chatId ? c : { ...c, messages: c.messages.map((m) => (m.id === messageId ? fn(m) : m)) }
		);
	}

	function editPart(chatId: number, messageId: number, partId: number, fn: (p: Part) => Part) {
		edit(chatId, messageId, (m) => ({ ...m, parts: m.parts.map((p) => (p.id === partId ? fn(p) : p)) }));
	}

	function addParts(chatId: number, messageId: number, parts: Part[]) {
		edit(chatId, messageId, (m) => ({ ...m, parts: [...m.parts, ...parts] }));
	}

	async function streamText(
		chatId: number,
		messageId: number,
		step: Extract<Step, { kind: 'text' | 'code' }>,
		pace: number,
		alive: () => boolean
	) {
		const part: Part =
			step.kind === 'text' ? { id: uid(), kind: 'text', text: '' } : { id: uid(), kind: 'code', lang: step.lang, code: '' };
		addParts(chatId, messageId, [part]);
		const tokens = (step.kind === 'text' ? step.text : step.code).match(/\s+|\S+/g) ?? [];
		for (let i = 0; i < tokens.length; ) {
			if (!alive()) return;
			const n = step.kind === 'code' ? 4 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 3);
			const chunk = tokens.slice(i, i + n).join('');
			i += n;
			editPart(chatId, messageId, part.id, (p) =>
				p.kind === 'text' ? { ...p, text: p.text + chunk } : p.kind === 'code' ? { ...p, code: p.code + chunk } : p
			);
			await wait((step.kind === 'code' ? 30 : 25 + Math.random() * 45) * pace);
		}
		await wait(250 * pace);
	}

	async function runTools(chatId: number, messageId: number, steps: ToolStep[], pace: number, alive: () => boolean) {
		now = Date.now();
		const parts = steps.map((tool) => toolPart(tool, now));
		addParts(chatId, messageId, parts);
		await Promise.all(
			steps.map(async (tool, i) => {
				await wait(tool.ms * pace);
				if (!alive()) return;
				editPart(chatId, messageId, parts[i].id, (p) =>
					p.kind === 'tool'
						? {
								...p,
								status: tool.error ? 'error' : 'done',
								ms: Math.round(tool.ms * pace),
								result: tool.result ?? null,
								error: tool.error ?? null
							}
						: p
				);
			})
		);
		await wait(400 * pace);
	}

	async function play(chatId: number, messageId: number, steps: Step[]) {
		const token = ++run;
		const alive = () => token === run;
		const { pace, think } = model;
		streaming = { chatId, messageId };
		now = Date.now();
		await wait(think);
		for (const step of steps) {
			if (!alive()) return;
			if (step.kind === 'text' || step.kind === 'code') await streamText(chatId, messageId, step, pace, alive);
			else await runTools(chatId, messageId, step.kind === 'parallel' ? step.tools : [step], pace, alive);
		}
		if (!alive()) return;
		edit(chatId, messageId, (m) => ({ ...m, streaming: false }));
		streaming = null;
	}

	function stop() {
		if (!streaming) return;
		run++;
		const { chatId, messageId } = streaming;
		edit(chatId, messageId, (m) => ({
			...m,
			streaming: false,
			stopped: true,
			parts: m.parts.map((p) =>
				p.kind === 'tool' && p.status === 'running' ? { ...p, status: 'cancelled', ms: Date.now() - p.startedAt } : p
			)
		}));
		streaming = null;
	}

	function send(text: string, title?: string) {
		const prompt = text.trim();
		if (!prompt || streaming) return;
		let chatId = activeId;
		if (chatId === null) {
			title ??= prompt.length > 24 ? `${prompt.slice(0, 23).trimEnd()}…` : prompt;
			const chat: Chat = { id: uid(), title, when: 'now', messages: [] };
			chats = [chat, ...chats];
			chatId = activeId = chat.id;
		}
		const user: Message = { id: uid(), role: 'user', text: prompt, parts: [], streaming: false, stopped: false, model: '' };
		const reply: Message = { id: uid(), role: 'assistant', text: '', parts: [], streaming: true, stopped: false, model: model.name };
		chats = chats.map((c) => (c.id === chatId ? { ...c, when: 'now', messages: [...c.messages, user, reply] } : c));
		draft = '';
		follow = true;
		play(chatId, reply.id, respond(prompt));
	}

	function regenerate(chatId: number, messageId: number, prompt: string) {
		if (streaming) return;
		edit(chatId, messageId, (m) => ({ ...m, parts: [], streaming: true, stopped: false, model: model.name }));
		follow = true;
		play(chatId, messageId, respond(prompt));
	}

	function toggleTool(chatId: number, messageId: number, partId: number) {
		editPart(chatId, messageId, partId, (p) => (p.kind === 'tool' ? { ...p, open: !p.open } : p));
	}

	function copy(message: Message) {
		const text = message.parts
			.map((p) => (p.kind === 'text' ? p.text : p.kind === 'code' ? p.code : `[${p.name}] ${p.result?.summary ?? p.error ?? ''}`))
			.join('\n\n');
		navigator.clipboard?.writeText(text);
		copiedId = message.id;
		setTimeout(() => copiedId === message.id && (copiedId = null), 1500);
	}

	function openChat(id: number | null) {
		activeId = id;
		follow = true;
	}

	function deleteChat(id: number) {
		if (streaming?.chatId === id) stop();
		chats = chats.filter((c) => c.id !== id);
		if (activeId === id) openChat(null);
		menu = null;
	}

	function jumpToLatest() {
		follow = true;
		bottom?.scrollIntoView({ block: 'end', behavior: 'smooth' });
	}

	function toggleMenu(next: Menu, event: Event) {
		event.stopPropagation();
		if (menu?.key === next.key) {
			menu = null;
			return;
		}
		// The button that opened it: what the menu is anchored to.
		menu = { ...next, trigger: event.currentTarget as HTMLElement };
		menuRow = null;
	}

	// Paragraphs and "- " bullets, one block per line.
	function blocks(text: string) {
		return text
			.split('\n')
			.map((line, i) => (line.startsWith('- ') ? { key: i, kind: 'li', text: line.slice(2) } : { key: i, kind: 'p', text: line }))
			.filter((b) => b.text.trim() !== '');
	}

	const caret = (message: Message, part: Part) =>
		message.streaming && message.parts[message.parts.length - 1] === part ? '▍' : '';

	const seconds = (part: Extract<Part, { kind: 'tool' }>) =>
		`${(Math.max(0, part.status === 'running' ? now - part.startedAt : part.ms) / 1000).toFixed(1)}s`;

	$effect(() => {
		if (!streaming) return;
		const id = setInterval(() => (now = Date.now()), 100);
		return () => clearInterval(id);
	});

	// Re-runs on every change to the open conversation, including each streamed
	// chunk. It waits a frame so the scroll lands after the new content is laid out.
	$effect(() => {
		void activeChat;
		const end = bottom;
		if (!follow || !end) return;
		const frame = requestAnimationFrame(() => end.scrollIntoView({ block: 'end' }));
		return () => cancelAnimationFrame(frame);
	});

	$effect(() => {
		void activeId;
		composer?.focus();
	});

	// A press outside the open menu and the button that opened it closes it.
	$effect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!menu || menuEl?.contains(target) || menu.trigger?.contains(target)) return;
			menu = null;
		};
		const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (menu = null);
		window.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('keydown', onKey);
		};
	});

	$effect(() => {
		document.title = activeChat ? `${activeChat.title} · Atlas` : 'Atlas';
	});

	const ink = '#1f1f1d';
	const muted = '#6f6f69';
	const faint = '#a3a39c';
	const line = '#e9e8e4';
	const accent = '#c96442';
	const mono = 'Menlo';

	const row = $style({ flexDirection: 'row', alignItems: 'center' });
	const spacer = $style({ width: 'fill' });
	const divider = $style({ width: 'fill', height: 1, background: line });
	const column = $style({ width: 'fill', maxWidth: 760 });

	const sidebarItem = $style({
		width: 'fill',
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		padding: [8, 10],
		borderRadius: 8,
		fontSize: 14,
		color: '#3d3d3a'
	});
	const avatar = (color: string, size: number) =>
		$style({
			width: size,
			height: size,
			borderRadius: size / 2,
			background: color,
			alignItems: 'center',
			justifyContent: 'center',
			color: '#ffffff',
			fontSize: size * 0.46,
			fontWeight: 600
		});
	const bubble = $style({
		maxWidth: 560,
		padding: [10, 16],
		borderRadius: [18, 18, 4, 18],
		background: '#f0efeb',
		lineHeight: 24
	});
	const prose = $style({ width: 'fill', lineHeight: 26, color: ink });

	const toolCard = $style({
		width: 'fill',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: line,
		background: '#fbfbf9',
		overflow: 'hidden'
	});
	const badge = $style({
		width: 18,
		height: 18,
		borderRadius: 9,
		alignItems: 'center',
		justifyContent: 'center',
		color: '#ffffff',
		fontSize: 10,
		fontWeight: 800
	});
	const badgeColor = { running: '#e0a32e', done: '#3f9b6f', error: '#d14b3c', cancelled: '#b4b3ad' };
	const badgeMark = { running: '', done: '✓', error: '!', cancelled: '–' };
	const caption = $style({ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: faint });
	const monoBox = $style({
		width: 'fill',
		padding: [10, 12],
		borderRadius: 8,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontFamily: mono,
		fontSize: 12,
		lineHeight: 18,
		color: '#3d3d3a'
	});
	const cell = $style({ width: 'fill', fontSize: 13, lineHeight: 18 });
	const action = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [4, 0],
		fontSize: 12.5,
		fontWeight: 500,
		color: muted
	});
	const pillButton = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [4, 10],
		borderRadius: 999,
		fontSize: 12.5,
		color: muted
	});
	const popover = $style({
		position: 'absolute',
		padding: 4,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		color: ink,
		fontSize: 14,
		boxShadow: [
			{ y: 2, blur: 4, color: '#1f1f1d0f' },
			{ y: 12, blur: 32, spread: -8, color: '#1f1f1d33' }
		]
	});
	const popoverRow = $style({ width: 'fill', flexDirection: 'row', alignItems: 'center', gap: 10, padding: [8, 10], borderRadius: 8 });
</script>

<main style={{ width: 'fill', height: 'fill', flexDirection: 'row', color: ink, fontSize: 15 }}>
	<!-- Sidebar -->
	<div style={{ width: 264, height: 'fill', background: '#f7f6f3', padding: [16, 12], gap: 16 }}>
		<div style={[row, { gap: 10, padding: [2, 8] }]}>
			<div style={[avatar(accent, 26), { borderRadius: 8, fontSize: 14 }]}>✦</div>
			<p style={{ fontSize: 17, fontWeight: 650, letterSpacing: -0.3 }}>Atlas</p>
		</div>

		<button
			style={[
				sidebarItem,
				{ borderWidth: 1, borderColor: line, background: '#ffffff', fontWeight: 500, boxShadow: { y: 1, blur: 2, color: '#1f1f1d0d' } }
			]}
			onclick={() => openChat(null)}
		>
			<span style={{ fontSize: 17, lineHeight: 18, color: muted }}>+</span>
			<span>New chat</span>
		</button>

		<div style={{ width: 'fill', height: 'fill', gap: 4 }}>
		<p style={[caption, { margin: [4, 10] }]}>RECENT</p>
		<div style={{ width: 'fill', height: 'fill', overflowY: 'auto', gap: 2 }}>
			{#each chats as chat (chat.id)}
				<div
					style={[
						sidebarItem,
						{ padding: [4, 4, 4, 10] },
						hoveredChat === chat.id && { background: '#efeeea' },
						activeId === chat.id && { background: '#e9e7e1', color: ink, fontWeight: 500 }
					]}
					onclick={() => openChat(chat.id)}
					onpointerenter={() => (hoveredChat = chat.id)}
					onpointerleave={() => hoveredChat === chat.id && (hoveredChat = null)}
				>
					<p style={{ width: 'fill' }}>{chat.title}</p>
					{#if hoveredChat === chat.id || menu?.chatId === chat.id}
						<button
							style={[
								{ width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center', color: muted, fontSize: 15 },
								menu?.chatId === chat.id && { background: '#dddbd4' }
							]}
							onclick={(e: Event) => toggleMenu({ kind: 'chat', key: `chat-${chat.id}`, chatId: chat.id }, e)}
						>
							⋯
						</button>
					{:else if streaming?.chatId === chat.id}
						<div style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
							<div style={[badge, { width: 8, height: 8, background: badgeColor.running }]}></div>
						</div>
					{:else}
						<div style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
							<p style={{ fontSize: 12, color: faint, fontWeight: 400 }}>{chat.when}</p>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		</div>

		<div style={[row, { width: 'fill', gap: 10, padding: [8, 8] }]}>
			<div style={avatar('#5e6ad2', 30)}>MO</div>
			<div style={{ gap: 2 }}>
				<p style={{ fontSize: 14, fontWeight: 500 }}>Mara Okafor</p>
				<p style={{ fontSize: 12, color: muted }}>Northwind · Team plan</p>
			</div>
		</div>
	</div>
	<div style={{ width: 1, height: 'fill', background: line }}></div>

	<!-- Conversation -->
	<div style={{ width: 'fill', height: 'fill' }}>
		<div style={[row, { width: 'fill', gap: 10, padding: [12, 24] }]}>
			<p style={{ fontSize: 15, fontWeight: 600 }}>{activeChat ? activeChat.title : 'New chat'}</p>
			<div style={spacer}></div>
			<button
				bind:this={modelButton}
				style={[pillButton, { borderWidth: 1, borderColor: line }, menu?.kind === 'model' && { background: '#f3f2ee' }]}
				onclick={(e: Event) => toggleMenu({ kind: 'model', key: 'model' }, e)}
			>
				<div style={[badge, { width: 7, height: 7, background: streaming ? badgeColor.running : badgeColor.done }]}></div>
				<span style={{ color: ink, fontWeight: 500 }}>{model.name}</span>
				<span style={{ fontSize: 10 }}>▾</span>
			</button>
		</div>
		<div style={divider}></div>

		{#if activeChat}
			<div
				style={{ width: 'fill', height: 'fill', flexDirection: 'row', justifyContent: 'center', overflowY: 'auto', padding: [0, 32] }}
				onwheel={(e: WheelEvent) => e.deltaY < 0 && (follow = false)}
			>
				<div style={[column, { gap: 28, padding: [32, 0, 24, 0], marginTop: 'auto' }]}>
					{#each activeChat.messages as message, i (message.id)}
						{#if message.role === 'user'}
							<div style={[row, { width: 'fill', justifyContent: 'end' }]}>
								<div style={[bubble, message.text.length > 60 && { width: 520 }]}>
									<p style={{ width: message.text.length > 60 ? 'fill' : 'hug' }}>{message.text}</p>
								</div>
							</div>
						{:else}
							<div style={{ width: 'fill', flexDirection: 'row', gap: 14 }}>
								<div style={[avatar(accent, 28), { borderRadius: 8, fontSize: 14 }]}>✦</div>
								<div style={{ width: 'fill', gap: 14, paddingTop: 1 }}>
									{#if message.streaming && message.parts.length === 0}
										<div style={[row, { gap: 8, height: 26 }]}>
											{#each [0, 1, 2] as n (n)}
												<div
													style={[
														badge,
														{ width: 6, height: 6, background: faint, opacity: Math.floor(now / 250) % 3 === n ? 1 : 0.35 }
													]}
												></div>
											{/each}
											<p style={{ fontSize: 14, color: muted }}>{message.model === 'Atlas 2 Pro' ? 'Thinking it through' : 'Thinking'}</p>
										</div>
									{/if}

									{#each message.parts as part (part.id)}
										{#if part.kind === 'text'}
											<div style={{ width: 'fill', gap: 10 }}>
												{#each blocks(part.text + caret(message, part)) as block (block.key)}
													{#if block.kind === 'li'}
														<div style={{ width: 'fill', flexDirection: 'row', gap: 10, paddingLeft: 4 }}>
															<div style={{ width: 5, height: 5, borderRadius: 3, background: ink, marginTop: 11 }}></div>
															<p style={prose}>{block.text}</p>
														</div>
													{:else}
														<p style={prose}>{block.text}</p>
													{/if}
												{/each}
											</div>
										{:else if part.kind === 'code'}
											<div style={{ width: 'fill', borderRadius: 12, background: '#22211f', overflow: 'hidden' }}>
												<div style={[row, { width: 'fill', padding: [8, 14], background: '#2c2b28' }]}>
													<p style={{ fontSize: 12, color: '#a8a69f', fontFamily: mono }}>{part.lang}</p>
												</div>
												<div style={{ width: 'fill', padding: [12, 14] }}>
													<p style={{ width: 'fill', fontFamily: mono, fontSize: 13, lineHeight: 20, color: '#ecebe6' }}>
														{part.code}{caret(message, part)}
													</p>
												</div>
											</div>
										{:else}
											<div style={toolCard}>
												<button
													style={[row, { width: 'fill', gap: 10, padding: [10, 14] }]}
													onclick={() => toggleTool(activeChat!.id, message.id, part.id)}
												>
													<div
														style={[
															badge,
															{ background: badgeColor[part.status] },
															part.status === 'running' && { opacity: 0.45 + 0.55 * Math.abs(Math.sin(now / 280)) }
														]}
													>
														{badgeMark[part.status]}
													</div>
													<p style={{ fontFamily: mono, fontSize: 13, fontWeight: 600 }}>{part.name}</p>
													<p
														style={{
															width: 'fill',
															fontSize: 13,
															color: part.status === 'error' ? badgeColor.error : muted
														}}
													>
														{part.status === 'running'
															? 'Running…'
															: part.status === 'cancelled'
																? 'Cancelled'
																: part.error ?? part.result?.summary}
													</p>
													<p style={{ fontFamily: mono, fontSize: 12, color: faint }}>{seconds(part)}</p>
													<p style={{ width: 12, fontSize: 11, color: faint, textAlign: 'center' }}>{part.open ? '▾' : '▸'}</p>
												</button>

												{#if part.open}
													<div style={divider}></div>
													<div style={{ width: 'fill', gap: 8, padding: [12, 14, 14, 14] }}>
														<p style={caption}>INPUT</p>
														<div style={monoBox}>
															<p style={{ width: 'fill' }}>{part.args}</p>
														</div>
														{#if part.error}
															<p style={[caption, { marginTop: 4 }]}>ERROR</p>
															<div style={[monoBox, { background: '#fdf3f1', borderColor: '#f3d3cc', color: '#a63a2d' }]}>
																<p style={{ width: 'fill' }}>{part.error}</p>
															</div>
														{:else if part.result}
															<p style={[caption, { marginTop: 4 }]}>OUTPUT</p>
															{#if part.result.rows}
																<div style={[monoBox, { padding: 0, fontFamily: 'Inter', overflow: 'hidden' }]}>
																	<div style={[row, { width: 'fill', gap: 12, padding: [8, 12], background: '#f6f5f1' }]}>
																		{#each part.result.columns ?? [] as heading, c (c)}
																			<p style={[cell, { fontSize: 12, fontWeight: 600, color: muted }]}>{heading}</p>
																		{/each}
																	</div>
																	{#each part.result.rows as cells, r (r)}
																		<div style={divider}></div>
																		<div style={[row, { width: 'fill', gap: 12, padding: [8, 12] }]}>
																			{#each cells as value, c (c)}
																				<p style={[cell, { color: ink }]}>{value}</p>
																			{/each}
																		</div>
																	{/each}
																</div>
															{:else}
																<div style={monoBox}>
																	<p style={{ width: 'fill' }}>{part.result.text}</p>
																</div>
															{/if}
														{/if}
													</div>
												{/if}
											</div>
										{/if}
									{/each}

									{#if !message.streaming}
										<div style={[row, { gap: 16 }]}>
											<button style={action} onclick={() => copy(message)}>{copiedId === message.id ? 'Copied' : 'Copy'}</button>
											{#if i === activeChat.messages.length - 1 && !streaming}
												<button style={action} onclick={() => regenerate(activeChat!.id, message.id, activeChat!.messages[i - 1].text)}>
													Regenerate
												</button>
											{/if}
											{#if message.stopped}
												<p style={{ fontSize: 12.5, color: faint }}>Stopped</p>
											{/if}
											<p style={{ fontSize: 12.5, color: faint }}>{message.model}</p>
										</div>
									{/if}
								</div>
							</div>
						{/if}
					{/each}
					<div bind:this={bottom}></div>
				</div>
			</div>
		{:else}
			<div style={{ width: 'fill', height: 'fill', alignItems: 'center', justifyContent: 'center', gap: 28, padding: 32 }}>
				<div style={{ alignItems: 'center', gap: 10 }}>
					<div style={[avatar(accent, 44), { borderRadius: 14, fontSize: 22 }]}>✦</div>
					<p style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.6, marginTop: 6 }}>Good afternoon, Mara</p>
					<p style={{ color: muted }}>Responses are simulated locally. Pick a prompt to watch Atlas stream and use tools.</p>
				</div>
				<div style={{ width: 624, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
					{#each suggestions as suggestion (suggestion.title)}
						<button
							style={{
								width: 306,
								gap: 4,
								padding: [14, 16],
								borderRadius: 12,
								borderWidth: 1,
								borderColor: hoveredSuggestion === suggestion.title ? '#d3d1ca' : line,
								background: hoveredSuggestion === suggestion.title ? '#fbfaf8' : '#ffffff'
							}}
							onclick={() => send(suggestion.prompt, suggestion.title)}
							onpointerenter={() => (hoveredSuggestion = suggestion.title)}
							onpointerleave={() => hoveredSuggestion === suggestion.title && (hoveredSuggestion = null)}
						>
							<p style={{ fontSize: 14, fontWeight: 600 }}>{suggestion.title}</p>
							<p style={{ fontSize: 13, color: muted }}>{suggestion.detail}</p>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Composer -->
		<div style={{ width: 'fill', flexDirection: 'row', justifyContent: 'center', padding: [0, 32, 16, 32] }}>
			<div style={[column, { gap: 8, alignItems: 'center' }]}>
				<div
					bind:this={composerBox}
					style={{
						width: 'fill',
						gap: 6,
						padding: [14, 12, 10, 18],
						borderRadius: 18,
						borderWidth: 1,
						borderColor: '#dedcd6',
						background: '#ffffff',
						boxShadow: [
							{ y: 1, blur: 2, color: '#1f1f1d0d' },
							{ y: 8, blur: 24, spread: -12, color: '#1f1f1d26' }
						]
					}}
				>
					<textarea
						style={{ width: 'fill', height: 46, lineHeight: 22, paddingRight: 6 }}
						placeholder={activeChat ? 'Reply to Atlas…' : 'Ask Atlas anything…'}
						bind:value={draft}
						bind:this={composer}
						onkeydown={(e: KeyboardEvent) => {
							if (e.key !== 'Enter' || e.shiftKey) return;
							e.preventDefault();
							send(draft);
						}}
					></textarea>
					<div style={[row, { width: 'fill', gap: 8 }]}>
						<button
							bind:this={toolsButton}
							style={[pillButton, { background: menu?.kind === 'tools' ? '#e9e7e1' : '#f3f2ee' }]}
							onclick={(e: Event) => toggleMenu({ kind: 'tools', key: 'tools' }, e)}
						>
							<span style={{ fontFamily: mono, fontSize: 11 }}>{'{ }'}</span>
							<span>{tools.length} tools</span>
						</button>
						<p style={{ fontSize: 12.5, color: faint }}>Shift + Enter for a new line</p>
						<div style={spacer}></div>
						{#if streaming}
							<button style={[avatar(ink, 34), { fontSize: 11 }]} onclick={stop}>■</button>
						{:else}
							<button
								style={[avatar(canSend ? ink : '#d9d8d2', 34), { fontSize: 17 }]}
								disabled={!canSend}
								onclick={() => send(draft)}
							>
								↑
							</button>
						{/if}
					</div>
				</div>
				<p style={{ fontSize: 12, color: faint }}>Atlas is a demo. Every answer and tool result is scripted.</p>
			</div>
		</div>
	</div>

	{#if streamingHere && !follow}
		<button
			portal="overlay"
			style={[
				pillButton,
				{
					position: 'absolute',
					anchor: composerBox,
					anchorPosition: 'top',
					anchorOffset: 12,
					padding: [7, 14],
					background: ink,
					color: '#ffffff',
					fontWeight: 500,
					boxShadow: { y: 4, blur: 12, color: '#1f1f1d40' }
				}
			]}
			onclick={jumpToLatest}
		>
			↓ Jump to latest
		</button>
	{/if}

	{#if menu}
		<div
			portal="overlay"
			bind:this={menuEl}
			style={[
				popover,
				menu.kind === 'model' && { anchor: modelButton, anchorPosition: 'bottom-end', anchorOffset: 6, width: 280 },
				menu.kind === 'tools' && { anchor: toolsButton, anchorPosition: 'top-start', anchorOffset: 8, width: 320 },
				menu.kind === 'chat' && { anchor: menu.trigger, anchorPosition: 'right-start', anchorOffset: 6, width: 180 }
			]}
		>
			{#if menu.kind === 'model'}
				{#each models as option (option.id)}
					<button
						style={[popoverRow, menuRow === option.id && { background: '#f3f2ee' }]}
						onclick={() => {
							modelId = option.id;
							menu = null;
						}}
						onpointerenter={() => (menuRow = option.id)}
					>
						<div style={{ width: 'fill', gap: 2 }}>
							<p style={{ fontWeight: 500 }}>{option.name}</p>
							<p style={{ fontSize: 12.5, color: muted }}>{option.detail}</p>
						</div>
						<p style={{ width: 14, color: accent, fontWeight: 700 }}>{option.id === modelId ? '✓' : ''}</p>
					</button>
				{/each}
			{:else if menu.kind === 'tools'}
				<div style={{ padding: [8, 10, 6, 10] }}>
					<p style={caption}>AVAILABLE TOOLS</p>
				</div>
				<div style={{ width: 'fill', maxHeight: 300, overflowY: 'auto' }}>
					{#each tools as tool (tool.name)}
						<div style={[popoverRow, { padding: [6, 10], gap: 2, flexDirection: 'column', alignItems: 'start' }]}>
							<p style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600 }}>{tool.name}</p>
							<p style={{ fontSize: 12.5, color: muted }}>{tool.detail}</p>
						</div>
					{/each}
				</div>
			{:else}
				<button
					style={[popoverRow, { color: '#c0392b' }, menuRow === 'delete' && { background: '#fbefec' }]}
					onclick={() => deleteChat(menu!.chatId!)}
					onpointerenter={() => (menuRow = 'delete')}
				>
					Delete chat
				</button>
			{/if}
		</div>
	{/if}
</main>
<portal id="overlay" />
