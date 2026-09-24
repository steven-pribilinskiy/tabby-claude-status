#!/usr/bin/env node
// Copy the built plugin into the plugins dir of each app that hosts it.
// Run via: npm run install-plugin (builds first)
//
//   npm run install-plugin                      # every installed host (Tabby, Torbie)
//   npm run install-plugin -- --app torbie      # just one (repeatable)
//   npm run install-plugin -- --dir <data dir>  # a portable install's `data` dir
//
// With no --app/--dir, a host is "installed" when its data dir exists.

const fs = require('node:fs')
const path = require('node:path')
const { selectHosts } = require('./hosts')

const argv = process.argv.slice(2)
const explicit = argv.includes('--app') || argv.includes('--dir')
const hosts = selectHosts(argv, 'all').filter((h) => explicit || fs.existsSync(h.dir))
if (hosts.length === 0) {
    console.error(
        'No Tabby or Torbie data directory found. Pass --app <tabby|torbie> or --dir <data dir>.',
    )
    process.exit(1)
}

const pluginName = 'tabby-claude-status'
const src = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))

// Synthesized runtime package.json
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

for (const host of hosts) {
    const dest = path.join(host.dir, 'plugins', 'node_modules', pluginName)

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

    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(runtimePkg, null, 2))

    console.log(`Installed ${pkg.version} to ${dest}`)
    console.log(`Restart ${host.name} to reload the plugin.`)
}
