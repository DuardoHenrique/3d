import * as THREE from 'three';
import { createRoundedBoxGeometry, SharedMaterials, tagPartHierarchy } from './shared';

export function buildArrefecimentoHibrido(
  mats: SharedMaterials,
  radiatorCapTex: THREE.CanvasTexture
): THREE.Group {
  const group = new THREE.Group();

  // Compact translucent milky HDPE tank beside airbox & fuse box (inverter/PCU cooling loop)
  const tankShell = new THREE.Mesh(
    createRoundedBoxGeometry(0.105, 0.125, 0.165, 0.028),
    mats.translucentHdpe
  );
  group.add(tankShell);

  // Desaturated teal inverter coolant fluid in lower half
  const fluidMat = new THREE.MeshStandardMaterial({
    color: 0x4f9a97,
    roughness: 0.30,
    metalness: 0.03,
  });
  const innerFluid = new THREE.Mesh(
    createRoundedBoxGeometry(0.084, 0.056, 0.138, 0.020),
    fluidMat
  );
  innerFluid.position.set(0, -0.026, 0);
  group.add(innerFluid);

  // Neck and pressure cap
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.026, 0.028, 16),
    mats.translucentHdpe
  );
  neck.position.set(0.005, 0.072, 0.015);
  group.add(neck);

  const capMat = new THREE.MeshStandardMaterial({
    map: radiatorCapTex,
    roughness: 0.30,
    metalness: 0.58,
  });
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.015, 18),
    [mats.polishedAluminum, capMat, mats.polishedAluminum]
  );
  cap.position.set(0.005, 0.090, 0.015);
  group.add(cap);

  // Coolant return hose stub
  const hoseStub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.052, 10),
    mats.rubberHose
  );
  hoseStub.rotation.z = Math.PI / 2;
  hoseStub.position.set(-0.07, 0.035, 0.04);
  group.add(hoseStub);

  return tagPartHierarchy(group, 'arrefecimento-hibrido');
}

export function buildArrefecimentoMotor(
  mats: SharedMaterials,
  radiatorCapTex: THREE.CanvasTexture
): THREE.Group {
  const group = new THREE.Group();

  // Front-left milky HDPE expansion reservoir + pressurized radiator neck
  const mainTank = new THREE.Mesh(
    createRoundedBoxGeometry(0.17, 0.12, 0.135, 0.034),
    mats.translucentHdpe
  );
  mainTank.position.set(-0.02, -0.005, -0.015);
  group.add(mainTank);

  // Desaturated blue-teal engine coolant in lower half
  const coolantMat = new THREE.MeshStandardMaterial({
    color: 0x48829e,
    roughness: 0.30,
    metalness: 0.03,
  });
  const fluidCore = new THREE.Mesh(
    createRoundedBoxGeometry(0.14, 0.052, 0.11, 0.024),
    coolantMat
  );
  fluidCore.position.set(-0.02, -0.034, -0.015);
  group.add(fluidCore);

  // Side pressurized radiator filler tower
  const fillerColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.040, 0.095, 18),
    mats.translucentHdpe
  );
  fillerColumn.position.set(0.078, 0.030, 0.01);
  group.add(fillerColumn);

  // Prominent Metallic Radiator Cap with side locking ears & red/white caution sticker
  const capMat = new THREE.MeshStandardMaterial({
    map: radiatorCapTex,
    roughness: 0.24,
    metalness: 0.72,
  });
  const radiatorCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.018, 22),
    [mats.polishedAluminum, capMat, mats.polishedAluminum]
  );
  radiatorCap.position.set(0.078, 0.086, 0.01);
  group.add(radiatorCap);

  const capEars = new THREE.Mesh(
    createRoundedBoxGeometry(0.082, 0.009, 0.018, 0.004),
    mats.polishedAluminum
  );
  capEars.position.set(0.078, 0.084, 0.01);
  capEars.rotation.y = 0.45;
  group.add(capEars);

  // Thin curved overflow/bleed hose connecting filler neck to expansion tank top
  const bleedHoseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.052, 0.068, 0.01),
    new THREE.Vector3(0.018, 0.084, 0.005),
    new THREE.Vector3(-0.015, 0.072, -0.008),
    new THREE.Vector3(-0.025, 0.055, -0.015),
  ]);
  const bleedHose = new THREE.Mesh(
    new THREE.TubeGeometry(bleedHoseCurve, 18, 0.0065, 8, false),
    mats.rubberHose
  );
  group.add(bleedHose);

  // Thick black radiator hose connecting from filler assembly
  const hoseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.098, -0.015, 0.005),
    new THREE.Vector3(0.145, -0.025, -0.045),
    new THREE.Vector3(0.165, -0.055, -0.105),
  ]);
  const radiatorHose = new THREE.Mesh(
    new THREE.TubeGeometry(hoseCurve, 14, 0.017, 10, false),
    mats.rubberHose
  );
  group.add(radiatorHose);

  return tagPartHierarchy(group, 'arrefecimento-motor');
}

export function buildFluidoFreio(mats: SharedMaterials): THREE.Group {
  const group = new THREE.Group();

  // Rear-right compact cylindrical milky brake fluid reservoir beside right strut tower
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.038, 0.082, 20),
    mats.translucentHdpe
  );
  group.add(body);

  // Soft desaturated amber brake fluid in lower half
  const amberMat = new THREE.MeshStandardMaterial({
    color: 0xb5955c,
    roughness: 0.30,
    metalness: 0.03,
  });
  const fluid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.031, 0.040, 18),
    amberMat
  );
  fluid.position.set(0, -0.016, 0);
  group.add(fluid);

  // Master cylinder lower metallic collar
  const masterMount = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.034, 0.028, 16),
    mats.castAluminum
  );
  masterMount.position.set(0, -0.052, 0);
  group.add(masterMount);

  // Dark cap with subtle yellow caution ring
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.037, 0.018, 18),
    mats.satinBlackPlastic
  );
  cap.position.set(0, 0.048, 0);
  group.add(cap);

  const cautionRing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.005, 16),
    new THREE.MeshStandardMaterial({ color: 0xc99c2c, roughness: 0.45 })
  );
  cautionRing.position.set(0, 0.059, 0);
  group.add(cautionRing);

  return tagPartHierarchy(group, 'fluido-freio');
}

export function buildAguaLimpador(
  mats: SharedMaterials,
  washerCapTex: THREE.CanvasTexture
): THREE.Group {
  const group = new THREE.Group();

  // Lowered fender-tucked translucent milky reservoir body (underneath left L-flange)
  const lowerTank = new THREE.Mesh(
    createRoundedBoxGeometry(0.098, 0.088, 0.112, 0.026),
    mats.translucentHdpe
  );
  lowerTank.position.set(0, -0.082, 0);
  group.add(lowerTank);

  // Muted blue washer fluid in lower half of tank
  const washerFluidMat = new THREE.MeshStandardMaterial({
    color: 0x457bb5,
    roughness: 0.30,
  });
  const innerFluid = new THREE.Mesh(
    createRoundedBoxGeometry(0.080, 0.048, 0.090, 0.018),
    washerFluidMat
  );
  innerFluid.position.set(0, -0.095, 0);
  group.add(innerFluid);

  // Filler neck rising cleanly through the left fender cutout
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.024, 0.028, 0.090, 16),
    mats.translucentHdpe
  );
  neck.position.set(0, 0.005, 0);
  group.add(neck);

  // Iconic Vivid Blue Washer Cap with windshield graphic visible in fender cutout
  const blueSideMat = new THREE.MeshPhysicalMaterial({
    color: 0x1d75d8,
    roughness: 0.24,
    metalness: 0.02,
    clearcoat: 0.45,
  });
  const blueTopMat = new THREE.MeshPhysicalMaterial({
    map: washerCapTex,
    roughness: 0.22,
    metalness: 0.02,
    clearcoat: 0.45,
  });
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.031, 0.031, 0.016, 20),
    [blueSideMat, blueTopMat, blueSideMat]
  );
  cap.position.set(0, 0.055, 0);
  group.add(cap);

  // Small blue cap tether tab
  const capTab = new THREE.Mesh(
    new THREE.BoxGeometry(0.016, 0.008, 0.014),
    blueSideMat
  );
  capTab.position.set(-0.032, 0.052, 0);
  group.add(capTab);

  return tagPartHierarchy(group, 'agua-limpador');
}
