import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type ViewName =
  | 'right'
  | 'left'
  | 'front_muzzle'
  | 'rear_butt'
  | 'top'
  | 'three_quarter_front'
  | 'three_quarter_rear'
  | 'closeup_optic'
  | 'closeup_mag_trigger'
  | 'closeup_muzzle'
  | 'closeup_ejection_buttpad'
  | 'closeup_material_grazing';

export type LightingPreset = 'reference-match' | 'neutral' | 'grazing';

export type SetViewOptions = {
  yawDeg?: number;
};

export interface AugSceneContext {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  orthoCamera: THREE.OrthographicCamera;
  perspCamera: THREE.PerspectiveCamera;
  getActiveCamera: () => THREE.Camera;
  controls: OrbitControls;
  setView: (name: ViewName, opts?: SetViewOptions) => void;
  setBackground: (hex: string) => void;
  setLightingForMode: (mode: 'clay' | 'shaded') => void;
  setLightingPreset: (preset: LightingPreset) => void;
  renderOnce: () => void;
  markInteractive: () => void;
}

export function setupAugScene(container: HTMLElement): AugSceneContext {
  const width = container.clientWidth || window.innerWidth || 1024;
  const height = container.clientHeight || window.innerHeight || 448;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'default',
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setStyle('#eef1f4', THREE.SRGBColorSpace);

  // Code-generated PMREM environment using RoomEnvironment
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();
  } catch (err) {
    console.warn('PMREM RoomEnvironment fallback:', err);
  }

  // Lighting rig calibrated for both clay blockout (no white clipping) & shaded PBR
  const hemi = new THREE.HemisphereLight(0xf6f8fc, 0x3b4046, 0.44);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff6e8, 1.45);
  keyLight.position.set(1.6, 3.0, 3.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.006;
  keyLight.shadow.camera.near = 0.2;
  keyLight.shadow.camera.far = 15;
  keyLight.shadow.camera.left = -0.7;
  keyLight.shadow.camera.right = 0.7;
  keyLight.shadow.camera.top = 0.5;
  keyLight.shadow.camera.bottom = -0.5;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xd0e2ff, 0.90);
  fillLight.position.set(-1.8, 1.8, -3.4);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.95);
  rimLight.position.set(-1.2, 2.8, -2.2);
  scene.add(rimLight);

  const underBounce = new THREE.DirectionalLight(0xcfd4da, 0.22);
  underBounce.position.set(0.5, -2.5, 1.5);
  scene.add(underBounce);

  // Cameras
  const aspect = width / height;
  const orthoHalfH = 0.3838 / 2;
  const orthoHalfW = (0.8774 / 2) * (aspect / (1024 / 448));
  const orthoCamera = new THREE.OrthographicCamera(
    -orthoHalfW,
    orthoHalfW,
    orthoHalfH,
    -orthoHalfH,
    0.05,
    20,
  );

  const perspCamera = new THREE.PerspectiveCamera(35, aspect, 0.02, 25);
  perspCamera.position.set(0.88, 0.28, 0.98);

  let activeCamera: THREE.Camera = perspCamera;
  let currentView: ViewName = 'three_quarter_front';
  let currentLeftYawDeg = 5;

  const controls = new OrbitControls(perspCamera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.2;
  controls.maxDistance = 4.5;
  controls.target.set(0, -0.045, 0);
  controls.update();

  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.style.touchAction = 'none';
  controls.addEventListener('start', () => {
    (window as any).__interactive = true;
    renderer.domElement.style.cursor = 'grabbing';
  });
  controls.addEventListener('end', () => {
    renderer.domElement.style.cursor = 'grab';
  });

  function updateOrthoBounds(targetWidth: number, targetHeight: number) {
    const w = renderer.domElement.clientWidth || container.clientWidth || window.innerWidth || 1024;
    const h = renderer.domElement.clientHeight || container.clientHeight || window.innerHeight || 448;
    const curAspect = w / Math.max(1, h);
    const refAspect = targetWidth / targetHeight;
    let halfH = targetHeight * 0.5;
    let halfW = targetWidth * 0.5;
    if (curAspect > refAspect) {
      halfW = halfH * curAspect;
    } else {
      halfH = halfW / curAspect;
    }
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
  }

  function updatePerspAspect() {
    const w = renderer.domElement.clientWidth || container.clientWidth || window.innerWidth || 1200;
    const h = renderer.domElement.clientHeight || container.clientHeight || window.innerHeight || 800;
    perspCamera.aspect = w / Math.max(1, h);
    perspCamera.updateProjectionMatrix();
  }

  function setView(name: ViewName, opts: SetViewOptions = {}) {
    currentView = name;
    if (opts.yawDeg !== undefined) {
      currentLeftYawDeg = opts.yawDeg;
    }

    if (name === 'right') {
      updateOrthoBounds(0.8774, 0.3838);
      orthoCamera.up.set(0, 1, 0);
      orthoCamera.position.set(0, -0.0523, 2.0);
      orthoCamera.lookAt(0, -0.0523, 0);
      orthoCamera.updateProjectionMatrix();
      activeCamera = orthoCamera;
      controls.object = orthoCamera;
      controls.target.set(0, -0.0523, 0);
    } else if (name === 'left') {
      updateOrthoBounds(0.8774, 0.3838);
      const yawRad = THREE.MathUtils.degToRad(opts.yawDeg ?? currentLeftYawDeg);
      const dist = 2.0;
      orthoCamera.up.set(0, 1, 0);
      orthoCamera.position.set(
        -Math.sin(yawRad) * dist,
        -0.0463,
        -Math.cos(yawRad) * dist,
      );
      orthoCamera.lookAt(0, -0.0463, 0);
      orthoCamera.updateProjectionMatrix();
      activeCamera = orthoCamera;
      controls.object = orthoCamera;
      controls.target.set(0, -0.0463, 0);
    } else if (name === 'top') {
      updateOrthoBounds(0.88, 0.30);
      orthoCamera.up.set(0, 0, -1);
      orthoCamera.position.set(0, 2.0, 0);
      orthoCamera.lookAt(0, 0, 0);
      orthoCamera.updateProjectionMatrix();
      activeCamera = orthoCamera;
      controls.object = orthoCamera;
      controls.target.set(0, 0, 0);
    } else if (name === 'front_muzzle') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(0.66, -0.04, 0.08);
      perspCamera.lookAt(0.08, -0.04, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(0.08, -0.04, 0);
    } else if (name === 'rear_butt') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(-0.66, -0.04, -0.08);
      perspCamera.lookAt(-0.12, -0.04, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(-0.12, -0.04, 0);
    } else if (name === 'three_quarter_front') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(0.68, 0.24, 0.88);
      perspCamera.lookAt(0, -0.05, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(0, -0.05, 0);
    } else if (name === 'three_quarter_rear') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(-0.72, 0.24, -0.86);
      perspCamera.lookAt(0, -0.05, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(0, -0.05, 0);
    } else if (name === 'closeup_optic') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(0.22, 0.11, -0.28);
      perspCamera.lookAt(0.02, 0.032, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(0.02, 0.032, 0);
    } else if (name === 'closeup_mag_trigger') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(-0.20, -0.03, -0.39);
      perspCamera.lookAt(-0.10, -0.090, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(-0.10, -0.090, 0);
    } else if (name === 'closeup_muzzle') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(0.46, 0.08, 0.24);
      perspCamera.lookAt(0.265, -0.005, 0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(0.265, -0.005, 0);
    } else if (name === 'closeup_ejection_buttpad') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(-0.12, 0.015, 0.37);
      perspCamera.lookAt(-0.258, -0.055, 0.012);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(-0.258, -0.055, 0.012);
    } else if (name === 'closeup_material_grazing') {
      updatePerspAspect();
      perspCamera.up.set(0, 1, 0);
      perspCamera.position.set(0.21, 0.095, 0.34);
      perspCamera.lookAt(-0.04, 0.005, 0.0);
      activeCamera = perspCamera;
      controls.object = perspCamera;
      controls.target.set(-0.04, 0.005, 0.0);
    }
    renderOnce();
  }

  function setBackground(hex: string) {
    const normalized = hex.startsWith('#') ? hex : `#${hex}`;
    scene.background = new THREE.Color().setStyle(normalized, THREE.SRGBColorSpace);
    document.body.style.background = normalized;
    renderOnce();
  }

  let currentLightingPreset: LightingPreset = 'reference-match';

  function applyLightingPreset(preset: LightingPreset) {
    if (preset === 'reference-match') {
      renderer.toneMappingExposure = 0.96;
      hemi.color.setHex(0xf8f9fb);
      hemi.groundColor.setHex(0x45494e);
      hemi.intensity = 0.56;

      keyLight.color.setHex(0xfff8ef);
      keyLight.intensity = 1.12;
      keyLight.position.set(1.3, 2.8, 3.4);

      // Neutralize and balance -Z fillLight (compensates RoomEnvironment +Z bias so left & right match reference)
      fillLight.color.setHex(0xfaf8f4);
      fillLight.intensity = 2.28;
      fillLight.position.set(-0.9, 1.9, -3.6);

      rimLight.color.setHex(0xffffff);
      rimLight.intensity = 0.72;
      rimLight.position.set(-1.2, 2.8, -2.0);

      underBounce.color.setHex(0xd4d7dc);
      underBounce.intensity = 0.30;
      underBounce.position.set(0.0, -2.5, 0.0);
    } else if (preset === 'neutral') {
      renderer.toneMappingExposure = 0.92;
      hemi.color.setHex(0xffffff);
      hemi.groundColor.setHex(0x6e7278);
      hemi.intensity = 0.72;

      keyLight.color.setHex(0xffffff);
      keyLight.intensity = 1.05;
      keyLight.position.set(1.8, 2.8, 2.8);

      fillLight.color.setHex(0xf4f6f8);
      fillLight.intensity = 0.90;
      fillLight.position.set(-1.8, 2.0, -2.6);

      rimLight.color.setHex(0xffffff);
      rimLight.intensity = 0.45;
      rimLight.position.set(-0.8, 2.6, -2.2);

      underBounce.color.setHex(0xe0e2e5);
      underBounce.intensity = 0.35;
      underBounce.position.set(0.0, -2.6, 1.0);
    } else {
      // 'grazing': low raking semi-hard key light to expose micro-pebble grain, stock scratches & edge wear
      renderer.toneMappingExposure = 0.98;
      hemi.color.setHex(0xdde4ee);
      hemi.groundColor.setHex(0x1c1f24);
      hemi.intensity = 0.22;

      keyLight.color.setHex(0xfff5e4);
      keyLight.intensity = 2.35;
      keyLight.position.set(2.4, 0.55, 1.45);

      fillLight.color.setHex(0xb8cde8);
      fillLight.intensity = 0.38;
      fillLight.position.set(-2.2, 1.1, -2.8);

      rimLight.color.setHex(0xffffff);
      rimLight.intensity = 1.35;
      rimLight.position.set(-1.4, 1.2, -2.4);

      underBounce.color.setHex(0x889098);
      underBounce.intensity = 0.14;
      underBounce.position.set(0.3, -2.4, 1.0);
    }
  }

  function setLightingPreset(preset: LightingPreset) {
    currentLightingPreset = preset;
    applyLightingPreset(preset);
    renderOnce();
  }

  function setLightingForMode(mode: 'clay' | 'shaded') {
    if (mode === 'clay') {
      // Slightly toned-down exposure so #b8b8b4 clay stays distinct from #ffffff background
      renderer.toneMappingExposure = 0.88;
      hemi.color.setHex(0xf6f8fc);
      hemi.groundColor.setHex(0x3b4046);
      hemi.intensity = 0.56;
      keyLight.color.setHex(0xfff6e8);
      keyLight.intensity = 1.55;
      keyLight.position.set(1.6, 3.0, 3.5);
      fillLight.color.setHex(0xd0e2ff);
      fillLight.intensity = 0.85;
      fillLight.position.set(-1.8, 1.8, -3.4);
      rimLight.color.setHex(0xffffff);
      rimLight.intensity = 0.78;
      rimLight.position.set(-1.2, 2.8, -2.2);
      underBounce.color.setHex(0xcfd4da);
      underBounce.intensity = 0.28;
      underBounce.position.set(0.5, -2.5, 1.5);
    } else {
      applyLightingPreset(currentLightingPreset);
    }
    renderOnce();
  }

  function renderOnce() {
    renderer.render(scene, activeCamera);
  }

  function markInteractive() {
    (window as any).__interactive = true;
  }

  window.addEventListener('resize', () => {
    const w = container.clientWidth || window.innerWidth || 1024;
    const h = container.clientHeight || window.innerHeight || 448;
    renderer.setSize(w, h);
    if (activeCamera === perspCamera) {
      updatePerspAspect();
    } else {
      setView(currentView);
    }
    renderOnce();
  });

  return {
    scene,
    renderer,
    orthoCamera,
    perspCamera,
    getActiveCamera: () => activeCamera,
    controls,
    setView,
    setBackground,
    setLightingForMode,
    setLightingPreset,
    renderOnce,
    markInteractive,
  };
}
