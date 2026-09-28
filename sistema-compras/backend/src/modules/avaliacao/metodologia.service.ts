/**
 * Metodologia de avaliacao: criterios, pesos e versionamento.
 *
 * A regra que organiza este arquivo e a 8 da secao 67: toda alteracao
 * metodologica e versionada. Na pratica isso vira duas travas:
 *
 *   - metodologia publicada nao aceita mudanca de criterio nem de peso;
 *   - alterar peso e criar VERSAO NOVA, a partir da anterior.
 *
 * Sem isso, mudar um peso hoje mudaria o significado de toda avaliacao
 * gravada no ano passado - e o historico deixaria de querer dizer alguma
 * coisa.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  listarMetodologiasSchema, metodologiaSchema, publicarMetodologiaSchema,
} from './avaliacao.schemas.js';
import { validarPesos, type Direcao, type Grupo } from './calculos.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);

export interface DefinicaoCriterio {
  id: number;
  grupo: Grupo;
  nome: string;
  descricao: string | null;
  peso: number;
  minimoEventos: number;
  ordem: number;
  indicadores: Array<{
    codigo: string;
    nome: string;
    peso: number;
    direcao: Direcao;
    valorPior: number | null;
    valorMelhor: number | null;
    unidade: string | null;
    minimoEventos: number;
    ordem: number;
  }>;
}

export interface MetodologiaCarregada {
  id: number;
  versao: string;
  nome: string;
  escopo: string;
  frequencia: string;
  escalaMaxima: number;
  publicada: boolean;
  vigente: boolean;
  criterios: DefinicaoCriterio[];
}

/**
 * Escolhe a metodologia vigente do mais especifico para o mais geral:
 * fornecedor, categoria, tipo de compra, empresa.
 *
 * A linha de empresa sempre existe e serve de piso - e a mesma ideia da
 * tolerancia do modulo 09. Sem um piso garantido, um fornecedor sem
 * metodologia propria simplesmente nao teria como ser avaliado.
 */
export async function resolverMetodologia(
  fornecedorId: number | null, categoriaId: number | null, tipoCompra: string | null,
): Promise<MetodologiaCarregada> {
  const { rows } = await query(`
    SELECT * FROM metodologias_avaliacao
     WHERE vigente AND ativo
       AND (
         (escopo = 'FORNECEDOR'  AND fornecedor_id = $1)
         OR (escopo = 'CATEGORIA'  AND categoria_id = $2)
         OR (escopo = 'TIPO_COMPRA' AND tipo_compra = $3)
         OR escopo = 'EMPRESA'
       )
     ORDER BY CASE escopo WHEN 'FORNECEDOR' THEN 1 WHEN 'CATEGORIA' THEN 2
                          WHEN 'TIPO_COMPRA' THEN 3 ELSE 4 END
     LIMIT 1`, [fornecedorId, categoriaId, tipoCompra]);

  if (!rows.length) {
    throw regraNegocio(
      'Nenhuma metodologia de avaliacao vigente. Publique uma metodologia antes de avaliar');
  }
  return carregar(Number(rows[0].id));
}

export async function carregar(metodologiaId: number): Promise<MetodologiaCarregada> {
  const { rows } = await query(
    'SELECT * FROM metodologias_avaliacao WHERE id = $1', [metodologiaId]);
  if (!rows.length) throw naoEncontrado('Metodologia');
  const m = rows[0];

  const { rows: criterios } = await query(
    'SELECT * FROM metodologia_criterios WHERE metodologia_id = $1 ORDER BY ordem, id',
    [metodologiaId]);

  const { rows: indicadores } = await query(`
    SELECT i.* FROM metodologia_indicadores i
      JOIN metodologia_criterios c ON c.id = i.metodologia_criterio_id
     WHERE c.metodologia_id = $1 ORDER BY i.ordem, i.id`, [metodologiaId]);

  return {
    id: Number(m.id),
    versao: m.versao,
    nome: m.nome,
    escopo: m.escopo,
    frequencia: m.frequencia,
    escalaMaxima: num(m.escala_maxima),
    publicada: m.publicada_em !== null,
    vigente: m.vigente,
    criterios: criterios.map((c: any) => ({
      id: Number(c.id),
      grupo: c.grupo as Grupo,
      nome: c.nome,
      descricao: c.descricao,
      peso: num(c.peso_percentual),
      minimoEventos: Number(c.minimo_eventos),
      ordem: Number(c.ordem),
      indicadores: indicadores
        .filter((i: any) => Number(i.metodologia_criterio_id) === Number(c.id))
        .map((i: any) => ({
          codigo: i.codigo,
          nome: i.nome,
          peso: num(i.peso_percentual),
          direcao: i.direcao as Direcao,
          valorPior: i.valor_pior === null ? null : num(i.valor_pior),
          valorMelhor: i.valor_melhor === null ? null : num(i.valor_melhor),
          unidade: i.unidade,
          minimoEventos: Number(i.minimo_eventos),
          ordem: Number(i.ordem),
        })),
    })),
  };
}

async function gravarCriterios(
  cliente: Cliente, metodologiaId: number,
  criterios: z.output<typeof metodologiaSchema>['criterios'],
) {
  await cliente.query(
    'DELETE FROM metodologia_criterios WHERE metodologia_id = $1', [metodologiaId]);

  let ordem = 0;
  for (const c of criterios) {
    ordem += 1;
    const { rows } = await cliente.query(`
      INSERT INTO metodologia_criterios
        (metodologia_id, grupo, nome, descricao, peso_percentual, minimo_eventos, ordem)
      VALUES ($1,$2::grupo_criterio_enum,$3,$4,$5,$6,$7) RETURNING id`,
      [metodologiaId, c.grupo, c.nome, c.descricao ?? null, c.peso_percentual,
        c.minimo_eventos, ordem]);

    let ordemIndicador = 0;
    for (const i of c.indicadores ?? []) {
      ordemIndicador += 1;
      await cliente.query(`
        INSERT INTO metodologia_indicadores
          (metodologia_criterio_id, codigo, nome, peso_percentual, direcao,
           valor_pior, valor_melhor, unidade, minimo_eventos, ordem)
        VALUES ($1,$2,$3,$4,$5::direcao_criterio_enum,$6,$7,$8,$9,$10)`,
        [rows[0].id, i.codigo, i.nome, i.peso_percentual, i.direcao,
          i.valor_pior ?? null, i.valor_melhor ?? null, i.unidade ?? null,
          i.minimo_eventos, ordemIndicador]);
    }
  }
}

export async function criarMetodologia(
  entrada: z.output<typeof metodologiaSchema>, contexto: ContextoSessao,
) {
  // Regra 4 da secao 67, validada antes de tocar no banco para a mensagem
  // chegar em portugues em vez de como erro de constraint.
  const pesos = validarPesos(entrada.criterios.map((c) => c.peso_percentual));
  if (!pesos.valido) throw regraNegocio(pesos.mensagem!);

  for (const c of entrada.criterios) {
    const internos = (c.indicadores ?? []).map((i) => i.peso_percentual);
    if (internos.length) {
      const soma = Math.round(internos.reduce((a, p) => a + p, 0) * 100) / 100;
      if (soma !== 100) {
        throw regraNegocio(
          `Os indicadores do criterio ${c.grupo} somam ${soma}% e precisam somar 100%`);
      }
    }
  }

  return comTransacao(contexto, async (cliente) => {
    const { rows: duplicada } = await cliente.query(
      'SELECT id FROM metodologias_avaliacao WHERE versao = $1', [entrada.versao]);
    if (duplicada.length) {
      throw conflito(`Ja existe uma metodologia na versao ${entrada.versao}`);
    }

    const { rows } = await cliente.query(`
      INSERT INTO metodologias_avaliacao
        (versao, nome, descricao, escopo, categoria_id, fornecedor_id, tipo_compra,
         escala_maxima, frequencia, observacoes, created_by, updated_by)
      VALUES ($1,$2,$3,$4::escopo_metodologia_enum,$5,$6,$7,$8,
              $9::frequencia_avaliacao_enum,$10,$11,$11)
      RETURNING *`,
      [entrada.versao, entrada.nome, entrada.descricao ?? null, entrada.escopo,
        entrada.categoria_id ?? null, entrada.fornecedor_id ?? null,
        entrada.tipo_compra ?? null, entrada.escala_maxima, entrada.frequencia,
        entrada.observacoes ?? null, contexto.usuarioId ?? null]);

    await gravarCriterios(cliente, Number(rows[0].id), entrada.criterios);
    return { ...rows[0], criterios: entrada.criterios.length };
  });
}

/**
 * Edita uma metodologia que ainda nao foi publicada.
 *
 * Depois de publicada ela e congelada: quem quiser outro peso cria a versao
 * seguinte. E o que garante que uma avaliacao de marco continue querendo
 * dizer, em dezembro, exatamente o que dizia em marco.
 */
export async function editarMetodologia(
  metodologiaId: number, entrada: z.output<typeof metodologiaSchema>,
  contexto: ContextoSessao,
) {
  const pesos = validarPesos(entrada.criterios.map((c) => c.peso_percentual));
  if (!pesos.valido) throw regraNegocio(pesos.mensagem!);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM metodologias_avaliacao WHERE id = $1 FOR UPDATE', [metodologiaId]);
    if (!rows.length) throw naoEncontrado('Metodologia');

    if (rows[0].publicada_em !== null) {
      throw conflito(
        `A metodologia ${rows[0].versao} ja foi publicada e nao pode ser alterada.`
        + ' Crie uma nova versao a partir dela');
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE metodologias_avaliacao
         SET nome = $2, descricao = $3, escopo = $4::escopo_metodologia_enum,
             categoria_id = $5, fornecedor_id = $6, tipo_compra = $7,
             escala_maxima = $8, frequencia = $9::frequencia_avaliacao_enum,
             observacoes = $10, updated_by = $11, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [metodologiaId, entrada.nome, entrada.descricao ?? null, entrada.escopo,
        entrada.categoria_id ?? null, entrada.fornecedor_id ?? null,
        entrada.tipo_compra ?? null, entrada.escala_maxima, entrada.frequencia,
        entrada.observacoes ?? null, contexto.usuarioId ?? null]);

    await gravarCriterios(cliente, metodologiaId, entrada.criterios);
    return atualizada[0];
  });
}

/**
 * Nova versao a partir de uma existente (secao 36).
 *
 * Copia criterios e indicadores; quem chamou ajusta o que quiser e publica.
 * As avaliacoes antigas continuam apontando para a versao antiga.
 */
export async function versionarMetodologia(
  metodologiaId: number, versao: string, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM metodologias_avaliacao WHERE id = $1', [metodologiaId]);
    if (!rows.length) throw naoEncontrado('Metodologia');
    const origem = rows[0];

    const { rows: duplicada } = await cliente.query(
      'SELECT id FROM metodologias_avaliacao WHERE versao = $1', [versao]);
    if (duplicada.length) throw conflito(`Ja existe uma metodologia na versao ${versao}`);

    const { rows: nova } = await cliente.query(`
      INSERT INTO metodologias_avaliacao
        (versao, nome, descricao, escopo, categoria_id, fornecedor_id, tipo_compra,
         escala_maxima, frequencia, observacoes, created_by, updated_by)
      SELECT $2, nome, descricao, escopo, categoria_id, fornecedor_id, tipo_compra,
             escala_maxima, frequencia,
             coalesce(observacoes || ' | ', '') || 'Derivada da versao ' || versao,
             $3, $3
        FROM metodologias_avaliacao WHERE id = $1
      RETURNING *`, [metodologiaId, versao, contexto.usuarioId ?? null]);

    const novaId = Number(nova[0].id);

    const { rows: criterios } = await cliente.query(`
      INSERT INTO metodologia_criterios
        (metodologia_id, grupo, nome, descricao, peso_percentual, minimo_eventos, ordem)
      SELECT $2, grupo, nome, descricao, peso_percentual, minimo_eventos, ordem
        FROM metodologia_criterios WHERE metodologia_id = $1
      RETURNING id, grupo`, [metodologiaId, novaId]);

    for (const c of criterios) {
      await cliente.query(`
        INSERT INTO metodologia_indicadores
          (metodologia_criterio_id, codigo, nome, peso_percentual, direcao,
           valor_pior, valor_melhor, unidade, minimo_eventos, ordem)
        SELECT $1, i.codigo, i.nome, i.peso_percentual, i.direcao,
               i.valor_pior, i.valor_melhor, i.unidade, i.minimo_eventos, i.ordem
          FROM metodologia_indicadores i
          JOIN metodologia_criterios mc ON mc.id = i.metodologia_criterio_id
         WHERE mc.metodologia_id = $2 AND mc.grupo = $3::grupo_criterio_enum`,
        [c.id, metodologiaId, c.grupo]);
    }

    return { ...nova[0], derivada_de: origem.versao, criterios: criterios.length };
  });
}

/** Publica e, opcionalmente, torna vigente no escopo. */
export async function publicarMetodologia(
  metodologiaId: number, entrada: z.output<typeof publicarMetodologiaSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM metodologias_avaliacao WHERE id = $1 FOR UPDATE', [metodologiaId]);
    if (!rows.length) throw naoEncontrado('Metodologia');
    const m = rows[0];

    const { rows: criterios } = await cliente.query(`
      SELECT c.grupo, c.peso_percentual,
             (SELECT count(*)::int FROM metodologia_indicadores i
               WHERE i.metodologia_criterio_id = c.id) AS indicadores
        FROM metodologia_criterios c WHERE c.metodologia_id = $1`, [metodologiaId]);
    if (!criterios.length) throw regraNegocio('A metodologia nao tem criterios');

    const pesos = validarPesos(criterios.map((c: any) => num(c.peso_percentual)));
    if (!pesos.valido) throw regraNegocio(pesos.mensagem!);

    // Criterio que pontua mas nao tem indicador nunca seria calculavel: o peso
    // dele viraria buraco permanente no score, e toda avaliacao nasceria
    // parcial sem que ninguem entendesse por que. Peso zero pode ficar sem
    // indicador, porque nao entra na conta.
    const semIndicador = criterios.filter(
      (c: any) => num(c.peso_percentual) > 0 && Number(c.indicadores) === 0);
    if (semIndicador.length) {
      throw regraNegocio(
        `Estes criterios tem peso mas nenhum indicador configurado, entao nunca poderiam`
        + ` ser calculados: ${semIndicador.map((c: any) => c.grupo).join(', ')}`);
    }

    if (entrada.vigente) {
      // Uma vigente por escopo: a anterior sai de cena, mas continua existindo
      // para as avaliacoes que a usaram.
      await cliente.query(`
        UPDATE metodologias_avaliacao
           SET vigente = FALSE, updated_at = now()
         WHERE vigente AND id <> $1 AND escopo = $2::escopo_metodologia_enum
           AND categoria_id IS NOT DISTINCT FROM $3
           AND fornecedor_id IS NOT DISTINCT FROM $4
           AND tipo_compra IS NOT DISTINCT FROM $5`,
        [metodologiaId, m.escopo, m.categoria_id, m.fornecedor_id, m.tipo_compra]);
    }

    const { rows: publicada } = await cliente.query(`
      UPDATE metodologias_avaliacao
         SET publicada_em = coalesce(publicada_em, now()), vigente = $2,
             updated_by = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [metodologiaId, entrada.vigente, contexto.usuarioId ?? null]);

    return publicada[0];
  });
}

export async function listarMetodologias(
  filtro: z.output<typeof listarMetodologiasSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.escopo) filtrar('m.escopo = $?::escopo_metodologia_enum', filtro.escopo);
  if (filtro.vigente !== undefined) filtrar('m.vigente = $?', filtro.vigente);
  if (filtro.fornecedor_id) filtrar('m.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.categoria_id) filtrar('m.categoria_id = $?', filtro.categoria_id);
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(m.versao ILIKE $${valores.length} OR m.nome ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM metodologias_avaliacao m ${onde}`, valores);

  const { rows } = await query(`
    SELECT m.*, c.nome AS categoria, f.razao_social AS fornecedor,
           (SELECT count(*)::int FROM metodologia_criterios x
             WHERE x.metodologia_id = m.id) AS criterios,
           (SELECT coalesce(sum(x.peso_percentual), 0) FROM metodologia_criterios x
             WHERE x.metodologia_id = m.id) AS soma_pesos,
           (SELECT count(*)::int FROM avaliacoes_fornecedores a
             WHERE a.metodologia_id = m.id) AS avaliacoes
      FROM metodologias_avaliacao m
      LEFT JOIN categorias c ON c.id = m.categoria_id
      LEFT JOIN fornecedores f ON f.id = m.fornecedor_id
      ${onde}
     ORDER BY m.vigente DESC, m.versao DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

export async function detalharMetodologia(metodologiaId: number) {
  const metodologia = await carregar(metodologiaId);

  const { rows: uso } = await query(`
    SELECT count(*)::int AS avaliacoes, min(periodo_inicio) AS primeira,
           max(periodo_fim) AS ultima
      FROM avaliacoes_fornecedores WHERE metodologia_id = $1`, [metodologiaId]);

  return {
    ...metodologia,
    soma_pesos: metodologia.criterios.reduce((a, c) => a + c.peso, 0),
    uso: uso[0],
  };
}
