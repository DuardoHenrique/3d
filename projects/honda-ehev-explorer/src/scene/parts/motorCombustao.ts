import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

function createAsymmetricCoverShape(inset = 0): THREE.Shape {
  // Asymmetric chamfered valve cover silhouette in (sx = x, sy = -z)
  // Front edge is at sy = -0.135 (z = +0.135), rear edge at sy = +0.155 (z = -0.155)
  const s = new THREE.Shape();
  const minX = -0.31 + inset;
  const maxX = 0.31 - inset;
  const frontY = -0.135 + inset;
  const rearY = 0.155 - inset;

  // Start at front-left angled chamfer
  s.moveTo(minX + 0.085, frontY);
  s.lineTo(maxX - 0.035, frontY);
  s.quadraticCurveTo(maxX, frontY, maxX, frontY + 0.035);
  s.lineTo(maxX, rearY - 0.04);
  s.quadraticCurveTo(maxX, rearY, maxX - 0.04, rearY);
  s.lineTo(minX + 0.05, rearY);
  s.quadraticCurveTo(minX, rearY, minX, rearY - 0.05);
  // Chamfered left-front sweep around oil filler corner
  s.lineTo(minX, frontY + 0.095);
  s.quadraticCurveTo(minX + 0.015, frontY + 0.025, minX + 0.085, frontY);
  s.closePath();
  return s;
}

function createCoverTopPlateGeometry(): THREE.ShapeGeometry {
  const outer = createAsymmetricCoverShape(0.022);

  // Circular cutout recess for oilCap at (-0.18, z = +0.03 -> sy = -0.03)
  const hole = new THREE.Path();
  hole.absarc(-0.18, -0.03, 0.048, 0, Math.PI * 2, true);
  outer.holes.push(hole);

  const geo = new THREE.ShapeGeometry(outer, 16);

  // Normalize planar UVs to [0..1] so HONDA cover texture maps cleanly
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const minX = -0.288;
  const maxX = 0.288;
  const minY = -0.113;
  const maxY = 0.133;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uv.setXY(i, (x - minX) / (maxX - minX), (y - minY) / (maxY - minY));
  }
  uv.needsUpdate = true;
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function createHeatShieldGeometry(): THREE.ExtrudeGeometry {
  // Stamped trapezoidal heat shield: width 0.20 at top -> 0.12 at base
  const shape = new THREE.Shape();
  const topHW = 0.10;
  const botHW = 0.06;
  const topY = 0.072;
  const botY = -0.082;

  shape.moveTo(-botHW + 0.018, botY);
  shape.lineTo(botHW - 0.018, botY);
  shape.quadraticCurveTo(botHW, botY, botHW + 0.008, botY + 0.026);
  shape.lineTo(topHW, topY - 0.026);
  shape.quadraticCurveTo(topHW, topY, topHW - 0.022, topY);
  shape.lineTo(-topHW + 0.022, topY);
  shape.quadraticCurveTo(-topHW, topY, -topHW, topY - 0.026);
  shape.lineTo(-botHW - 0.008, botY + 0.026);
  shape.quadraticCurveTo(-botHW, botY, -botHW + 0.018, botY);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.020,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.010,
    bevelSegments: 4,
    curveSegments: 8,
  });
  geo.center();
  return geo;
}

export function buildMotorCombustao(
  mats: SharedMaterials,
  coverTexture: THREE.CanvasTexture
): THREE.Group {
  const group = new THREE.Group();

  // Dedicated darkened & compact aluminum engine block material
  const engineBlockMat = new THREE.MeshStandardMaterial({
    color: 0x525862,
    roughness: 0.68,
    metalness: 0.72,
    bumpMap: mats.brushedMetal,
    bumpScale: 0.0025,
  });

  // Lower cast aluminum engine block (reduced and darkened)
  const blockMain = new THREE.Mesh(
    createRoundedBoxGeometry(0.54, 0.16, 0.30, 0.035),
    engineBlockMat
  );
  blockMain.position.set(0.0, -0.02, -0.02);
  group.add(blockMain);

  // Crankcase / oil pan bottom sump
  const oilPan = new THREE.Mesh(
    createRoundedBoxGeometry(0.46, 0.075, 0.25, 0.03),
    mats.matteDarkPlastic
  );
  oilPan.position.set(0.0, -0.13, -0.02);
  group.add(oilPan);

  // Cylinder head cooling fins / ribs on sides
  for (let i = -2; i <= 2; i++) {
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 0.012, 0.28),
      engineBlockMat
    );
    rib.position.set(0, -0.045 + i * 0.024, -0.02);
    group.add(rib);
  }

  // Side transmission / e-CVT transaxle housing hint on right side
  const transaxle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.095, 0.105, 0.16, 16),
    engineBlockMat
  );
  transaxle.rotation.z = Math.PI / 2;
  transaxle.position.set(0.25, -0.08, -0.02);
  group.add(transaxle);

  // Rear intake manifold plenum behind valve cover
  const intakePlenum = new THREE.Mesh(
    createRoundedBoxGeometry(0.44, 0.10, 0.13, 0.04),
    mats.satinBlackPlastic
  );
  intakePlenum.position.set(0.02, 0.08, -0.21);
  group.add(intakePlenum);

  // Dark cylindrical resonator body nestled low behind intake plenum
  const rearResonator = new THREE.Mesh(
    new THREE.CylinderGeometry(0.044, 0.044, 0.22, 16),
    mats.satinBlackPlastic
  );
  rearResonator.rotation.z = Math.PI / 2;
  rearResonator.position.set(0.07, 0.123, -0.275);
  group.add(rearResonator);

  const rearResonatorCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.046, 0.046, 0.036, 16),
    mats.matteDarkPlastic
  );
  rearResonatorCap.rotation.z = Math.PI / 2;
  rearResonatorCap.position.set(-0.03, 0.123, -0.275);
  group.add(rearResonatorCap);

  // 2 Curved Aluminum Tubes (r = 0.0065) tucked low and snug to intakePlenum
  const rearAlumCurve1 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.09, 0.110, -0.23),
    new THREE.Vector3(-0.06, 0.145, -0.265),
    new THREE.Vector3(0.01, 0.143, -0.285),
    new THREE.Vector3(0.07, 0.120, -0.265),
  ]);
  group.add(
    new THREE.Mesh(
      new THREE.TubeGeometry(rearAlumCurve1, 18, 0.0065, 8, false),
      mats.polishedAluminum
    )
  );

  const rearAlumCurve2 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.01, 0.107, -0.235),
    new THREE.Vector3(0.07, 0.141, -0.270),
    new THREE.Vector3(0.14, 0.139, -0.295),
    new THREE.Vector3(0.19, 0.113, -0.275),
  ]);
  group.add(
    new THREE.Mesh(
      new THREE.TubeGeometry(rearAlumCurve2, 18, 0.0065, 8, false),
      mats.polishedAluminum
    )
  );

  // Top Acoustic Valve Cover — Asymmetric chamfered ExtrudeGeometry
  const coverShape = createAsymmetricCoverShape(0);
  const coverGeo = new THREE.ExtrudeGeometry(coverShape, {
    depth: 0.056,
    bevelEnabled: true,
    bevelThickness: 0.016,
    bevelSize: 0.016,
    bevelSegments: 4,
    curveSegments: 10,
  });
  coverGeo.rotateX(-Math.PI / 2);

  const coverBase = new THREE.Mesh(coverGeo, mats.matteDarkPlastic);
  coverBase.position.set(0.0, 0.074, -0.02);
  group.add(coverBase);

  // Top face graphic plate seamlessly flush on top of asymmetric cover (with oilCap hole)
  const coverTopMat = new THREE.MeshStandardMaterial({
    map: coverTexture,
    roughness: 0.64,
    metalness: 0.04,
    bumpMap: mats.plasticGrainBump,
    bumpScale: 0.003,
  });

  const coverGraphicPlate = new THREE.Mesh(createCoverTopPlateGeometry(), coverTopMat);
  coverGraphicPlate.position.set(0.0, 0.1465, -0.02);
  group.add(coverGraphicPlate);

  // Molded upper channel groove & raised flanking rails on cover top
  for (const rz of [-0.108, -0.058]) {
    const channelRail = new THREE.Mesh(
      createRoundedBoxGeometry(0.44, 0.014, 0.016, 0.005),
      mats.matteDarkPlastic
    );
    channelRail.position.set(0.02, 0.151, rz);
    group.add(channelRail);
  }
  const channelFloor = new THREE.Mesh(
    createRoundedBoxGeometry(0.42, 0.006, 0.036, 0.006),
    mats.satinBlackPlastic
  );
  channelFloor.position.set(0.02, 0.147, -0.083);
  group.add(channelFloor);

  // Circular recessed pocket bezel + Oil Filler Cap (front-left on cover)
  const oilPocketRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.046, 0.008, 8, 22),
    mats.matteDarkPlastic
  );
  oilPocketRing.rotation.x = Math.PI / 2;
  oilPocketRing.scale.set(1, 1, 0.75);
  oilPocketRing.position.set(-0.18, 0.146, 0.01);
  group.add(oilPocketRing);

  const oilCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.036, 0.022, 20),
    mats.satinBlackPlastic
  );
  oilCap.position.set(-0.18, 0.148, 0.01);
  group.add(oilCap);

  const oilCapTab = new THREE.Mesh(
    new THREE.BoxGeometry(0.058, 0.012, 0.014),
    mats.matteDarkPlastic
  );
  oilCapTab.position.set(-0.18, 0.161, 0.01);
  oilCapTab.rotation.y = 0.4;
  group.add(oilCapTab);

  // Subtle recessed ring / notch on top of oilCap
  const oilCapRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.025, 0.0028, 6, 18),
    mats.satinBlackPlastic
  );
  oilCapRing.rotation.x = Math.PI / 2;
  oilCapRing.position.set(-0.18, 0.1595, 0.01);
  group.add(oilCapRing);

  // Front Horizontal Black Corrugated Wiring Harness (y = 0.06, z = 0.155)
  const frontHarnessCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.23, 0.06, 0.148),
    new THREE.Vector3(-0.08, 0.06, 0.156),
    new THREE.Vector3(0.08, 0.06, 0.156),
    new THREE.Vector3(0.22, 0.055, 0.148),
  ]);
  const frontHarness = new THREE.Mesh(
    new THREE.TubeGeometry(frontHarnessCurve, 24, 0.0095, 8, false),
    mats.rubberHose
  );
  group.add(frontHarness);

  const hRibGeo = new THREE.TorusGeometry(0.0105, 0.0022, 6, 10);
  const hRibCount = 22;
  const hRibs = new THREE.InstancedMesh(hRibGeo, mats.rubberHose, hRibCount);
  const dummy = new THREE.Object3D();
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < hRibCount; i++) {
    const t = (i + 0.5) / hRibCount;
    dummy.position.copy(frontHarnessCurve.getPointAt(t));
    dummy.quaternion.setFromUnitVectors(zAxis, frontHarnessCurve.getTangentAt(t).normalize());
    dummy.updateMatrix();
    hRibs.setMatrixAt(i, dummy.matrix);
  }
  hRibs.instanceMatrix.needsUpdate = true;
  group.add(hRibs);

  // Small harness retention clip / ID tag
  const harnessTag = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.014, 0.006),
    new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.5 })
  );
  harnessTag.position.set(-0.085, 0.058, 0.166);
  group.add(harnessTag);

  // Stamped Trapezoidal Brushed-Aluminum Exhaust Heat Shield (width 0.20 top -> 0.12 base)
  const heatShield = new THREE.Mesh(
    createHeatShieldGeometry(),
    mats.polishedAluminum
  );
  heatShield.position.set(0.02, -0.022, 0.165);
  heatShield.rotation.x = 0.14;
  group.add(heatShield);

  // Stamped vertical flutes on heat shield
  for (const fx of [-0.024, 0.064]) {
    const flute = new THREE.Mesh(
      createRoundedBoxGeometry(0.018, 0.09, 0.012, 0.004),
      mats.polishedAluminum
    );
    flute.position.set(fx, -0.026, 0.180);
    flute.rotation.x = 0.14;
    group.add(flute);
  }

  // 3 Mounting Bolts on Heat Shield
  const boltGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.012, 6);
  const boltCoords: [number, number, number][] = [
    [-0.055, 0.034, 0.186],
    [0.095, 0.034, 0.186],
    [0.02, -0.086, 0.172],
  ];
  for (const [bx, by, bz] of boltCoords) {
    const bolt = new THREE.Mesh(boltGeo, mats.steelHardware);
    bolt.rotation.x = Math.PI / 2 + 0.14;
    bolt.position.set(bx, by, bz);
    group.add(bolt);
  }

  // Oxygen (Lambda) Sensor protruding from center of heat shield
  const o2Boss = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.016, 0.042, 8),
    mats.steelHardware
  );
  o2Boss.rotation.x = Math.PI / 2 - 0.18;
  o2Boss.position.set(0.02, 0.006, 0.194);
  group.add(o2Boss);

  const o2Cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.011, 0.024, 10),
    mats.satinBlackPlastic
  );
  o2Cap.rotation.x = Math.PI / 2 - 0.18;
  o2Cap.position.set(0.02, 0.010, 0.218);
  group.add(o2Cap);

  // Lower fluted catalytic converter / exhaust body visible below heatShield
  const catBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.058, 0.064, 0.09, 16),
    engineBlockMat
  );
  catBody.position.set(0.02, -0.14, 0.15);
  group.add(catBody);

  for (const cy of [-0.118, -0.14, -0.162]) {
    const catRib = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.004, 6, 18),
      engineBlockMat
    );
    catRib.rotation.x = Math.PI / 2;
    catRib.position.set(0.02, cy, 0.15);
    group.add(catRib);
  }

  // White Lambda Sensor Cable (r = 0.0045, 0xe2e4e8) arching high to black connector at [0.13, -0.01, 0.19]
  const o2CableCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.02, 0.010, 0.222),
    new THREE.Vector3(0.075, 0.028, 0.228),
    new THREE.Vector3(0.112, 0.006, 0.210),
    new THREE.Vector3(0.13, -0.01, 0.19),
  ]);
  const o2WhiteCable = new THREE.Mesh(
    new THREE.TubeGeometry(o2CableCurve, 20, 0.0045, 8, false),
    new THREE.MeshStandardMaterial({ color: 0xe2e4e8, roughness: 0.45, metalness: 0.04 })
  );
  group.add(o2WhiteCable);

  const o2Connector = new THREE.Mesh(
    createRoundedBoxGeometry(0.032, 0.024, 0.030, 0.006),
    mats.satinBlackPlastic
  );
  o2Connector.position.set(0.13, -0.01, 0.19);
  group.add(o2Connector);

  // Right-side Actuator Assembly (next to heat shield & connector)
  const actuatorFlange = new THREE.Mesh(
    createRoundedBoxGeometry(0.058, 0.054, 0.048, 0.010),
    engineBlockMat
  );
  actuatorFlange.position.set(0.19, 0.01, 0.155);
  group.add(actuatorFlange);

  const actuatorMotor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.052, 16),
    mats.satinBlackPlastic
  );
  actuatorMotor.position.set(0.195, 0.025, 0.178);
  group.add(actuatorMotor);

  const actuatorCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.020, 0.022, 0.018, 12),
    mats.matteDarkPlastic
  );
  actuatorCap.position.set(0.195, 0.055, 0.178);
  group.add(actuatorCap);

  // Lower Curved Black Coolant Hose on right side
  const lowerHoseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.21, -0.04, 0.13),
    new THREE.Vector3(0.255, -0.085, 0.175),
    new THREE.Vector3(0.28, -0.145, 0.215),
  ]);
  const lowerHose = new THREE.Mesh(
    new THREE.TubeGeometry(lowerHoseCurve, 18, 0.020, 12, false),
    mats.rubberHose
  );
  group.add(lowerHose);

  const lowerHoseClamp = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.010, 14),
    mats.steelHardware
  );
  lowerHoseClamp.rotation.x = 0.65;
  lowerHoseClamp.rotation.z = -0.35;
  lowerHoseClamp.position.set(0.268, -0.115, 0.195);
  group.add(lowerHoseClamp);

  // Orange Engine Oil Dipstick Handle (left-front)
  const dipstickStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0045, 0.0045, 0.075, 8),
    mats.steelHardware
  );
  dipstickStem.position.set(-0.145, 0.02, 0.155);
  dipstickStem.rotation.z = 0.25;
  group.add(dipstickStem);

  const dipstickLoop = new THREE.Mesh(
    new THREE.TorusGeometry(0.015, 0.0055, 8, 16),
    mats.hvOrange
  );
  dipstickLoop.position.set(-0.16, 0.056, 0.155);
  group.add(dipstickLoop);

  return tagPartHierarchy(group, 'motor-combustao');
}
