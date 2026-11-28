import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

function createUIntakeScoopWallsGeometry(): THREE.ExtrudeGeometry {
  // Rectangular U-shaped raised rim open toward the rear (+Z open is -Z in Shape sy)
  // Outer rect: width 0.17 (x: -0.085..0.085), depth 0.13 (z: -0.065..0.065 -> sy: -0.065..0.065)
  // Open at rear (sy = +0.065 -> z = -0.065) where bellows enters
  const s = new THREE.Shape();
  const ow = 0.086;
  const od = 0.065;
  const wall = 0.016;
  const iw = ow - wall;
  const idFront = od - wall;

  // Trace U-shape perimeter in (sx = x, sy = -z)
  // Start at rear-left outer corner (sy = +od)
  s.moveTo(-ow, od);
  s.lineTo(-ow, -od + 0.018);
  s.quadraticCurveTo(-ow, -od, -ow + 0.018, -od);
  s.lineTo(ow - 0.018, -od);
  s.quadraticCurveTo(ow, -od, ow, -od + 0.018);
  s.lineTo(ow, od);
  // Step inward to inner right edge
  s.lineTo(iw, od);
  s.lineTo(iw, -idFront + 0.010);
  s.quadraticCurveTo(iw, -idFront, iw - 0.010, -idFront);
  s.lineTo(-iw + 0.010, -idFront);
  s.quadraticCurveTo(-iw, -idFront, -iw, -idFront + 0.010);
  s.lineTo(-iw, od);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.044,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function buildAdmissaoFiltroAr(mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();

  // Main Vertical Air Filter Housing (tall black ribbed box right of engine cover)
  const lowerBox = new THREE.Mesh(
    createRoundedBoxGeometry(0.21, 0.12, 0.48, 0.03),
    mats.matteDarkPlastic
  );
  lowerBox.position.set(0.0, -0.05, -0.06);
  group.add(lowerBox);

  const upperLid = new THREE.Mesh(
    createRoundedBoxGeometry(0.20, 0.078, 0.46, 0.03),
    mats.satinBlackPlastic
  );
  upperLid.position.set(0.0, 0.04, -0.06);
  group.add(upperLid);

  // Characteristic Inverted-"L" Channel / Rib Molded on Top of Airbox Lid
  // Recessed dark slot bed
  const lSlotLong = new THREE.Mesh(
    createRoundedBoxGeometry(0.022, 0.008, 0.30, 0.004),
    mats.matteDarkPlastic
  );
  lSlotLong.position.set(-0.025, 0.079, -0.08);
  group.add(lSlotLong);

  const lSlotShort = new THREE.Mesh(
    createRoundedBoxGeometry(0.105, 0.008, 0.024, 0.004),
    mats.matteDarkPlastic
  );
  lSlotShort.position.set(0.022, 0.079, 0.058);
  group.add(lSlotShort);

  // Raised framing ribs forming the inverted "L" shoulder
  const lRibLeft = new THREE.Mesh(
    createRoundedBoxGeometry(0.018, 0.016, 0.34, 0.006),
    mats.satinBlackPlastic
  );
  lRibLeft.position.set(-0.052, 0.083, -0.07);
  group.add(lRibLeft);

  const lRibInnerLong = new THREE.Mesh(
    createRoundedBoxGeometry(0.018, 0.016, 0.25, 0.006),
    mats.satinBlackPlastic
  );
  lRibInnerLong.position.set(0.002, 0.083, -0.095);
  group.add(lRibInnerLong);

  const lRibFrontTop = new THREE.Mesh(
    createRoundedBoxGeometry(0.125, 0.016, 0.020, 0.006),
    mats.satinBlackPlastic
  );
  lRibFrontTop.position.set(0.015, 0.083, 0.082);
  group.add(lRibFrontTop);

  const lRibFrontBottom = new THREE.Mesh(
    createRoundedBoxGeometry(0.082, 0.016, 0.018, 0.006),
    mats.satinBlackPlastic
  );
  lRibFrontBottom.position.set(0.036, 0.083, 0.036);
  group.add(lRibFrontBottom);

  // Outer stepped shelf on right half of airbox lid
  const outerShelf = new THREE.Mesh(
    createRoundedBoxGeometry(0.052, 0.014, 0.22, 0.008),
    mats.satinBlackPlastic
  );
  outerShelf.position.set(0.062, 0.080, -0.15);
  group.add(outerShelf);

  // 3 Metallic Spring Retention Clips along outer side seam
  for (const cz of [-0.19, -0.05, 0.09]) {
    const clip = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.052, 0.024),
      mats.steelHardware
    );
    clip.position.set(0.103, 0.0, cz);
    group.add(clip);

    const clipTab = new THREE.Mesh(
      new THREE.BoxGeometry(0.020, 0.008, 0.022),
      mats.steelHardware
    );
    clipTab.position.set(0.096, 0.026, cz);
    group.add(clipTab);
  }

  // Curved Accordion Bellows Duct leading forward to front intake scoop
  const bellowsCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.0, 0.02, 0.16),
    new THREE.Vector3(0.005, -0.002, 0.235),
    new THREE.Vector3(-0.025, -0.036, 0.295),
    new THREE.Vector3(-0.065, -0.065, 0.345),
  ]);
  const bellowsTube = new THREE.Mesh(
    new THREE.TubeGeometry(bellowsCurve, 32, 0.047, 16, false),
    mats.rubberHose
  );
  group.add(bellowsTube);

  // 11 Finer, Closely Spaced Accordion Rings (TorusGeometry(0.052, 0.0065, 8, 18))
  const ringCount = 11;
  const ringGeo = new THREE.TorusGeometry(0.052, 0.0065, 8, 18);
  const rings = new THREE.InstancedMesh(ringGeo, mats.rubberHose, ringCount);
  const dummy = new THREE.Object3D();
  const zAxis = new THREE.Vector3(0, 0, 1);

  for (let i = 0; i < ringCount; i++) {
    const t = 0.13 + (i / (ringCount - 1)) * 0.69;
    const p = bellowsCurve.getPointAt(t);
    const tangent = bellowsCurve.getTangentAt(t).normalize();
    dummy.position.copy(p);
    dummy.quaternion.setFromUnitVectors(zAxis, tangent);
    dummy.updateMatrix();
    rings.setMatrixAt(i, dummy.matrix);
  }
  rings.instanceMatrix.needsUpdate = true;
  group.add(rings);

  // 2 Metallic Hose Clamps (airbox outlet + scoop inlet)
  const bandGeo = new THREE.CylinderGeometry(0.053, 0.053, 0.011, 18);
  for (const tClamp of [0.04, 0.89]) {
    const clamp = new THREE.Mesh(bandGeo, mats.steelHardware);
    clamp.position.copy(bellowsCurve.getPointAt(tClamp));
    clamp.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      bellowsCurve.getTangentAt(tClamp).normalize()
    );
    group.add(clamp);
  }

  // Front Snorkel / Fresh Air Intake Scoop: Rectangular U with Raised Rim seated on slam panel
  const scoopGroup = new THREE.Group();
  scoopGroup.position.set(-0.07, -0.075, 0.40);

  const scoopBase = new THREE.Mesh(
    createRoundedBoxGeometry(0.172, 0.022, 0.132, 0.018),
    mats.satinBlackPlastic
  );
  scoopGroup.add(scoopBase);

  const scoopInterior = new THREE.Mesh(
    createRoundedBoxGeometry(0.132, 0.014, 0.095, 0.010),
    mats.matteDarkPlastic
  );
  scoopInterior.position.set(0, 0.010, 0.008);
  scoopGroup.add(scoopInterior);

  const scoopURim = new THREE.Mesh(
    createUIntakeScoopWallsGeometry(),
    mats.satinBlackPlastic
  );
  scoopURim.position.set(0, 0.006, 0);
  scoopGroup.add(scoopURim);

  group.add(scoopGroup);

  // Rear outlet elbow toward throttle body / intake plenum
  const rearCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.06, 0.02, -0.26),
    new THREE.Vector3(-0.18, 0.03, -0.32),
    new THREE.Vector3(-0.34, 0.02, -0.28),
  ]);
  const rearPipe = new THREE.Mesh(
    new THREE.TubeGeometry(rearCurve, 18, 0.040, 14, false),
    mats.rubberHose
  );
  group.add(rearPipe);

  return tagPartHierarchy(group, 'admissao-filtro-ar');
}
