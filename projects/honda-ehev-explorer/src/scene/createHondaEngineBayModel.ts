import * as THREE from 'three';
import { ENGINE_PARTS, EnginePartMetadata } from '../data/partsMetadata';
import {
  createBatteryTopTexture,
  createBrushedMetalTexture,
  createHondaEngineCoverTexture,
  createPlasticGrainBumpTexture,
  createRadiatorCapTexture,
  createWasherCapTexture,
} from './textures';
import { createSharedMaterials } from './parts/shared';
import { buildBaseCofre } from './parts/baseCofre';
import { buildMotorCombustao } from './parts/motorCombustao';
import { buildCabosAltaTensao } from './parts/cabosAltaTensao';
import { buildAdmissaoFiltroAr } from './parts/admissaoFiltroAr';
import { buildBateria12v } from './parts/bateria12v';
import { buildCaixaFusiveis } from './parts/caixaFusiveis';
import {
  buildAguaLimpador,
  buildArrefecimentoHibrido,
  buildArrefecimentoMotor,
  buildFluidoFreio,
} from './parts/reservatorios';

export interface EnginePartNode {
  metadata: EnginePartMetadata;
  group: THREE.Group;
  /** Posição montada original */
  mountedPosition: THREE.Vector3;
  /** Vetor de deslocamento máximo no modo explodido */
  explodedOffset: THREE.Vector3;
  /** Centro geométrico do Box3 em coordenadas locais do group (para centralizar no palco) */
  localBoxCenter: THREE.Vector3;
  /** Raio da esfera envoltória local */
  boundingRadius: number;
  /** Altura máxima atingida quando explodeFactor = 1 */
  maxExplodedTopY: number;
}

export interface HondaEngineBayAssembly {
  root: THREE.Group;
  parts: Map<string, EnginePartNode>;
  orderedParts: EnginePartNode[];
  /** Altura máxima de todas as peças quando explodeFactor = 1, usada para calcular palco dinâmico */
  maxExplodedSceneY: number;
}

export function createHondaEngineBayModel(): HondaEngineBayAssembly {
  const root = new THREE.Group();
  root.name = 'honda-ehev-engine-bay';

  const plasticBump = createPlasticGrainBumpTexture();
  const brushedMetal = createBrushedMetalTexture();
  const coverTex = createHondaEngineCoverTexture();
  const batteryTex = createBatteryTopTexture();
  const radiatorCapTex = createRadiatorCapTexture();
  const washerCapTex = createWasherCapTexture();

  const mats = createSharedMaterials(plasticBump, brushedMetal);

  const builders: Record<string, () => THREE.Group> = {
    'base-cofre': () => buildBaseCofre(mats),
    'motor-combustao': () => buildMotorCombustao(mats, coverTex),
    'cabos-alta-tensao': () => buildCabosAltaTensao(mats),
    'admissao-filtro-ar': () => buildAdmissaoFiltroAr(mats),
    'bateria-12v': () => buildBateria12v(mats, batteryTex),
    'caixa-fusiveis': () => buildCaixaFusiveis(mats),
    'arrefecimento-hibrido': () => buildArrefecimentoHibrido(mats, radiatorCapTex),
    'arrefecimento-motor': () => buildArrefecimentoMotor(mats, radiatorCapTex),
    'fluido-freio': () => buildFluidoFreio(mats),
    'agua-limpador': () => buildAguaLimpador(mats, washerCapTex),
  };

  const parts = new Map<string, EnginePartNode>();
  const orderedParts: EnginePartNode[] = [];
  const runtimeNodes: Record<string, THREE.Object3D> = {};
  const runtimeMeshes: Record<string, THREE.Mesh> = {};
  let maxExplodedSceneY = 0.85;

  for (const meta of ENGINE_PARTS) {
    const buildFn = builders[meta.id];
    if (!buildFn) {
      throw new Error(`Missing builder for engine part: ${meta.id}`);
    }
    const group = buildFn();

    // Compute local Box3 BEFORE positioning the group at mountedPosition
    group.position.set(0, 0, 0);
    group.updateMatrixWorld(true);
    const localBox = new THREE.Box3().setFromObject(group);
    const localBoxCenter = new THREE.Vector3();
    const localBoxSize = new THREE.Vector3();
    localBox.getCenter(localBoxCenter);
    localBox.getSize(localBoxSize);
    const boundingRadius = localBoxSize.length() * 0.5;

    const mountedPosition = new THREE.Vector3(...meta.posicaoMontada);
    const explodedOffset = new THREE.Vector3(...meta.deslocamentoExplodido);
    group.position.copy(mountedPosition);

    const maxExplodedTopY = mountedPosition.y + explodedOffset.y + localBox.max.y;
    if (maxExplodedTopY > maxExplodedSceneY) {
      maxExplodedSceneY = maxExplodedTopY;
    }

    root.add(group);
    runtimeNodes[meta.id] = group;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        runtimeMeshes[`${meta.id}/${obj.name}`] = obj;
      }
    });

    const node: EnginePartNode = {
      metadata: meta,
      group,
      mountedPosition,
      explodedOffset,
      localBoxCenter,
      boundingRadius,
      maxExplodedTopY,
    };
    parts.set(meta.id, node);
    orderedParts.push(node);
  }

  root.userData.sculptRuntime = {
    nodes: runtimeNodes,
    meshes: runtimeMeshes,
    partsCount: orderedParts.length,
  };

  return {
    root,
    parts,
    orderedParts,
    maxExplodedSceneY,
  };
}
