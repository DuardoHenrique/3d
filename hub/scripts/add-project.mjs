import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(HUB_DIR, 'projects.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.id || !args.name || !args.cwd) {
    console.log(`Uso:
  npm run add-project -- --id <slug> --name "<Nome>" --cwd <caminho-relativo-ou-absoluto> [opções]

Opções:
  --port <numero>         Porta do servidor local (padrão: próxima porta livre a partir de 5176)
  --route <caminho>       Sub-rota opcional, ex: /embed (padrão: "/")
  --badge "<texto>"       Etiqueta na aba, ex: "Three.js" (padrão: "Three.js")
  --description "<texto>" Descrição exibida no topo
  --accent "<hex>"        Cor de destaque, ex: "#38BDF8"
  --command "<cmd>"       Comando dev personalizado (padrão: "npm run dev -- --port <port> --strictPort")
`);
    process.exit(args.help ? 0 : 1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const projects = registry.projects || [];

  if (projects.some((p) => p.id === args.id)) {
    console.error(`Já existe um projeto com id "${args.id}" em projects.json.`);
    process.exit(1);
  }

  const usedPorts = new Set(
    projects.map((p) => Number(p?.dev?.port)).filter((n) => Number.isFinite(n))
  );
  let port = args.port ? Number(args.port) : 5176;
  while (usedPorts.has(port)) port++;

  const route = typeof args.route === 'string' && args.route !== '/'
    ? (args.route.startsWith('/') ? args.route : `/${args.route}`)
    : '';

  const entry = {
    id: String(args.id),
    name: String(args.name),
    badge: String(args.badge || 'Three.js'),
    description: String(args.description || `${args.name} — Visualizador 3D`),
    accent: String(args.accent || '#38BDF8'),
    url: `http://localhost:${port}${route}`,
    enabled: true,
    dev: {
      cwd: String(args.cwd),
      command: String(args.command || `npm run dev -- --port ${port} --strictPort`),
      port,
    },
  };

  projects.push(entry);
  registry.projects = projects;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  console.log(`Projeto "${entry.name}" adicionado em projects.json (porta ${port}).`);
}

main();
