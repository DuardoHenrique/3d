import * as THREE from 'three';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context for procedural texture.');
  }
  return [canvas, ctx];
}

export function createPlasticGrainBumpTexture(seed = 42): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  const rand = mulberry32(seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(110 + rand() * 48);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

export function createBrushedMetalTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  const rand = mulberry32(99);
  ctx.fillStyle = '#888c92';
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    const lum = Math.floor(115 + rand() * 55);
    ctx.fillStyle = `rgb(${lum},${lum + 2},${lum + 5})`;
    ctx.fillRect(0, y, size, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

export function createHondaEngineCoverTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const [canvas, ctx] = makeCanvas(width, height);
  const rand = mulberry32(101);

  // Base charcoal matte texture
  ctx.fillStyle = '#26292f';
  ctx.fillRect(0, 0, width, height);

  // Subtle plastic grain
  for (let i = 0; i < 16000; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const g = Math.floor(30 + rand() * 20);
    ctx.fillStyle = `rgba(${g},${g + 2},${g + 4},0.35)`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Recessed top channel stripe
  ctx.fillStyle = '#1b1e23';
  ctx.beginPath();
  ctx.roundRect(120, 54, 720, 96, 18);
  ctx.fill();
  ctx.strokeStyle = '#3b414c';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Molded subtle contour lines
  ctx.strokeStyle = '#16181d';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(42, 32, width - 84, height - 64, 34);
  ctx.stroke();

  // Embossed HONDA lettering (OEM molded charcoal tone)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 124px "Arial Black", "Segoe UI", sans-serif';
  // Subtle top-left bevel catchlight
  ctx.fillStyle = '#4f5663';
  ctx.fillText('HONDA', width * 0.56 - 2, height * 0.59 - 2);
  // Deep bottom-right recessed shadow
  ctx.fillStyle = '#12151a';
  ctx.fillText('HONDA', width * 0.56 + 4, height * 0.59 + 5);
  // Main embossed letter face
  ctx.fillStyle = '#3a404a';
  ctx.fillText('HONDA', width * 0.56, height * 0.59);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createBatteryTopTexture(): THREE.CanvasTexture {
  const width = 512;
  const height = 384;
  const [canvas, ctx] = makeCanvas(width, height);

  ctx.fillStyle = '#17191d';
  ctx.fillRect(0, 0, width, height);

  // Subtle vent cap strip along top
  ctx.fillStyle = '#252930';
  ctx.fillRect(36, 22, 440, 34);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = '#14161a';
    ctx.beginPath();
    ctx.arc(78 + i * 71, 39, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#383d46';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // High-contrast warning & spec decal
  ctx.fillStyle = '#f6f8fb';
  ctx.fillRect(58, 72, 396, 248);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 3;
  ctx.strokeRect(58, 72, 396, 248);

  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(58, 72, 396, 44);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 25px sans-serif';
  ctx.fillText('12V AUXILIARY BATTERY', 76, 102);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 22px monospace';
  ctx.fillText('AGM  45Ah  CCA 380A', 76, 154);

  ctx.fillStyle = '#dc2626';
  ctx.fillRect(76, 180, 104, 42);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('e:HEV', 94, 209);

  // Polarity & caution blocks
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(198, 182, 234, 18);
  ctx.fillStyle = '#475569';
  ctx.fillRect(198, 210, 190, 14);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(76, 244, 356, 28);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('DO NOT OPEN  •  SEALED AGM', 112, 263);

  // Yellow hazard triangle icon on right
  ctx.fillStyle = '#eab308';
  ctx.beginPath();
  ctx.moveTo(416, 190);
  ctx.lineTo(438, 226);
  ctx.lineTo(394, 226);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('!', 412, 222);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRadiatorCapTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);

  ctx.fillStyle = '#cfd5dc';
  ctx.fillRect(0, 0, size, size);

  // Outer brushed metallic bevel ring
  ctx.strokeStyle = '#9aa2ac';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(128, 128, 108, 0, Math.PI * 2);
  ctx.stroke();

  // Centered white caution label disc inside brushed metal border
  ctx.fillStyle = '#f3f4f6';
  ctx.beginPath();
  ctx.arc(128, 128, 60, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Crisp slim red warning band across upper-center of label
  ctx.save();
  ctx.beginPath();
  ctx.arc(128, 128, 58, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(68, 86, 120, 32);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 17px sans-serif';
  ctx.fillText('HOT', 128, 102);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('1.1', 128, 150);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createWasherCapTexture(): THREE.CanvasTexture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);

  ctx.fillStyle = '#1d75d8';
  ctx.fillRect(0, 0, size, size);

  // Windshield icon in white
  ctx.strokeStyle = '#eef6ff';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(64, 152);
  ctx.quadraticCurveTo(128, 104, 192, 152);
  ctx.lineTo(174, 196);
  ctx.quadraticCurveTo(128, 166, 82, 196);
  ctx.closePath();
  ctx.stroke();

  // Spray arcs
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(128, 134);
  ctx.quadraticCurveTo(96, 82, 74, 72);
  ctx.moveTo(128, 134);
  ctx.quadraticCurveTo(160, 82, 182, 72);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
