<script lang="ts">
	import {
		initialIssues,
		initialLabels,
		labelColors,
		members,
		priorities,
		statuses,
		type Issue,
		type Label,
		type Priority,
		type Status
	} from './data.ts';

	type MenuKind = 'status' | 'priority' | 'assignee' | 'labels';
	type Menu = { kind: MenuKind; issueId: number; key: string; trigger?: HTMLElement };
	type MenuItem = {
		key: string;
		label: string;
		selected: boolean;
		pick: () => void;
		status?: Status;
		priority?: Priority;
		member?: string | null;
		color?: string;
		create?: boolean;
	};

	let issues: Issue[] = $state(initialIssues);
	let labels: Label[] = $state(initialLabels);
	let nextId = $state(232);

	let query = $state('');
	let labelFilter: string | null = $state(null);
	let selectedId: number | null = $state(null);
	let hoveredId: number | null = $state(null);

	let composerStatus: Status | null = $state(null);
	let draftTitle = $state('');

	// One dropdown at a time, rendered into the overlay portal and anchored to
	// the button that opened it.
	let menu = $state<Menu | null>(null);
	let menuQuery = $state('');
	let menuIndex = $state(0);
	let newLabelColor = $state(labelColors[6]);

	let searchInput = $state<HTMLInputElement>();
	let composerInput = $state<HTMLInputElement>();
	let menuInput = $state<HTMLInputElement>();
	let menuEl = $state<HTMLDivElement>();

	const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
	const statusById = Object.fromEntries(statuses.map((s) => [s.id, s]));
	const key = (id: number) => `ENG-${id}`;
	const placeholders: Record<MenuKind, string> = {
		status: 'Change status…',
		priority: 'Set priority…',
		assignee: 'Assign to…',
		labels: 'Change or add labels…'
	};

	let labelById = $derived(Object.fromEntries(labels.map((l) => [l.id, l])));
	let terms = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
	let filtering = $derived(terms.length > 0 || labelFilter !== null);

	function matches(issue: Issue) {
		if (labelFilter && !issue.labels.includes(labelFilter)) return false;
		const haystack = [
			key(issue.id),
			issue.title,
			...issue.labels.map((id) => labelById[id]?.name ?? ''),
			issue.assignee ? memberById[issue.assignee].name : 'unassigned'
		]
			.join(' ')
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	}

	let visible = $derived(issues.filter(matches));
	let columns = $derived(
		statuses.map((status) => ({
			...status,
			issues: visible.filter((i) => i.status === status.id),
			total: issues.filter((i) => i.status === status.id).length
		}))
	);
	let labelCounts = $derived(
		Object.fromEntries(labels.map((l) => [l.id, issues.filter((i) => i.labels.includes(l.id)).length]))
	);
	let selected = $derived(issues.find((i) => i.id === selectedId) ?? null);
	let menuIssue = $derived(menu ? (issues.find((i) => i.id === menu!.issueId) ?? null) : null);

	let menuItems = $derived.by((): MenuItem[] => {
		const issue = menuIssue;
		if (!menu || !issue) return [];
		const q = menuQuery.trim().toLowerCase();
		const match = (text: string) => text.toLowerCase().includes(q);
		if (menu.kind === 'status')
			return statuses
				.filter((s) => match(s.name))
				.map((s) => ({ key: s.id, label: s.name, selected: issue.status === s.id, status: s.id, pick: () => choose({ status: s.id }) }));
		if (menu.kind === 'priority')
			return priorities
				.filter((p) => match(p.name))
				.map((p) => ({ key: String(p.id), label: p.name, selected: issue.priority === p.id, priority: p.id, pick: () => choose({ priority: p.id }) }));
		if (menu.kind === 'assignee')
			return [{ id: null, name: 'No assignee' }, ...members]
				.filter((m) => match(m.name))
				.map((m) => ({
					key: m.id ?? 'none',
					label: m.name,
					selected: issue.assignee === m.id,
					member: m.id,
					pick: () => choose({ assignee: m.id })
				}));
		const items: MenuItem[] = labels
			.filter((l) => match(l.name))
			.map((l) => ({ key: l.id, label: l.name, selected: issue.labels.includes(l.id), color: l.color, pick: () => toggleLabel(issue, l.id) }));
		if (q && !labels.some((l) => l.name.toLowerCase() === q))
			items.push({ key: 'create', label: menuQuery.trim(), selected: false, color: newLabelColor, create: true, pick: () => createLabel(issue) });
		return items;
	});

	function update(id: number, patch: Partial<Issue>) {
		issues = issues.map((i) => (i.id === id ? { ...i, ...patch } : i));
	}

	function toggleLabel(issue: Issue, labelId: string) {
		const labels = issue.labels.includes(labelId)
			? issue.labels.filter((id) => id !== labelId)
			: [...issue.labels, labelId];
		update(issue.id, { labels });
	}

	function select(id: number) {
		selectedId = selectedId === id ? null : id;
	}

	function openComposer(status: Status) {
		composerStatus = status;
		draftTitle = '';
	}

	function createIssue() {
		const title = draftTitle.trim();
		if (!title || !composerStatus) return;
		const issue: Issue = { id: nextId, title, status: composerStatus, priority: 0, labels: [], assignee: null };
		issues = [issue, ...issues];
		nextId += 1;
		composerStatus = null;
		draftTitle = '';
		selectedId = issue.id;
	}

	function deleteIssue(id: number) {
		issues = issues.filter((i) => i.id !== id);
		selectedId = null;
		menu = null;
	}

	// `key` tells which button opened the menu; the menu is anchored to that button.
	function toggleMenu(kind: MenuKind, issueId: number, key: string, event: Event) {
		event.stopPropagation();
		if (menu?.key === key) {
			menu = null;
			return;
		}
		menu = { kind, issueId, key, trigger: event.currentTarget as HTMLElement };
		menuQuery = '';
		menuIndex = 0;
	}

	function choose(patch: Partial<Issue>) {
		if (menu) update(menu.issueId, patch);
		menu = null;
	}

	function createLabel(issue: Issue) {
		const name = menuQuery.trim();
		if (!name) return;
		const label: Label = { id: `label-${labels.length + 1}`, name, color: newLabelColor };
		labels = [...labels, label];
		update(issue.id, { labels: [...issue.labels, label.id] });
		menuQuery = '';
		menuIndex = 0;
		newLabelColor = labelColors[(labelColors.indexOf(newLabelColor) + 3) % labelColors.length];
	}

	function menuKey(event: KeyboardEvent) {
		const count = menuItems.length;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (count) menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			menuItems[Math.min(menuIndex, count - 1)]?.pick();
		}
	}

	function clearFilters() {
		query = '';
		labelFilter = null;
	}

	// Escape backs out of whatever is open, innermost first. "/" jumps to search.
	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing = (event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA';
			if (event.key === '/' && !typing) {
				event.preventDefault();
				searchInput?.focus();
			}
			if (event.key !== 'Escape') return;
			if (menu) menu = null;
			else if (composerStatus) composerStatus = null;
			else if (typing) (event.target as HTMLElement).blur();
			else selectedId = null;
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// A press outside the open dropdown and the button that opened it closes it.
	$effect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!menu || menuEl?.contains(target) || menu.trigger?.contains(target)) return;
			menu = null;
		};
		window.addEventListener('pointerdown', onPointerDown);
		return () => window.removeEventListener('pointerdown', onPointerDown);
	});

	$effect(() => composerInput?.focus());
	$effect(() => menuInput?.focus({ preventScroll: true }));

	$effect(() => {
		document.title = selected ? `${key(selected.id)} ${selected.title}` : 'Board · Engineering';
	});

	const ink = '#1b1b1f';
	const muted = '#6b6f76';
	const faint = '#9b9ea6';
	const line = '#e6e6ea';
	const accent = '#5e6ad2';

	const row = $style({ flexDirection: 'row', alignItems: 'center' });
	const spacer = $style({ width: 'fill' });
	const divider = $style({ width: 'fill', height: 1, background: line });

	const button = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [6, 10],
		borderRadius: 7,
		fontSize: 13,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const primary = $style({ background: accent, color: '#ffffff', boxShadow: { y: 1, blur: 2, color: '#1b1b1f26' } });
	const iconButton = $style({
		width: 24,
		height: 24,
		borderRadius: 6,
		alignItems: 'center',
		justifyContent: 'center',
		color: muted,
		fontSize: 15
	});

	const chip = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		padding: [4, 10],
		borderRadius: 999,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 12,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const chipActive = $style({ background: '#eef0fc', borderColor: '#c5caf3', color: '#3a43a5' });
	const pill = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 5,
		padding: [2, 8],
		borderRadius: 999,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 11.5,
		fontWeight: 500,
		color: '#3c3c43'
	});
	const dot = (color: string) => $style({ width: 8, height: 8, borderRadius: 4, background: color });

	const column = $style({
		width: 'fill',
		height: 'fill',
		minWidth: 240,
		gap: 6,
		padding: [8, 6, 0, 6],
		borderRadius: 12,
		background: '#f6f6f8'
	});
	const card = $style({
		width: 'fill',
		gap: 8,
		padding: [10, 12],
		borderRadius: 9,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		boxShadow: { y: 1, blur: 2, color: '#1b1b1f0d' }
	});
	const cardHover = $style({ borderColor: '#d3d4da', boxShadow: { y: 2, blur: 6, color: '#1b1b1f14' } });
	const cardSelected = $style({
		borderColor: accent,
		boxShadow: [
			{ spread: 2, color: '#5e6ad22e' },
			{ y: 2, blur: 6, color: '#1b1b1f14' }
		]
	});

	const ring = (status: Status) =>
		$style({
			width: 14,
			height: 14,
			borderRadius: 7,
			borderWidth: 1.5,
			borderColor: statusById[status].color,
			background: status === 'done' ? statusById[status].color : '#ffffff',
			alignItems: 'center',
			justifyContent: 'center'
		});
	const ringCore = $style({ width: 6, height: 6, borderRadius: 3, background: statusById.progress.color });
	const ringCheck = $style({ fontSize: 9, lineHeight: 10, fontWeight: 800, color: '#ffffff' });

	const priorityBox = $style({ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' });
	const urgent = $style({
		width: 14,
		height: 14,
		borderRadius: 3,
		background: '#f2994a',
		alignItems: 'center',
		justifyContent: 'center',
		color: '#ffffff',
		fontSize: 10,
		fontWeight: 800
	});
	const bars = $style({ flexDirection: 'row', alignItems: 'end', gap: 1.5, height: 12 });
	const bar = (priority: Priority, n: number) =>
		$style({
			width: 3,
			height: [6, 9, 12][n - 1],
			borderRadius: 1,
			background: priority !== 0 && n <= 5 - priority ? '#5c5f66' : '#d6d7dc'
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
			fontSize: size * 0.42,
			fontWeight: 600
		});
	const noAvatar = (size: number) =>
		$style({
			width: size,
			height: size,
			borderRadius: size / 2,
			borderWidth: 1.5,
			borderColor: '#c9cad0',
			background: '#ffffff'
		});

	const field = $style({
		width: 'fill',
		padding: [7, 10],
		borderRadius: 7,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		fontSize: 13,
		lineHeight: 18,
		color: ink
	});

	const panel = $style({
		width: 360,
		height: 'fill',
		overflowY: 'auto',
		gap: 20,
		padding: 18,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		boxShadow: { y: 1, blur: 2, color: '#1b1b1f0d' }
	});
	const property = $style({ width: 'fill', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30 });
	const propertyLabel = $style({ width: 76, fontSize: 12.5, color: muted });
	const propertyButton = $style({
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		padding: [5, 8],
		borderRadius: 6,
		fontSize: 13,
		fontWeight: 500,
		color: ink
	});
	const propertyOpen = $style({ background: '#f1f1f4' });

	const menuBox = $style({
		position: 'absolute',
		anchorPadding: 8,
		width: 248,
		maxHeight: 'available',
		borderRadius: 10,
		borderWidth: 1,
		borderColor: line,
		background: '#ffffff',
		overflowX: 'hidden',
		overflowY: 'auto',
		color: ink,
		fontSize: 13,
		boxShadow: [
			{ y: 2, blur: 4, color: '#1b1b1f0f' },
			{ y: 12, blur: 32, spread: -8, color: '#1b1b1f33' }
		]
	});
	const menuRow = $style({
		width: 'fill',
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		padding: [7, 10],
		borderRadius: 6
	});
	const checkbox = (on: boolean) =>
		$style({
			width: 14,
			height: 14,
			borderRadius: 4,
			borderWidth: on ? 0 : 1.5,
			borderColor: '#c9cad0',
			background: on ? accent : '#ffffff',
			alignItems: 'center',
			justifyContent: 'center',
			color: '#ffffff',
			fontSize: 9,
			fontWeight: 800
		});
</script>

<main style={{ width: 'fill', height: 'fill', color: ink, fontSize: 13 }}>
	<!-- Top bar -->
	<div style={[row, { width: 'fill', gap: 12, padding: [12, 24] }]}>
		<div style={[row, { gap: 8 }]}>
			<div style={[avatar(accent, 22), { borderRadius: 6, fontSize: 12, fontWeight: 700 }]}>N</div>
			<p style={{ fontWeight: 600 }}>Northwind</p>
			<p style={{ color: '#c9cad0' }}>/</p>
			<p style={{ color: muted }}>Engineering</p>
			<p style={{ color: '#c9cad0' }}>/</p>
			<p style={{ fontWeight: 500 }}>Board</p>
		</div>
		<div style={spacer}></div>
		<div style={[row, field, { width: 320, padding: [0, 6, 0, 10], gap: 6, height: 32 }]}>
			<input
				style={{ width: 'fill', fontSize: 13, color: ink }}
				placeholder="Search issues, labels, people…"
				bind:value={query}
				bind:this={searchInput}
			/>
			{#if query}
				<button style={[iconButton, { width: 20, height: 20, fontSize: 12 }]} onclick={() => (query = '')}>✕</button>
			{:else}
				<div style={{ padding: [1, 6], borderRadius: 4, borderWidth: 1, borderColor: line, fontSize: 11, color: faint }}>/</div>
			{/if}
		</div>
		<button style={[button, primary]} onclick={() => openComposer('todo')}>
			<span style={{ fontSize: 15, lineHeight: 16 }}>+</span>
			<span>New issue</span>
		</button>
	</div>
	<div style={divider}></div>

	<!-- Label filters -->
	<div style={[row, { width: 'fill', gap: 6, padding: [12, 24], flexWrap: 'wrap' }]}>
		<button style={[chip, labelFilter === null && chipActive]} onclick={() => (labelFilter = null)}>
			All issues
			<span style={{ color: faint }}>{issues.length}</span>
		</button>
		{#each labels as label (label.id)}
			<button
				style={[chip, labelFilter === label.id && chipActive]}
				onclick={() => (labelFilter = labelFilter === label.id ? null : label.id)}
			>
				<div style={dot(label.color)}></div>
				<span>{label.name}</span>
				<span style={{ color: faint }}>{labelCounts[label.id]}</span>
			</button>
		{/each}
		<div style={spacer}></div>
		{#if filtering}
			<p style={{ color: muted, fontSize: 12 }}>
				Showing <span style={{ color: ink, fontWeight: 600 }}>{visible.length}</span> of {issues.length} issues
			</p>
			<button style={[button, { padding: [4, 8], fontSize: 12, color: accent }]} onclick={clearFilters}>Clear filters</button>
		{/if}
	</div>

	<div style={[row, { width: 'fill', height: 'fill', gap: 16, padding: [0, 24, 20, 24], alignItems: 'start' }]}>
		<!-- Board: each column scrolls on its own -->
		<div style={[row, { width: 'fill', height: 'fill', gap: 12, alignItems: 'start' }]}>
			{#each columns as col (col.id)}
				<div style={column}>
					<div style={[row, { width: 'fill', gap: 8, padding: [2, 6] }]}>
						<div style={ring(col.id)}>
							{#if col.id === 'progress'}
								<div style={ringCore}></div>
							{:else if col.id === 'done'}
								<span style={ringCheck}>✓</span>
							{/if}
						</div>
						<p style={{ fontWeight: 600 }}>{col.name}</p>
						<p style={{ color: faint }}>{filtering ? `${col.issues.length} of ${col.total}` : col.total}</p>
						<div style={spacer}></div>
						<button style={iconButton} onclick={() => openComposer(col.id)}>+</button>
					</div>

					<div style={{ width: 'fill', height: 'fill', overflowY: 'auto', gap: 8, padding: [2, 2, 10, 2] }}>
						{#if composerStatus === col.id}
							<div style={[card, cardSelected, { gap: 10 }]}>
								<input
									style={[field, { borderWidth: 0, padding: 0, fontWeight: 500 }]}
									placeholder="Issue title"
									bind:value={draftTitle}
									bind:this={composerInput}
									onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && createIssue()}
								/>
								<div style={[row, { width: 'fill', gap: 6 }]}>
									<p style={{ color: faint, fontSize: 11.5 }}>Enter to create · Esc to cancel</p>
									<div style={spacer}></div>
									<button style={[button, { padding: [4, 8], fontSize: 12 }]} onclick={() => (composerStatus = null)}>
										Cancel
									</button>
									<button
										style={[button, primary, { padding: [4, 10], fontSize: 12 }, !draftTitle.trim() && { opacity: 0.5 }]}
										disabled={!draftTitle.trim()}
										onclick={createIssue}
									>
										Create
									</button>
								</div>
							</div>
						{/if}

						{#each col.issues as issue (issue.id)}
							<div
								style={[card, hoveredId === issue.id && cardHover, selectedId === issue.id && cardSelected]}
								onclick={() => select(issue.id)}
								onpointerenter={() => (hoveredId = issue.id)}
								onpointerleave={() => hoveredId === issue.id && (hoveredId = null)}
							>
								<div style={[row, { width: 'fill', gap: 8 }]}>
									<button
										style={[iconButton, { width: 18, height: 18 }, menu?.key === `status-${issue.id}` && propertyOpen]}
										onclick={(e: Event) => toggleMenu('status', issue.id, `status-${issue.id}`, e)}
									>
										<div style={ring(issue.status)}>
											{#if issue.status === 'progress'}
												<div style={ringCore}></div>
											{:else if issue.status === 'done'}
												<span style={ringCheck}>✓</span>
											{/if}
										</div>
									</button>
									<p style={{ color: faint, fontSize: 12, fontWeight: 500 }}>{key(issue.id)}</p>
									<div style={spacer}></div>
									<button
										style={{ borderRadius: 11 }}
										onclick={(e: Event) => toggleMenu('assignee', issue.id, `assignee-${issue.id}`, e)}
									>
										{#if issue.assignee}
											<div style={avatar(memberById[issue.assignee].color, 20)}>{memberById[issue.assignee].initials}</div>
										{:else}
											<div style={noAvatar(20)}></div>
										{/if}
									</button>
								</div>
								<p
									style={{
										width: 'fill',
										fontWeight: 500,
										lineHeight: 18,
										color: issue.status === 'done' ? muted : ink
									}}
								>
									{issue.title}
								</p>
								<div style={[row, { width: 'fill', gap: 6, flexWrap: 'wrap' }]}>
									<button
										style={[pill, { padding: [3, 5] }, menu?.key === `priority-${issue.id}` && propertyOpen]}
										onclick={(e: Event) => toggleMenu('priority', issue.id, `priority-${issue.id}`, e)}
									>
										{#if issue.priority === 1}
											<div style={urgent}>!</div>
										{:else}
											<div style={priorityBox}>
												<div style={bars}>
													{#each [1, 2, 3] as n (n)}
														<div style={bar(issue.priority, n)}></div>
													{/each}
												</div>
											</div>
										{/if}
									</button>
									{#if issue.labels.length > 0}
										<button
											style={[row, { gap: 6, flexWrap: 'wrap', borderRadius: 999 }]}
											onclick={(e: Event) => toggleMenu('labels', issue.id, `labels-${issue.id}`, e)}
										>
											{#each issue.labels as labelId (labelId)}
												<div style={[pill, labelFilter === labelId && chipActive]}>
													<div style={dot(labelById[labelId].color)}></div>
													<span>{labelById[labelId].name}</span>
												</div>
											{/each}
										</button>
									{/if}
								</div>
							</div>
						{/each}

						{#if col.issues.length === 0 && composerStatus !== col.id}
							<div style={{ width: 'fill', padding: [20, 12], alignItems: 'center', gap: 4 }}>
								<p style={{ color: muted, fontWeight: 500 }}>{filtering ? 'No matching issues' : 'No issues'}</p>
								<p style={{ color: faint, fontSize: 12 }}>
									{filtering ? 'Try a different search or label.' : 'Press + to add one.'}
								</p>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Issue details -->
		{#if selected}
			<div style={panel}>
				<div style={[row, { width: 'fill', gap: 8 }]}>
					<p style={{ color: muted, fontWeight: 500 }}>{key(selected.id)}</p>
					<div style={spacer}></div>
					<button style={[button, { padding: [4, 8], fontSize: 12, color: '#d14343' }]} onclick={() => deleteIssue(selected!.id)}>
						Delete
					</button>
					<button style={iconButton} onclick={() => (selectedId = null)}>✕</button>
				</div>

				<textarea
					style={{ width: 'fill', height: 50, fontSize: 17, lineHeight: 24, fontWeight: 600, color: ink }}
					value={selected.title}
					placeholder="Issue title"
					oninput={(e: Event) => update(selected!.id, { title: (e.currentTarget as HTMLTextAreaElement).value })}
				></textarea>

				<div style={{ width: 'fill', gap: 6 }}>
					<div style={property}>
						<p style={propertyLabel}>Status</p>
						<button
							style={[propertyButton, menu?.key === 'panel-status' && propertyOpen]}
							onclick={(e: Event) => toggleMenu('status', selected!.id, 'panel-status', e)}
						>
							<div style={ring(selected.status)}>
								{#if selected.status === 'progress'}
									<div style={ringCore}></div>
								{:else if selected.status === 'done'}
									<span style={ringCheck}>✓</span>
								{/if}
							</div>
							<span>{statusById[selected.status].name}</span>
						</button>
					</div>

					<div style={property}>
						<p style={propertyLabel}>Priority</p>
						<button
							style={[propertyButton, menu?.key === 'panel-priority' && propertyOpen]}
							onclick={(e: Event) => toggleMenu('priority', selected!.id, 'panel-priority', e)}
						>
							{#if selected.priority === 1}
								<div style={urgent}>!</div>
							{:else}
								<div style={priorityBox}>
									<div style={bars}>
										{#each [1, 2, 3] as n (n)}
											<div style={bar(selected.priority, n)}></div>
										{/each}
									</div>
								</div>
							{/if}
							<span>{priorities.find((p) => p.id === selected!.priority)?.name}</span>
						</button>
					</div>

					<div style={property}>
						<p style={propertyLabel}>Assignee</p>
						<button
							style={[propertyButton, menu?.key === 'panel-assignee' && propertyOpen]}
							onclick={(e: Event) => toggleMenu('assignee', selected!.id, 'panel-assignee', e)}
						>
							{#if selected.assignee}
								<div style={avatar(memberById[selected.assignee].color, 20)}>{memberById[selected.assignee].initials}</div>
								<span>{memberById[selected.assignee].name}</span>
							{:else}
								<div style={noAvatar(20)}></div>
								<span style={{ color: muted }}>Unassigned</span>
							{/if}
						</button>
					</div>

					<div style={[property, { alignItems: 'start' }]}>
						<p style={[propertyLabel, { marginTop: 7 }]}>Labels</p>
						<div style={[row, { width: 'fill', gap: 6, flexWrap: 'wrap', paddingTop: 3 }]}>
							{#each selected.labels as labelId (labelId)}
								<div style={[pill, { padding: [3, 9], fontSize: 12 }]}>
									<div style={dot(labelById[labelId].color)}></div>
									<span>{labelById[labelId].name}</span>
								</div>
							{/each}
							<button
								style={[pill, { padding: [3, 9], fontSize: 12, color: muted }, menu?.key === 'panel-labels' && chipActive]}
								onclick={(e: Event) => toggleMenu('labels', selected!.id, 'panel-labels', e)}
							>
								{selected.labels.length ? 'Edit' : '+ Add label'}
							</button>
						</div>
					</div>
				</div>

				<div style={divider}></div>
				<p style={{ width: 'fill', fontSize: 12, lineHeight: 18, color: faint }}>
					Click any status, priority, avatar or label on a card to change it in place. Press / to search, Esc to close.
				</p>
			</div>
		{/if}
	</div>

	<!-- The open dropdown, painted above everything through the overlay portal -->
	{#if menu && menuIssue}
		<div
			portal="overlay"
			bind:this={menuEl}
			style={[
				menuBox,
				{
					anchor: menu.trigger,
					anchorPosition: menu.key.startsWith('assignee-') || menu.key === 'panel-labels' ? 'bottom-end' : 'bottom-start',
					anchorOffset: 6
				}
			]}
		>
			<div style={[row, { width: 'fill', gap: 8, padding: [9, 12] }]}>
				<input
					style={{ width: 'fill', fontSize: 13, lineHeight: 18, color: ink }}
					placeholder={placeholders[menu.kind]}
					value={menuQuery}
					bind:this={menuInput}
					oninput={(e: Event) => {
						menuQuery = (e.currentTarget as HTMLInputElement).value;
						menuIndex = 0;
					}}
					onkeydown={menuKey}
				/>
				<p style={{ fontSize: 11.5, color: faint }}>{key(menuIssue.id)}</p>
			</div>
			<div style={divider}></div>
			<div style={{ width: 'fill', maxHeight: 280, overflowY: 'auto', padding: 4 }}>
				{#each menuItems as item, i (item.key)}
					<button
						style={[menuRow, i === menuIndex && { background: '#f1f1f4' }]}
						onclick={item.pick}
						onpointermove={() => (menuIndex = i)}
					>
						{#if item.create}
							<div style={dot(item.color!)}></div>
							<p style={{ width: 'fill' }}>Create label <span style={{ fontWeight: 600 }}>“{item.label}”</span></p>
						{:else}
							{#if menu.kind === 'labels'}
								<div style={checkbox(item.selected)}>{item.selected ? '✓' : ''}</div>
								<div style={dot(item.color!)}></div>
							{:else if item.status}
								<div style={ring(item.status)}>
									{#if item.status === 'progress'}
										<div style={ringCore}></div>
									{:else if item.status === 'done'}
										<span style={ringCheck}>✓</span>
									{/if}
								</div>
							{:else if menu.kind === 'priority'}
								{#if item.priority === 1}
									<div style={urgent}>!</div>
								{:else}
									<div style={priorityBox}>
										<div style={bars}>
											{#each [1, 2, 3] as n (n)}
												<div style={bar(item.priority ?? 0, n)}></div>
											{/each}
										</div>
									</div>
								{/if}
							{:else if item.member}
								<div style={avatar(memberById[item.member].color, 18)}>{memberById[item.member].initials}</div>
							{:else}
								<div style={noAvatar(18)}></div>
							{/if}
							<p style={{ width: 'fill' }}>{item.label}</p>
							{#if menu.kind === 'labels'}
								<p style={{ color: faint, fontSize: 12 }}>{labelCounts[item.key]}</p>
							{:else if item.selected}
								<p style={{ color: accent, fontSize: 12, fontWeight: 700 }}>✓</p>
							{/if}
						{/if}
					</button>
				{/each}
				{#if menuItems.length === 0}
					<div style={{ padding: [8, 10] }}><p style={{ color: faint }}>No results</p></div>
				{/if}
			</div>
			{#if menuItems.some((item) => item.create)}
				<div style={divider}></div>
				<div style={[row, { width: 'fill', gap: 6, padding: [10, 12] }]}>
					{#each labelColors as color (color)}
						<button
							style={[
								{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
								color === newLabelColor && { borderWidth: 1.5, borderColor: color }
							]}
							onclick={() => (newLabelColor = color)}
						>
							<div style={[dot(color), { width: 12, height: 12, borderRadius: 6 }]}></div>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</main>
<portal id="overlay" />
