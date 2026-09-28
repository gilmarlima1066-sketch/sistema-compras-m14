/**
 * Conciliacao entre o sistema e a origem externa (secao 34).
 *
 * A regra que define este modulo esta na propria secao 34: *"Nunca corrigir
 * automaticamente sem regra autorizada."*
 *
 * E por isso que aqui nao existe nenhuma funcao que escreva no estoque. A
 * conciliacao COMPARA, registra a divergencia, gera alerta e para. Quem aceita
 * o numero externo e uma pessoa, e a aceitacao fica gravada com nome e
 * justificativa - o CHECK `ck_conciliacao_aceite` garante que a justificativa
 * existe.
 *
 * O motivo nao e burocracia. "ERP diz 1.000 kg, sistema diz 950" pode ser
 * qualquer uma de cinco coisas: recebimento nao lancado, venda nao faturada,
 * perda nao registrada, erro de digitacao no inventario, ou o ERP que esta
 * errado. Corrigir sozinho escolheria uma das cinco no escuro, e apagaria a
 * evidencia das outras quatro.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import * as eventos from '../automacao/eventos.service.js';
import { registrarAlerta } from '../bi/alertas.service.js';
import { numero as configNumero } from './config.js';

export type StatusConciliacao =
  | 'DIVERGENTE' | 'CONCILIADO' | 'ACEITO' | 'EM_ANALISE' | 'IGNORADO';

export interface Divergencia {
  entidade: string;
  chave_externa: string;
  referencia_id?: number | null;
  campo: string;
  valor_interno: number | null;
  valor_externo: number | null;
  unidade?: string | null;
  descricao?: string | null;
}

export interface ResultadoConciliacao {
  integracao: string;
  entidade: string;
  campo: string;
  comparados: number;
  divergentes: number;
  dentro_tolerancia: number;
  sem_referencia: number;
  tolerancia_percentual: number;
  maior_diferenca: number | null;
  registradas: number;
  ja_abertas: number;
  motivo_sem_base?: string;
}

/**
 * Compara uma lista de valores externos com os internos e registra o que diverge.
 *
 * A tolerancia existe porque arredondamento de unidade e diferenca de momento
 * de corte produzem divergencia minuscula em quase toda linha. Sem ela, a tela
 * de conciliacao nasceria com dez mil linhas irrelevantes e ninguem olharia a
 * que importa.
 */
export async function conciliar(
  integracaoCodigo: string,
  entidade: string,
  campo: string,
  externos: Divergencia[],
  contexto: ContextoSessao,
  opcoes: { execucao_id?: number | null; tolerancia_percentual?: number } = {},
): Promise<ResultadoConciliacao> {
  const tolerancia = opcoes.tolerancia_percentual
    ?? await configNumero('conciliacao_tolerancia_percentual', 1);

  const { rows: integracao } = await query<{ id: string }>(
    'SELECT id FROM integracoes WHERE upper(codigo) = upper($1)', [integracaoCodigo]);
  if (!integracao.length) throw naoEncontrado(`Integracao ${integracaoCodigo}`);
  const integracaoId = Number(integracao[0]!.id);

  let divergentes = 0;
  let dentroTolerancia = 0;
  let semReferencia = 0;
  let registradas = 0;
  let jaAbertas = 0;
  let maiorDiferenca: number | null = null;

  const hoje = new Date().toISOString().slice(0, 10);

  for (const d of externos) {
    if (d.valor_interno === null || d.valor_externo === null) {
      semReferencia += 1;
      continue;
    }

    const diferenca = d.valor_externo - d.valor_interno;
    const base = Math.abs(d.valor_interno) > 0 ? Math.abs(d.valor_interno) : 1;
    const percentual = Math.abs(diferenca) / base * 100;

    if (Math.abs(diferenca) < 1e-9 || percentual <= tolerancia) {
      dentroTolerancia += 1;
      continue;
    }

    divergentes += 1;
    if (maiorDiferenca === null || Math.abs(diferenca) > Math.abs(maiorDiferenca)) {
      maiorDiferenca = diferenca;
    }

    // A chave inclui o dia: a divergencia de hoje e um fato novo em relacao a
    // de ontem, mesmo sendo do mesmo produto - a mesma logica dos eventos do
    // modulo 13.
    const chaveDedup = `${integracaoCodigo}:${entidade}:${d.chave_externa}:${campo}:${hoje}`;

    const { rows } = await query<{ id: string; inserido: boolean }>(`
      INSERT INTO conciliacoes
        (integracao_id, execucao_id, entidade, chave_externa, referencia_id, campo,
         valor_interno, valor_externo, diferenca_percentual, unidade, tolerancia,
         chave_dedup)
      VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10,
              $11::numeric, $12)
      ON CONFLICT (chave_dedup) WHERE chave_dedup IS NOT NULL AND status = 'DIVERGENTE'
      DO UPDATE SET valor_interno = EXCLUDED.valor_interno,
                    valor_externo = EXCLUDED.valor_externo,
                    diferenca_percentual = EXCLUDED.diferenca_percentual
      RETURNING id, (xmax = 0) AS inserido`,
    [integracaoId, opcoes.execucao_id ?? null, entidade, d.chave_externa,
      d.referencia_id ?? null, campo, d.valor_interno, d.valor_externo,
      Math.round(percentual * 10000) / 10000, d.unidade ?? null, tolerancia,
      chaveDedup]);

    if (rows[0]!.inserido) registradas += 1; else jaAbertas += 1;
  }

  if (registradas > 0) {
    await avisar(integracaoCodigo, entidade, campo, registradas, maiorDiferenca, contexto);
  }

  return {
    integracao: integracaoCodigo,
    entidade,
    campo,
    comparados: externos.length,
    divergentes,
    dentro_tolerancia: dentroTolerancia,
    sem_referencia: semReferencia,
    tolerancia_percentual: tolerancia,
    maior_diferenca: maiorDiferenca === null
      ? null : Math.round(maiorDiferenca * 10000) / 10000,
    registradas,
    ja_abertas: jaAbertas,
    // Zero divergencias com zero comparacoes nao e "esta tudo certo".
    ...(externos.length === 0 ? {
      motivo_sem_base: 'Nenhum valor externo recebido para comparar',
    } : semReferencia === externos.length ? {
      motivo_sem_base: `Os ${externos.length} registros externos nao casaram com `
        + 'nenhum registro interno: a chave de correspondencia pode estar errada',
    } : {}),
  };
}

async function avisar(
  integracao: string, entidade: string, campo: string, total: number,
  maior: number | null, contexto: ContextoSessao,
): Promise<void> {
  const hoje = new Date().toISOString().slice(0, 10);

  await registrarAlerta({
    chave: `conciliacao:${integracao}:${entidade}:${campo}:${hoje}`,
    tipo: 'INTEGRACAO_DIVERGENCIA',
    categoria: 'governanca',
    prioridade: total > 50 ? 'ALTO' : 'MEDIO',
    titulo: `${total} divergencia(s) de ${campo} entre o sistema e ${integracao}`,
    mensagem: `Comparacao de ${entidade} encontrou ${total} registro(s) fora da `
      + `tolerancia${maior !== null ? `; a maior diferenca foi de ${maior}` : ''}. `
      + 'Nenhum valor foi corrigido automaticamente (secao 34).',
    origem: `integracao:${integracao}`,
    entidade: 'conciliacao',
    link: `/integracoes/conciliacoes?entidade=${entidade}`,
    valor: total,
  }, contexto);

  await eventos.registrar({
    tipo: 'INTEGRATION_MISMATCH',
    origem: 'INTEGRACAO',
    entidade: 'conciliacao',
    payload: {
      integracao, entidade_conciliada: entidade, campo,
      divergencias: total, maior_diferenca: maior,
    },
  }, contexto);
}

// ---------------------------------------------------------------------------
// Conciliacao de estoque: a do exemplo da secao 34
// ---------------------------------------------------------------------------

/**
 * Compara saldos de estoque com os do sistema externo.
 *
 * O saldo interno vem de `vw_estoque_atual`, a MESMA visao que o modulo 03 e o
 * painel usam. Calcular o saldo aqui de outro jeito criaria um segundo numero
 * para "quanto tem em estoque", e a conciliacao passaria a acusar divergencia
 * contra o proprio sistema.
 */
export async function conciliarEstoque(
  integracaoCodigo: string,
  saldosExternos: Array<{ codigo_produto: string; saldo: number; unidade?: string }>,
  contexto: ContextoSessao,
  opcoes: { execucao_id?: number | null } = {},
): Promise<ResultadoConciliacao> {
  if (!saldosExternos.length) {
    return conciliar(integracaoCodigo, 'estoque', 'saldo', [], contexto, opcoes);
  }

  const codigos = saldosExternos.map((s) => s.codigo_produto);
  const { rows } = await query<{
    codigo: string; produto_id: string; estoque_disponivel: string;
  }>(`
    SELECT codigo, produto_id, estoque_disponivel
      FROM vw_estoque_atual
     WHERE codigo = ANY($1::text[])`, [codigos]);

  const internos = new Map(rows.map((r) => [r.codigo, {
    id: Number(r.produto_id), saldo: Number(r.estoque_disponivel),
  }]));

  const divergencias: Divergencia[] = saldosExternos.map((s) => {
    const interno = internos.get(s.codigo_produto);
    return {
      entidade: 'estoque',
      chave_externa: s.codigo_produto,
      referencia_id: interno?.id ?? null,
      campo: 'saldo',
      valor_interno: interno?.saldo ?? null,
      valor_externo: s.saldo,
      unidade: s.unidade ?? null,
    };
  });

  return conciliar(integracaoCodigo, 'estoque', 'saldo', divergencias, contexto, opcoes);
}

// ---------------------------------------------------------------------------
// Decisao humana
// ---------------------------------------------------------------------------

/**
 * Aceita o valor externo como correto.
 *
 * ACEITAR NAO CORRIGE O ESTOQUE. Registra que uma pessoa olhou, concluiu que o
 * numero de fora esta certo e explicou por que. A correcao do saldo continua
 * sendo feita pelo modulo 03, por inventario ou movimentacao, com as regras e a
 * rastreabilidade de la. Fazer a conciliacao escrever no estoque abriria um
 * segundo caminho para alterar saldo - sem documento, sem movimentacao e sem
 * historico.
 */
export async function aceitar(
  id: number, usuarioId: number, justificativa: string,
): Promise<{ id: number; status: StatusConciliacao; observacao: string }> {
  if (!justificativa?.trim() || justificativa.trim().length < 10) {
    throw regraNegocio(
      'Aceitar o valor externo exige justificativa com ao menos 10 caracteres: '
      + 'ela e o que explica a divergencia para quem consultar depois.');
  }

  const { rows } = await query<{ entidade: string; chave_externa: string }>(`
    UPDATE conciliacoes
       SET status = 'ACEITO', decidido_por = $2, decidido_em = now(),
           justificativa = $3
     WHERE id = $1 AND status IN ('DIVERGENTE', 'EM_ANALISE')
     RETURNING entidade, chave_externa`,
  [id, usuarioId, justificativa.trim()]);

  if (!rows.length) throw regraNegocio('A divergencia ja foi decidida ou nao existe');

  return {
    id,
    status: 'ACEITO',
    observacao: 'A divergencia foi registrada como aceita. O saldo NAO foi alterado: '
      + 'a correcao, se necessaria, e feita por inventario ou movimentacao no '
      + 'modulo de estoque, que mantem documento e historico.',
  };
}

export async function marcarConciliado(
  id: number, usuarioId: number, justificativa?: string | null,
): Promise<void> {
  const { rowCount } = await query(`
    UPDATE conciliacoes
       SET status = 'CONCILIADO', decidido_por = $2, decidido_em = now(),
           justificativa = coalesce($3, justificativa)
     WHERE id = $1 AND status IN ('DIVERGENTE', 'EM_ANALISE')`,
  [id, usuarioId, justificativa ?? null]);
  if (!rowCount) throw regraNegocio('A divergencia ja foi decidida ou nao existe');
}

export async function ignorar(
  id: number, usuarioId: number, motivo: string,
): Promise<void> {
  if (!motivo?.trim()) throw regraNegocio('Ignorar uma divergencia exige motivo');
  const { rowCount } = await query(`
    UPDATE conciliacoes
       SET status = 'IGNORADO', decidido_por = $2, decidido_em = now(),
           justificativa = $3
     WHERE id = $1 AND status IN ('DIVERGENTE', 'EM_ANALISE')`,
  [id, usuarioId, motivo.trim()]);
  if (!rowCount) throw regraNegocio('A divergencia ja foi decidida ou nao existe');
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listar(filtro: {
  status?: string; entidade?: string; integracao?: string;
  limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('c.status = $?::status_conciliacao_enum', filtro.status);
  add('c.entidade = $?', filtro.entidade);
  add('upper(i.codigo) = upper($?)', filtro.integracao);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT c.id, c.entidade, c.chave_externa, c.referencia_id, c.campo,
           c.valor_interno, c.valor_externo, c.diferenca, c.diferenca_percentual,
           c.unidade, c.tolerancia, c.status::text AS status, c.justificativa,
           c.decidido_em, c.created_at, i.codigo AS integracao, i.nome AS integracao_nome,
           u.nome AS decidido_por_nome,
           p.descricao AS produto_descricao,
           count(*) OVER () AS total
      FROM conciliacoes c
      LEFT JOIN integracoes i ON i.id = c.integracao_id
      LEFT JOIN usuarios u ON u.id = c.decidido_por
      LEFT JOIN produtos p ON p.id = c.referencia_id AND c.entidade = 'estoque'
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY CASE WHEN c.status = 'DIVERGENTE' THEN 0 ELSE 1 END,
              abs(c.diferenca) DESC, c.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    conciliacoes: rows.map((r) => {
      const { total: _t, ...c } = r as Record<string, unknown>;
      return c;
    }),
  };
}

export async function resumo() {
  const { rows } = await query(`
    SELECT c.entidade, c.campo, c.status::text AS status,
           count(*) AS total,
           round(sum(abs(c.diferenca)), 4) AS diferenca_absoluta,
           round(max(abs(c.diferenca)), 4) AS maior
      FROM conciliacoes c
     WHERE c.created_at >= now() - interval '30 days'
     GROUP BY c.entidade, c.campo, c.status
     ORDER BY c.entidade, c.campo, c.status`);

  return rows.map((r) => {
    const c = r as Record<string, unknown>;
    return {
      ...c,
      total: Number(c.total),
      diferenca_absoluta: c.diferenca_absoluta === null
        ? null : Number(c.diferenca_absoluta),
      maior: c.maior === null ? null : Number(c.maior),
    };
  });
}
