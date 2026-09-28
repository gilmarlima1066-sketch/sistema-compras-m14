/** Contratos de dados compartilhados entre as telas e a API. */

export interface Meta {
  total: number;
  pagina: number;
  limite: number;
  paginas: number;
  /* Alguns modulos devolvem contexto junto da paginacao: periodo resolvido,
     resumos e avisos sobre a confiabilidade dos dados. */
  [extra: string]: unknown;
}

export interface RespostaApi<T> {
  success: boolean;
  data: T;
  message: string;
  meta?: Meta;
}

export interface UsuarioSessao {
  id: number;
  nome: string;
  email: string;
  perfil: string;
  perfil_id: number;
  permissoes: string[];
}

export interface Produto {
  id: number;
  codigo: string;
  ean: string | null;
  descricao: string;
  categoria_id: number;
  categoria_nome: string;
  subcategoria_nome: string | null;
  marca_nome: string | null;
  unidade_estoque_codigo: string;
  estoque_minimo: number;
  estoque_maximo: number | null;
  ponto_pedido: number | null;
  classificacao_abc: string | null;
  produto_importado: boolean;
  origem: string | null;
  ativo: boolean;
}

export interface Fornecedor {
  id: number;
  razao_social: string;
  nome_fantasia: string | null;
  cnpj: string | null;
  email: string | null;
  telefone: string | null;
  cidade: string | null;
  estado: string | null;
  pais: string;
  tipo_fornecedor: string;
  origem_fornecedor: 'NACIONAL' | 'INTERNACIONAL';
  prazo_medio_pagamento: number | null;
  lead_time_padrao_dias: number | null;
  total_produtos: number;
  ativo: boolean;
}

export interface PosicaoEstoque {
  produto_id: number;
  codigo: string;
  descricao: string;
  estoque_fisico: number;
  estoque_disponivel: number;
  estoque_em_transito: number;
  demanda_media_diaria: number | null;
  cobertura_dias: number | null;
  lead_time_dias: number | null;
  ponto_pedido: number | null;
  estoque_minimo: number | null;
  situacao: string;
}

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  perfil_id: number;
  perfil: string;
  ativo: boolean;
  ultimo_login: string | null;
}

export interface Perfil {
  id: number;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  permissoes?: string[];
}

export interface Indicadores {
  produtos_cadastrados: number;
  produtos_ativos: number;
  fornecedores_ativos: number;
  estoque_total: number;
  produtos_em_ruptura: number;
  produtos_abaixo_minimo: number;
  produtos_ponto_pedido: number;
  produtos_excesso: number;
  compras_em_aberto: number;
  valor_em_aberto: number;
  entregas_atrasadas: number;
  alertas_criticos: number;
  alertas_abertos: number;
  lotes_validade_proxima: number;
}

export interface Dashboard {
  indicadores: Indicadores;
  produtos_criticos: Array<{
    produto_id: number;
    codigo: string;
    descricao: string;
    estoque_disponivel: number;
    cobertura_dias: number | null;
    situacao: string;
  }>;
  alertas_recentes: Array<{
    id: number;
    tipo: string;
    severidade: string;
    mensagem: string;
    data_geracao: string;
  }>;
}

export interface OpcaoCadastro {
  id: number;
  nome?: string;
  codigo?: string;
  categoria_id?: number;
}
