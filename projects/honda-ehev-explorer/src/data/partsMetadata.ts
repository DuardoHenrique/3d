export type PartCategory =
  | 'estrutura'
  | 'propulsao'
  | 'hibrido-eletrica'
  | 'admissao'
  | 'fluidos';

export interface EnginePartMetadata {
  id: string;
  nome: string;
  nomeCurto: string;
  categoria: PartCategory;
  categoriaLabel: string;
  /** Cor hexadecimal exclusiva de alto contraste (hover, seleção, badges) */
  cor: string;
  descricao: string;
  /** Coordenadas originais montadas no cofre [X: esq-/dir+, Y: baixo-/cima+, Z: fundo-/frente+] */
  posicaoMontada: [number, number, number];
  /** Vetor de deslocamento máximo na vista explodida (explodeFactor = 1) */
  deslocamentoExplodido: [number, number, number];
  /** Offset local da âncora do rótulo flutuante em relação à peça */
  ancoraRotulo: [number, number, number];
  /** Distância ideal da câmera para enquadramento 360° no palco */
  raioInspecao: number;
  /** Permite ocultar a peça para explorar o restante flutuando em 360° */
  removivel?: boolean;
}

export const CATEGORY_LABELS: Record<PartCategory, string> = {
  estrutura: 'Estrutura',
  propulsao: 'Propulsão',
  'hibrido-eletrica': 'Híbrido / Elétrica',
  admissao: 'Admissão',
  fluidos: 'Fluidos',
};

export const ENGINE_PARTS: EnginePartMetadata[] = [
  {
    id: 'base-cofre',
    nome: 'Base / Cofre Estrutural',
    nomeCurto: 'Base / Cofre',
    categoria: 'estrutura',
    categoriaLabel: 'Estrutura',
    cor: '#94A3B8',
    descricao:
      'Chassi interno em U composto pelas longarinas branco perolizadas, torres de suspensão dianteiras, travessa frontal (slam panel) com trava do capô, churrasqueira traseira e conjunto frontal de radiador.',
    posicaoMontada: [0.0, 0.0, 0.0],
    deslocamentoExplodido: [0.0, -0.20, 0.0],
    ancoraRotulo: [0.0, 0.22, 0.50],
    raioInspecao: 2.35,
    removivel: true,
  },
  {
    id: 'motor-combustao',
    nome: 'Motor a Combustão / Tampa Superior',
    nomeCurto: 'Motor a Combustão',
    categoria: 'propulsao',
    categoriaLabel: 'Propulsão',
    cor: '#EF4444',
    descricao:
      'Motor 2.0 ciclo Atkinson do conjunto Honda e:HEV em peça unificada: tampa acústica preta fosca com emblema HONDA e bocal de óleo, bloco em alumínio fundido, vareta de nível e protetor térmico prateado do coletor com sonda lambda.',
    posicaoMontada: [-0.14, 0.24, -0.02],
    deslocamentoExplodido: [-0.08, 0.42, -0.04],
    ancoraRotulo: [-0.14, 0.46, -0.02],
    raioInspecao: 1.25,
  },
  {
    id: 'cabos-alta-tensao',
    nome: 'Cabos de Alta Tensão (e:HEV)',
    nomeCurto: 'Cabos Alta Tensão',
    categoria: 'hibrido-eletrica',
    categoriaLabel: 'Híbrido / Elétrica',
    cor: '#FF6B00',
    descricao:
      'Condutores blindados em laranja de alta visibilidade (padrão automotivo de alta tensão). Interligam a unidade de potência híbrida (PCU/inversor), gerador/motor elétrico e bateria de tração.',
    posicaoMontada: [-0.10, 0.22, -0.04],
    deslocamentoExplodido: [-0.20, 0.56, 0.14],
    ancoraRotulo: [-0.46, 0.36, 0.08],
    raioInspecao: 1.45,
  },
  {
    id: 'admissao-filtro-ar',
    nome: 'Sistema de Admissão e Filtro de Ar',
    nomeCurto: 'Filtro de Ar / Admissão',
    categoria: 'admissao',
    categoriaLabel: 'Admissão',
    cor: '#10B981',
    descricao:
      'Caixa vertical do filtro de ar acoplada ao duto sanfonado flexível e tomada frontal de ar frio. Filtra impurezas e direciona o fluxo de ar para o coletor de admissão do motor.',
    posicaoMontada: [0.28, 0.26, 0.04],
    deslocamentoExplodido: [0.24, 0.36, 0.12],
    ancoraRotulo: [0.28, 0.44, 0.08],
    raioInspecao: 1.20,
  },
  {
    id: 'bateria-12v',
    nome: 'Bateria Auxiliar 12V',
    nomeCurto: 'Bateria 12V',
    categoria: 'hibrido-eletrica',
    categoriaLabel: 'Híbrido / Elétrica',
    cor: '#F59E0B',
    descricao:
      'Bateria auxiliar de baixa tensão (12V) com suporte metálico de fixação e capa vermelha no polo positivo. Alimenta os módulos eletrônicos, iluminação, travas e aciona os contatores do sistema híbrido.',
    posicaoMontada: [0.51, 0.14, 0.24],
    deslocamentoExplodido: [0.40, 0.24, 0.32],
    ancoraRotulo: [0.51, 0.32, 0.24],
    raioInspecao: 0.90,
  },
  {
    id: 'caixa-fusiveis',
    nome: 'Caixa de Fusíveis',
    nomeCurto: 'Caixa de Fusíveis',
    categoria: 'hibrido-eletrica',
    categoriaLabel: 'Híbrido / Elétrica',
    cor: '#8B5CF6',
    descricao:
      'Central de distribuição elétrica do cofre abrigando fusíveis de alta corrente, relés de arrefecimento, módulos de controle e proteção dos circuitos auxiliares.',
    posicaoMontada: [0.66, 0.24, -0.04],
    deslocamentoExplodido: [0.50, 0.26, -0.06],
    ancoraRotulo: [0.66, 0.40, -0.04],
    raioInspecao: 0.85,
  },
  {
    id: 'arrefecimento-hibrido',
    nome: 'Reservatório de Arrefecimento (Híbrido)',
    nomeCurto: 'Arrefec. Híbrido',
    categoria: 'fluidos',
    categoriaLabel: 'Fluidos',
    cor: '#06B6D4',
    descricao:
      'Reservatório dedicado ao circuito de arrefecimento do sistema híbrido / inversor (PCU), posicionado à direita entre o filtro de ar, a caixa de fusíveis e o cabo laranja traseiro. Controla a temperatura da eletrônica de potência.',
    posicaoMontada: [0.48, 0.24, -0.14],
    deslocamentoExplodido: [0.34, 0.34, -0.22],
    ancoraRotulo: [0.48, 0.39, -0.14],
    raioInspecao: 0.72,
  },
  {
    id: 'arrefecimento-motor',
    nome: 'Reservatório de Arrefecimento (Motor)',
    nomeCurto: 'Arrefec. Motor',
    categoria: 'fluidos',
    categoriaLabel: 'Fluidos',
    cor: '#EC4899',
    descricao:
      'Reservatório de expansão e bocal pressurizado do sistema de arrefecimento do motor a combustão, localizado na parte frontal-esquerda com tampa metálica de radiador (adesivo de advertência) e mangueira para o radiador principal.',
    posicaoMontada: [-0.22, 0.16, 0.34],
    deslocamentoExplodido: [-0.20, 0.28, 0.38],
    ancoraRotulo: [-0.22, 0.32, 0.34],
    raioInspecao: 0.75,
  },
  {
    id: 'fluido-freio',
    nome: 'Reservatório de Fluido de Freio',
    nomeCurto: 'Fluido de Freio',
    categoria: 'fluidos',
    categoriaLabel: 'Fluidos',
    cor: '#EAB308',
    descricao:
      'Reservatório cilíndrico translúcido montado próximo à torre de suspensão traseira direita (junto ao cilindro mestre/atuador eletrônico), mantendo o fluido hidráulico do sistema de frenagem regenerativa e mecânica.',
    posicaoMontada: [0.44, 0.30, -0.32],
    deslocamentoExplodido: [0.26, 0.38, -0.36],
    ancoraRotulo: [0.44, 0.42, -0.32],
    raioInspecao: 0.68,
  },
  {
    id: 'agua-limpador',
    nome: 'Reservatório de Água do Limpador',
    nomeCurto: 'Água Limpador',
    categoria: 'fluidos',
    categoriaLabel: 'Fluidos',
    cor: '#3B82F6',
    descricao:
      'Gargalo e reservatório do lavador de para-brisa no canto traseiro esquerdo do cofre, facilmente identificado pela tampa azul brilhante com símbolo do para-brisa.',
    posicaoMontada: [-0.68, 0.22, -0.26],
    deslocamentoExplodido: [-0.46, 0.32, -0.26],
    ancoraRotulo: [-0.68, 0.38, -0.26],
    raioInspecao: 0.75,
  },
];

export const ENGINE_PARTS_MAP = new Map<string, EnginePartMetadata>(
  ENGINE_PARTS.map((part) => [part.id, part])
);
