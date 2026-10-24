import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');

export function buildPages(outputDir = resolve(ROOT, '.work/pages-site')) {
  const output = resolve(outputDir);
  const rel = relative(ROOT, output);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Pages output must be a child directory of the repository.');
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const html = readFileSync(resolve(PUBLIC, 'draw.html'), 'utf8')
    .replaceAll('href="/static/', 'href="static/')
    .replaceAll('src="/static/', 'src="static/');
  writeFileSync(resolve(output, 'index.html'), html, 'utf8');
  mkdirSync(resolve(output, 'static'), { recursive: true });
  for (const file of ['style.css', 'draw.js', 'play.js', 'ritual-botanical-mark.svg']) {
    cpSync(resolve(PUBLIC, 'static', file), resolve(output, 'static', file));
  }
  cpSync(resolve(PUBLIC, 'deck'), resolve(output, 'deck'), { recursive: true });
  writeFileSync(resolve(output, '.nojekyll'), '', 'utf8');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = buildPages(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`GitHub Pages site built at ${output}`);
}
