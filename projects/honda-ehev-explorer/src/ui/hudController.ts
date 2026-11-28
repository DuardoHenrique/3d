import { ENGINE_PARTS, EnginePartMetadata } from '../data/partsMetadata';
import { ProjectedLabel, SceneController, SceneSnapshot } from '../scene/sceneController';

export class HudController {
  private readonly sceneCtrl: SceneController;

  private readonly appRoot: HTMLElement;
  private readonly labelsLayer: HTMLElement;
  private readonly inspectionCard: HTMLElement;
  private readonly inspCategory: HTMLElement;
  private readonly inspDot: HTMLElement;
  private readonly inspName: HTMLElement;
  private readonly inspDesc: HTMLElement;
  private readonly btnPrevPart: HTMLButtonElement;
  private readonly btnNextPart: HTMLButtonElement;
  private readonly btnToggleTexture: HTMLButtonElement;
  private readonly btnCardHideBase: HTMLButtonElement;
  private readonly btnAssemble: HTMLButtonElement;

  private readonly partsDrawer: HTMLElement;
  private readonly drawerToggle: HTMLButtonElement;
  private readonly partsListEl: HTMLElement;
  private readonly partButtons = new Map<string, HTMLButtonElement>();

  private readonly btnExplodeToggle: HTMLButtonElement;
  private readonly explodeSlider: HTMLInputElement;
  private readonly explodeValueEl: HTMLElement;
  private readonly btnLabelsToggle: HTMLButtonElement;
  private readonly btnBaseToggle: HTMLButtonElement;
  private readonly btnResetCamera: HTMLButtonElement;

  private readonly labelElements = new Map<string, HTMLButtonElement>();
  private isMobileDrawerOpen = false;

  constructor(sceneCtrl: SceneController) {
    this.sceneCtrl = sceneCtrl;

    this.appRoot = this.mustGet('app');
    this.labelsLayer = this.mustGet('labels-layer');
    this.inspectionCard = this.mustGet('inspection-card');
    this.inspCategory = this.mustGet('insp-category');
    this.inspDot = this.mustGet('insp-dot');
    this.inspName = this.mustGet('insp-name');
    this.inspDesc = this.mustGet('insp-desc');
    this.btnPrevPart = this.mustGet('btn-prev-part') as HTMLButtonElement;
    this.btnNextPart = this.mustGet('btn-next-part') as HTMLButtonElement;
    this.btnToggleTexture = this.mustGet('btn-toggle-texture') as HTMLButtonElement;
    this.btnCardHideBase = this.mustGet('btn-card-hide-base') as HTMLButtonElement;
    this.btnAssemble = this.mustGet('btn-assemble') as HTMLButtonElement;

    this.partsDrawer = this.mustGet('parts-drawer');
    this.drawerToggle = this.mustGet('drawer-toggle') as HTMLButtonElement;
    this.partsListEl = this.mustGet('parts-list');

    this.btnExplodeToggle = this.mustGet('btn-explode-toggle') as HTMLButtonElement;
    this.explodeSlider = this.mustGet('explode-slider') as HTMLInputElement;
    this.explodeValueEl = this.mustGet('explode-value');
    this.btnLabelsToggle = this.mustGet('btn-labels-toggle') as HTMLButtonElement;
    this.btnBaseToggle = this.mustGet('btn-base-toggle') as HTMLButtonElement;
    this.btnResetCamera = this.mustGet('btn-reset-camera') as HTMLButtonElement;

    this.buildPartsList(ENGINE_PARTS);
    this.bindUiEvents();
    this.syncSliderCssVars();
  }

  private mustGet(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`Missing HUD element: #${id}`);
    }
    return el;
  }

  private buildPartsList(parts: EnginePartMetadata[]): void {
    const countEl = document.getElementById('parts-count');
    if (countEl) countEl.textContent = String(parts.length);

    this.partsListEl.innerHTML = '';
    for (const part of parts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'part-item';
      btn.dataset.partId = part.id;
      btn.setAttribute('role', 'listitem');
      btn.style.setProperty('--part-color', part.cor);

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.backgroundColor = part.cor;

      const textWrap = document.createElement('span');
      textWrap.className = 'part-item-text';

      const title = document.createElement('span');
      title.className = 'part-item-name';
      title.textContent = part.nome;

      const cat = document.createElement('span');
      cat.className = 'part-item-cat';
      cat.textContent = part.categoriaLabel;

      textWrap.append(title, cat);
      btn.append(dot, textWrap);

      btn.addEventListener('pointerenter', () => {
        this.sceneCtrl.setHoveredPart(part.id);
      });
      btn.addEventListener('pointerleave', () => {
        this.sceneCtrl.setHoveredPart(null);
      });
      btn.addEventListener('click', () => {
        if (part.id === 'base-cofre' && !this.sceneCtrl.getSnapshot().isBaseVisible) {
          this.sceneCtrl.setBaseVisible(true);
        }
        this.sceneCtrl.selectPart(part.id);
        this.setMobileDrawerOpen(false);
      });

      this.partsListEl.appendChild(btn);
      this.partButtons.set(part.id, btn);
    }
  }

  private bindUiEvents(): void {
    this.btnPrevPart.addEventListener('click', () => this.sceneCtrl.cycleSelectedPart(-1));
    this.btnNextPart.addEventListener('click', () => this.sceneCtrl.cycleSelectedPart(1));
    this.btnToggleTexture.addEventListener('click', () =>
      this.sceneCtrl.toggleInspectedRealistic()
    );
    this.btnCardHideBase.addEventListener('click', () =>
      this.sceneCtrl.setBaseVisible(false)
    );
    this.btnAssemble.addEventListener('click', () => this.sceneCtrl.selectPart(null));

    this.drawerToggle.addEventListener('click', () => {
      this.setMobileDrawerOpen(!this.isMobileDrawerOpen);
    });

    this.explodeSlider.addEventListener('input', () => {
      this.syncSliderCssVars();
      this.sceneCtrl.setExplodeFactor(Number(this.explodeSlider.value) / 100);
    });

    this.btnExplodeToggle.addEventListener('click', () => {
      const current = this.sceneCtrl.getSnapshot().explodeFactor;
      this.sceneCtrl.setExplodeFactor(current > 0.5 ? 0 : 1);
    });

    this.btnLabelsToggle.addEventListener('click', () => {
      const snap = this.sceneCtrl.getSnapshot();
      this.sceneCtrl.setShowAllLabels(!snap.showAllLabels);
    });

    this.btnBaseToggle.addEventListener('click', () => {
      const snap = this.sceneCtrl.getSnapshot();
      this.sceneCtrl.setBaseVisible(!snap.isBaseVisible);
    });

    this.btnResetCamera.addEventListener('click', () => {
      this.sceneCtrl.resetCamera();
    });

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.sceneCtrl.getSnapshot().selectedId !== null) {
          this.sceneCtrl.selectPart(null);
        } else if (this.isMobileDrawerOpen) {
          this.setMobileDrawerOpen(false);
        }
      } else if (e.key === 'ArrowLeft') {
        if (document.activeElement !== this.explodeSlider) {
          this.sceneCtrl.cycleSelectedPart(-1);
        }
      } else if (e.key === 'ArrowRight') {
        if (document.activeElement !== this.explodeSlider) {
          this.sceneCtrl.cycleSelectedPart(1);
        }
      }
    });
  }

  private setMobileDrawerOpen(open: boolean): void {
    this.isMobileDrawerOpen = open;
    this.partsDrawer.classList.toggle('is-open', open);
    this.drawerToggle.setAttribute('aria-expanded', String(open));
  }

  private syncSliderCssVars(): void {
    this.explodeSlider.style.setProperty('--attr-min', this.explodeSlider.min || '0');
    this.explodeSlider.style.setProperty('--attr-max', this.explodeSlider.max || '100');
    this.explodeSlider.style.setProperty('--control-value', this.explodeSlider.value);
    this.explodeSlider.setAttribute('aria-valuetext', `${this.explodeSlider.value}%`);
  }

  public syncState(snap: SceneSnapshot): void {
    // Sync parts list bidirectional highlight
    for (const [id, btn] of this.partButtons.entries()) {
      const isSelected = id === snap.selectedId;
      const isHovered = id === snap.hoveredId;
      const isBaseHidden = id === 'base-cofre' && !snap.isBaseVisible;

      btn.classList.toggle('is-selected', isSelected);
      btn.classList.toggle('is-hovered', isHovered && !isSelected);
      btn.classList.toggle('is-hidden-part', isBaseHidden);

      if (isSelected) {
        btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    // Sync inspection card
    this.appRoot.classList.toggle('is-inspecting', snap.selectedId !== null);
    if (snap.selectedId) {
      const meta = this.sceneCtrl.getPartMetadata(snap.selectedId);
      if (meta) {
        this.inspectionCard.hidden = false;
        this.inspectionCard.style.setProperty('--part-color', meta.cor);
        this.inspCategory.textContent = meta.categoriaLabel;
        this.inspDot.style.backgroundColor = meta.cor;
        this.inspName.textContent = meta.nome;
        this.inspDesc.textContent = meta.descricao;

        this.btnToggleTexture.textContent = snap.inspectedUseRealistic
          ? 'Ver cor identificadora'
          : 'Ver textura padrão';
        this.btnToggleTexture.setAttribute('aria-pressed', String(snap.inspectedUseRealistic));

        this.btnCardHideBase.hidden = !meta.removivel;
      }
    } else {
      this.inspectionCard.hidden = true;
    }

    // Sync explode controls
    const pct = Math.round(snap.explodeFactor * 100);
    if (Number(this.explodeSlider.value) !== pct) {
      this.explodeSlider.value = String(pct);
      this.syncSliderCssVars();
    }
    this.explodeValueEl.textContent = `${pct}%`;
    const isExploded = snap.explodeFactor > 0.5;
    this.btnExplodeToggle.classList.toggle('is-active', isExploded);
    this.btnExplodeToggle.setAttribute('aria-pressed', String(isExploded));
    this.btnExplodeToggle.textContent = isExploded ? 'Recolher' : 'Explodir';

    // Sync quick toggles
    this.btnLabelsToggle.classList.toggle('is-active', snap.showAllLabels);
    this.btnLabelsToggle.setAttribute('aria-pressed', String(snap.showAllLabels));

    this.btnBaseToggle.classList.toggle('is-active', snap.isBaseVisible);
    this.btnBaseToggle.setAttribute('aria-pressed', String(snap.isBaseVisible));
    this.btnBaseToggle.textContent = snap.isBaseVisible ? 'Base visível' : 'Base oculta (360°)';
  }

  public updateLabels(labels: ProjectedLabel[]): void {
    const activeIds = new Set<string>();

    for (const lbl of labels) {
      if (!lbl.visible) continue;
      activeIds.add(lbl.id);

      let el = this.labelElements.get(lbl.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'floating-label';
        const dot = document.createElement('span');
        dot.className = 'floating-label-dot';
        const text = document.createElement('span');
        text.className = 'floating-label-text';
        el.append(dot, text);

        const partId = lbl.id;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.sceneCtrl.selectPart(partId);
        });
        this.labelsLayer.appendChild(el);
        this.labelElements.set(lbl.id, el);
      }

      const dotEl = el.firstElementChild as HTMLElement;
      const textEl = el.lastElementChild as HTMLElement;
      dotEl.style.backgroundColor = lbl.cor;
      textEl.textContent = lbl.isHovered ? lbl.nome : lbl.nomeCurto;
      el.style.setProperty('--part-color', lbl.cor);
      el.classList.toggle('is-hovered', lbl.isHovered);
      el.style.transform = `translate3d(${lbl.x.toFixed(1)}px, ${lbl.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.display = 'inline-flex';
    }

    for (const [id, el] of this.labelElements.entries()) {
      if (!activeIds.has(id)) {
        el.style.display = 'none';
      }
    }
  }
}
