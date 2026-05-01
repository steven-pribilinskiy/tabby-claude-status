/* eslint-disable */
// Smoke test for mic detection regex + sound listing logic.
// Run: node scripts/smoke-mic-sound.js

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ACTIVE_RE = /LastUsedTimeStop\s+REG_QWORD\s+0x0\b/i
const PLAYABLE_RE = /\.(wav|mp3|ogg|m4a|aac)$/i

console.log('=== Mic detection ===')
try {
    const out = execFileSync(
        'reg',
        [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
            '/s',
            '/v',
            'LastUsedTimeStop',
        ],
        { encoding: 'utf8', windowsHide: true },
    )
    const totalRows = (out.match(/LastUsedTimeStop/g) || []).length
    const active = ACTIVE_RE.test(out)
    console.log(`Total apps tracked: ${totalRows}`)
    console.log(`Mic currently active: ${active}`)

    // Sanity: synthesize an active row and re-test regex
    const fake = 'LastUsedTimeStop    REG_QWORD    0x0\n'
    console.log(`Regex matches fake active row: ${ACTIVE_RE.test(fake)}`)
    const fakeIdle = 'LastUsedTimeStop    REG_QWORD    0x1dc5bf9a8ec2cf9\n'
    console.log(`Regex matches idle row (should be false): ${ACTIVE_RE.test(fakeIdle)}`)
} catch (err) {
    console.error('Mic probe failed:', err.message)
}

console.log()
console.log('=== Windows sounds enumeration ===')
const root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Media')
try {
    const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(e => e.isFile() && PLAYABLE_RE.test(e.name))
    console.log(`Sound files in ${root}: ${entries.length}`)
    console.log(`First 3: ${entries.slice(0, 3).map(e => e.name).join(', ')}`)
} catch (err) {
    console.error('Windows sounds enumeration failed:', err.message)
}

console.log()
console.log('=== Bundled manifest ===')
const manifestPath = path.join(__dirname, '..', 'assets', 'sounds', 'manifest.json')
try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    console.log(`Manifest version: ${parsed.version}, sounds: ${(parsed.sounds || []).length}`)
} catch (err) {
    console.error('Manifest read failed:', err.message)
}

console.log()
console.log('=== Online catalog ===')
const catalogPath = path.join(__dirname, '..', 'online-sounds', 'catalog.json')
try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))
    console.log(`Catalog version: ${parsed.version}, updated: ${parsed.updated}, sounds: ${(parsed.sounds || []).length}`)
} catch (err) {
    console.error('Catalog read failed:', err.message)
}

console.log()
console.log('=== Cache dir ===')
const local = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local')
const cacheDir = path.join(local, 'tabby-claude-status', 'sounds')
console.log(`Cache dir: ${cacheDir}`)
console.log(`Exists: ${fs.existsSync(cacheDir)}`)
