import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

function addCorrugatedConduit(
  group: THREE.Group,
  curve: THREE.CatmullRomCurve3,
  radius: number,
  ribCount: number,
  mats: SharedMaterials
): void {
  const tubeGeo = new THREE.TubeGeometry(curve, 64, radius, 14, false);
  const tubeMesh = new THREE.Mesh(tubeGeo, mats.hvOrange);
  group.add(tubeMesh);

  // Fine corrugation rib rings along the curve (eliminates serrated look)
  const ribGeo = new THREE.TorusGeometry(radius * 1.03, radius * 0.11, 8, 16);
  const ribInstanced = new THREE.InstancedMesh(ribGeo, mats.hvOrange, ribCount);
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 0, 1);

  for (let i = 0; i < ribCount; i++) {
    const t = (i + 0.5) / ribCount;
    const pos = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    dummy.position.copy(pos);
    dummy.quaternion.setFromUnitVectors(up, tangent);
    dummy.updateMatrix();
    ribInstanced.setMatrixAt(i, dummy.matrix);
  }
  ribInstanced.instanceMatrix.needsUpdate = true;
  group.add(ribInstanced);
}

export function buildCabosAltaTensao(mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();

  // Primary Left HV Harness — smooth continuous S-curve (r = 0.021, 58 fine ribs)
  // Grounded at rear firewall behind left strut tower, cleared from coolant reservoir at front
  const primaryCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.38, 0.02, -0.36),
    new THREE.Vector3(-0.43, 0.06, -0.20),
    new THREE.Vector3(-0.43, 0.045, -0.01),
    new THREE.Vector3(-0.36, 0.01, 0.14),
    new THREE.Vector3(-0.30, -0.06, 0.22),
    new THREE.Vector3(-0.28, -0.15, 0.20),
  ]);
  addCorrugatedConduit(group, primaryCurve, 0.021, 58, mats);

  // Secondary parallel thin HV line hugging the primary branch (36 ribs)
  const secondaryLeftCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.34, 0.02, -0.34),
    new THREE.Vector3(-0.39, 0.055, -0.18),
    new THREE.Vector3(-0.39, 0.025, 0.01),
    new THREE.Vector3(-0.32, -0.015, 0.13),
  ]);
  addCorrugatedConduit(group, secondaryLeftCurve, 0.014, 36, mats);

  // Rear-Right HV Conduit tucked cleanly between airbox and hybrid coolant reservoir (34 ribs)
  const rightCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.47, 0.10, -0.26),
    new THREE.Vector3(0.50, 0.08, -0.15),
    new THREE.Vector3(0.49, 0.01, -0.04),
    new THREE.Vector3(0.45, -0.08, 0.03),
  ]);
  addCorrugatedConduit(group, rightCurve, 0.022, 34, mats);

  // Under-engine connecting HV bus bar (tucked under oil pan for 360° / exploded view)
  const bridgeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.28, -0.15, 0.20),
    new THREE.Vector3(-0.14, -0.21, 0.06),
    new THREE.Vector3(0.06, -0.22, -0.02),
    new THREE.Vector3(0.30, -0.20, -0.02),
    new THREE.Vector3(0.45, -0.08, 0.03),
  ]);
  const bridgeTube = new THREE.Mesh(
    new THREE.TubeGeometry(bridgeCurve, 28, 0.017, 10, false),
    mats.hvOrange
  );
  group.add(bridgeTube);

  // Rear Firewall Pass-Through Grommet Boot (bota passa-muro traseira)
  const bootGroup = new THREE.Group();
  const bootPos = primaryCurve.getPointAt(0.04);
  const bootTan = primaryCurve.getTangentAt(0.04).normalize();
  bootGroup.position.copy(bootPos);
  bootGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bootTan);

  const bootCone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.044, 0.055, 16),
    mats.satinBlackPlastic
  );
  bootGroup.add(bootCone);

  const bootFlange = new THREE.Mesh(
    createRoundedBoxGeometry(0.082, 0.016, 0.082, 0.014),
    mats.matteDarkPlastic
  );
  bootFlange.position.set(0, -0.022, 0);
  bootGroup.add(bootFlange);
  group.add(bootGroup);

  // Elongated Mid-Curve Retaining Clamp & Bracket (braçadeira alongada no meio da curva)
  const midClampPos = primaryCurve.getPointAt(0.56);
  const midClampTan = primaryCurve.getTangentAt(0.56).normalize();
  const midClampGroup = new THREE.Group();
  midClampGroup.position.copy(midClampPos);
  midClampGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), midClampTan);

  const midClampBody = new THREE.Mesh(
    createRoundedBoxGeometry(0.054, 0.048, 0.095, 0.012),
    mats.satinBlackPlastic
  );
  midClampGroup.add(midClampBody);

  const midClampTab = new THREE.Mesh(
    createRoundedBoxGeometry(0.042, 0.014, 0.038, 0.004),
    mats.steelHardware
  );
  midClampTab.position.set(0.032, 0, 0);
  midClampGroup.add(midClampTab);
  group.add(midClampGroup);

  // White Wrap-Around ID Label (0xefefef) on lower vertical leg of primaryCurve
  const labelPos = primaryCurve.getPointAt(0.80);
  const labelTan = primaryCurve.getTangentAt(0.80).normalize();
  const labelMat = new THREE.MeshStandardMaterial({
    color: 0xefefef,
    roughness: 0.45,
    metalness: 0.02,
  });
  const labelGroup = new THREE.Group();
  labelGroup.position.copy(labelPos);
  labelGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), labelTan);

  const wrapSleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0252, 0.0252, 0.044, 16),
    labelMat
  );
  labelGroup.add(wrapSleeve);

  const labelFlag = new THREE.Mesh(
    new THREE.BoxGeometry(0.004, 0.034, 0.018),
    labelMat
  );
  labelFlag.position.set(0.024, 0, 0.008);
  labelGroup.add(labelFlag);
  group.add(labelGroup);

  // Rear-Right HV Conduit Clamp (hugging airbox / coolant gap)
  const clampRight = new THREE.Mesh(
    createRoundedBoxGeometry(0.056, 0.048, 0.062, 0.01),
    mats.satinBlackPlastic
  );
  clampRight.position.set(0.495, 0.05, -0.10);
  group.add(clampRight);

  // Orange HV lock collar ring
  const lockCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.020, 14),
    mats.hvOrange
  );
  lockCollar.position.copy(primaryCurve.getPointAt(0.68));
  lockCollar.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    primaryCurve.getTangentAt(0.68).normalize()
  );
  group.add(lockCollar);

  return tagPartHierarchy(group, 'cabos-alta-tensao');
}
