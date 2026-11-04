// Copies the two shared Personal Command packages into vendor/, where package.json installs them from:
//   @awestley/glassive    the design system (obsidian-glassive, package/)
//   @awestley/pc-runtime  the shell runtime (westley-app, packages/runtime/)
// They are private packages on GitHub Packages. Until the build has a token to install them from there,
// they are vendored: run this after either one changes, then commit vendor/.
//
//   node scripts/sync-vendor.mjs <path to obsidian-glassive> <path to westley-app>
import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const [glassive = process.env.GLASSIVE_DIR, westley = process.env.WESTLEY_DIR] = process.argv.slice(2);
if (!glassive || !westley) {
  console.error('Usage: node scripts/sync-vendor.mjs <obsidian-glassive checkout> <westley-app checkout>');
  process.exit(2);
}

function copy(name, from, parts) {
  const out = resolve('vendor', name);
  rmSync(out, { recursive: true, force: true });
  for (const part of parts) cpSync(join(from, part), join(out, part), { recursive: true });
  console.log(`vendor/${name} <- ${from}`);
}

const glassivePkg = resolve(glassive, 'package');
execFileSync(process.execPath, ['build.mjs'], { cwd: glassivePkg, stdio: 'inherit' });
copy('glassive', glassivePkg, ['package.json', 'dist']);
copy('pc-runtime', resolve(westley, 'packages', 'runtime'), ['package.json', 'src']);
