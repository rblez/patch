export type Status = 'todo' | 'progress' | 'done';
export type Priority = 0 | 1 | 2 | 3 | 4;

export type Label = { id: string; name: string; color: string };
export type Member = { id: string; name: string; initials: string; color: string };
export type Issue = {
	id: number;
	title: string;
	status: Status;
	priority: Priority;
	labels: string[];
	assignee: string | null;
};

export const statuses: { id: Status; name: string; color: string }[] = [
	{ id: 'todo', name: 'Todo', color: '#a1a1aa' },
	{ id: 'progress', name: 'In progress', color: '#f0b100' },
	{ id: 'done', name: 'Complete', color: '#5e6ad2' }
];

export const priorities: { id: Priority; name: string }[] = [
	{ id: 1, name: 'Urgent' },
	{ id: 2, name: 'High' },
	{ id: 3, name: 'Medium' },
	{ id: 4, name: 'Low' },
	{ id: 0, name: 'No priority' }
];

export const labelColors = ['#eb5757', '#f2994a', '#f2c94c', '#4cb782', '#26b5ce', '#4ea7fc', '#5e6ad2', '#bb87fc', '#e46bb6', '#95a2b3'];

export const members: Member[] = [
	{ id: 'mara', name: 'Mara Okafor', initials: 'MO', color: '#5e6ad2' },
	{ id: 'jun', name: 'Jun Park', initials: 'JP', color: '#26b5ce' },
	{ id: 'lena', name: 'Lena Fischer', initials: 'LF', color: '#e46bb6' },
	{ id: 'theo', name: 'Theo Alvarez', initials: 'TA', color: '#f2994a' },
	{ id: 'sam', name: 'Sam Whitlock', initials: 'SW', color: '#4cb782' }
];

export const initialLabels: Label[] = [
	{ id: 'bug', name: 'Bug', color: '#eb5757' },
	{ id: 'feature', name: 'Feature', color: '#bb87fc' },
	{ id: 'improvement', name: 'Improvement', color: '#4ea7fc' },
	{ id: 'design', name: 'Design', color: '#f2994a' },
	{ id: 'performance', name: 'Performance', color: '#26b5ce' },
	{ id: 'infra', name: 'Infra', color: '#4cb782' },
	{ id: 'docs', name: 'Docs', color: '#95a2b3' }
];

export const initialIssues: Issue[] = [
	{ id: 231, title: 'Checkout button stays disabled after fixing a card error', status: 'todo', priority: 1, labels: ['bug'], assignee: 'jun' },
	{ id: 228, title: 'Add CSV export to the invoices table', status: 'todo', priority: 3, labels: ['feature'], assignee: 'lena' },
	{ id: 226, title: 'Empty states for projects with no activity', status: 'todo', priority: 4, labels: ['design', 'improvement'], assignee: 'mara' },
	{ id: 224, title: 'Rate limit the public search endpoint', status: 'todo', priority: 2, labels: ['infra'], assignee: 'theo' },
	{ id: 221, title: 'Document webhook retry behaviour and signatures', status: 'todo', priority: 3, labels: ['docs'], assignee: null },
	{ id: 219, title: 'Dashboard takes 4s to load for workspaces with 10k+ issues', status: 'todo', priority: 2, labels: ['performance', 'bug'], assignee: 'sam' },
	{ id: 217, title: 'Keyboard shortcut cheat sheet', status: 'todo', priority: 0, labels: ['feature', 'design'], assignee: null },
	{ id: 214, title: 'Timezone is ignored when scheduling reminders', status: 'todo', priority: 2, labels: ['bug'], assignee: 'jun' },

	{ id: 229, title: 'Redesign the onboarding checklist', status: 'progress', priority: 2, labels: ['design', 'feature'], assignee: 'mara' },
	{ id: 225, title: 'Migrate background jobs to the new queue', status: 'progress', priority: 2, labels: ['infra', 'performance'], assignee: 'theo' },
	{ id: 222, title: 'Inline editing for issue titles', status: 'progress', priority: 3, labels: ['improvement'], assignee: 'lena' },
	{ id: 218, title: 'Avatar uploads fail for HEIC images', status: 'progress', priority: 1, labels: ['bug'], assignee: 'sam' },
	{ id: 215, title: 'Virtualise long comment threads', status: 'progress', priority: 3, labels: ['performance'], assignee: 'jun' },
	{ id: 212, title: 'API reference for the v2 endpoints', status: 'progress', priority: 4, labels: ['docs'], assignee: 'lena' },

	{ id: 223, title: 'Dark mode for the settings pages', status: 'done', priority: 3, labels: ['design', 'improvement'], assignee: 'mara' },
	{ id: 220, title: 'Session expires while a long form is open', status: 'done', priority: 2, labels: ['bug'], assignee: 'theo' },
	{ id: 216, title: 'Slack notifications for assigned issues', status: 'done', priority: 3, labels: ['feature'], assignee: 'jun' },
	{ id: 213, title: 'Cache workspace permissions per request', status: 'done', priority: 2, labels: ['performance', 'infra'], assignee: 'sam' },
	{ id: 211, title: 'Typo in the password reset email', status: 'done', priority: 4, labels: ['bug', 'docs'], assignee: null },
	{ id: 209, title: 'Bulk select issues with shift-click', status: 'done', priority: 3, labels: ['improvement'], assignee: 'lena' }
];
