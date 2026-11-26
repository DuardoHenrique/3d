# 3D Studio Hub

Aplicação unificada para alternar e interagir com múltiplos projetos 3D sem misturar suas pastas.

## Como executar tudo com um comando

```bash
cd /home/eduardo/Antigravity/3D/hub
npm run dev
```

Acesse: `http://localhost:4000`

O comando sobe automaticamente os servidores dos projetos configurados em `projects.json` (reutilizando portas já abertas) e encerra tudo ao pressionar `Ctrl+C`.

## Como adicionar um novo projeto 3D

### Opção 1 — Comando rápido

```bash
cd /home/eduardo/Antigravity/3D/hub
npm run add-project -- --id meu-3d --name "Meu Novo 3D" --cwd ../projects/meu-3d --accent "#A78BFA"
```

### Opção 2 — Editar `projects.json` manualmente

Adicione um objeto no array `projects` dentro de `hub/projects.json`:

```json
{
  "id": "meu-3d",
  "name": "Meu Novo 3D",
  "badge": "Three.js",
  "description": "Descrição exibida na barra superior",
  "accent": "#A78BFA",
  "url": "http://localhost:5176",
  "enabled": true,
  "dev": {
    "cwd": "../projects/meu-3d",
    "command": "npm run dev -- --port 5176 --strictPort",
    "port": 5176
  }
}
```

Se quiser ocultar algum projeto temporariamente sem removê-lo, basta definir `"enabled": false`.
