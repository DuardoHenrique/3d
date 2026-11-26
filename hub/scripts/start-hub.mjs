import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(HUB_DIR, 'projects.json');

const children = [];
let shuttingDown = false;

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function prefixStream(stream, prefix, target) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        target.write(`[${prefix}] ${line}\n`);
      }
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) {
      target.write(`[${prefix}] ${buffer}\n`);
    }
  });
}

function startProcess(label, command, cwd) {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.stdout) prefixStream(child.stdout, label, process.stdout);
  if (child.stderr) prefixStream(child.stderr, label, process.stderr);

  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`[${label}] processo encerrado com código ${code}`);
    }
  });

  children.push(child);
  return child;
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nEncerrando servidores do 3D Studio Hub...');
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // already exited
        }
      }
    }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const hubPort = Number(registry.hubPort || 4000);
  const enabledProjects = (registry.projects || []).filter(
    (p) => p.enabled !== false && p.dev && p.dev.command && p.dev.cwd && p.dev.port
  );

  for (const project of enabledProjects) {
    const port = Number(project.dev.port);
    const alreadyRunning = await isPortOpen(port);
    if (alreadyRunning) {
      console.log(`[${project.id}] já ativo na porta ${port} (reutilizando).`);
      continue;
    }

    const cwd = path.resolve(HUB_DIR, project.dev.cwd);
    if (!fs.existsSync(cwd)) {
      console.warn(`[${project.id}] diretório não encontrado: ${cwd}`);
      continue;
    }

    console.log(`[${project.id}] iniciando na porta ${port}...`);
    startProcess(project.id, project.dev.command, cwd);
  }

  for (const project of enabledProjects) {
    const port = Number(project.dev.port);
    const ok = await waitForPort(port, 20000);
    if (ok) {
      console.log(`[${project.id}] pronto em http://localhost:${port}`);
    } else {
      console.warn(`[${project.id}] demorou para responder na porta ${port}; verifique os logs acima.`);
    }
  }

  const hubAlreadyOpen = await isPortOpen(hubPort);
  if (!hubAlreadyOpen) {
    startProcess('hub', `npx vite --port ${hubPort} --strictPort`, HUB_DIR);
    await waitForPort(hubPort, 15000);
  }

  console.log(`\n========================================`);
  console.log(`  3D Studio Hub disponível em:`);
  console.log(`  http://localhost:${hubPort}`);
  console.log(`========================================\n`);
}

main().catch((err) => {
  console.error('Erro ao iniciar o Hub:', err);
  cleanup();
});
