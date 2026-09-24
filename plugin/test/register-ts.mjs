// Lets `node --test` import the plugin's TypeScript sources as they are. Node
// strips the types itself; this supplies the two things the bundler does for
// the build. An extensionless relative import resolves to `.ts`, and a `.ts`
// file is an ES module: plugin/package.json has no "type", and adding one
// would turn rspack.config.js and scripts/ into ES modules.
import { registerHooks } from 'node:module'

registerHooks({
    resolve(specifier, context, nextResolve) {
        const relative = /^\.\.?\//.test(specifier)
        const bare = !/\.[cm]?[jt]s$/.test(specifier)
        const fromTs = context.parentURL?.endsWith('.ts')
        const resolved =
            relative && bare && fromTs
                ? nextResolve(`${specifier}.ts`, context)
                : nextResolve(specifier, context)
        return resolved.url.endsWith('.ts')
            ? { ...resolved, format: 'module-typescript' }
            : resolved
    },
})
