# 3D Studio Hub

Galeria unificada para visualizar e interagir com múltiplos modelos 3D em uma única página, mantendo cada projeto isolado em sua própria pasta.

## Projetos incluídos

- **Sword Divine** (`projects/sword-divine`) — Espada procedural em cristal e ouro PBR (Three.js + Vite)
- **Steyr AUG A1** (`projects/aug-a1`) — Rifle bullpup PBR com inspeção de peças e ações mecânicas (Three.js + Vite)
- **Violino 3D** (`projects/violino-3d`) — Violino interativo isolado com OrbitControls, síntese sonora das cordas (Tone.js) e partículas (React Three Fiber + Next.js)

## Deploy no Netlify

O repositório já possui [`netlify.toml`](./netlify.toml) configurado:
- **Build command:** `npm run build`
- **Publish directory:** `dist`

## Como executar localmente

1. Instale as dependências:

```bash
npm run setup
```

2. Inicie o Hub e todos os visualizadores 3D com um único comando:

```bash
npm run dev
```

3. Acesse no navegador:

- `http://localhost:4000`
