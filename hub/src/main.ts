import registry from '../projects.json';

interface ProjectEntry {
  id: string;
  name: string;
  badge?: string;
  description?: string;
  accent?: string;
  url: string;
  enabled?: boolean;
}

const projects: ProjectEntry[] = (registry.projects as ProjectEntry[]).filter(
  (p) => p.enabled !== false
);

const tablist = document.getElementById('project-tablist') as HTMLDivElement;
const panel = document.getElementById('viewer-panel') as HTMLDivElement;
const iframe = document.getElementById('viewer-iframe') as HTMLIFrameElement;
const loadingEl = document.getElementById('viewer-loading') as HTMLDivElement;
const loadingLabel = document.getElementById('loading-label') as HTMLParagraphElement;
const activeDesc = document.getElementById('active-description') as HTMLParagraphElement;
const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement;
const externalLink = document.getElementById('open-external-link') as HTMLAnchorElement;

function resolveProjectUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (
      parsed.hostname === 'localhost' &&
      window.location.hostname &&
      window.location.hostname !== 'localhost'
    ) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

async function initFocusgroupPolyfill() {
  if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
    const { polyfill } = await import('@microsoft/focusgroup-polyfill');
    polyfill(tablist);
  }
}

function setupScrollFadeFallback(scroller: HTMLElement) {
  if (CSS.supports('animation-timeline', 'scroll()')) return;
  const first = scroller.firstElementChild;
  const last = scroller.lastElementChild;
  if (!first || !last) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRatio } of entries) {
        scroller.classList.toggle(
          target === first ? 'more-start' : 'more-end',
          intersectionRatio < 1
        );
      }
    },
    { root: scroller, threshold: 1, rootMargin: '1px' }
  );

  observer.observe(first);
  observer.observe(last);
}

const tabButtons = new Map<string, HTMLButtonElement>();
let activeId = '';

function selectProject(projectId: string, updateUrl = true) {
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  if (!project) return;

  activeId = project.id;
  const resolvedUrl = resolveProjectUrl(project.url);

  for (const [id, btn] of tabButtons.entries()) {
    const isSelected = id === project.id;
    btn.setAttribute('aria-selected', String(isSelected));
    btn.toggleAttribute('focusgroupstart', isSelected);
    if (isSelected) {
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  const activeTab = tabButtons.get(project.id);
  if (activeTab) {
    panel.setAttribute('aria-labelledby', activeTab.id);
  }

  activeDesc.textContent = project.description || project.name;
  externalLink.href = resolvedUrl;
  document.documentElement.style.setProperty('--accent', project.accent || '#38bdf8');

  loadingLabel.textContent = `Carregando ${project.name}...`;
  loadingEl.hidden = false;
  iframe.title = `${project.name} — Visualizador 3D`;
  iframe.src = resolvedUrl;

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('model', project.id);
    window.history.replaceState(null, '', url.toString());
  }
}

function renderTabs() {
  tablist.replaceChildren();
  tabButtons.clear();

  if (projects.length === 0) {
    activeDesc.textContent = 'Nenhum projeto 3D habilitado em projects.json';
    return;
  }

  for (const project of projects) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `tab-${project.id}`;
    btn.className = 'tab-btn';
    btn.setAttribute('aria-selected', 'false');
    if (project.accent) {
      btn.style.setProperty('--tab-accent', project.accent);
    }

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = project.name;

    btn.append(dot, label);

    if (project.badge) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = project.badge;
      btn.append(badge);
    }

    btn.addEventListener('click', () => {
      if (activeId !== project.id) {
        selectProject(project.id);
      }
    });

    tablist.append(btn);
    tabButtons.set(project.id, btn);
  }

  setupScrollFadeFallback(tablist);
}

iframe.addEventListener('load', () => {
  loadingEl.hidden = true;
});

reloadBtn.addEventListener('click', () => {
  const current = projects.find((p) => p.id === activeId);
  if (!current) return;
  loadingLabel.textContent = `Recarregando ${current.name}...`;
  loadingEl.hidden = false;
  iframe.src = resolveProjectUrl(current.url);
});

async function bootstrap() {
  renderTabs();
  const initialParam = new URLSearchParams(window.location.search).get('model');
  const initialProject =
    projects.find((p) => p.id === initialParam)?.id ?? projects[0]?.id;

  if (initialProject) {
    selectProject(initialProject, false);
  }

  await initFocusgroupPolyfill();
}

bootstrap();
