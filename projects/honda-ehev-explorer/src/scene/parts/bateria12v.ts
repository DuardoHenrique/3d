import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

export function buildBateria12v(
  mats: SharedMaterials,
  batteryTopTexture: THREE.CanvasTexture
): THREE.Group {
  const group = new THREE.Group();
  // Corner alignment angle matching reference photo
  group.rotation.y = -0.24;

  // Battery Tray Base
  const tray = new THREE.Mesh(
    createRoundedBoxGeometry(0.285, 0.022, 0.210, 0.018),
    mats.matteDarkPlastic
  );
  tray.position.set(0, -0.092, 0);
  group.add(tray);

  // Main Battery Case
  const casing = new THREE.Mesh(
    createRoundedBoxGeometry(0.255, 0.185, 0.182, 0.018),
    mats.satinBlackPlastic
  );
  casing.position.set(0, 0.0, 0);
  group.add(casing);

  // Top Battery Decal Plate (high-contrast label)
  const labelMat = new THREE.MeshStandardMaterial({
    map: batteryTopTexture,
    roughness: 0.40,
    metalness: 0.02,
  });
  const topLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.15), labelMat);
  topLabel.rotation.x = -Math.PI / 2;
  topLabel.position.set(0, 0.094, 0);
  group.add(topLabel);

  // Snug Steel Hold-Down Bracket across top (length 0.265)
  const holdBar = new THREE.Mesh(
    createRoundedBoxGeometry(0.265, 0.014, 0.024, 0.005),
    mats.steelHardware
  );
  holdBar.position.set(0, 0.101, 0.005);
  group.add(holdBar);

  // J-bolt tie rods snug against casing sides
  for (const sx of [-0.128, 0.128]) {
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0045, 0.0045, 0.195, 8),
      mats.steelHardware
    );
    rod.position.set(sx, 0.005, 0.005);
    group.add(rod);

    const nut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.012, 6),
      mats.steelHardware
    );
    nut.position.set(sx, 0.112, 0.005);
    group.add(nut);
  }

  // Negative Terminal Post & Black IBS (Intelligent Battery Sensor) on front-left
  const negPost = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.013, 0.026, 12),
    mats.castAluminum
  );
  negPost.position.set(-0.075, 0.104, 0.052);
  group.add(negPost);

  const ibsBracket = new THREE.Mesh(
    new THREE.BoxGeometry(0.028, 0.012, 0.026),
    mats.steelHardware
  );
  ibsBracket.position.set(-0.082, 0.104, 0.055);
  group.add(ibsBracket);

  const ibsSensor = new THREE.Mesh(
    createRoundedBoxGeometry(0.044, 0.022, 0.036, 0.005),
    mats.satinBlackPlastic
  );
  ibsSensor.position.set(-0.098, 0.106, 0.064);
  group.add(ibsSensor);

  const negGroundCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.116, 0.102, 0.072),
    new THREE.Vector3(-0.145, 0.085, 0.092),
    new THREE.Vector3(-0.165, 0.055, 0.105),
  ]);
  const negGroundCable = new THREE.Mesh(
    new THREE.TubeGeometry(negGroundCurve, 12, 0.007, 8, false),
    mats.rubberHose
  );
  group.add(negGroundCable);

  // Compact Red Positive Terminal Protective Boot (rear-right/inboard of battery)
  const redCapMat = new THREE.MeshStandardMaterial({
    color: 0xd92626,
    roughness: 0.36,
    metalness: 0.04,
  });
  const posBoot = new THREE.Mesh(
    createRoundedBoxGeometry(0.052, 0.032, 0.046, 0.010),
    redCapMat
  );
  posBoot.position.set(0.078, 0.110, -0.048);
  group.add(posBoot);

  // Positive feed harness exiting rear of posBoot toward fuse box entry
  const posFeedCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.080, 0.106, -0.066),
    new THREE.Vector3(0.085, 0.096, -0.098),
    new THREE.Vector3(0.082, 0.078, -0.132),
  ]);
  const posFeedCable = new THREE.Mesh(
    new THREE.TubeGeometry(posFeedCurve, 14, 0.0085, 8, false),
    mats.rubberHose
  );
  group.add(posFeedCable);

  return tagPartHierarchy(group, 'bateria-12v');
}
