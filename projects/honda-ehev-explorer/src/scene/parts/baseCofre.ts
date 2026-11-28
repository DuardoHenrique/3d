import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

function createSlamPanelGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const halfW = 0.82;
  const steps = 16;

  // Front edge (swept U-curve, sy = -z)
  for (let i = 0; i <= steps; i++) {
    const t = -1 + (2 * i) / steps;
    const x = t * halfW;
    const zFront = 0.52 - 0.095 * t * t;
    if (i === 0) shape.moveTo(x, -zFront);
    else shape.lineTo(x, -zFront);
  }
  // Rear edge
  for (let i = steps; i >= 0; i--) {
    const t = -1 + (2 * i) / steps;
    const x = t * halfW;
    const zRear = 0.36 - 0.075 * t * t;
    shape.lineTo(x, -zRear);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.028,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function createLeftFlangeWithWasherCutout(): THREE.ExtrudeGeometry {
  // Horizontal L-flange on left fender (x: -0.88..-0.71, z: -0.50..0.42)
  // tapering smoothly at front corner to merge into bumperLip without protruding blocks
  const shape = new THREE.Shape();
  // CCW in (sx = x, sy = -z)
  shape.moveTo(-0.82, -0.43);
  shape.lineTo(-0.71, -0.43);
  shape.lineTo(-0.71, 0.17);
  shape.lineTo(-0.63, 0.19);
  shape.lineTo(-0.63, 0.33);
  shape.lineTo(-0.71, 0.35);
  shape.lineTo(-0.71, 0.50);
  shape.lineTo(-0.88, 0.50);
  shape.lineTo(-0.88, -0.32);
  shape.quadraticCurveTo(-0.87, -0.40, -0.82, -0.43);
  shape.closePath();

  // CW hole around agua-limpador neck (-0.68, -0.26 -> sy = +0.26)
  const hole = new THREE.Path();
  hole.absarc(-0.68, 0.26, 0.042, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.020,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 14,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function createRightFlangeWithFuseCutout(): THREE.ExtrudeGeometry {
  // Horizontal L-flange on right fender (z: -0.50..0.42)
  // recessed outward to x = 0.778..0.88 in z = -0.24..+0.16, and tapered smoothly at front corner
  const shape = new THREE.Shape();
  // CCW in (sx = x, sy = -z)
  shape.moveTo(0.71, -0.43);
  shape.lineTo(0.82, -0.43);
  shape.quadraticCurveTo(0.87, -0.40, 0.88, -0.32);
  shape.lineTo(0.88, 0.50);
  shape.lineTo(0.71, 0.50);
  shape.lineTo(0.71, 0.25);
  shape.lineTo(0.778, 0.23);
  shape.lineTo(0.778, -0.15);
  shape.lineTo(0.71, -0.17);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.020,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function buildBaseCofre(mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();

  const lowerChassisMat = new THREE.MeshStandardMaterial({
    color: 0x16191e,
    roughness: 0.72,
    metalness: 0.25,
    bumpMap: mats.plasticGrainBump,
    bumpScale: 0.003,
  });

  // Lower structural tray / subframe (kept tucked behind bumper lip)
  const floorTray = new THREE.Mesh(
    createRoundedBoxGeometry(1.64, 0.055, 0.96, 0.14),
    lowerChassisMat
  );
  floorTray.position.set(0, -0.02, -0.02);
  group.add(floorTray);

  // Inner dark engine bay recess liner
  const innerLiner = new THREE.Mesh(
    createRoundedBoxGeometry(1.46, 0.045, 0.84, 0.10),
    mats.matteDarkPlastic
  );
  innerLiner.position.set(0, 0.02, -0.02);
  group.add(innerLiner);

  // Dark inner fender aprons (contorno inferior escuro below white L-flanges)
  for (const side of [-1, 1]) {
    const innerApron = new THREE.Mesh(
      createRoundedBoxGeometry(0.055, 0.18, 0.94, 0.02),
      lowerChassisMat
    );
    innerApron.position.set(side * 0.76, 0.13, -0.04);
    group.add(innerApron);
  }

  // Left & Right Pearl-White Fender Rails as Horizontal L-Flanges (y = 0.22..0.26)
  // Left horizontal flange with cutout for agua-limpador (-0.68, -0.26)
  const leftFlange = new THREE.Mesh(
    createLeftFlangeWithWasherCutout(),
    mats.pearlWhiteBody
  );
  leftFlange.position.set(0, 0.23, 0);
  group.add(leftFlange);

  // Right horizontal flange recessed around caixa-fusiveis (z = -0.24..+0.16)
  const rightFlange = new THREE.Mesh(
    createRightFlangeWithFuseCutout(),
    mats.pearlWhiteBody
  );
  rightFlange.position.set(0, 0.23, 0);
  group.add(rightFlange);

  // Outer vertical fender edge lips completing the L-profile (tapering before front curve)
  for (const side of [-1, 1]) {
    const outerLip = new THREE.Mesh(
      createRoundedBoxGeometry(0.036, 0.086, 0.84, 0.016),
      mats.pearlWhiteBody
    );
    outerLip.position.set(side * 0.865, 0.205, -0.08);
    group.add(outerLip);

    // Stamped bridge tying each strut tower to its outer horizontal rail
    const towerBridge = new THREE.Mesh(
      createRoundedBoxGeometry(0.16, 0.026, 0.14, 0.02),
      mats.pearlWhiteBody
    );
    towerBridge.position.set(side * 0.67, 0.226, -0.37);
    group.add(towerBridge);
  }

  // Front Curved White Bumper Lip sweeping smoothly back into outer fender rails
  const frontCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.858, 0.228, 0.30),
    new THREE.Vector3(-0.820, 0.212, 0.415),
    new THREE.Vector3(-0.54, 0.168, 0.51),
    new THREE.Vector3(0.0, 0.155, 0.545),
    new THREE.Vector3(0.54, 0.168, 0.51),
    new THREE.Vector3(0.820, 0.212, 0.415),
    new THREE.Vector3(0.858, 0.228, 0.30),
  ]);
  const bumperLip = new THREE.Mesh(
    new THREE.TubeGeometry(frontCurve, 44, 0.054, 12, false),
    mats.pearlWhiteBody
  );
  bumperLip.scale.set(1, 0.56, 1);
  group.add(bumperLip);

  // Sculpted Wide Black Slam Panel / Radiator Core Support (z = 0.36..0.52, y = 0.15..0.20)
  const slamPanel = new THREE.Mesh(createSlamPanelGeometry(), mats.satinBlackPlastic);
  slamPanel.position.set(0, 0.152, 0);
  group.add(slamPanel);

  // Raised front/rear stiffening ribs along slam panel
  const slamRibCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.78, 0.188, 0.40),
    new THREE.Vector3(-0.42, 0.186, 0.48),
    new THREE.Vector3(0.0, 0.185, 0.505),
    new THREE.Vector3(0.42, 0.186, 0.48),
    new THREE.Vector3(0.78, 0.188, 0.40),
  ]);
  const slamRib = new THREE.Mesh(
    new THREE.TubeGeometry(slamRibCurve, 32, 0.014, 8, false),
    mats.matteDarkPlastic
  );
  slamRib.scale.set(1, 0.75, 1);
  group.add(slamRib);

  // Recessed latch pocket + Hood Latch Assembly (front center-right)
  const latchWell = new THREE.Mesh(
    createRoundedBoxGeometry(0.20, 0.016, 0.105, 0.015),
    lowerChassisMat
  );
  latchWell.position.set(0.09, 0.182, 0.445);
  group.add(latchWell);

  const latchHousing = new THREE.Mesh(
    createRoundedBoxGeometry(0.14, 0.052, 0.085, 0.016),
    mats.satinBlackPlastic
  );
  latchHousing.position.set(0.09, 0.186, 0.45);
  group.add(latchHousing);

  const latchHook = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.036, 0.025),
    mats.steelHardware
  );
  latchHook.position.set(0.045, 0.202, 0.455);
  group.add(latchHook);

  // Mounting holes / recessed grommets along slam panel
  const holeRingGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.008, 12);
  const holeXPositions = [-0.66, -0.44, -0.22, 0.28, 0.50, 0.68];
  const holeRings = new THREE.InstancedMesh(
    holeRingGeo,
    lowerChassisMat,
    holeXPositions.length
  );
  const dummy = new THREE.Object3D();
  holeXPositions.forEach((hx, idx) => {
    const t = hx / 0.82;
    const hz = 0.45 - 0.085 * t * t;
    dummy.position.set(hx, 0.185, hz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    holeRings.setMatrixAt(idx, dummy.matrix);
  });
  holeRings.instanceMatrix.needsUpdate = true;
  group.add(holeRings);

  // Lowered Front Radiator Core (tucked under slam panel so it doesn't protrude like a wall)
  const radiatorMat = new THREE.MeshStandardMaterial({
    color: 0x22262c,
    roughness: 0.55,
    metalness: 0.55,
    bumpMap: mats.brushedMetal,
    bumpScale: 0.002,
  });
  const radiator = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.13, 0.045),
    radiatorMat
  );
  radiator.position.set(-0.04, 0.05, 0.41);
  group.add(radiator);

  // Rear Black Cowl & Windshield Base Trim (z = -0.50)
  const rearCowl = new THREE.Mesh(
    createRoundedBoxGeometry(1.72, 0.11, 0.17, 0.03),
    mats.satinBlackPlastic
  );
  rearCowl.position.set(0.0, 0.255, -0.50);
  group.add(rearCowl);

  // Cowl weatherstripping ridge
  const sealStrip = new THREE.Mesh(
    createRoundedBoxGeometry(1.66, 0.028, 0.036, 0.01),
    mats.rubberHose
  );
  sealStrip.position.set(0.0, 0.32, -0.435);
  group.add(sealStrip);

  // Horizontal Cowl Vent Grille (InstancedMesh of louver slats)
  const grilleRecess = new THREE.Mesh(
    createRoundedBoxGeometry(1.28, 0.012, 0.085, 0.01),
    lowerChassisMat
  );
  grilleRecess.position.set(0.04, 0.308, -0.515);
  group.add(grilleRecess);

  const slatGeo = new THREE.BoxGeometry(0.56, 0.008, 0.010);
  const slatInstanced = new THREE.InstancedMesh(slatGeo, mats.satinBlackPlastic, 10);
  let slatIdx = 0;
  for (const bankX of [-0.28, 0.36]) {
    for (let row = 0; row < 5; row++) {
      dummy.position.set(bankX, 0.314, -0.545 + row * 0.015);
      dummy.rotation.set(0.28, 0, 0);
      dummy.updateMatrix();
      slatInstanced.setMatrixAt(slatIdx++, dummy.matrix);
    }
  }
  slatInstanced.instanceMatrix.needsUpdate = true;
  group.add(slatInstanced);

  // 2 Windshield Wiper Pivots & Arms on Rear Cowl
  for (const px of [-0.18, 0.38]) {
    const pivot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.020, 0.024, 0.026, 14),
      mats.satinBlackPlastic
    );
    pivot.position.set(px, 0.326, -0.505);
    group.add(pivot);

    const pivotNut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.010, 6),
      mats.steelHardware
    );
    pivotNut.position.set(px, 0.340, -0.505);
    group.add(pivotNut);

    const wiperArm = new THREE.Mesh(
      createRoundedBoxGeometry(0.36, 0.012, 0.018, 0.004),
      mats.matteDarkPlastic
    );
    wiperArm.position.set(px - 0.17, 0.332, -0.525);
    wiperArm.rotation.y = 0.08;
    group.add(wiperArm);
  }

  // Strut Towers (Left & Right) + 3 Mounting Nuts each + slam panel bolts (InstancedMesh)
  const towerGeo = new THREE.CylinderGeometry(0.094, 0.118, 0.18, 20);
  const towerCapGeo = new THREE.CylinderGeometry(0.052, 0.058, 0.026, 16);
  const towerNutGeo = new THREE.CylinderGeometry(0.0095, 0.0095, 0.016, 6);
  const nutsInstanced = new THREE.InstancedMesh(towerNutGeo, mats.steelHardware, 12);
  let nutIdx = 0;

  for (const side of [-1, 1]) {
    const tx = side * 0.58;
    const tz = -0.34;
    const tower = new THREE.Mesh(towerGeo, mats.pearlWhiteBody);
    tower.position.set(tx, 0.16, tz);
    group.add(tower);

    const mountCap = new THREE.Mesh(towerCapGeo, mats.satinBlackPlastic);
    mountCap.position.set(tx, 0.256, tz);
    group.add(mountCap);

    for (let k = 0; k < 3; k++) {
      const ang = (k * Math.PI * 2) / 3 + 0.4;
      dummy.position.set(tx + Math.cos(ang) * 0.072, 0.258, tz + Math.sin(ang) * 0.072);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      nutsInstanced.setMatrixAt(nutIdx++, dummy.matrix);
    }
  }
  // Slam panel bolts matching mounting holes
  holeXPositions.forEach((hx) => {
    const t = hx / 0.82;
    const hz = 0.45 - 0.085 * t * t;
    dummy.position.set(hx, 0.190, hz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    nutsInstanced.setMatrixAt(nutIdx++, dummy.matrix);
  });
  nutsInstanced.instanceMatrix.needsUpdate = true;
  group.add(nutsInstanced);

  // =========================================================================
  // LEFT ENGINE BAY DETAILING (x = -0.74..-0.42): ABS, A/C lines, hose, mount
  // =========================================================================

  // 1. ABS Hydraulic Modulator Module at [-0.58, 0.07, 0.20] + 4 Brake Tubes (r = 0.004)
  const absBlock = new THREE.Mesh(
    createRoundedBoxGeometry(0.092, 0.072, 0.092, 0.012),
    mats.castAluminum
  );
  absBlock.position.set(-0.58, 0.07, 0.20);
  group.add(absBlock);

  const absMotor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.034, 0.056, 16),
    mats.satinBlackPlastic
  );
  absMotor.rotation.x = Math.PI / 2;
  absMotor.position.set(-0.58, 0.068, 0.135);
  group.add(absMotor);

  const absConnector = new THREE.Mesh(
    createRoundedBoxGeometry(0.032, 0.048, 0.045, 0.006),
    mats.satinBlackPlastic
  );
  absConnector.position.set(-0.635, 0.072, 0.20);
  group.add(absConnector);

  for (let i = 0; i < 4; i++) {
    const bx = -0.602 + i * 0.015;
    const bz = 0.178 + (i % 2) * 0.022;
    const brakeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(bx, 0.105, bz),
      new THREE.Vector3(bx, 0.135, bz - 0.03),
      new THREE.Vector3(-0.62 + i * 0.012, 0.145, -0.02),
      new THREE.Vector3(-0.60 + i * 0.012, 0.155, -0.26),
    ]);
    const brakeTube = new THREE.Mesh(
      new THREE.TubeGeometry(brakeCurve, 18, 0.004, 6, false),
      mats.steelHardware
    );
    group.add(brakeTube);
  }

  // 2. Two Parallel Aluminum A/C Lines with H / L Service Valves (Blue & Black caps)
  const acCurve1 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.72, 0.12, -0.34),
    new THREE.Vector3(-0.69, 0.145, -0.10),
    new THREE.Vector3(-0.66, 0.125, 0.14),
    new THREE.Vector3(-0.62, 0.09, 0.33),
  ]);
  const acPipe1 = new THREE.Mesh(
    new THREE.TubeGeometry(acCurve1, 24, 0.010, 8, false),
    mats.polishedAluminum
  );
  group.add(acPipe1);

  const acCurve2 = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.70, 0.10, -0.34),
    new THREE.Vector3(-0.66, 0.125, -0.10),
    new THREE.Vector3(-0.63, 0.105, 0.14),
    new THREE.Vector3(-0.59, 0.07, 0.33),
  ]);
  const acPipe2 = new THREE.Mesh(
    new THREE.TubeGeometry(acCurve2, 24, 0.0085, 8, false),
    mats.polishedAluminum
  );
  group.add(acPipe2);

  // Crimped sleeve on primary A/C line
  const acSleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(0.013, 0.013, 0.055, 12),
    mats.rubberHose
  );
  acSleeve.rotation.x = Math.PI / 2;
  acSleeve.position.set(-0.675, 0.135, 0.02);
  group.add(acSleeve);

  // Service Valve H (Blue cap)
  const acValveStubH = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.009, 0.024, 10),
    mats.polishedAluminum
  );
  acValveStubH.position.set(-0.68, 0.155, -0.14);
  group.add(acValveStubH);

  const acCapBlue = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0115, 0.0115, 0.018, 12),
    new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.36, metalness: 0.05 })
  );
  acCapBlue.position.set(-0.68, 0.172, -0.14);
  group.add(acCapBlue);

  // Service Valve L (Black cap)
  const acValveStubL = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0075, 0.0085, 0.022, 10),
    mats.polishedAluminum
  );
  acValveStubL.position.set(-0.648, 0.135, -0.02);
  group.add(acValveStubL);

  const acCapBlack = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0105, 0.0105, 0.016, 12),
    mats.satinBlackPlastic
  );
  acCapBlack.position.set(-0.648, 0.150, -0.02);
  group.add(acCapBlack);

  // 3. Diagonal Black Rubber Hose (r = 0.018) across left bay
  const diagHoseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.50, 0.16, -0.22),
    new THREE.Vector3(-0.57, 0.145, -0.04),
    new THREE.Vector3(-0.64, 0.11, 0.14),
    new THREE.Vector3(-0.68, 0.07, 0.28),
  ]);
  const diagHose = new THREE.Mesh(
    new THREE.TubeGeometry(diagHoseCurve, 24, 0.018, 12, false),
    mats.rubberHose
  );
  group.add(diagHose);

  // 4. Cast Aluminum Side Engine Mount Bracket at [-0.50, 0.13, -0.05]
  const sideMountArm = new THREE.Mesh(
    createRoundedBoxGeometry(0.115, 0.044, 0.075, 0.012),
    mats.castAluminum
  );
  sideMountArm.position.set(-0.50, 0.13, -0.05);
  group.add(sideMountArm);

  const sideMountBushing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.030, 0.048, 16),
    mats.satinBlackPlastic
  );
  sideMountBushing.position.set(-0.52, 0.135, -0.05);
  group.add(sideMountBushing);

  const sideMountCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.054, 12),
    mats.polishedAluminum
  );
  sideMountCore.position.set(-0.52, 0.135, -0.05);
  group.add(sideMountCore);

  return tagPartHierarchy(group, 'base-cofre');
}
