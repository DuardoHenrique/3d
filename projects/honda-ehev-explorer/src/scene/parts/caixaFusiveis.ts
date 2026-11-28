import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

function createAsymmetricLLidGeometry(): THREE.ExtrudeGeometry {
  // Asymmetric L-stepped top cover in (sx = x, sy = -z)
  // Wider along outer-right/rear side, stepped inward at front-left corner
  const s = new THREE.Shape();
  s.moveTo(-0.085, -0.145);
  s.lineTo(0.095, -0.145);
  s.lineTo(0.095, 0.145);
  s.lineTo(-0.035, 0.145);
  s.lineTo(-0.035, 0.035);
  s.lineTo(-0.085, 0.035);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.022,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function buildCaixaFusiveis(mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();

  // Lower Fuse Housing Body
  const lowerBody = new THREE.Mesh(
    createRoundedBoxGeometry(0.215, 0.115, 0.33, 0.024),
    mats.matteDarkPlastic
  );
  lowerBody.position.set(0, -0.04, 0);
  group.add(lowerBody);

  // Main Stepped Base Lid
  const lid = new THREE.Mesh(
    createRoundedBoxGeometry(0.225, 0.046, 0.34, 0.022),
    mats.satinBlackPlastic
  );
  lid.position.set(0, 0.042, 0);
  group.add(lid);

  // Asymmetric L-Stepped Upper Cover
  const lStep = new THREE.Mesh(
    createAsymmetricLLidGeometry(),
    mats.satinBlackPlastic
  );
  lStep.position.set(0.005, 0.064, 0);
  group.add(lStep);

  // Thin, low molded relay-grid ribs on top of cover (height: 0.004)
  // Perimeter frame ribs around relay bay
  for (const rx of [-0.022, 0.088]) {
    const vRib = new THREE.Mesh(
      new THREE.BoxGeometry(0.005, 0.004, 0.24),
      mats.matteDarkPlastic
    );
    vRib.position.set(rx, 0.092, 0.00);
    group.add(vRib);
  }
  for (const rz of [-0.12, -0.04, 0.04, 0.12]) {
    const hRib = new THREE.Mesh(
      new THREE.BoxGeometry(0.115, 0.004, 0.005),
      mats.matteDarkPlastic
    );
    hRib.position.set(0.033, 0.092, rz);
    group.add(hRib);
  }
  const centerDiv = new THREE.Mesh(
    new THREE.BoxGeometry(0.005, 0.004, 0.24),
    mats.matteDarkPlastic
  );
  centerDiv.position.set(0.033, 0.092, 0.00);
  group.add(centerDiv);

  // Chamfered Side Latch Tabs (travas chanfradas)
  for (const lz of [-0.105, 0.095]) {
    const latch = new THREE.Mesh(
      createRoundedBoxGeometry(0.024, 0.058, 0.034, 0.007),
      mats.matteDarkPlastic
    );
    latch.position.set(-0.114, 0.012, lz);
    latch.rotation.z = 0.08;
    group.add(latch);
  }
  const frontLatch = new THREE.Mesh(
    createRoundedBoxGeometry(0.036, 0.054, 0.022, 0.006),
    mats.matteDarkPlastic
  );
  frontLatch.position.set(0.02, 0.014, 0.172);
  frontLatch.rotation.x = -0.10;
  group.add(frontLatch);

  // Molded wiring entry boot at front
  const wireBoot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.024, 0.028, 0.048, 12),
    mats.rubberHose
  );
  wireBoot.rotation.x = Math.PI / 2;
  wireBoot.position.set(-0.04, -0.02, 0.17);
  group.add(wireBoot);

  // Black Wiring Harness Connected Forward Toward the 12V Battery
  const harnessCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.04, -0.02, 0.185),
    new THREE.Vector3(-0.068, -0.028, 0.235),
    new THREE.Vector3(-0.102, -0.020, 0.275),
    new THREE.Vector3(-0.120, -0.002, 0.295),
  ]);
  const harnessTube = new THREE.Mesh(
    new THREE.TubeGeometry(harnessCurve, 18, 0.015, 10, false),
    mats.rubberHose
  );
  group.add(harnessTube);

  const tapeSleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.032, 12),
    mats.satinBlackPlastic
  );
  tapeSleeve.position.copy(harnessCurve.getPointAt(0.55));
  tapeSleeve.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    harnessCurve.getTangentAt(0.55).normalize()
  );
  group.add(tapeSleeve);

  return tagPartHierarchy(group, 'caixa-fusiveis');
}
