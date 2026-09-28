/**
 * Contexto de execucao da IA: configuracao, perfil e escopo de dados.
 *
 * A secao 38 termina com a frase que desenha este arquivo: "A IA nunca devera
 * revelar dados aos quais o usuario nao possui acesso". Isso nao se resolve
 * escondendo campo na tela - se resolve aqui, decidindo ANTES da consulta o
 * que aquele perfil pode ver, e deixando essa decisao em um lugar so.
 */
import { query } from '../../config/database.js';
import type { Confianca } from './evidencias.js';

export interface ConfigIA {
  confiancaMinima: Confianca;
  minimoEventos: number;
  minimoDiasHistorico: number;
  zscoreAnomalia: number;
  variacaoPrecoAnormal: number;
  horizonteRupturaDias: number;
  diasValidadeRisco: number;
  concentracaoCriticaPercentual: number;
  mapeMaximo: number;
  economiaMinima: number;
  limiteLinhas: number;
  timeoutMs: number;
  pesoImpacto: number;
  pesoUrgencia: number;
  pesoCriticidade: number;
  expiraDias: number;
}

const PADRAO: ConfigIA = {
  confiancaMinima: 'BAIXA',
  minimoEventos: 5,
  minimoDiasHistorico: 30,
  zscoreAnomalia: 2.5,
  variacaoPrecoAnormal: 15,
  horizonteRupturaDias: 30,
  diasValidadeRisco: 60,
  concentracaoCriticaPercentual: 60,
  mapeMaximo: 30,
  economiaMinima: 500,
  limiteLinhas: 500,
  timeoutMs: 8000,
  pesoImpacto: 0.5,
  pesoUrgencia: 0.3,
  pesoCriticidade: 0.2,
  expiraDias: 30,
};

export async function carregarConfig(): Promise<ConfigIA> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'ia' AND ativo");
  const m = new Map(rows.map((r) => [r.chave, r.valor]));
  const n = (chave: string, padrao: number) => {
    const v = Number(m.get(chave));
    return Number.isFinite(v) ? v : padrao;
  };

  const confianca = m.get('ia.confianca_minima_recomendar');
  return {
    confiancaMinima: (['ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE'].includes(confianca ?? '')
      ? confianca : PADRAO.confiancaMinima) as Confianca,
    minimoEventos: n('ia.minimo_eventos_analise', PADRAO.minimoEventos),
    minimoDiasHistorico: n('ia.minimo_dias_historico', PADRAO.minimoDiasHistorico),
    zscoreAnomalia: n('ia.zscore_anomalia', PADRAO.zscoreAnomalia),
    variacaoPrecoAnormal: n('ia.variacao_preco_anormal', PADRAO.variacaoPrecoAnormal),
    horizonteRupturaDias: n('ia.horizonte_ruptura_dias', PADRAO.horizonteRupturaDias),
    diasValidadeRisco: n('ia.dias_validade_risco', PADRAO.diasValidadeRisco),
    concentracaoCriticaPercentual: n('ia.concentracao_critica_percentual',
      PADRAO.concentracaoCriticaPercentual),
    mapeMaximo: n('ia.mape_maximo_aceitavel', PADRAO.mapeMaximo),
    economiaMinima: n('ia.economia_minima_reportar', PADRAO.economiaMinima),
    limiteLinhas: n('ia.limite_linhas_consulta', PADRAO.limiteLinhas),
    timeoutMs: n('ia.timeout_consulta_ms', PADRAO.timeoutMs),
    pesoImpacto: n('ia.peso_impacto_financeiro', PADRAO.pesoImpacto),
    pesoUrgencia: n('ia.peso_urgencia', PADRAO.pesoUrgencia),
    pesoCriticidade: n('ia.peso_criticidade', PADRAO.pesoCriticidade),
    expiraDias: n('ia.recomendacao_expira_dias', PADRAO.expiraDias),
  };
}

// ---------------------------------------------------------------------------
// Escopo de dados por perfil (secao 38)
// ---------------------------------------------------------------------------

/** Dominios de informacao que a IA sabe responder. */
export type Dominio =
  | 'COMPRAS' | 'ESTOQUE' | 'DEMANDA' | 'FORNECEDORES' | 'COTACOES'
  | 'PEDIDOS' | 'LOGISTICA' | 'QUALIDADE' | 'FINANCEIRO' | 'RISCOS';

/**
 * O que cada perfil enxerga (secao 38).
 *
 * ADMIN e GESTOR_COMPRAS veem tudo. Os demais veem o proprio dominio - e essa
 * e a lista que a consulta consulta antes de responder, nao a tela.
 */
const ESCOPO: Record<string, Dominio[]> = {
  ADMIN: ['COMPRAS', 'ESTOQUE', 'DEMANDA', 'FORNECEDORES', 'COTACOES', 'PEDIDOS',
    'LOGISTICA', 'QUALIDADE', 'FINANCEIRO', 'RISCOS'],
  GESTOR_COMPRAS: ['COMPRAS', 'ESTOQUE', 'DEMANDA', 'FORNECEDORES', 'COTACOES',
    'PEDIDOS', 'LOGISTICA', 'QUALIDADE', 'FINANCEIRO', 'RISCOS'],
  DIRETORIA: ['COMPRAS', 'ESTOQUE', 'DEMANDA', 'FORNECEDORES', 'PEDIDOS',
    'LOGISTICA', 'QUALIDADE', 'FINANCEIRO', 'RISCOS'],
  COMPRADOR: ['COMPRAS', 'ESTOQUE', 'DEMANDA', 'FORNECEDORES', 'COTACOES',
    'PEDIDOS', 'LOGISTICA', 'RISCOS'],
  ESTOQUE: ['ESTOQUE', 'DEMANDA', 'PEDIDOS', 'LOGISTICA', 'RISCOS'],
  QUALIDADE: ['QUALIDADE', 'FORNECEDORES', 'ESTOQUE', 'RISCOS'],
  FINANCEIRO: ['FINANCEIRO', 'COMPRAS', 'PEDIDOS', 'FORNECEDORES'],
  COMERCIAL: ['DEMANDA', 'ESTOQUE'],
};

export interface SessaoIA {
  usuarioId: number | null;
  perfil: string;
  permissoes: string[];
  dominios: Dominio[];
  ip: string | null;
}

export function montarSessao(usuario: {
  id: number; perfil: string; permissoes: string[];
} | undefined, ip?: string | null): SessaoIA {
  const perfil = usuario?.perfil ?? 'DESCONHECIDO';
  return {
    usuarioId: usuario?.id ?? null,
    perfil,
    permissoes: usuario?.permissoes ?? [],
    dominios: ESCOPO[perfil] ?? [],
    ip: ip ?? null,
  };
}

export const podeVer = (sessao: SessaoIA, dominio: Dominio): boolean =>
  sessao.dominios.includes(dominio);

/**
 * Frase unica para negar acesso a um dominio.
 *
 * Diz QUAL dominio faltou, e nao quais dados existem la dentro. Um "nao posso
 * te mostrar os 3 fornecedores bloqueados" ja teria revelado que sao tres.
 */
export const negar = (dominio: Dominio): string =>
  `Seu perfil nao tem acesso a informacoes de ${dominio.toLowerCase()}.`;
