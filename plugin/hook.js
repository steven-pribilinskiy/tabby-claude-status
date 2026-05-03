// hook.js — Claude Code hook handler (cross-platform)
// Reads hook event JSON from stdin, writes status to temp file for Tabby plugin
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const STATUS_FILE = path.join(os.tmpdir(), 'tabby-claude-status.json')

// ── Platform-specific process tree walkers ──────────────────────────

/**
 * Linux: read /proc/<pid>/stat directly — zero subprocesses, ~1ms for 6 levels.
 * Format: `pid (comm) state ppid ...`  — comm can contain `)`, so match from last `)`.
 */
function getAncestorPidsLinux(startPid, depth) {
    const pids = []
    let current = startPid
    for (let i = 0; i < depth; i++) {
        try {
            const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8')
            const match = stat.match(/\)\s+\S+\s+(\d+)/)
            const parent = match ? parseInt(match[1]) : null
            if (!parent || parent <= 1) break
            pids.push(parent)
            current = parent
        } catch (_) { break }
    }
    return pids
}

/**
 * macOS (and other Unix): `ps -o ppid= -p <pid>` per level, ~10ms/call.
 */
function getAncestorPidsDarwin(startPid, depth) {
    const pids = []
    let current = startPid
    for (let i = 0; i < depth; i++) {
        try {
            const out = execSync(`ps -o ppid= -p ${current}`, {
                encoding: 'utf8',
                timeout: 2000,
            })
            const parent = parseInt(out.trim()) || null
            if (!parent || parent <= 1) break
            pids.push(parent)
            current = parent
        } catch (_) { break }
    }
    return pids
}

/**
 * Windows: P/Invoke NtQueryInformationProcess via PowerShell Add-Type.
 * Bypasses WMI entirely — direct kernel calls, ~500ms total (PS startup + Add-Type).
 * Falls back to WMI batch query if P/Invoke fails.
 */
function getAncestorPidsWindows(startPid, depth) {
    try {
        return getAncestorPidsNtQuery(startPid, depth)
    } catch (_) {
        try {
            return getAncestorPidsWmiBatch(startPid, depth)
        } catch (__) {
            return []
        }
    }
}

/** Fast path: NtQueryInformationProcess P/Invoke (~500ms) */
function getAncestorPidsNtQuery(startPid, depth) {
    // Uses Add-Type to compile a tiny C# helper that calls NtQueryInformationProcess
    // directly from kernel32/ntdll — no WMI overhead. Passed via -EncodedCommand
    // because PowerShell stdin mode can't handle here-strings.
    const psScript = `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class PT{
[StructLayout(LayoutKind.Sequential)]struct PBI{public IntPtr R1;public IntPtr Peb;public IntPtr R2a;public IntPtr R2b;public IntPtr Pid;public IntPtr PPid;}
[DllImport("ntdll.dll")]static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI i,int l,out int r);
[DllImport("kernel32.dll")]static extern IntPtr OpenProcess(int a,bool b,int p);
[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
public static int GetPPid(int pid){
IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return -1;
PBI pbi=new PBI();int r;int s=NtQueryInformationProcess(h,0,ref pbi,Marshal.SizeOf(pbi),out r);
CloseHandle(h);return s==0?pbi.PPid.ToInt32():-1;}}
'@
$p=${startPid};for($i=0;$i -lt ${depth};$i++){$pp=[PT]::GetPPid($p);if($pp -le 1){break};Write-Output $pp;$p=$pp}
`
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
    const out = execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
    })
    return out.trim().split(/\r?\n/).filter(Boolean).map(Number).filter(n => n > 1)
}

/** Slow fallback: WMI batch query (~2s) */
function getAncestorPidsWmiBatch(startPid, depth) {
    const psScript = `& { $map = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $map[[int]$_.ProcessId] = [int]$_.ParentProcessId }; $p = ${startPid}; for ($i = 0; $i -lt ${depth}; $i++) { if (-not $map.ContainsKey($p) -or $map[$p] -le 1) { break }; $p = $map[$p]; Write-Output $p } }`
    const out = execSync('powershell.exe -NoProfile -Command -', {
        input: psScript,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
    })
    return out.trim().split(/\r?\n/).filter(Boolean).map(Number).filter(n => n > 1)
}

/**
 * Dispatcher: pick the right implementation for the current platform.
 */
function getAncestorPids(startPid, depth) {
    switch (process.platform) {
        case 'win32':  return getAncestorPidsWindows(startPid, depth)
        case 'linux':  return getAncestorPidsLinux(startPid, depth)
        default:       return getAncestorPidsDarwin(startPid, depth)
    }
}

// Exit after timeout if no stdin received (safety net)
// Windows needs more time due to PowerShell startup overhead
const safetyTimeout = process.platform === 'win32' ? 3000 : 1000
const timeout = setTimeout(() => process.exit(0), safetyTimeout)

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
    clearTimeout(timeout)
    try {
        const event = JSON.parse(input)
        const name = event.hook_event_name || 'Unknown'
        // Walk up: hook.js → Claude Code → shell → conpty/terminal → ...
        const ancestors = getAncestorPids(process.pid, 6)
        const status = {
            ts: Date.now(),
            event: name,
            session: event.session_id || '',
            ppid: process.ppid,
            ancestors: ancestors,
        }
        if (event.tool_name) status.tool = event.tool_name
        if (event.notification_type) status.type = event.notification_type
        // `cwd` is sent in the hook payload by Claude Code; capture it so the
        // plugin can spawn a restored tab in the same directory later.
        if (event.cwd) status.cwd = event.cwd
        // `transcript_path` is the JSONL session log Claude Code maintains.
        // The dynamic-phrase audio mode reads the tail of this file to derive
        // a context-aware announcement; without forwarding it we'd need a
        // separate session→path lookup on the plugin side.
        if (event.transcript_path) status.transcript_path = event.transcript_path
        fs.writeFileSync(STATUS_FILE, JSON.stringify(status))

        // Fire-and-forget seed to windows-settings so the server's
        // session→ancestors cache is populated for subsequent curl-only events.
        try {
            const https = require('https')
            const payload = JSON.stringify({
                hook_event_name: name,
                session_id: event.session_id || '',
                tool_name: event.tool_name,
                notification_type: event.notification_type,
                ancestors: ancestors,
                ppid: process.ppid,
            })
            const req = https.request('https://windows-settings.lvh.me/api/claude/hook', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                },
                rejectUnauthorized: false,
                timeout: 400,
            })
            req.on('error', () => {})
            req.on('timeout', () => req.destroy())
            req.write(payload)
            req.end()
        } catch (_) { /* server offline is fine */ }
    } catch (_) {
        // Silently ignore parse errors
    }
})
