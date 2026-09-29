// Node can't parse .jsx on its own, so the scripts in here run behind this hook:
// it hands every .jsx file to sucrase (already in node_modules via vite) and
// returns plain JS. Paired with register-jsx.mjs — see the header of any script.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { transform } from 'sucrase';

// src/ imports omit the extension the way vite allows, so fill it back in.
const EXTS = ['.js', '.jsx', '.mjs', '/index.js', '/index.jsx'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.') || !context.parentURL) throw err;
    const base = new URL(specifier, context.parentURL);
    for (const ext of EXTS) {
      const candidate = new URL(base.href + ext);
      if (existsSync(candidate)) {
        return { url: candidate.href, format: 'module', shortCircuit: true };
      }
    }
    throw err;
  }
}

// vite turns an asset import into a URL string and a .css import into nothing;
// outside vite they are just files node refuses to parse, so stand in for them.
const ASSETS = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|mp[34]|webm)$/i;
const STYLES = /\.(css|scss|sass|less)$/i;

export async function load(url, context, nextLoad) {
  if (ASSETS.test(url)) {
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
  }
  if (STYLES.test(url)) {
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  }
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const { code } = transform(source, {
    transforms: ['jsx'],
    jsxRuntime: 'automatic',
    filePath: url,
  });
  return { format: 'module', shortCircuit: true, source: code };
}
