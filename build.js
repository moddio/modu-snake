/**
 * Build script for snake game
 *
 * Features:
 * - Deterministic transform: converts Math.sqrt -> dSqrt, Math.random -> dRandom
 * - Bundles game code (engine loaded from CDN/localhost)
 * - Source maps for debugging
 *
 * Usage:
 *   node build.js           # Build once
 *   node build.js --watch   # Watch mode
 *   node build.js --watch --serve  # Watch + dev server
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/**
 * Transform code to use deterministic math functions.
 */
function deterministicTransform(code, filename, fullPath) {
    if (filename.includes('node_modules') || fullPath.includes('engine')) {
        return code;
    }

    console.log(`[deterministic] Transforming: ${filename}`);

    const neededImports = new Set();
    const existingImportMatch = code.match(/import\s*\{([^}]+)\}\s*from\s*['"]modu-engine['"]/s);
    const existingImportBlock = existingImportMatch ? existingImportMatch[1] : '';

    const hasDSqrt = /\bdSqrt\b/.test(existingImportBlock);
    const hasDRandom = /\bdRandom\b/.test(existingImportBlock);

    // Transform Math.sqrt(x) -> dSqrt(x)
    code = code.replace(/Math\.sqrt\s*\(/g, () => {
        if (!hasDSqrt) neededImports.add('dSqrt');
        return 'dSqrt(';
    });

    // Transform Math.random() -> dRandom()
    code = code.replace(/Math\.random\s*\(\s*\)/g, () => {
        if (!hasDRandom) neededImports.add('dRandom');
        return 'dRandom()';
    });

    // Add imports if needed
    if (neededImports.size > 0) {
        const imports = Array.from(neededImports).join(', ');
        const engineImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]modu-engine['"]/s;
        const match = code.match(engineImportRegex);

        if (match) {
            let existingImports = match[1].trim();
            if (existingImports.endsWith(',')) {
                existingImports = existingImports.slice(0, -1);
            }
            const newImports = `${existingImports}, ${imports}`;
            code = code.replace(engineImportRegex, `import { ${newImports} } from 'modu-engine'`);
        } else {
            code = `import { ${imports} } from 'modu-engine';\n` + code;
        }
    }

    return code;
}

const deterministicPlugin = {
    name: 'deterministic',
    setup(build) {
        build.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
            const source = await fs.promises.readFile(args.path, 'utf8');
            const transformed = deterministicTransform(source, path.basename(args.path), args.path);
            return {
                contents: transformed,
                loader: args.path.endsWith('.ts') ? 'ts' : 'js',
            };
        });
    },
};

// Plugin to map 'modu-engine' imports to the CDN global (window.Modu)
const cdnEnginePlugin = {
    name: 'cdn-engine',
    setup(build) {
        // Resolve 'modu-engine' to a virtual module
        build.onResolve({ filter: /^modu-engine$/ }, () => ({
            path: 'modu-engine',
            namespace: 'cdn-global',
        }));

        // Return a module that re-exports from the global
        build.onLoad({ filter: /.*/, namespace: 'cdn-global' }, () => ({
            contents: 'module.exports = window.Modu;',
            loader: 'js',
        }));
    },
};

const buildOptions = {
    entryPoints: ['src/game.ts'],
    bundle: true,
    outfile: 'dist/game.js',
    format: 'iife',
    globalName: 'SnakeGame',
    sourcemap: true,
    target: 'es2020',
    plugins: [deterministicPlugin, cdnEnginePlugin],
    define: {
        'process.env.NODE_ENV': '"development"',
    },
    logLevel: 'info',
};

async function build() {
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');
    const serve = args.includes('--serve');

    // Auto-detect: CI/GitHub Actions = production (CDN), otherwise local
    const isCI = process.env.CI || process.env.GITHUB_ACTIONS;
    const localEngineUrl = 'http://localhost:3001/dist/modu.min.js';
    const cdnEngineUrl = `https://cdn.moduengine.com/modu.min.js?v=${Date.now()}`;
    const engineUrl = isCI ? cdnEngineUrl : localEngineUrl;

    if (!fs.existsSync('dist')) {
        fs.mkdirSync('dist');
    }

    // Update engine URL in dist/index.html
    let indexHtml = fs.readFileSync('dist/index.html', 'utf8');
    indexHtml = indexHtml.replace(localEngineUrl, engineUrl);
    indexHtml = indexHtml.replace(/https:\/\/cdn\.moduengine\.com\/modu\.min\.js(\?v=\d+)?/, engineUrl);
    fs.writeFileSync('dist/index.html', indexHtml);
    console.log('[build] Engine: ' + (isCI ? 'CDN (CI)' : 'localhost'));

    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[build] Watching for changes...');

        if (serve) {
            // Kill any existing process on the port
            const { execSync } = require('child_process');
            try {
                if (process.platform === 'win32') {
                    execSync('npx kill-port 8081', { stdio: 'ignore' });
                } else {
                    execSync('lsof -ti:8081 | xargs kill -9 2>/dev/null || true', { stdio: 'ignore' });
                }
            } catch { }

            const { port } = await ctx.serve({
                servedir: 'dist',
                port: 8081,
            });
            console.log(`[build] Serving at http://localhost:${port}`);
        }
    } else {
        await esbuild.build(buildOptions);
        console.log('[build] Done!');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
