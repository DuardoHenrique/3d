import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function run(command, cwd, extraEnv = {}) {
  console.log(`\n> [${path.relative(ROOT_DIR, cwd) || '.'}] ${command}`);
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function ensureInstalled(projectDir) {
  if (!fs.existsSync(path.join(projectDir, 'node_modules'))) {
    run('npm install --no-audit --no-fund', projectDir);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const hubDir = path.join(ROOT_DIR, 'hub');
  const swordDir = path.join(ROOT_DIR, 'projects', 'sword-divine');
  const augDir = path.join(ROOT_DIR, 'projects', 'aug-a1');
  const violinDir = path.join(ROOT_DIR, 'projects', 'violino-3d');
  const hondaDir = path.join(ROOT_DIR, 'projects', 'honda-ehev-explorer');

  // 1. Hub
  ensureInstalled(hubDir);
  run('npm run build', hubDir);
  copyDir(path.join(hubDir, 'dist'), DIST_DIR);

  // 2. Sword Divine
  ensureInstalled(swordDir);
  run('npm run build', swordDir);
  copyDir(path.join(swordDir, 'dist'), path.join(DIST_DIR, 'projects', 'sword-divine'));

  // 3. Steyr AUG A1
  ensureInstalled(augDir);
  run('npm run build', augDir);
  copyDir(path.join(augDir, 'dist'), path.join(DIST_DIR, 'projects', 'aug-a1'));

  // 4. Violino 3D (Static Export)
  ensureInstalled(violinDir);
  run('npm run build', violinDir, {
    STATIC_EXPORT: '1',
    NEXT_PUBLIC_BASE_PATH: '/projects/violino-3d',
  });
  copyDir(path.join(violinDir, 'out'), path.join(DIST_DIR, 'projects', 'violino-3d'));

  // 5. Honda e:HEV Explorer
  ensureInstalled(hondaDir);
  run('npm run build', hondaDir);
  copyDir(path.join(hondaDir, 'dist'), path.join(DIST_DIR, 'projects', 'honda-ehev-explorer'));

  console.log('\nBuild estático unificado concluído em ./dist');
}

main();
