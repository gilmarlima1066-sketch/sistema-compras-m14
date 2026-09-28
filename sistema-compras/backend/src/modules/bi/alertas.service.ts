/**
 * Central de alertas (secoes 40, 41 e 42).
 *
 * Uma unica central para todos os modulos. O modulo 11 NAO cria um segundo
 * cadastro de alertas: ele passou a alimentar e a ler a tabela `alertas` que
 * ja existia desde o modulo 02, agora com titulo, prioridade, categoria,
 * origem, link e chave de deduplicacao.
 *
 * Deduplicacao (secao 42): o alerta nao e identificado pelo texto, e sim por
 * uma chave estavel do evento (regra + entidade). Enquanto o alerta estiver
 * ABERTO com aquela chave, uma nova apuracao ATUALIZA o registro - valor,
 * ultima ocorrencia e contador - em vez de inserir um segundo. Quem resolveu
 * o alerta ontem nao o ve renascer hoje como se fosse novo; ele volta a
 * aparecer, sim, mas como reincidencia contada.
 *
 * O indice parcial `uq_alerta_dedup` garante isso no banco: mesmo que duas
 * apuracoes rodem ao mesmo tempo, o segundo INSERT cai no ON CONFLICT.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { apurar, configuracoes, type ResultadoKpi } from './kpi.service.js';
import type { FiltroGlobal } from './filtros.js';
import { sufixo } from './calculos.js';

export type Prioridade = 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAIXO';

/** Secao 41: prioridade e o que ela significa em termos de acao. */
export const SIGNIFICADO_PRIORIDADE: Record<Prioridade, string> = {
  CRITICO: 'Necessita acao imediata',
  ALTO: 'Necessita acao prioritaria',
  MEDIO: 'Necessita acompanhamento',
  BAIXO: 'Informativo',
};

/** Secao 40: categorias da central. */
export const CATEGORIAS = [
  'ruptura', 'estoque', 'compra', 'fornecedor', 'atraso', 'qualidade',
  'recebimento', 'preco', 'demanda', 'importacao', 'governanca',
] as const;

/**
 * Severidade e o campo antigo (modulo 02) e prioridade e o novo (secao 41).
 * Mantemos os dois coerentes para que as telas dos modulos anteriores, que
 * leem severidade, continuem corretas.
 */
const SEVERIDADE_DE: Record<Prioridade, string> = {
  CRITICO: 'CRITICA', ALTO: 'ALTA', MEDIO: 'MEDIA', BAIXO: 'BAIXA',
};

const ORDEM_PRIORIDADE: Record<Prioridade, number> = {
  CRITICO: 1, ALTO: 2, MEDIO: 3, BAIXO: 4,
};

// ---------------------------------------------------------------------------
// Registro com deduplicacao
// ---------------------------------------------------------------------------

export interface EntradaAlerta {
  /** Chave estavel do evento. Dois alertas com a mesma chave sao o mesmo alerta. */
  chave: string;
  tipo: string;
  categoria: string;
  prioridade: Prioridade;
  titulo: string;
  mensagem: string;
  origem: string;
  entidade?: string | null;
  entidade_id?: number | null;
  link?: string | null;
  kpi_id?: number | null;
  valor?: number | null;
  limite?: number | null;
  produto_id?: number | null;
  fornecedor_id?: number | null;
  ordem_compra_id?: number | null;
  detalhes?: Record<string, unknown> | null;
}

export interface RegistroAlerta {
  id: number;
  chave_dedup: string;
  novo: boolean;
  ocorrencias: number;
  prioridade: Prioridade;
  titulo: string;
}

/**
 * Insere o alerta ou atualiza o que ja esta aberto com a mesma chave.
 *
 * O `xmax = 0` do RETURNING distingue insercao de atualizacao sem uma segunda
 * consulta: em uma linha recem-inserida o xmax e zero.
 */
export async function registrarAlerta(
  entrada: EntradaAlerta, contexto: ContextoSessao,
): Promise<RegistroAlerta> {
  if (!CATEGORIAS.includes(entrada.categoria as typeof CATEGORIAS[number])) {
    throw regraNegocio(`Categoria de alerta desconhecida: ${entrada.categoria}`);
  }

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{
      id: string; ocorrencias: number; inserido: boolean;
    }>(`
      INSERT INTO alertas
        (tipo, severidade, prioridade, categoria, titulo, mensagem, origem,
         entidade, entidade_id, link, chave_dedup, kpi_id, valor, limite,
         produto_id, fornecedor_id, ordem_compra_id, detalhes,
         primeira_ocorrencia, ultima_ocorrencia, ocorrencias, status)
      VALUES
        ($1::tipo_alerta_enum, $2::severidade_enum, $3::prioridade_alerta_enum,
         $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14::numeric,
         $15, $16, $17, $18::jsonb, now(), now(), 1, 'ABERTO')
      ON CONFLICT (chave_dedup) WHERE chave_dedup IS NOT NULL AND status = 'ABERTO'
      DO UPDATE SET
        ocorrencias       = alertas.ocorrencias + 1,
        ultima_ocorrencia = now(),
        mensagem          = EXCLUDED.mensagem,
        titulo            = EXCLUDED.titulo,
        valor             = EXCLUDED.valor,
        limite            = EXCLUDED.limite,
        detalhes          = EXCLUDED.detalhes,
        prioridade        = EXCLUDED.prioridade,
        severidade        = EXCLUDED.severidade,
        updated_at        = now()
      RETURNING id, ocorrencias, (xmax = 0) AS inserido`,
    [entrada.tipo, SEVERIDADE_DE[entrada.prioridade], entrada.prioridade,
      entrada.categoria, entrada.titulo, entrada.mensagem, entrada.origem,
      entrada.entidade ?? null, entrada.entidade_id ?? null, entrada.link ?? null,
      entrada.chave, entrada.kpi_id ?? null, entrada.valor ?? null,
      entrada.limite ?? null, entrada.produto_id ?? null,
      entrada.fornecedor_id ?? null, entrada.ordem_compra_id ?? null,
      entrada.detalhes ? JSON.stringify(entrada.detalhes) : null]);

    const linha = rows[0]!;
    return {
      id: Number(linha.id),
      chave_dedup: entrada.chave,
      novo: linha.inserido,
      ocorrencias: linha.ocorrencias,
      prioridade: entrada.prioridade,
      titulo: entrada.titulo,
    };
  });
}

// ---------------------------------------------------------------------------
// Avaliacao das regras
// ---------------------------------------------------------------------------

interface Regra {
  id: number;
  codigo: string;
  nome: string;
  descricao: string | null;
  categoria: string;
  kpi_id: number | null;
  kpi_codigo: string | null;
  tipo_alerta: string;
  prioridade: Prioridade;
  comparador: string;
  limite: number | null;
  janela_dias: number;
  responsavel_id: number | null;
}

async function carregarRegras(codigo?: string): Promise<Regra[]> {
  const valores: unknown[] = [];
  let cond = 'r.ativo';
  if (codigo) {
    valores.push(codigo);
    cond += ` AND upper(r.codigo) = upper($${valores.length})`;
  }
  const { rows } = await query<Regra & { limite: string | null }>(`
    SELECT r.id, r.codigo, r.nome, r.descricao, r.categoria, r.kpi_id,
           k.codigo AS kpi_codigo, r.tipo_alerta::text AS tipo_alerta,
           r.prioridade::text AS prioridade, r.comparador, r.limite,
           r.janela_dias, r.responsavel_id
      FROM alertas_regras r
      LEFT JOIN kpi_definicoes k ON k.id = r.kpi_id
     WHERE ${cond}
     ORDER BY r.prioridade, r.codigo`, valores);
  return rows.map((r) => ({ ...r, limite: r.limite === null ? null : Number(r.limite) }));
}

export interface Disparo {
  regra: string;
  nome: string;
  kpi: string | null;
  disparou: boolean;
  motivo: string;
  valor: number | null;
  limite: number | null;
  alerta_id?: number;
  novo?: boolean;
  ocorrencias?: number;
}

/**
 * Decide se a regra dispara para o resultado apurado.
 *
 * Regra 6 da secao 71: zero nao e ausencia de dados. Um KPI nao calculavel
 * nunca dispara um alerta de limite - ele dispara, no maximo, o alerta de
 * SEM_DADOS, e so quando a regra e justamente essa.
 */
export function avaliarRegra(
  regra: Pick<Regra, 'comparador' | 'limite'>, resultado: ResultadoKpi,
): { disparou: boolean; motivo: string; limite: number | null } {
  if (regra.comparador === 'SEM_DADOS') {
    return resultado.calculavel
      ? { disparou: false, motivo: 'Indicador apurado normalmente', limite: null }
      : {
        disparou: true,
        motivo: resultado.motivo ?? 'Indicador sem dados suficientes no periodo',
        limite: null,
      };
  }

  if (!resultado.calculavel || resultado.valor === null) {
    return {
      disparou: false,
      motivo: 'Indicador nao calculavel no periodo - ausencia de dados nao e violacao',
      limite: null,
    };
  }

  const valor = resultado.valor;

  if (regra.comparador === 'FORA_DA_META') {
    if (!resultado.meta) {
      return {
        disparou: false,
        motivo: 'Sem meta vigente para comparar',
        limite: null,
      };
    }
    const fora = resultado.semaforo === 'VERMELHO' || resultado.semaforo === 'AMARELO';
    return {
      disparou: fora,
      motivo: fora
        ? `Semaforo ${resultado.semaforo}: ${resultado.desvio_texto ?? 'fora da meta'}`
        : 'Dentro da meta',
      limite: resultado.meta.meta,
    };
  }

  const limite = regra.limite;
  if (limite === null) {
    return { disparou: false, motivo: 'Regra sem limite configurado', limite: null };
  }

  const u = sufixo(resultado.unidade);
  const comparacoes: Record<string, [boolean, string]> = {
    MAIOR_QUE: [valor > limite, `${valor}${u} acima de ${limite}${u}`],
    MENOR_QUE: [valor < limite, `${valor}${u} abaixo de ${limite}${u}`],
    IGUAL_A: [valor === limite, `${valor}${u} igual a ${limite}${u}`],
  };
  const [disparou, texto] = comparacoes[regra.comparador]
    ?? [false, `Comparador desconhecido: ${regra.comparador}`];

  return {
    disparou,
    motivo: disparou ? texto : `${valor}${u} dentro do limite de ${limite}${u}`,
    limite,
  };
}

/**
 * Roda as regras ativas e registra os alertas correspondentes.
 *
 * A chave de deduplicacao e `REGRA:<codigo>` mais o escopo do filtro. Duas
 * apuracoes do mesmo escopo atualizam o mesmo alerta; escopos diferentes
 * (outro fornecedor, outra categoria) geram alertas distintos, porque sao
 * de fato problemas distintos.
 */
export async function avaliarRegras(
  filtro: FiltroGlobal, contexto: ContextoSessao, codigoRegra?: string,
): Promise<{ avaliadas: number; disparos: Disparo[] }> {
  const regras = await carregarRegras(codigoRegra);
  const cfg = await configuracoes();
  const disparos: Disparo[] = [];

  const escopo = [
    filtro.categoria_id ? `cat${filtro.categoria_id}` : null,
    filtro.produto_id ? `prod${filtro.produto_id}` : null,
    filtro.fornecedor_id ? `forn${filtro.fornecedor_id}` : null,
    filtro.local_id ? `loc${filtro.local_id}` : null,
    filtro.comprador_id ? `comp${filtro.comprador_id}` : null,
  ].filter(Boolean).join('|');

  for (const regra of regras) {
    if (!regra.kpi_codigo) {
      disparos.push({
        regra: regra.codigo, nome: regra.nome, kpi: null, disparou: false,
        motivo: 'Regra sem KPI associado', valor: null, limite: regra.limite,
      });
      continue;
    }

    const resultado = await apurar(
      regra.kpi_codigo, { ...filtro, dias: regra.janela_dias }, cfg);
    const veredito = avaliarRegra(regra, resultado);

    const disparo: Disparo = {
      regra: regra.codigo,
      nome: regra.nome,
      kpi: regra.kpi_codigo,
      disparou: veredito.disparou,
      motivo: veredito.motivo,
      valor: resultado.valor,
      limite: veredito.limite ?? regra.limite,
    };

    if (veredito.disparou) {
      const registro = await registrarAlerta({
        chave: `REGRA:${regra.codigo}${escopo ? `:${escopo}` : ''}`,
        tipo: regra.tipo_alerta,
        categoria: regra.categoria,
        prioridade: regra.prioridade,
        titulo: regra.nome,
        mensagem: `${regra.nome}: ${veredito.motivo}`,
        origem: `BI / regra ${regra.codigo}`,
        entidade: 'kpi',
        entidade_id: regra.kpi_id,
        link: resultado.drilldown ? `/bi/drilldown/${resultado.drilldown}` : null,
        kpi_id: regra.kpi_id,
        valor: resultado.valor,
        limite: veredito.limite ?? regra.limite,
        produto_id: filtro.produto_id ?? null,
        fornecedor_id: filtro.fornecedor_id ?? null,
        detalhes: {
          regra: regra.codigo,
          kpi: regra.kpi_codigo,
          periodo: resultado.periodo,
          semaforo: resultado.semaforo,
          filtros: resultado.filtros_aplicados,
        },
      }, contexto);

      disparo.alerta_id = registro.id;
      disparo.novo = registro.novo;
      disparo.ocorrencias = registro.ocorrencias;
    }

    disparos.push(disparo);
  }

  return { avaliadas: regras.length, disparos };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export interface FiltroAlertas {
  status?: string;
  prioridade?: string;
  categoria?: string;
  origem?: string;
  produto_id?: number;
  fornecedor_id?: number;
  responsavel_id?: number;
  limite?: number;
  pagina?: number;
}

export async function listarAlertas(filtro: FiltroAlertas) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('a.status = $?::status_alerta_enum', filtro.status ?? 'ABERTO');
  add('a.prioridade = $?::prioridade_alerta_enum', filtro.prioridade);
  add('a.categoria = $?', filtro.categoria);
  add('a.origem ILIKE $?', filtro.origem ? `%${filtro.origem}%` : undefined);
  add('a.produto_id = $?', filtro.produto_id);
  add('a.fornecedor_id = $?', filtro.fornecedor_id);
  add('a.usuario_responsavel_id = $?', filtro.responsavel_id);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT a.id, a.titulo, a.mensagem AS descricao, a.origem,
           a.prioridade::text AS prioridade, a.severidade::text AS severidade,
           a.categoria, a.tipo::text AS tipo, a.status::text AS status,
           a.data_geracao, a.data_resolucao, a.primeira_ocorrencia,
           a.ultima_ocorrencia, a.ocorrencias, a.link, a.entidade, a.entidade_id,
           a.valor, a.limite, a.produto_id, a.fornecedor_id, a.ordem_compra_id,
           k.codigo AS kpi, u.nome AS responsavel, a.usuario_responsavel_id,
           p.descricao AS produto, f.razao_social AS fornecedor,
           count(*) OVER () AS total
      FROM alertas a
      LEFT JOIN kpi_definicoes k ON k.id = a.kpi_id
      LEFT JOIN usuarios u       ON u.id = a.usuario_responsavel_id
      LEFT JOIN produtos p       ON p.id = a.produto_id
      LEFT JOIN fornecedores f   ON f.id = a.fornecedor_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY CASE a.prioridade
                WHEN 'CRITICO' THEN 1 WHEN 'ALTO' THEN 2
                WHEN 'MEDIO' THEN 3 ELSE 4 END,
              a.ultima_ocorrencia DESC NULLS LAST, a.data_geracao DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  const total = rows.length ? Number((rows[0] as { total: string }).total) : 0;
  return {
    total,
    pagina,
    limite,
    alertas: rows.map((r) => {
      const { total: _t, ...alerta } = r as Record<string, unknown>;
      return {
        ...alerta,
        significado: SIGNIFICADO_PRIORIDADE[
          (alerta.prioridade as Prioridade) ?? 'MEDIO'] ?? null,
      };
    }),
  };
}

export async function obterAlerta(id: number) {
  const { rows } = await query(`
    SELECT a.*, a.mensagem AS descricao, k.codigo AS kpi, k.nome AS kpi_nome,
           u.nome AS responsavel, p.descricao AS produto, f.razao_social AS fornecedor
      FROM alertas a
      LEFT JOIN kpi_definicoes k ON k.id = a.kpi_id
      LEFT JOIN usuarios u       ON u.id = a.usuario_responsavel_id
      LEFT JOIN produtos p       ON p.id = a.produto_id
      LEFT JOIN fornecedores f   ON f.id = a.fornecedor_id
     WHERE a.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Alerta');
  const alerta = rows[0] as Record<string, unknown>;
  return {
    ...alerta,
    significado: SIGNIFICADO_PRIORIDADE[(alerta.prioridade as Prioridade)] ?? null,
  };
}

/**
 * Agrupamento da secao 42: quantos alertas abertos por categoria e prioridade.
 * A central abre por aqui - o operador ve o volume antes da lista.
 */
export async function resumoAlertas() {
  const { rows } = await query<{
    categoria: string; prioridade: Prioridade; quantidade: string; reincidentes: string;
  }>(`
    SELECT coalesce(a.categoria, 'sem_categoria') AS categoria,
           coalesce(a.prioridade, 'MEDIO')        AS prioridade,
           count(*)                                AS quantidade,
           count(*) FILTER (WHERE a.ocorrencias > 1) AS reincidentes
      FROM alertas a
     WHERE a.status = 'ABERTO'
     GROUP BY 1, 2`);

  const porCategoria: Record<string, Record<string, number>> = {};
  const porPrioridade: Record<string, number> = {
    CRITICO: 0, ALTO: 0, MEDIO: 0, BAIXO: 0,
  };
  let total = 0;
  let reincidentes = 0;

  for (const r of rows) {
    const q = Number(r.quantidade);
    total += q;
    reincidentes += Number(r.reincidentes);
    porPrioridade[r.prioridade] = (porPrioridade[r.prioridade] ?? 0) + q;
    (porCategoria[r.categoria] ??= {})[r.prioridade] = q;
  }

  return {
    total,
    reincidentes,
    por_prioridade: porPrioridade,
    por_categoria: porCategoria,
    significados: SIGNIFICADO_PRIORIDADE,
    categorias: CATEGORIAS,
  };
}

// ---------------------------------------------------------------------------
// Tratativa
// ---------------------------------------------------------------------------

const TRANSICOES: Record<string, string[]> = {
  ABERTO: ['EM_TRATATIVA', 'RESOLVIDO', 'IGNORADO'],
  EM_TRATATIVA: ['RESOLVIDO', 'IGNORADO'],
  RESOLVIDO: [],
  IGNORADO: ['ABERTO'],
};

/**
 * Muda o status do alerta.
 *
 * Isto NAO altera dado operacional (regra 9 da secao 71): fechar o alerta de
 * ruptura nao repoe estoque. O alerta e um apontamento sobre o dado, e essa
 * separacao e o que impede o dashboard de virar um caminho paralelo de
 * escrita nos modulos operacionais.
 */
export async function tratarAlerta(
  id: number,
  destino: string,
  contexto: ContextoSessao,
  observacao?: string,
  responsavelId?: number,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ status: string; titulo: string | null }>(
      'SELECT status::text AS status, titulo FROM alertas WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw naoEncontrado('Alerta');

    const atual = rows[0]!.status;
    if (!(TRANSICOES[atual] ?? []).includes(destino)) {
      throw regraNegocio(`Alerta ${atual} nao pode ir para ${destino}`);
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE alertas
         SET status = $2::status_alerta_enum,
             data_resolucao = CASE WHEN $2 = 'RESOLVIDO' THEN now() ELSE NULL END,
             usuario_responsavel_id = coalesce($3, usuario_responsavel_id),
             detalhes = coalesce(detalhes, '{}'::jsonb)
                        || jsonb_build_object('tratativa', $4::text,
                                              'tratado_em', now()),
             updated_at = now()
       WHERE id = $1
      RETURNING id, status::text AS status, data_resolucao`,
    [id, destino, responsavelId ?? contexto.usuarioId ?? null, observacao ?? null]);

    return atualizado[0];
  });
}

export async function listarRegras() {
  const regras = await carregarRegras();
  return regras.map((r) => ({
    ...r,
    significado_prioridade: SIGNIFICADO_PRIORIDADE[r.prioridade],
    ordem: ORDEM_PRIORIDADE[r.prioridade],
  }));
}
