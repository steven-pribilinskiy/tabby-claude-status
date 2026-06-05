#!/usr/bin/env node
// Build + copy the plugin into Tabby's plugins dir.
// Run via: npm run install-plugin (after `npm run build`)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Tabby's per-user config dir, cross-platform. Without this the script
 *  blindly used %APPDATA% and threw an opaque `path.join(undefined, …)`
 *  TypeError on macOS/Linux (where APPDATA is unset). */
function tabbyConfigDir() {
    if (process.platform === 'win32') {
        if (!process.env.APPDATA) {
            throw new Error('APPDATA is not set — cannot locate the Tabby plugins directory.')
        }
        return path.join(process.env.APPDATA, 'tabby')
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'tabby')
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tabby')
}

const pluginName = 'tabby-claude-status'
const src = path.join(__dirname, '..')
const dest = path.join(tabbyConfigDir(), 'plugins', 'node_modules', pluginName)

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.join(dest, 'dist'), { recursive: true })

// Copy dist/
fs.cpSync(path.join(src, 'dist'), path.join(dest, 'dist'), { recursive: true })

// Copy hook.js
fs.copyFileSync(path.join(src, 'hook.js'), path.join(dest, 'hook.js'))

// Copy assets/ (overlay icons, etc.) if it exists
const assetsSrc = path.join(src, 'assets')
if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, path.join(dest, 'assets'), { recursive: true })
}

// Synthesize a runtime package.json
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    keywords: pkg.keywords,
    author: pkg.author,
    license: pkg.license,
}
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(runtimePkg, null, 2))

console.log('Installed to', dest)
console.log('Restart Tabby to reload the plugin.')
