/**
 * Motor de sincronizacao (secoes 6, 8, 9, 10, 28 e 29).
 *
 * O caminho de ENTRADA, da secao 6:
 *
 *   SISTEMA EXTERNO -> CONECTOR -> AUTENTICACAO -> RECEBIMENTO -> VALIDACAO
 *   -> NORMALIZACAO -> MAPEAMENTO -> [MENSAGEM] -> PROCESSAMENTO -> BANCO
 *   -> EVENTO -> AUTOMACAO -> MODULOS
 *
 * A etapa entre colchetes e a que sustenta o resto. Cada registro externo vira
 * uma MENSAGEM antes de virar qualquer coisa no sistema, e a mensagem carrega
 * a chave natural da origem e o hash do conteudo. Com esses dois campos, a
 * pergunta "ja processei isto?" tem resposta exata:
 *
 *   chave nova            -> criar
 *   chave conhecida, hash igual    -> descartar (nada mudou la fora)
 *   chave conhecida, hash diferente -> atualizar
 *
 * Quem garante e o indice UNIQUE `uq_mensagem_chave`, nao uma verificacao no
 * codigo: duas sincronizacoes simultaneas leriam ao mesmo tempo e as duas
 * criariam. O banco recusa a segunda.
 *
 * A SAIDA (secao 9) tem uma regra que nao se negocia: **o sistema nao envia
 * pedido que nao passou pela aprovacao**. Nao por educacao - porque enviar ao
 * ERP e um ato com consequencia financeira, e a alcada do modulo 07 e quem
 * decide se ele existe.
 */
import { comTransacao, pool, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import * as eventos from '../automacao/eventos.service.js';
import { registrarAlerta } from '../bi/alertas.service.js';
import * as conector from './conector.js';
import { numero as configNumero, ligado } from './config.js';
import * as credenciais from './credenciais.service.js';
import * as mapeador from './mapeamento.service.js';

export type Direcao = 'ENTRADA' | 'SAIDA' | 'BIDIRECIONAL';
export type Modo = 'TEMPO_REAL' | 'AGENDADO' | 'MANUAL' | 'SOB_DEMANDA';

export interface Integracao {
  id: number;
  codigo: string;
  nome: string;
  sistema: string;
  conector: string;
  direcao: Direcao;
  modo_sincronizacao: Modo;
  ativo: boolean;
  status: string;
  endpoint: string | null;
  configuracao: Record<string, unknown>;
  timeout_segundos: number;
  max_tentativas: number;
  limite_por_execucao: number;
  limite_por_minuto: number | null;
  intervalo_minutos: number | null;
  ultima_sincronizacao: string | null;
}

export async function obter(codigoOuId: string | number): Promise<Integracao> {
  const porId = typeof codigoOuId === 'number';
  const { rows } = await query<Record<string, unknown>>(`
    SELECT id, codigo, nome, sistema::text AS sistema, conector::text AS conector,
           direcao::text AS direcao, modo_sincronizacao::text AS modo_sincronizacao,
           ativo, status::text AS status, endpoint, configuracao, timeout_segundos,
           max_tentativas, limite_por_execucao, limite_por_minuto,
           intervalo_minutos, ultima_sincronizacao
      FROM integracoes
     WHERE ${porId ? 'id = $1' : 'upper(codigo) = upper($1)'}`, [codigoOuId]);

  const i = rows[0];
  if (!i) throw naoEncontrado(`Integracao ${codigoOuId}`);

  return {
    id: Number(i.id),
    codigo: String(i.codigo),
    nome: String(i.nome),
    sistema: String(i.sistema),
    conector: String(i.conector),
    direcao: i.direcao as Direcao,
    modo_sincronizacao: i.modo_sincronizacao as Modo,
    ativo: Boolean(i.ativo),
    status: String(i.status),
    endpoint: (i.endpoint as string) ?? null,
    configuracao: (i.configuracao as Record<string, unknown>) ?? {},
    timeout_segundos: Number(i.timeout_segundos),
    max_tentativas: Number(i.max_tentativas),
    limite_por_execucao: Number(i.limite_por_execucao),
    limite_por_minuto: i.limite_por_minuto === null ? null : Number(i.limite_por_minuto),
    intervalo_minutos: i.intervalo_minutos === null ? null : Number(i.intervalo_minutos),
    ultima_sincronizacao: (i.ultima_sincronizacao as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Execucao: abrir e fechar
// ---------------------------------------------------------------------------

export interface Execucao {
  id: number;
  correlation_id: string;
}

export async function abrirExecucao(entrada: {
  integracao: Integracao;
  tipo: 'SINCRONIZACAO' | 'IMPORTACAO' | 'EXPORTACAO' | 'TESTE' | 'CONCILIACAO' | 'ENVIO';
  direcao: Direcao;
  entidade?: string | null;
  modo?: Modo;
  disparado_por?: string;
}, contexto: ContextoSessao): Promise<Execucao> {
  const ambiente = await credenciais.ambienteDoServidor();
  const { rows } = await query<{ id: string; correlation_id: string }>(`
    INSERT INTO integracao_execucoes
      (integracao_id, integracao_codigo, tipo, direcao, entidade, modo, ambiente,
       disparado_por, usuario_id)
    VALUES ($1, $2, $3::tipo_execucao_integracao_enum,
            $4::direcao_integracao_enum, $5, $6::modo_sincronizacao_enum,
            $7::ambiente_enum, $8, $9)
    RETURNING id, correlation_id::text AS correlation_id`,
  [entrada.integracao.id, entrada.integracao.codigo, entrada.tipo, entrada.direcao,
    entrada.entidade ?? null, entrada.modo ?? entrada.integracao.modo_sincronizacao,
    ambiente, entrada.disparado_por ?? 'MANUAL', contexto.usuarioId ?? null]);

  return { id: Number(rows[0]!.id), correlation_id: rows[0]!.correlation_id };
}

export interface FechamentoExecucao {
  status: 'CONCLUIDA' | 'CONCLUIDA_COM_ERROS' | 'FALHOU' | 'CANCELADA';
  lidos?: number;
  criados?: number;
  atualizados?: number;
  descartados?: number;
  rejeitados?: number;
  marca_fim?: string | null;
  resumo?: Record<string, unknown>;
  erro?: string | null;
}

export async function fecharExecucao(
  execucaoId: number, dados: FechamentoExecucao,
): Promise<void> {
  await query(`
    UPDATE integracao_execucoes
       SET status = $2::status_execucao_integracao_enum,
           concluido_em = now(),
           duracao_ms = EXTRACT(EPOCH FROM (now() - iniciado_em)) * 1000,
           registros_lidos = $3, registros_criados = $4,
           registros_atualizados = $5, registros_descartados = $6,
           registros_rejeitados = $7, marca_fim = $8, resumo = $9::jsonb, erro = $10
     WHERE id = $1`,
  [execucaoId, dados.status, dados.lidos ?? 0, dados.criados ?? 0,
    dados.atualizados ?? 0, dados.descartados ?? 0, dados.rejeitados ?? 0,
    dados.marca_fim ?? null,
    dados.resumo ? JSON.stringify(dados.resumo) : null,
    dados.erro?.slice(0, 4000) ?? null]);
}

// ---------------------------------------------------------------------------
// Mensagens: o registro externo (secoes 14, 28 e 29)
// ---------------------------------------------------------------------------

export interface NovaMensagem {
  integracao: Integracao;
  execucao_id: number;
  direcao: Direcao;
  entidade: string;
  origem: 'ERP' | 'EXCEL' | 'CSV' | 'API' | 'MANUAL' | 'EMAIL' | 'WEBHOOK' | 'PORTAL';
  chave_externa: string;
  payload: Record<string, unknown>;
  normalizado?: Record<string, unknown>;
  versao_externa?: string | null;
  atualizado_na_origem?: string | null;
  correlation_id?: string | null;
}

export type Desfecho = 'NOVA' | 'ALTERADA' | 'INALTERADA';

/**
 * Registra o que chegou e diz se e novidade.
 *
 * O `ON CONFLICT DO UPDATE` devolve linha nos dois casos - `DO NOTHING` nao
 * devolveria, e precisariamos de uma segunda consulta. O `xmax = 0` distingue
 * insercao de conflito, e a comparacao de hash distingue "voltou igual" de
 * "mudou na origem".
 */
export async function registrarMensagem(
  entrada: NovaMensagem, contexto: ContextoSessao,
): Promise<{ id: number; desfecho: Desfecho }> {
  const normalizado = entrada.normalizado ?? entrada.payload;
  const hash = mapeador.hashConteudo(normalizado);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{
      id: string; inserido: boolean; hash_anterior: string;
    }>(`
      INSERT INTO integracao_mensagens
        (integracao_id, integracao_codigo, execucao_id, direcao, entidade, origem,
         chave_externa, hash_conteudo, versao_externa, atualizado_na_origem,
         payload, normalizado, correlation_id, max_tentativas, status)
      VALUES ($1, $2, $3, $4::direcao_integracao_enum, $5,
              $6::origem_registro_enum, $7, $8, $9, $10::timestamptz,
              $11::jsonb, $12::jsonb, $13::uuid, $14, 'PENDENTE')
      ON CONFLICT (integracao_codigo, entidade, chave_externa) DO UPDATE
        SET hash_conteudo = EXCLUDED.hash_conteudo,
            payload = EXCLUDED.payload,
            normalizado = EXCLUDED.normalizado,
            execucao_id = EXCLUDED.execucao_id,
            versao_externa = EXCLUDED.versao_externa,
            atualizado_na_origem = EXCLUDED.atualizado_na_origem,
            -- Reabre para processar somente quando o conteudo MUDOU. Reabrir
            -- sempre faria toda sincronizacao reprocessar a base inteira.
            status = CASE
              WHEN integracao_mensagens.hash_conteudo IS DISTINCT FROM EXCLUDED.hash_conteudo
                THEN 'PENDENTE'::status_mensagem_enum
              ELSE integracao_mensagens.status END,
            tentativa = CASE
              WHEN integracao_mensagens.hash_conteudo IS DISTINCT FROM EXCLUDED.hash_conteudo
                THEN 0 ELSE integracao_mensagens.tentativa END
      RETURNING id, (xmax = 0) AS inserido,
                coalesce(integracao_mensagens.hash_conteudo, '') AS hash_anterior`,
    [entrada.integracao.id, entrada.integracao.codigo, entrada.execucao_id,
      entrada.direcao, entrada.entidade, entrada.origem, entrada.chave_externa,
      hash, entrada.versao_externa ?? null, entrada.atualizado_na_origem ?? null,
      JSON.stringify(entrada.payload), JSON.stringify(normalizado),
      entrada.correlation_id ?? null, entrada.integracao.max_tentativas]);

    const linha = rows[0]!;
    const desfecho: Desfecho = linha.inserido ? 'NOVA'
      : linha.hash_anterior === hash ? 'INALTERADA' : 'ALTERADA';

    return { id: Number(linha.id), desfecho };
  });
}

// ---------------------------------------------------------------------------
// ENTRADA: puxar do sistema externo (secoes 8 e 10)
// ---------------------------------------------------------------------------

export interface ResultadoSincronizacao {
  integracao: string;
  entidade: string;
  execucao_id: number;
  correlation_id: string;
  status: string;
  lidos: number;
  novos: number;
  alterados: number;
  inalterados: number;
  rejeitados: number;
  duracao_ms: number;
  truncado: boolean;
  aviso?: string;
  erro?: string;
  motivo_sem_dados?: string;
}

/**
 * Puxa uma entidade do sistema externo e registra as mensagens.
 *
 * Nao aplica nada no sistema: registrar e aplicar sao passos separados, pelo
 * mesmo motivo do modulo 13. Se a aplicacao de um registro falha, os outros
 * seguem e o que falhou fica na fila com o erro - em vez de a sincronizacao
 * inteira abortar e ninguem saber quanto entrou.
 */
export async function sincronizarEntrada(
  codigoIntegracao: string, entidade: string, contexto: ContextoSessao,
  opcoes: { modo?: Modo; disparado_por?: string; desde?: string | null } = {},
): Promise<ResultadoSincronizacao> {
  const integracao = await obter(codigoIntegracao);

  if (!integracao.ativo) {
    throw regraNegocio(`A integracao ${integracao.codigo} esta inativa`);
  }
  if (integracao.direcao === 'SAIDA') {
    throw regraNegocio(
      `A integracao ${integracao.codigo} e somente de saida`);
  }
  if (!await ligado('sincronizacao_ativa', true)) {
    throw regraNegocio(
      'As sincronizacoes estao desligadas em `integracao.sincronizacao_ativa`');
  }

  const execucao = await abrirExecucao({
    integracao, tipo: 'SINCRONIZACAO', direcao: 'ENTRADA', entidade,
    ...(opcoes.modo ? { modo: opcoes.modo } : {}),
    ...(opcoes.disparado_por ? { disparado_por: opcoes.disparado_por } : {}),
  }, contexto);

  const inicio = Date.now();

  try {
    if (integracao.conector !== 'REST') {
      throw regraNegocio(
        `O conector ${integracao.conector} nao puxa dados por sincronizacao. `
        + 'Arquivo entra por importacao; webhook chega sozinho.');
    }
    if (!integracao.endpoint) {
      throw regraNegocio(
        `A integracao ${integracao.codigo} nao tem endpoint configurado`);
    }

    // Limite de taxa antes de qualquer chamada (secao 37).
    const porMinuto = integracao.limite_por_minuto
      ?? await configNumero('rate_limit_por_minuto', 120);
    if (conector.limiteExcedido(integracao.codigo, porMinuto)) {
      throw regraNegocio(
        `Limite de ${porMinuto} chamadas por minuto atingido para `
        + `${integracao.codigo}. A sincronizacao sera retomada no proximo ciclo.`);
    }

    const auth = await credenciais.autenticar(integracao.id);

    const cfg = integracao.configuracao;
    const caminhos = (cfg.caminhos ?? {}) as Record<string, string>;
    const url = `${integracao.endpoint.replace(/\/$/, '')}/${(caminhos[entidade] ?? entidade).replace(/^\//, '')}`;

    const paginacaoCfg = (cfg.paginacao ?? {}) as Record<string, unknown>;
    const paginacao: conector.Paginacao = {
      tipo: (paginacaoCfg.tipo as conector.Paginacao['tipo']) ?? 'offset',
      tamanho: Number(paginacaoCfg.tamanho ?? 500),
      ...(paginacaoCfg.campo_dados ? { campo_dados: String(paginacaoCfg.campo_dados) } : {}),
    };

    // Sincronizacao incremental: pede so o que mudou desde a ultima vez.
    const desde = opcoes.desde ?? integracao.ultima_sincronizacao;
    const filtro: Record<string, string> = {};
    if (desde && cfg.parametro_desde) {
      filtro[String(cfg.parametro_desde)] = String(desde);
    }

    const resposta = await conector.paginar<Record<string, unknown>>({
      url,
      metodo: 'GET',
      cabecalhos: auth.cabecalhos,
      query: { ...filtro, ...auth.query },
      timeout_segundos: integracao.timeout_segundos,
      max_tentativas: integracao.max_tentativas,
    }, paginacao, integracao.limite_por_execucao);

    if (resposta.erro && resposta.registros.length === 0) {
      await registrarErro({
        integracao, execucao_id: execucao.id, entidade,
        tipo: resposta.erro.tipo, classe: resposta.erro.classe,
        mensagem: resposta.erro.mensagem,
        payload: { url: conector.higienizarUrl(url) },
      });

      await fecharExecucao(execucao.id, {
        status: 'FALHOU', erro: resposta.erro.mensagem,
        resumo: { paginas: resposta.paginas },
      });
      await atualizarStatus(integracao.id, 'ERRO', resposta.erro.mensagem);
      await avisarFalha(integracao, entidade, resposta.erro.mensagem, contexto);

      return {
        integracao: integracao.codigo, entidade, execucao_id: execucao.id,
        correlation_id: execucao.correlation_id, status: 'FALHOU',
        lidos: 0, novos: 0, alterados: 0, inalterados: 0, rejeitados: 0,
        duracao_ms: Date.now() - inicio, truncado: true,
        erro: resposta.erro.mensagem,
      };
    }

    // Mapeia com o template da entidade, quando houver.
    const templateCodigo = (cfg.templates as Record<string, string> | undefined)?.[entidade];
    let template: mapeador.Template | null = null;
    let casamento: mapeador.Casamento | null = null;
    if (templateCodigo) {
      template = await mapeador.obterTemplate(templateCodigo);
      const colunas = Object.keys(resposta.registros[0] ?? {});
      casamento = mapeador.casarColunas(template, colunas);
    }

    const campoChave = String(cfg.chave_externa ?? 'id');
    let novos = 0; let alterados = 0; let inalterados = 0; let rejeitados = 0;

    for (const registro of resposta.registros) {
      const chave = registro[campoChave];
      if (chave === undefined || chave === null || String(chave).trim() === '') {
        rejeitados += 1;
        continue;
      }

      let normalizado = registro;
      if (template && casamento) {
        const aplicado = mapeador.aplicarLinha(template, casamento, registro);
        if (!aplicado.valido) { rejeitados += 1; continue; }
        normalizado = aplicado.dados;
      }

      const { desfecho } = await registrarMensagem({
        integracao, execucao_id: execucao.id, direcao: 'ENTRADA', entidade,
        origem: integracao.sistema === 'ERP' ? 'ERP' : 'API',
        chave_externa: String(chave),
        payload: registro,
        normalizado,
        correlation_id: execucao.correlation_id,
      }, contexto);

      if (desfecho === 'NOVA') novos += 1;
      else if (desfecho === 'ALTERADA') alterados += 1;
      else inalterados += 1;
    }

    const duracao = Date.now() - inicio;
    const status = rejeitados > 0 ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA';

    await fecharExecucao(execucao.id, {
      status,
      lidos: resposta.registros.length,
      criados: novos,
      atualizados: alterados,
      descartados: inalterados,
      rejeitados,
      marca_fim: new Date().toISOString(),
      resumo: {
        paginas: resposta.paginas,
        truncado: resposta.truncado,
        ...(resposta.aviso ? { aviso: resposta.aviso } : {}),
      },
    });

    await query(`
      UPDATE integracoes
         SET ultima_sincronizacao = now(), ultimo_status = 'OK',
             status = 'OPERACIONAL'::status_conector_enum,
             ultima_execucao_id = $2,
             registros_processados = registros_processados + $3,
             registros_rejeitados = registros_rejeitados + $4,
             proxima_sincronizacao = CASE
               WHEN modo_sincronizacao = 'AGENDADO' AND intervalo_minutos IS NOT NULL
                 THEN now() + make_interval(mins => intervalo_minutos)
               ELSE proxima_sincronizacao END
       WHERE id = $1`,
    [integracao.id, execucao.id, novos + alterados, rejeitados]);

    return {
      integracao: integracao.codigo, entidade, execucao_id: execucao.id,
      correlation_id: execucao.correlation_id, status,
      lidos: resposta.registros.length, novos, alterados, inalterados, rejeitados,
      duracao_ms: duracao, truncado: resposta.truncado,
      ...(resposta.aviso ? { aviso: resposta.aviso } : {}),
      // Zero registros com sucesso e ambiguo: a origem esta sem novidade ou o
      // filtro esta errado? A resposta vai junto.
      ...(resposta.registros.length === 0 ? {
        motivo_sem_dados: desde
          ? `A origem nao devolveu nenhum registro alterado desde ${desde}`
          : 'A origem nao devolveu nenhum registro para esta entidade',
      } : {}),
    };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await fecharExecucao(execucao.id, { status: 'FALHOU', erro: mensagem });
    await atualizarStatus(integracao.id, 'ERRO', mensagem);
    throw erro;
  }
}

async function atualizarStatus(
  integracaoId: number, status: string, mensagem?: string,
): Promise<void> {
  await query(`
    UPDATE integracoes
       SET status = $2::status_conector_enum, ultimo_status = $3,
           erros = CASE WHEN $2 = 'ERRO' THEN erros + 1 ELSE erros END
     WHERE id = $1`, [integracaoId, status, mensagem?.slice(0, 200) ?? null]);
}

async function avisarFalha(
  integracao: Integracao, entidade: string, mensagem: string, contexto: ContextoSessao,
): Promise<void> {
  await registrarAlerta({
    chave: `integracao-falha:${integracao.codigo}:${entidade}:${new Date().toISOString().slice(0, 10)}`,
    tipo: 'INTEGRACAO_FALHOU',
    categoria: 'governanca',
    prioridade: 'ALTO',
    titulo: `Integracao ${integracao.nome} falhou em ${entidade}`,
    mensagem: mensagem.slice(0, 400),
    origem: `integracao:${integracao.codigo}`,
    entidade: 'integracao',
    entidade_id: integracao.id,
    link: `/integracoes/erros?integracao=${integracao.codigo}`,
  }, contexto);

  await eventos.registrar({
    tipo: 'INTEGRATION_FAILED',
    origem: 'INTEGRACAO',
    entidade: 'integracao',
    entidade_id: integracao.id,
    payload: {
      integracao: integracao.codigo, nome: integracao.nome,
      entidade, erro: mensagem.slice(0, 400),
    },
  }, contexto);
}

// ---------------------------------------------------------------------------
// Erros (secao 35)
// ---------------------------------------------------------------------------

export interface NovoErro {
  integracao: Integracao;
  execucao_id?: number | null;
  mensagem_id?: number | null;
  entidade?: string | null;
  linha?: number | null;
  tipo: conector.TipoErro;
  classe: conector.ClasseErro;
  mensagem: string;
  payload?: Record<string, unknown> | null;
  tentativa?: number;
}

/**
 * Registra o erro com a causa provavel SEPARADA do fato.
 *
 * A secao 35 e explicita: a IA pode sugerir a causa, "mas devera diferencia-la
 * de um erro confirmado". Por isso `causa_provavel` vem com
 * `origem_diagnostico` e `confianca_diagnostico` - e `confirmado` so vira
 * verdadeiro quando uma pessoa confirma.
 */
export async function registrarErro(entrada: NovoErro): Promise<number> {
  const diagnostico = diagnosticar(entrada.tipo, entrada.mensagem);
  const chave = `${entrada.integracao.codigo}:${entrada.entidade ?? '-'}:${entrada.tipo}:`
    + `${entrada.mensagem.slice(0, 80)}`;

  const { rows } = await query<{ id: string }>(`
    INSERT INTO integracao_erros
      (integracao_id, integracao_codigo, execucao_id, mensagem_id, entidade, linha,
       tipo, classe, mensagem, payload, tentativa, causa_provavel,
       origem_diagnostico, confianca_diagnostico, solucao_sugerida, chave_dedup)
    VALUES ($1, $2, $3, $4, $5, $6, $7::tipo_erro_integracao_enum,
            $8::classe_erro_enum, $9, $10::jsonb, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (chave_dedup) WHERE chave_dedup IS NOT NULL AND status = 'ABERTO'
    DO UPDATE SET ocorrencias = integracao_erros.ocorrencias + 1
    RETURNING id`,
  [entrada.integracao.id, entrada.integracao.codigo, entrada.execucao_id ?? null,
    entrada.mensagem_id ?? null, entrada.entidade ?? null, entrada.linha ?? null,
    entrada.tipo, entrada.classe, entrada.mensagem.slice(0, 2000),
    entrada.payload ? JSON.stringify(conector.higienizarCorpo(entrada.payload)) : null,
    entrada.tentativa ?? 1,
    diagnostico.causa, diagnostico.origem, diagnostico.confianca, diagnostico.solucao,
    chave]);

  return Number(rows[0]!.id);
}

/**
 * Causa provavel por regra deterministica.
 *
 * Deliberadamente NAO e a IA do modulo 12. Um padrao conhecido de erro tem
 * causa conhecida, e chamar isso de inferencia inflaria o que o sistema sabe.
 * A origem vai declarada como `regra`, e fica evidente que e palpite de
 * catalogo - nao diagnostico confirmado.
 */
function diagnosticar(tipo: conector.TipoErro, mensagem: string): {
  causa: string; origem: string; confianca: string; solucao: string;
} {
  const catalogo: Record<conector.TipoErro, { causa: string; solucao: string }> = {
    AUTENTICACAO: {
      causa: 'A credencial foi recusada pelo sistema externo',
      solucao: 'Verifique se a variavel de ambiente referenciada existe neste '
        + 'servidor e se o segredo continua valido na origem',
    },
    AUTORIZACAO: {
      causa: 'A credencial e valida mas nao tem permissao para o recurso',
      solucao: 'Peca ao administrador do sistema externo para liberar o escopo',
    },
    TIMEOUT: {
      causa: 'O sistema externo aceitou a conexao e nao respondeu no prazo',
      solucao: 'Aumente o timeout da integracao ou reduza o tamanho da pagina',
    },
    CONEXAO: {
      causa: 'O endereco nao foi alcancado',
      solucao: 'Confira a URL e se a rede deste servidor chega ao destino',
    },
    LIMITE_TAXA: {
      causa: 'O sistema externo recusou por excesso de chamadas',
      solucao: 'Reduza o limite por minuto da integracao',
    },
    PAYLOAD_INVALIDO: {
      causa: 'O formato enviado nao foi aceito',
      solucao: 'Confira o mapeamento de saida e a versao da API',
    },
    VALIDACAO: {
      causa: 'O conteudo foi recebido e recusado por regra do sistema externo',
      solucao: 'Veja a resposta registrada no erro para o campo recusado',
    },
    MAPEAMENTO: {
      causa: 'A resposta nao tem o formato que o mapeamento espera',
      solucao: 'Reveja o template: a origem pode ter mudado nomes de campo',
    },
    REFERENCIA_INEXISTENTE: {
      causa: 'O recurso ou registro referenciado nao existe do outro lado',
      solucao: 'Confira o caminho da entidade e se o registro ainda existe',
    },
    DUPLICIDADE: {
      causa: 'O sistema externo ja tem um registro com esta chave',
      solucao: 'Normal em reenvio; confira se a chave de idempotencia esta correta',
    },
    INDISPONIVEL: {
      causa: 'O sistema externo esta com problema interno',
      solucao: 'Aguarde; a reexecucao automatica tenta de novo com espera crescente',
    },
    INTERNO: {
      causa: 'Falha nao classificada',
      solucao: 'Veja a mensagem completa e o payload registrado',
    },
  };

  const item = catalogo[tipo];
  return {
    causa: item.causa,
    origem: 'regra',
    // Alta so onde o proprio protocolo ja disse o que houve; o resto e palpite.
    confianca: ['AUTENTICACAO', 'AUTORIZACAO', 'TIMEOUT', 'LIMITE_TAXA'].includes(tipo)
      ? 'ALTA' : 'MEDIA',
    solucao: item.solucao,
  };
}

// ---------------------------------------------------------------------------
// SAIDA: enviar ao sistema externo (secao 9)
// ---------------------------------------------------------------------------

export interface ResultadoEnvio {
  integracao: string;
  entidade: string;
  registro_id: number;
  execucao_id: number;
  enviado: boolean;
  status: number;
  chave_idempotencia: string;
  duracao_ms: number;
  ja_enviado?: boolean;
  erro?: string;
}

/**
 * Envia um registro ao sistema externo.
 *
 * TRES exigencias da secao 9, todas obrigatorias: autenticado, registrado,
 * auditado, idempotente.
 *
 * A idempotencia do envio e diferente da entrada: nao adianta so nao repetir
 * daqui, porque o outro lado tambem pode receber duas vezes se a resposta se
 * perder. Por isso vai um cabecalho `Idempotency-Key` derivado do registro, e
 * a mensagem de saida fica gravada ANTES da chamada - se o processo morrer no
 * meio, a proxima tentativa reconhece que ja enviou.
 */
export async function enviar(
  codigoIntegracao: string,
  entrada: {
    entidade: string; registro_id: number; payload: Record<string, unknown>;
    caminho?: string; metodo?: conector.Metodo;
  },
  contexto: ContextoSessao,
): Promise<ResultadoEnvio> {
  const integracao = await obter(codigoIntegracao);

  if (!integracao.ativo) throw regraNegocio(`A integracao ${integracao.codigo} esta inativa`);
  if (integracao.direcao === 'ENTRADA') {
    throw regraNegocio(`A integracao ${integracao.codigo} e somente de entrada`);
  }
  if (!integracao.endpoint) {
    throw regraNegocio(`A integracao ${integracao.codigo} nao tem endpoint configurado`);
  }

  // A trava da secao 9. Vale para pedido de compra, que e o caso com
  // consequencia financeira; as demais entidades nao tem fluxo de aprovacao.
  if (entrada.entidade === 'pedidos' || entrada.entidade === 'ordens_compra') {
    await exigirPedidoAprovado(entrada.registro_id);
  }

  const chaveIdempotencia =
    `${integracao.codigo}:${entrada.entidade}:${entrada.registro_id}`;

  const { rows: jaEnviado } = await query<{ id: string; status: string }>(`
    SELECT id, status::text AS status FROM integracao_mensagens
     WHERE integracao_codigo = $1 AND entidade = $2 AND chave_externa = $3
       AND direcao = 'SAIDA' AND status = 'SUCESSO'`,
  [integracao.codigo, entrada.entidade, String(entrada.registro_id)]);

  if (jaEnviado.length) {
    return {
      integracao: integracao.codigo, entidade: entrada.entidade,
      registro_id: entrada.registro_id, execucao_id: 0, enviado: true,
      status: 200, chave_idempotencia: chaveIdempotencia, duracao_ms: 0,
      ja_enviado: true,
    };
  }

  const execucao = await abrirExecucao({
    integracao, tipo: 'ENVIO', direcao: 'SAIDA', entidade: entrada.entidade,
  }, contexto);

  const mensagem = await registrarMensagem({
    integracao, execucao_id: execucao.id, direcao: 'SAIDA',
    entidade: entrada.entidade, origem: 'MANUAL',
    chave_externa: String(entrada.registro_id),
    payload: entrada.payload,
    correlation_id: execucao.correlation_id,
  }, contexto);

  const inicio = Date.now();

  try {
    const auth = await credenciais.autenticar(integracao.id);
    const caminhos = (integracao.configuracao.caminhos ?? {}) as Record<string, string>;
    const url = `${integracao.endpoint.replace(/\/$/, '')}/`
      + `${(entrada.caminho ?? caminhos[entrada.entidade] ?? entrada.entidade).replace(/^\//, '')}`;

    const resposta = await conector.chamar({
      url,
      metodo: entrada.metodo ?? 'POST',
      cabecalhos: { ...auth.cabecalhos, 'Idempotency-Key': chaveIdempotencia },
      ...(auth.query ? { query: auth.query } : {}),
      corpo: entrada.payload,
      timeout_segundos: integracao.timeout_segundos,
      max_tentativas: integracao.max_tentativas,
    });

    const duracao = Date.now() - inicio;

    if (resposta.ok) {
      await query(`
        UPDATE integracao_mensagens
           SET status = 'SUCESSO', processado_em = now(), erro = NULL
         WHERE id = $1`, [mensagem.id]);

      await fecharExecucao(execucao.id, {
        status: 'CONCLUIDA', lidos: 1, criados: 1,
        resumo: {
          url: conector.higienizarUrl(url),
          status: resposta.status,
          chave_idempotencia: chaveIdempotencia,
        },
      });

      await query(`
        UPDATE integracoes
           SET registros_enviados = registros_enviados + 1,
               ultima_sincronizacao = now(), ultimo_status = 'OK',
               status = 'OPERACIONAL'::status_conector_enum
         WHERE id = $1`, [integracao.id]);

      await registrarAuditoria(entrada.entidade, entrada.registro_id,
        integracao.codigo, chaveIdempotencia, contexto);

      return {
        integracao: integracao.codigo, entidade: entrada.entidade,
        registro_id: entrada.registro_id, execucao_id: execucao.id,
        enviado: true, status: resposta.status,
        chave_idempotencia: chaveIdempotencia, duracao_ms: duracao,
      };
    }

    const erro = resposta.erro!;
    await query(`
      UPDATE integracao_mensagens
         SET status = $2::status_mensagem_enum, tentativa = tentativa + 1,
             erro = $3, dead_letter = ($4 = 'DEFINITIVO')
       WHERE id = $1`,
    [mensagem.id, erro.classe === 'DEFINITIVO' ? 'ERRO' : 'RETRY',
      erro.mensagem.slice(0, 2000), erro.classe]);

    await registrarErro({
      integracao, execucao_id: execucao.id, mensagem_id: mensagem.id,
      entidade: entrada.entidade, tipo: erro.tipo, classe: erro.classe,
      mensagem: erro.mensagem,
      payload: { url: conector.higienizarUrl(url), resposta: erro.corpo?.slice(0, 500) },
      tentativa: resposta.tentativas,
    });

    await fecharExecucao(execucao.id, {
      status: 'FALHOU', lidos: 1, rejeitados: 1, erro: erro.mensagem,
    });
    await atualizarStatus(integracao.id, 'ERRO', erro.mensagem);

    return {
      integracao: integracao.codigo, entidade: entrada.entidade,
      registro_id: entrada.registro_id, execucao_id: execucao.id,
      enviado: false, status: resposta.status,
      chave_idempotencia: chaveIdempotencia, duracao_ms: duracao,
      erro: erro.mensagem,
    };
  } catch (erro) {
    const texto = erro instanceof Error ? erro.message : String(erro);
    await fecharExecucao(execucao.id, { status: 'FALHOU', erro: texto });
    throw erro;
  }
}

/**
 * A trava da secao 9, em consulta.
 *
 * Le o estado real do pedido no modulo 07. Nao ha caminho alternativo: se o
 * pedido nao foi aprovado, nao sai - nem com configuracao, nem com permissao.
 */
async function exigirPedidoAprovado(pedidoId: number): Promise<void> {
  const { rows } = await query<{ status: string; numero: string }>(
    'SELECT status::text AS status, numero FROM ordens_compra WHERE id = $1', [pedidoId]);

  const pedido = rows[0];
  if (!pedido) throw naoEncontrado(`Pedido ${pedidoId}`);

  const aprovados = ['APROVADA', 'ENVIADA', 'CONFIRMADA', 'EM_PRODUCAO',
    'EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA', 'FINALIZADA'];

  if (!aprovados.includes(pedido.status)) {
    throw semPermissao(
      `O pedido ${pedido.numero} esta em ${pedido.status} e nao pode ser enviado `
      + 'ao sistema externo. A secao 9 exige que o fluxo de aprovacao seja '
      + 'respeitado antes de qualquer envio.');
  }
}

async function registrarAuditoria(
  entidade: string, registroId: number, integracao: string,
  chave: string, contexto: ContextoSessao,
): Promise<void> {
  await query(`
    INSERT INTO auditoria (usuario_id, tabela, registro_id, acao, valor_novo, ip, origem)
    VALUES ($1, $2, $3, 'UPDATE'::acao_auditoria_enum, $4::jsonb, $5, $6)`,
  [contexto.usuarioId ?? null, entidade, registroId,
    JSON.stringify({ enviado_para: integracao, chave_idempotencia: chave }),
    contexto.ip ?? null, `integracao:${integracao}`]);
}

// ---------------------------------------------------------------------------
// Agendador (secao 10)
// ---------------------------------------------------------------------------

export async function devidas(): Promise<Array<{ codigo: string; entidades: string[] }>> {
  const { rows } = await query<{ codigo: string; configuracao: Record<string, unknown> }>(`
    SELECT codigo, configuracao FROM integracoes
     WHERE ativo AND modo_sincronizacao = 'AGENDADO'
       AND direcao IN ('ENTRADA', 'BIDIRECIONAL')
       AND conector = 'REST'
       AND endpoint IS NOT NULL
       AND (proxima_sincronizacao IS NULL OR proxima_sincronizacao <= now())
     ORDER BY coalesce(proxima_sincronizacao, '-infinity'::timestamptz)`);

  return rows.map((r) => ({
    codigo: r.codigo,
    entidades: Array.isArray(r.configuracao?.entidades)
      ? (r.configuracao.entidades as string[]) : [],
  }));
}

export async function sincronizarDevidas(contexto: ContextoSessao): Promise<{
  ativo: boolean; executadas: ResultadoSincronizacao[];
  falhas: Array<{ integracao: string; entidade: string; erro: string }>;
  motivo?: string;
}> {
  if (!await ligado('sincronizacao_ativa', true)) {
    return {
      ativo: false, executadas: [], falhas: [],
      motivo: 'Sincronizacoes desligadas em `integracao.sincronizacao_ativa`',
    };
  }

  const executadas: ResultadoSincronizacao[] = [];
  const falhas: Array<{ integracao: string; entidade: string; erro: string }> = [];

  for (const integracao of await devidas()) {
    for (const entidade of integracao.entidades) {
      try {
        executadas.push(await sincronizarEntrada(integracao.codigo, entidade, contexto, {
          modo: 'AGENDADO', disparado_por: 'AGENDADOR',
        }));
      } catch (erro) {
        // Uma entidade que falha nao impede as outras: o cadastro de produtos
        // pode entrar mesmo com o endpoint de estoque fora do ar.
        falhas.push({
          integracao: integracao.codigo, entidade,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }
  }

  return { ativo: true, executadas, falhas };
}

export { pool as poolSincronizacao };
