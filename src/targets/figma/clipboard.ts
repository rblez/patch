// Puts a Figma payload on the system clipboard as HTML, the type Figma reads
// on paste. Plain-text tools like `pbcopy` are not enough:
//
// - macOS: `public.html` on the general pasteboard, set through AppKit via
//   osascript's JavaScript bridge, then read back.
// - Linux: `wl-copy --type text/html` (Wayland) or `xclip -t text/html` (X11).
// - Windows: PowerShell's `Set-Clipboard -AsHtml`, which writes the CF_HTML format.

const JXA = `
ObjC.import('AppKit');
function run() {
	const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	const html = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
	const board = $.NSPasteboard.generalPasteboard;
	board.clearContents;
	if (!board.setStringForType(html, $.NSPasteboardTypeHTML)) throw new Error('the pasteboard refused the HTML');
	const back = board.stringForType($.NSPasteboardTypeHTML);
	return back.isNil() ? 0 : back.length;
}
`;

// Windows PowerShell 5.1 ships with every Windows 10/11; `-AsHtml` was dropped in PowerShell 7.
const POWERSHELL = `$html = [Console]::In.ReadToEnd(); Set-Clipboard -Value $html -AsHtml`;

async function run(cmd: string[], input: string) {
	const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	proc.stdin.write(input);
	await proc.stdin.end();
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`Could not write the clipboard: ${err.trim() || `${cmd[0]} exited with ${code}`}`);
	return out;
}

export async function copyFigmaClipboard(html: string) {
	if (process.platform === 'darwin') {
		const out = await run(['osascript', '-l', 'JavaScript', '-e', JXA], html);
		if (Number(out.trim()) !== html.length) throw new Error('The clipboard did not keep the snapshot');
	} else if (process.platform === 'linux') {
		if (process.env.WAYLAND_DISPLAY && Bun.which('wl-copy')) await run(['wl-copy', '--type', 'text/html'], html);
		else if (Bun.which('xclip')) await run(['xclip', '-selection', 'clipboard', '-t', 'text/html'], html);
		else throw new Error('Copying to the clipboard needs wl-copy (Wayland) or xclip (X11)');
	} else if (process.platform === 'win32') {
		if (!Bun.which('powershell')) throw new Error('Copying to the clipboard needs Windows PowerShell (powershell.exe)');
		await run(['powershell', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL], html);
	} else throw new Error(`patch snapshot cannot write the clipboard on ${process.platform}`);
}
