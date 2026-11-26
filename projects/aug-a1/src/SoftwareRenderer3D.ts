import * as THREE from 'three';

interface RenderTri {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  depth: number;
  fill: string;
  stroke: string | null;
}

/**
 * Lightweight Canvas 2D Software 3D Rasterizer fallback for Three.js scenes
 * when WebGL is unavailable or blocked in the browser.
 * Supports both PerspectiveCamera and OrthographicCamera.
 */
export class SoftwareRenderer3D {
  public domElement: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 800;
  private height = 600;
  private pixelRatio = 1;
  public toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  public toneMappingExposure = 1.0;
  public outputColorSpace: THREE.ColorSpace = THREE.SRGBColorSpace;
  public shadowMap = { enabled: false, type: THREE.PCFSoftShadowMap };

  private triPool: RenderTri[] = [];
  private projScreenMatrix = new THREE.Matrix4();
  private viewMatrix = new THREE.Matrix4();
  private worldPosA = new THREE.Vector3();
  private worldPosB = new THREE.Vector3();
  private worldPosC = new THREE.Vector3();
  private viewPosA = new THREE.Vector3();
  private viewPosB = new THREE.Vector3();
  private viewPosC = new THREE.Vector3();
  private ndcA = new THREE.Vector3();
  private ndcB = new THREE.Vector3();
  private ndcC = new THREE.Vector3();
  private faceNormal = new THREE.Vector3();
  private edge1 = new THREE.Vector3();
  private edge2 = new THREE.Vector3();
  private viewDir = new THREE.Vector3();
  private centroid = new THREE.Vector3();
  private halfVecKey = new THREE.Vector3();

  private keyLightDir = new THREE.Vector3(1.6, 3.0, 3.5).normalize();
  private fillLightDir = new THREE.Vector3(-1.8, 1.8, -3.4).normalize();
  private rimLightDir = new THREE.Vector3(-1.2, 2.8, -2.2).normalize();
  private defaultColor = new THREE.Color(0x888888);
  private defaultEmissive = new THREE.Color(0x000000);

  constructor(width: number, height: number) {
    this.domElement = document.createElement('canvas');
    const context = this.domElement.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Canvas 2D context unavailable');
    }
    this.ctx = context;
    this.setSize(width, height);
  }

  public setPixelRatio(pr: number) {
    this.pixelRatio = Math.min(Math.max(1, pr), 1.25);
    this.setSize(this.width, this.height);
  }

  public setSize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.domElement.width = Math.floor(this.width * this.pixelRatio);
    this.domElement.height = Math.floor(this.height * this.pixelRatio);
    this.domElement.style.width = `${this.width}px`;
    this.domElement.style.height = `${this.height}px`;
  }

  private getTri(index: number): RenderTri {
    if (index >= this.triPool.length) {
      this.triPool.push({
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        depth: 0,
        fill: '',
        stroke: null,
      });
    }
    return this.triPool[index];
  }

  public render(scene: THREE.Scene, camera: THREE.Camera) {
    const ctx = this.ctx;
    const W = this.domElement.width;
    const H = this.domElement.height;
    const halfW = W * 0.5;
    const halfH = H * 0.5;

    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.viewMatrix.copy(camera.matrixWorldInverse);
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).projectionMatrix,
      this.viewMatrix,
    );
    const camPos = camera.position;
    const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera;

    const bg = scene.background instanceof THREE.Color ? scene.background : null;
    ctx.fillStyle = bg ? `#${bg.getHexString()}` : '#eef1f4';
    ctx.fillRect(0, 0, W, H);

    let triCount = 0;

    scene.traverse((obj) => {
      if (!obj.visible) return;
      if (!(obj instanceof THREE.Mesh)) return;

      const mat = obj.material as THREE.MeshStandardMaterial & {
        transmission?: number;
      };
      if (!mat || mat.type === 'ShaderMaterial') return;
      if (mat.transparent && (mat.opacity ?? 1) <= 0.02) return;

      const geo = obj.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute('position');
      if (!posAttr) return;

      const indexAttr = geo.getIndex();
      const worldMat = obj.matrixWorld;
      const detSign = worldMat.determinant() < 0 ? -1 : 1;

      const isWireframe = Boolean(mat.wireframe);
      const isDoubleSide = mat.side === THREE.DoubleSide;
      const baseColor = mat.color ?? this.defaultColor;
      const emissiveColor = mat.emissive ?? this.defaultEmissive;
      const emissiveIntensity = mat.emissiveIntensity ?? 0;
      const metalness = mat.metalness ?? 0.25;
      const roughness = mat.roughness ?? 0.5;
      const opacity = mat.transparent ? (mat.opacity ?? 1) : 1;

      const rBase = baseColor.r * 255;
      const gBase = baseColor.g * 255;
      const bBase = baseColor.b * 255;
      const rEm = emissiveColor.r * 255 * emissiveIntensity;
      const gEm = emissiveColor.g * 255 * emissiveIntensity;
      const bEm = emissiveColor.b * 255 * emissiveIntensity;
      const specPower = Math.max(4, Math.round((1 - roughness) * 28));

      const processTriangle = (i0: number, i1: number, i2: number) => {
        this.worldPosA.fromBufferAttribute(posAttr, i0).applyMatrix4(worldMat);
        this.worldPosB.fromBufferAttribute(posAttr, i1).applyMatrix4(worldMat);
        this.worldPosC.fromBufferAttribute(posAttr, i2).applyMatrix4(worldMat);

        this.viewPosA.copy(this.worldPosA).applyMatrix4(this.viewMatrix);
        this.viewPosB.copy(this.worldPosB).applyMatrix4(this.viewMatrix);
        this.viewPosC.copy(this.worldPosC).applyMatrix4(this.viewMatrix);

        if (!isOrtho && (this.viewPosA.z > -0.02 || this.viewPosB.z > -0.02 || this.viewPosC.z > -0.02)) {
          return;
        }

        this.ndcA.copy(this.worldPosA).applyMatrix4(this.projScreenMatrix);
        this.ndcB.copy(this.worldPosB).applyMatrix4(this.projScreenMatrix);
        this.ndcC.copy(this.worldPosC).applyMatrix4(this.projScreenMatrix);

        if (
          Math.max(this.ndcA.x, this.ndcB.x, this.ndcC.x) < -1.1 ||
          Math.min(this.ndcA.x, this.ndcB.x, this.ndcC.x) > 1.1 ||
          Math.max(this.ndcA.y, this.ndcB.y, this.ndcC.y) < -1.1 ||
          Math.min(this.ndcA.y, this.ndcB.y, this.ndcC.y) > 1.1
        ) {
          return;
        }

        const x0 = (this.ndcA.x + 1) * halfW;
        const y0 = (-this.ndcA.y + 1) * halfH;
        const x1 = (this.ndcB.x + 1) * halfW;
        const y1 = (-this.ndcB.y + 1) * halfH;
        const x2 = (this.ndcC.x + 1) * halfW;
        const y2 = (-this.ndcC.y + 1) * halfH;

        const cross2D = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (!isDoubleSide && !isWireframe && cross2D * detSign >= 0) {
          return;
        }
        if (!isWireframe && Math.abs(cross2D) < 0.25) {
          return;
        }

        this.edge1.subVectors(this.worldPosB, this.worldPosA);
        this.edge2.subVectors(this.worldPosC, this.worldPosA);
        this.faceNormal.crossVectors(this.edge1, this.edge2).normalize();

        this.centroid
          .copy(this.worldPosA)
          .add(this.worldPosB)
          .add(this.worldPosC)
          .multiplyScalar(0.333333);
        this.viewDir.subVectors(camPos, this.centroid).normalize();
        if (this.faceNormal.dot(this.viewDir) < 0) {
          this.faceNormal.negate();
        }

        const ndotlKey = Math.max(0, this.faceNormal.dot(this.keyLightDir));
        const ndotlFill = Math.max(0, this.faceNormal.dot(this.fillLightDir));
        const ndotlRim = Math.max(0, this.faceNormal.dot(this.rimLightDir));

        this.halfVecKey.addVectors(this.keyLightDir, this.viewDir).normalize();
        const specKey = Math.pow(Math.max(0, this.faceNormal.dot(this.halfVecKey)), specPower);

        const diff = 0.34 + 0.56 * ndotlKey + 0.28 * ndotlFill + 0.20 * ndotlRim;
        const spec = specKey * (0.25 + 0.75 * metalness) * 140;

        const r = Math.min(255, Math.max(0, rBase * diff + rEm + spec)) | 0;
        const g = Math.min(255, Math.max(0, gBase * diff + gEm + spec)) | 0;
        const b = Math.min(255, Math.max(0, bBase * diff + bEm + spec)) | 0;

        const tri = this.getTri(triCount++);
        tri.x0 = x0;
        tri.y0 = y0;
        tri.x1 = x1;
        tri.y1 = y1;
        tri.x2 = x2;
        tri.y2 = y2;
        tri.depth = (this.viewPosA.z + this.viewPosB.z + this.viewPosC.z) * 0.333333;

        if (isWireframe) {
          tri.fill = '';
          tri.stroke = `rgba(${r},${g},${b},0.75)`;
        } else {
          tri.fill = opacity < 0.99
            ? `rgba(${r},${g},${b},${opacity.toFixed(2)})`
            : `rgb(${r},${g},${b})`;
          tri.stroke = null;
        }
      };

      if (indexAttr) {
        const count = indexAttr.count;
        for (let i = 0; i < count; i += 3) {
          processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
        }
      } else {
        const count = posAttr.count;
        for (let i = 0; i < count; i += 3) {
          processTriangle(i, i + 1, i + 2);
        }
      }
    });

    const activeTris = this.triPool.slice(0, triCount);
    activeTris.sort((a, b) => a.depth - b.depth);

    ctx.lineJoin = 'round';
    for (let i = 0; i < triCount; i++) {
      const t = activeTris[i];
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.closePath();

      if (t.fill) {
        ctx.fillStyle = t.fill;
        ctx.fill();
      }
      if (t.stroke) {
        ctx.strokeStyle = t.stroke;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }
}
