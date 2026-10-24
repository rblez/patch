// Scripted assistant turns. Each scenario is a list of steps the chat plays
// back: text and code stream in token by token, tools run for `ms` and then
// resolve with a fake result (or fail with `error`).

export type ToolResult = { summary: string; columns?: string[]; rows?: string[][]; text?: string };

export type ToolStep = {
	kind: 'tool';
	name: string;
	args: Record<string, unknown>;
	ms: number;
	result?: ToolResult;
	error?: string;
	open?: boolean;
};

export type Step =
	| { kind: 'text'; text: string }
	| { kind: 'code'; lang: string; code: string }
	| ToolStep
	| { kind: 'parallel'; tools: ToolStep[] };

export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled';

export type Part =
	| { id: number; kind: 'text'; text: string }
	| { id: number; kind: 'code'; lang: string; code: string }
	| {
			id: number;
			kind: 'tool';
			name: string;
			args: string;
			status: ToolStatus;
			startedAt: number;
			ms: number;
			result: ToolResult | null;
			error: string | null;
			open: boolean;
	  };

export type Message = {
	id: number;
	role: 'user' | 'assistant';
	text: string;
	parts: Part[];
	streaming: boolean;
	stopped: boolean;
	model: string;
};

export type Chat = { id: number; title: string; when: string; messages: Message[] };

let seq = 0;
export const uid = () => ++seq;

export const toolPart = (step: ToolStep, startedAt: number): Part => ({
	id: uid(),
	kind: 'tool',
	name: step.name,
	args: Object.entries(step.args)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join('\n'),
	status: 'running',
	startedAt,
	ms: 0,
	result: null,
	error: null,
	open: step.open ?? false
});

/** The parts a scenario leaves behind once it has played to the end. */
export function finished(steps: Step[]): Part[] {
	return steps.flatMap((step): Part[] => {
		if (step.kind === 'text') return [{ id: uid(), kind: 'text', text: step.text }];
		if (step.kind === 'code') return [{ id: uid(), kind: 'code', lang: step.lang, code: step.code }];
		const tools = step.kind === 'parallel' ? step.tools : [step];
		return tools.map((tool) => ({
			...(toolPart(tool, 0) as Extract<Part, { kind: 'tool' }>),
			status: tool.error ? 'error' : 'done',
			ms: tool.ms,
			result: tool.result ?? null,
			error: tool.error ?? null
		}));
	});
}

const weather: Step[] = [
	{
		kind: 'tool',
		name: 'get_weather',
		args: { location: 'Lisbon, Portugal', start: '2026-10-24', days: 3, units: 'metric' },
		ms: 1400,
		open: true,
		result: {
			summary: '3-day forecast for Lisbon',
			columns: ['Day', 'Conditions', 'High', 'Low', 'Rain'],
			rows: [
				['Sat 24', 'Sunny', '23°', '15°', '0%'],
				['Sun 25', 'Partly cloudy, breezy', '21°', '14°', '10%'],
				['Mon 26', 'Showers', '18°', '13°', '70%']
			]
		}
	},
	{
		kind: 'text',
		text: 'Saturday is the pick of the weekend: sunny and 23°C with almost no wind. Sunday stays dry but the northerly picks up to around 18 km/h, so it will feel cooler by the water. Monday turns wet, with showers most of the day.\n\n- Saturday: Belém and the riverfront, then sunset at Miradouro da Senhora do Monte.\n- Sunday: a day trip to Sintra. Pack a layer, it runs 3 to 4 degrees cooler in the hills.\n- Monday: keep it indoors. The Gulbenkian and the National Tile Museum are both open.'
	}
];

const analytics: Step[] = [
	{ kind: 'text', text: "I'll pull weekly signups from the warehouse, then break this week down by channel." },
	{
		kind: 'tool',
		name: 'query_database',
		args: {
			database: 'analytics',
			sql: "SELECT date_trunc('week', created_at) AS week, count(*) AS signups FROM users WHERE created_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1"
		},
		ms: 1600,
		result: { summary: '2 rows in 41 ms', columns: ['Week', 'Signups'], rows: [['2026-10-12', '1,842'], ['2026-10-19', '2,317']] }
	},
	{
		kind: 'tool',
		name: 'query_database',
		args: {
			database: 'analytics',
			sql: "SELECT channel, count(*) FILTER (WHERE week = '2026-10-12') AS last_week, count(*) FILTER (WHERE week = '2026-10-19') AS this_week FROM signups_by_channel GROUP BY 1 ORDER BY 3 DESC"
		},
		ms: 2100,
		open: true,
		result: {
			summary: '5 rows in 63 ms',
			columns: ['Channel', 'Last week', 'This week', 'Change'],
			rows: [
				['Organic search', '712', '798', '+12.1%'],
				['Paid social', '401', '655', '+63.3%'],
				['Referral', '388', '402', '+3.6%'],
				['Direct', '251', '297', '+18.3%'],
				['Partner', '90', '165', '+83.3%']
			]
		}
	},
	{
		kind: 'text',
		text: 'Signups are up 25.8% week over week, from 1,842 to 2,317. Most of the lift came from two channels:\n\n- Paid social: +254 signups (+63%), lining up with the carousel ads that launched on Tuesday.\n- Partner: +75 signups (+83%), almost all from the new Fieldnote integration listing.\n\nOrganic search grew a healthy 12%, while referral and direct held steady. Here is a draft for #growth:'
	},
	{
		kind: 'code',
		lang: 'slack',
		code: ':chart_with_upwards_trend: Weekly signups: 2,317 (+25.8% WoW)\n\n• Paid social +63%: carousel ads are working, CPA held at $14.20\n• Partner +83%: Fieldnote listing drove 71 of the 75 new partner signups\n• Organic +12%, referral and direct steady\n\nNext: keep the carousel budget doubled for one more week and watch CPA.'
	},
	{ kind: 'text', text: 'Want me to post it to #growth?' }
];

const post: Step[] = [
	{
		kind: 'tool',
		name: 'send_slack_message',
		args: { channel: '#growth', text: ':chart_with_upwards_trend: Weekly signups: 2,317 (+25.8% WoW) …', unfurl_links: false },
		ms: 1100,
		result: { summary: 'Delivered to #growth', text: 'ok: true\nchannel: C04GR0WTH\nts: 1761062418.229519\npermalink: https://northwind.slack.com/archives/C04GR0WTH/p1761062418229519' }
	},
	{ kind: 'text', text: "Posted to #growth. I'll check the thread tomorrow morning and summarise any replies about the carousel budget." }
];

const trip: Step[] = [
	{ kind: 'text', text: "I'll check flights, hotels and your calendar at the same time." },
	{
		kind: 'parallel',
		tools: [
			{
				kind: 'tool',
				name: 'search_flights',
				args: { from: 'SFO', to: 'JFK', depart: '2026-10-29', return: '2026-11-01', nonstop: true, cabin: 'economy' },
				ms: 3200,
				open: true,
				result: {
					summary: '14 nonstop round trips, from $289',
					columns: ['Airline', 'Departs', 'Arrives', 'Round trip'],
					rows: [
						['United 1532', 'Thu 13:05', '21:40', '$289'],
						['JetBlue 916', 'Thu 07:00', '15:35', '$318'],
						['Alaska 1186', 'Thu 09:15', '17:50', '$342']
					]
				}
			},
			{
				kind: 'tool',
				name: 'search_hotels',
				args: { near: 'Lower Manhattan', check_in: '2026-10-29', check_out: '2026-11-01', max_nightly: 250, min_rating: 4.3 },
				ms: 4300,
				result: {
					summary: '23 matches, 3 shown',
					columns: ['Hotel', 'Area', 'Nightly', 'Rating'],
					rows: [
						['citizenM Bowery', 'Lower East Side', '$205', '4.4'],
						['The Hoxton', 'Williamsburg', '$219', '4.6'],
						['Arlo SoHo', 'Hudson Square', '$238', '4.5']
					]
				}
			},
			{
				kind: 'tool',
				name: 'get_calendar',
				args: { from: '2026-10-29', to: '2026-11-01' },
				ms: 900,
				result: {
					summary: '2 events',
					text: 'Thu 29 Oct  10:00–10:30  1:1 with Jun (movable)\nSun 1 Nov   18:30–20:00  Dinner with Lena, Mission'
				}
			}
		]
	},
	{
		kind: 'text',
		text: 'Here is a plan that comes in well under $1,200:\n\n- Flight: United 1532, Thursday 13:05 → 21:40, $289 round trip. It leaves after your 10:00 1:1 with Jun, so nothing needs to move.\n- Hotel: The Hoxton in Williamsburg, 3 nights at $219, $657 total. It has the best rating of the three and is one stop from Manhattan on the L.\n- Total: $946, leaving about $250 for food and getting around.\n\nOne catch: you have dinner with Lena on Sunday at 18:30. The return on that fare lands at 11:55 Pacific, so you will make it with time to spare. Want me to hold the flight and hotel?'
	}
];

const explain: Step[] = [
	{
		kind: 'text',
		text: 'Both coordinate access to shared resources, but they answer different questions.\n\nA mutex answers "who owns this right now?" Exactly one thread can hold it, and only the thread that locked it should unlock it. Use it to protect a critical section, like updating a shared map.\n\nA semaphore answers "how many more may enter?" It holds a count. Any thread can acquire (decrement) or release (increment) it, and threads block when the count reaches zero. Use it to cap concurrency, like allowing at most 4 simultaneous downloads.'
	},
	{
		kind: 'code',
		lang: 'typescript',
		code: 'const downloads = new Semaphore(4);\n\nasync function fetchAll(urls: string[]) {\n  return Promise.all(urls.map(async (url) => {\n    await downloads.acquire();\n    try {\n      return await fetch(url);\n    } finally {\n      downloads.release();\n    }\n  }));\n}'
	},
	{
		kind: 'text',
		text: 'A semaphore with a count of 1 behaves a lot like a mutex, with one important difference: it has no owner. That makes it useful for signalling between threads, but it also means nothing stops the wrong thread from releasing it, so prefer a real mutex for mutual exclusion.'
	}
];

const incident: Step[] = [
	{ kind: 'text', text: 'Checking the public status endpoint first.' },
	{
		kind: 'tool',
		name: 'http_request',
		args: { method: 'GET', url: 'https://status.northwind.dev/api/v2/status.json', timeout_ms: 2500 },
		ms: 2500,
		error: 'Request timed out after 2500 ms'
	},
	{
		kind: 'text',
		text: 'The status page timed out, which is a signal on its own. Checking the internal health endpoint and the error logs instead.'
	},
	{
		kind: 'parallel',
		tools: [
			{
				kind: 'tool',
				name: 'http_request',
				args: { method: 'GET', url: 'http://api-gateway.internal/healthz?verbose=1' },
				ms: 1200,
				result: {
					summary: '200 OK · status degraded',
					text: '{\n  "status": "degraded",\n  "checks": {\n    "postgres": "ok",\n    "redis": "ok",\n    "search": "ok",\n    "payments-svc": "failing (connection refused)"\n  },\n  "region": "us-east-1"\n}'
				}
			},
			{
				kind: 'tool',
				name: 'query_logs',
				args: { service: 'api-gateway', level: 'error', since: '15m', group_by: ['status', 'route'] },
				ms: 2600,
				result: {
					summary: '1,327 errors in the last 15 minutes',
					columns: ['Count', 'Status', 'Route', 'First seen'],
					rows: [
						['1,284', '502', 'POST /v1/checkout', '14:02:11'],
						['37', '504', 'GET /v1/invoices', '14:03:40'],
						['6', '429', 'GET /v1/search', '14:09:58']
					]
				}
			}
		]
	},
	{
		kind: 'text',
		text: 'The API is partially down. Checkout is failing: payments-svc is refusing connections, and the gateway has returned 1,284 errors on POST /v1/checkout since 14:02. Invoices are seeing a few timeouts downstream of the same service. Everything else, including login and search, is healthy.\n\n- Page the payments on-call. The failures started at 14:02, two minutes after the payments-svc deploy.\n- Roll that deploy back if on-call agrees, since it is the only change in the window.\n- Post an incident on the status page once it responds. It looks like it is struggling under the extra traffic.'
	}
];

const fallback = (prompt: string): Step[] => [
	{ kind: 'text', text: "I'm a simulated assistant, so I'll run a quick search and summarise what comes back." },
	{
		kind: 'tool',
		name: 'web_search',
		args: { query: prompt, max_results: 3 },
		ms: 1500,
		result: {
			summary: '3 results',
			columns: ['Title', 'Source'],
			rows: [
				['A practical guide to getting started', 'handbook.northwind.dev'],
				['Common pitfalls and how to avoid them', 'engineering.blog'],
				['Discussion: what worked for our team', 'forum.devtalk.io']
			]
		}
	},
	{
		kind: 'text',
		text: 'The top results are general guides rather than a direct answer, so I would not lean on them. This demo has a few scripted conversations that show off streaming and tool use. Try one of these:\n\n- "What\'s the weather in Lisbon this weekend?"\n- "Compare signups this week vs last week"\n- "Plan a trip to New York next Thursday to Sunday"\n- "Is the API down?"\n- "Explain a mutex vs a semaphore"'
	}
];

/** Picks the scripted reply for a prompt. */
export function respond(prompt: string): Step[] {
	const p = prompt.toLowerCase();
	if (/^(yes|yep|sure|ok|okay|go ahead|do it|send it|post it)\b/.test(p.trim())) return post;
	if (/weather|forecast|lisbon|rain/.test(p)) return weather;
	if (/signup|sign-up|metric|growth|analytics|week over week/.test(p)) return analytics;
	if (/trip|flight|hotel|new york|travel/.test(p)) return trip;
	if (/mutex|semaphore|lock|concurren/.test(p)) return explain;
	if (/down|outage|incident|error|status|5\d\d/.test(p)) return incident;
	return fallback(prompt);
}

const user = (text: string): Message => ({ id: uid(), role: 'user', text, parts: [], streaming: false, stopped: false, model: '' });
const assistant = (steps: Step[]): Message => ({
	id: uid(),
	role: 'assistant',
	text: '',
	parts: finished(steps),
	streaming: false,
	stopped: false,
	model: 'Atlas 2'
});

export const seedChats = (): Chat[] => [
	{
		id: uid(),
		title: 'Is the API down?',
		when: '12m',
		messages: [user('Is the API down? Customers are reporting errors at checkout.'), assistant(incident)]
	},
	{
		id: uid(),
		title: 'Weekly signups for #growth',
		when: '2h',
		messages: [
			user('Compare signups this week vs last week and draft an update for #growth'),
			assistant(analytics),
			user('Yes, post it'),
			assistant(post)
		]
	},
	{
		id: uid(),
		title: 'Mutex vs. semaphore',
		when: '1d',
		messages: [user("What's the difference between a mutex and a semaphore?"), assistant(explain)]
	},
	{
		id: uid(),
		title: 'Lisbon weekend forecast',
		when: 'Mon',
		messages: [user("What's the weather in Lisbon this weekend? Trying to plan what to do each day."), assistant(weather)]
	}
];

/** `pace` scales how long tokens and tools take; `think` is the pause before the first output. */
export const models = [
	{ id: 'atlas-2', name: 'Atlas 2', detail: 'Balanced speed and depth', pace: 1, think: 700 },
	{ id: 'atlas-2-mini', name: 'Atlas 2 Mini', detail: 'Fastest replies for quick questions', pace: 0.4, think: 250 },
	{ id: 'atlas-2-pro', name: 'Atlas 2 Pro', detail: 'Thinks longer before it answers', pace: 1.3, think: 2600 }
];

export const tools = [
	{ name: 'web_search', detail: 'Search the public web' },
	{ name: 'get_weather', detail: 'Forecasts for any city' },
	{ name: 'query_database', detail: 'Read-only SQL on the analytics warehouse' },
	{ name: 'query_logs', detail: 'Search production logs' },
	{ name: 'http_request', detail: 'Call internal and public HTTP endpoints' },
	{ name: 'search_flights', detail: 'Fares and schedules' },
	{ name: 'search_hotels', detail: 'Availability and nightly rates' },
	{ name: 'get_calendar', detail: 'Your events, read-only' },
	{ name: 'send_slack_message', detail: 'Post to channels you belong to' }
];

export const suggestions = [
	{ title: 'Plan a trip to New York', detail: 'Parallel flight, hotel and calendar lookups', prompt: 'Plan a trip to New York next Thursday to Sunday, under $1,200' },
	{ title: 'Compare weekly signups', detail: 'Two SQL queries, then a Slack draft', prompt: 'Compare signups this week vs last week and draft an update for #growth' },
	{ title: 'Is the API down?', detail: 'A failed request, a retry and a diagnosis', prompt: 'Is the API down? Customers are reporting errors at checkout.' },
	{ title: 'Mutex vs. semaphore', detail: 'A plain streamed answer with code', prompt: "What's the difference between a mutex and a semaphore?" }
];
