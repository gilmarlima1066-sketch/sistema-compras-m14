/**
 * Botao de importacao de planilha do ERP, usado em Demanda (vendas, Rel 7104) e
 * em Estoque (saldo, Rel 9054). Cada tela passa a sua configuracao.
 *
 * Fluxo, todo numa janela:
 *   escolher arquivo -> leitura no navegador (Web Worker) -> conferencia
 *   (colunas, resumo, amostra validada no servidor) -> confirmacao ->
 *   gravacao em lotes com progresso -> pos-processamento -> resultado.
 *
 * Nada e gravado antes da confirmacao.
 */
import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import {
  canonico, gravarEmLotes, lerPlanilha, linhaParaObjeto, posProcessar,
  type PlanilhaLida, type ProgressoLotes, type ResultadoLotes,
} from '../importacao/importador';
import { Aviso, Indicador, Modal, data, numero } from './ui';

interface Dado { rotulo: string; valor: string; nota?: string }

export interface ConfigImportacao {
  entidade: string;
  template: string;
  botao: string;
  titulo: string;
  /** Colunas que o gravador le. As demais nao viajam ate o servidor. */
  colunasUsadas: string[];
  obrigatorias: string[];
  instrucao: string;
  aviso: string;
  sucesso: string;
  /** Rotulos dos quatro contadores do resultado. */
  contadores: [string, string, string, string];
  notaDescartadas: string;
  resumir: (p: PlanilhaLida) => Dado[];
}

const idx = (p: PlanilhaLida, nome: string) =>
  p.colunas.findIndex((c) => canonico(c) === nome);
const num = (v: unknown) => Number(String(v ?? '').replace(',', '.')) || 0;

/** "05/01/2026" -> "2026-01-05"; outros formatos voltam como vieram. */
const isoDe = (v: unknown) => {
  const s = String(v ?? '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
};

export const CONFIG_VENDAS: ConfigImportacao = {
  entidade: 'vendas',
  template: 'REL7104_VENDAS',
  botao: 'Importar vendas',
  titulo: 'Importar vendas (Rel 7104)',
  colunasUsadas: [
    'DTFATURAMENTO', 'CODPRODUTO', 'DESCRICAO', 'QTDE', 'TOTAL', 'VALORMEDIO',
    'FANTASIA', 'CIDADE', 'ESTADO', 'APELIDO', 'NUMNF', 'SUBGRUPO', 'SITUACAO',
    'ID_CIENTE', 'TIPO',
  ],
  obrigatorias: ['DTFATURAMENTO', 'CODPRODUTO', 'QTDE', 'TOTAL', 'NUMNF', 'ID_CIENTE'],
  instrucao: 'Selecione o Rel 7104 exportado do ERP (XLSX, XLS ou CSV), com as colunas '
    + 'DTFATURAMENTO, CODPRODUTO, QTDE, TOTAL, NUMNF, ID_CIENTE e as demais do relatorio. '
    + 'O arquivo e lido no navegador e enviado em partes, entao pode ter centenas de '
    + 'milhares de linhas. Nada e gravado antes da sua confirmacao.',
  aviso: 'Notas que ja existem sao atualizadas, nunca duplicadas. Produtos que ainda nao '
    + 'estao cadastrados entram com a categoria do SUBGRUPO. Mantenha esta janela aberta '
    + 'ate o fim.',
  sucesso: 'Vendas importadas. O historico, o dashboard, a previsao e o painel de compras '
    + 'ja usam os novos dados.',
  contadores: ['Notas novas', 'Notas atualizadas', 'Descartadas', 'Rejeitadas'],
  notaDescartadas: 'Devolucoes',
  resumir: (p) => {
    const iData = idx(p, 'DTFATURAMENTO');
    const iProd = idx(p, 'CODPRODUTO');
    const iNf = idx(p, 'NUMNF');
    const iCli = idx(p, 'IDCIENTE');
    const iTipo = idx(p, 'TIPO');
    let de = '';
    let ate = '';
    let devolucoes = 0;
    const produtos = new Set<string>();
    const notas = new Set<string>();
    for (const l of p.linhas) {
      const d = isoDe(l[iData]);
      if (d && (!de || d < de)) de = d;
      if (d && (!ate || d > ate)) ate = d;
      produtos.add(String(l[iProd]));
      notas.add(`${l[iNf]}/${l[iCli]}/${d}`);
      if (String(l[iTipo] ?? '').trim().toUpperCase() === 'DEVOLUCAO') devolucoes++;
    }
    return [
      { rotulo: 'Periodo', valor: de ? `${data(de)} a ${data(ate)}` : '—' },
      { rotulo: 'Notas', valor: numero(notas.size) },
      { rotulo: 'Produtos', valor: numero(produtos.size) },
      { rotulo: 'Devolucoes', valor: numero(devolucoes), nota: 'Descartadas por configuracao' },
    ];
  },
};

export const CONFIG_ESTOQUE: ConfigImportacao = {
  entidade: 'estoque',
  template: 'REL9054_ESTOQUE',
  botao: 'Importar estoque',
  titulo: 'Importar estoque (Rel 9054)',
  colunasUsadas: ['CODPRODUTO', 'DESCRICAO', 'CODBARRAS', 'UNIDADE', 'SITUACAO', 'QTDE', 'QTDEVENDIDA'],
  obrigatorias: ['CODPRODUTO', 'QTDE'],
  instrucao: 'Selecione o Rel 9054 (saldo de estoque) exportado do ERP, com as colunas '
    + 'CODPRODUTO, DESCRICAO, CODBARRAS, UNIDADE, SITUACAO, QTDE e QTDEVENDIDA. O arquivo '
    + 'substitui a posicao anterior do ERP: so a diferenca entra como ajuste de inventario. '
    + 'Nada e gravado antes da sua confirmacao.',
  aviso: 'Produtos que ainda nao existem sao cadastrados na categoria "A CLASSIFICAR (ERP)". '
    + 'O saldo disponivel e QTDE menos QTDEVENDIDA. Importar o mesmo arquivo de novo nao '
    + 'gera ajuste. Mantenha esta janela aberta ate o fim.',
  sucesso: 'Estoque atualizado no local "ERP". O painel de compras e o planejamento ja usam '
    + 'o novo saldo; cada diferenca ficou registrada como ajuste de inventario.',
  contadores: ['Saldos novos', 'Saldos atualizados', 'Sem alteracao', 'Rejeitados'],
  notaDescartadas: 'Sem saldo ou igual ao anterior',
  resumir: (p) => {
    const iProd = idx(p, 'CODPRODUTO');
    const iQtde = idx(p, 'QTDE');
    const iVend = idx(p, 'QTDEVENDIDA');
    const iSit = idx(p, 'SITUACAO');
    let comSaldo = 0;
    let ativos = 0;
    let unidades = 0;
    let reservado = 0;
    const produtos = new Set<string>();
    for (const l of p.linhas) {
      produtos.add(String(l[iProd]));
      const q = num(l[iQtde]);
      if (q > 0) { comSaldo++; unidades += q; }
      reservado += Math.abs(num(l[iVend]));
      if (String(l[iSit] ?? '').trim().toUpperCase() === 'ATIVO') ativos++;
    }
    return [
      { rotulo: 'Produtos', valor: numero(produtos.size) },
      { rotulo: 'Com saldo', valor: numero(comSaldo), nota: `${numero(unidades)} unidades` },
      { rotulo: 'Ativos no ERP', valor: numero(ativos) },
      { rotulo: 'Vendido nao faturado', valor: numero(reservado), nota: 'Vira reservado' },
    ];
  },
};

export const CONFIG_FORNECEDORES: ConfigImportacao = {
  entidade: 'fornecedores',
  template: 'FORNECEDORES_ERP',
  botao: 'Importar fornecedores',
  titulo: 'Importar base de fornecedores (ERP)',
  colunasUsadas: ['ID', 'FANTASIA', 'ATIVO', 'NOME', 'ENDERECO', 'NUMERO', 'BAIRRO', 'CIDADE', 'CEP',
    'ESTADO', 'CNPJCPF', 'IERG', 'CONTATO', 'FONES', 'EMAILCONTATO', 'DTULTIMOPEDIDO', 'VALORULTPEDIDO'],
  obrigatorias: ['ID', 'NOME'],
  instrucao: 'Selecione a planilha de fornecedores exportada do ERP, com as colunas ID, FANTASIA, '
    + 'ATIVO, NOME, ENDERECO, NUMERO, BAIRRO, CIDADE, CEP, ESTADO, CNPJCPF, IERG, CONTATO, FONES, '
    + 'EMAILCONTATO, DTULTIMOPEDIDO e VALORULTPEDIDO. Nada e gravado antes da sua confirmacao.',
  aviso: 'O ID do ERP identifica o fornecedor: importar de novo atualiza, nao duplica. Um '
    + 'fornecedor ja cadastrado com o mesmo CNPJ recebe o ID e nao e repetido. A coluna ATIVO '
    + '(S/N) define a situacao; CNPJ e CEP que o Excel guardou sem o zero a esquerda sao corrigidos.',
  sucesso: 'Base de fornecedores atualizada. Use o botao de cada linha para ativar ou inativar.',
  contadores: ['Fornecedores novos', 'Fornecedores atualizados', 'Sem alteracao', 'Rejeitados'],
  notaDescartadas: 'Linhas repetidas ou vazias',
  resumir: (p) => {
    const iId = idx(p, 'ID');
    const iAtivo = idx(p, 'ATIVO');
    const iDoc = idx(p, 'CNPJCPF');
    const iData = idx(p, 'DTULTIMOPEDIDO');
    const ids = new Set<string>();
    let ativos = 0;
    let comDoc = 0;
    let comPedido = 0;
    for (const l of p.linhas) {
      ids.add(String(l[iId]));
      if (String(l[iAtivo] ?? '').trim().toUpperCase().startsWith('S')) ativos++;
      if (String(l[iDoc] ?? '').replace(/\D/g, '')) comDoc++;
      if (String(l[iData] ?? '').trim()) comPedido++;
    }
    return [
      { rotulo: 'Fornecedores', valor: numero(ids.size) },
      { rotulo: 'Ativos no ERP', valor: numero(ativos), nota: `${numero(ids.size - ativos)} inativos` },
      { rotulo: 'Com CNPJ/CPF', valor: numero(comDoc) },
      { rotulo: 'Ja receberam pedido', valor: numero(comPedido) },
    ];
  },
};

export const CONFIG_HISTORICO_COMPRAS: ConfigImportacao = {
  entidade: 'historico_compras',
  template: 'HISTORICO_COMPRAS',
  botao: 'Importar compras',
  titulo: 'Importar historico de compras (entradas do ERP)',
  colunasUsadas: ['DTALMOXARIFADO', 'PC', 'COD', 'DESC', 'KG_CX', 'QTD_CX', 'TOTAL_KG', 'PRECO_CX',
    'PRECO_KG', 'ALIQUOTAICMS', 'ALIQUOTA', 'ALIQ_PIS_COFINS', 'ALIQ_ICMS_RED', 'ALIQ_ICMS', 'TIPO',
    'PARCEIRO_ID', 'PARCEIRO_NOME'],
  obrigatorias: ['DTALMOXARIFADO', 'PC', 'COD', 'QTD_CX', 'PARCEIRO_ID'],
  instrucao: 'Selecione o relatorio de entradas do ERP (custo e imposto), com as colunas '
    + 'DTALMOXARIFADO, PC, COD, DESC, KG_CX, QTD_CX, TOTAL_KG, PRECO_CX, PRECO_KG, ALIQUOTAICMS, '
    + 'ALIQ_PIS_COFINS, ALIQ_ICMS_RED, TIPO, PARCEIRO_ID e PARCEIRO_NOME. Nada e gravado antes da '
    + 'sua confirmacao.',
  aviso: 'PARCEIRO_ID e o ID do ERP da base de fornecedores. Importar o mesmo periodo de novo '
    + 'atualiza as entradas em vez de duplicar. Compra de produto ou fornecedor ainda sem cadastro '
    + 'e guardada pelo codigo e ligada quando o cadastro chegar.',
  sucesso: 'Historico atualizado. Pesquise um produto ou um fornecedor para ver as ultimas compras.',
  contadores: ['Entradas novas', 'Entradas atualizadas', 'Repetidas no arquivo', 'Rejeitadas'],
  notaDescartadas: 'Mesmo PC, produto, data, quantidade e preco',
  resumir: (p) => {
    const iPc = idx(p, 'PC');
    const iCod = idx(p, 'COD');
    const iParc = idx(p, 'PARCEIRO_ID');
    const iQtd = idx(p, 'QTD_CX');
    const iPreco = idx(p, 'PRECO_CX');
    const pedidos = new Set<string>();
    const produtos = new Set<string>();
    const parceiros = new Set<string>();
    let valor = 0;
    for (const l of p.linhas) {
      pedidos.add(String(l[iPc]));
      produtos.add(String(l[iCod]));
      parceiros.add(String(l[iParc]));
      valor += num(l[iQtd]) * num(l[iPreco]);
    }
    return [
      { rotulo: 'Pedidos (PC)', valor: numero(pedidos.size), nota: `${numero(p.linhas.length)} itens` },
      { rotulo: 'Produtos', valor: numero(produtos.size) },
      { rotulo: 'Fornecedores', valor: numero(parceiros.size) },
      { rotulo: 'Valor das entradas', valor: `R$ ${numero(valor)}`, nota: 'caixas x preco por caixa' },
    ];
  },
};

export const CONFIG_INDUSTRIALIZACAO: ConfigImportacao = {
  entidade: 'industrializacao',
  template: 'HISTORICO_INDUSTRIALIZACAO',
  botao: 'Importar industrializados',
  titulo: 'Importar historico de industrializados',
  colunasUsadas: ['ID', 'ESTOQUESAI', 'ESTOQUEENTRA', 'SITUACAO', 'DTINCLUSAO', 'USUARIOINC', 'QTDE',
    'CODPRODUTO', 'DESCRICAO', 'PESOLIQ'],
  obrigatorias: ['ID', 'DTINCLUSAO', 'QTDE', 'CODPRODUTO'],
  instrucao: 'Selecione o relatorio de industrializados (fracionados) do ERP, em Excel ou CSV, com '
    + 'as colunas ID, ESTOQUESAI, ESTOQUEENTRA, SITUACAO, DTINCLUSAO, USUARIOINC, QTDE, CODPRODUTO, '
    + 'DESCRICAO e PESOLIQ. Nada e gravado antes da sua confirmacao.',
  aviso: 'O ID e o documento do ERP e pode ter varios produtos. Importar o mesmo periodo de novo '
    + 'atualiza em vez de duplicar. PESOLIQ e o peso por unidade: o peso do item e QTDE x PESOLIQ.',
  sucesso: 'Historico de industrializados atualizado.',
  contadores: ['Itens novos', 'Itens atualizados', 'Descartados', 'Rejeitados'],
  notaDescartadas: 'Linhas sem uso',
  resumir: (p) => {
    const iId = idx(p, 'ID');
    const iCod = idx(p, 'CODPRODUTO');
    const iQtd = idx(p, 'QTDE');
    const iPeso = idx(p, 'PESOLIQ');
    const iSit = idx(p, 'SITUACAO');
    const docs = new Set<string>();
    const produtos = new Set<string>();
    let peso = 0;
    let foraOk = 0;
    for (const l of p.linhas) {
      docs.add(String(l[iId]));
      produtos.add(String(l[iCod]));
      peso += num(l[iQtd]) * num(l[iPeso]);
      if (String(l[iSit] ?? '').trim().toUpperCase() !== 'OK') foraOk++;
    }
    return [
      { rotulo: 'Documentos', valor: numero(docs.size), nota: `${numero(p.linhas.length)} itens` },
      { rotulo: 'Produtos', valor: numero(produtos.size) },
      { rotulo: 'Peso industrializado', valor: `${numero(peso)} kg` },
      { rotulo: 'Fora de OK', valor: numero(foraOk), nota: 'situacao AB, AL...' },
    ];
  },
};

type Etapa = 'escolher' | 'lendo' | 'conferir' | 'gravando' | 'atualizando' | 'concluido';

interface Conferencia {
  importacaoId: number;
  linhas: number;
  emBranco: number;
  resumo: Dado[];
  jaImportado: { em: string; registros: number } | null;
  impedimentos: string[];
  validacao: { validas: number; com_erro: number; ocorrencias: Array<{ regra: string; total: number; exemplo: string }> };
}

const erroDe = (e: unknown) =>
  (e instanceof ErroApi || e instanceof Error ? e.message : 'Falha inesperada');

export function ImportarPlanilha({ config, aoConcluir }: {
  config: ConfigImportacao; aoConcluir: () => void;
}) {
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <button type="button" className="botao botao--primario" onClick={() => setAberto(true)}>
        {config.botao}
      </button>
      {aberto && (
        <Assistente
          config={config}
          aoFechar={(importou) => { setAberto(false); if (importou) aoConcluir(); }}
        />
      )}
    </>
  );
}

function Assistente({ config, aoFechar }: {
  config: ConfigImportacao; aoFechar: (importou: boolean) => void;
}) {
  const [etapa, setEtapa] = useState<Etapa>('escolher');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [mensagem, setMensagem] = useState('');
  const [planilha, setPlanilha] = useState<PlanilhaLida | null>(null);
  const [conf, setConf] = useState<Conferencia | null>(null);
  const [progresso, setProgresso] = useState<ProgressoLotes | null>(null);
  const [resultado, setResultado] = useState<ResultadoLotes | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const ocupado = etapa === 'lendo' || etapa === 'gravando' || etapa === 'atualizando';

  // Fechar a aba no meio da gravacao deixa a importacao pela metade.
  useEffect(() => {
    if (!ocupado) return undefined;
    const avisar = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [ocupado]);

  const ler = async () => {
    if (!arquivo) return;
    setErro(null);
    setEtapa('lendo');
    try {
      const p = await lerPlanilha(arquivo, setMensagem);
      const presentes = new Set(p.colunas.map(canonico));
      const faltando = config.obrigatorias.filter((c) => !presentes.has(canonico(c)));
      if (faltando.length) {
        throw new Error(`O arquivo nao parece o relatorio esperado: faltam as colunas ${faltando.join(', ')}.`);
      }
      if (!p.linhas.length) throw new Error('Nenhuma linha de dados no arquivo.');

      setMensagem('Conferindo com o servidor...');
      const amostra = p.linhas.slice(0, 100).map((l) => linhaParaObjeto(p.colunas, l));
      const { data: analise } = await api<any>('/integracoes/importacoes/iniciar-client', {
        metodo: 'POST',
        corpo: {
          nome_arquivo: arquivo.name, entidade: config.entidade, template: config.template,
          colunas: p.colunas, amostra, total_linhas: p.linhas.length,
        },
      });

      let validacao: Conferencia['validacao'] = { validas: 0, com_erro: 0, ocorrencias: [] };
      if (!(analise.impedimentos ?? []).length) {
        const { data: v } = await api<any>(
          `/integracoes/importacoes/${analise.importacao_id}/validar`, { metodo: 'POST', corpo: {} });
        validacao = {
          validas: v.validas, com_erro: v.com_erro,
          ocorrencias: (v.ocorrencias_por_regra ?? []).slice(0, 5),
        };
      }

      setPlanilha(p);
      setConf({
        importacaoId: analise.importacao_id,
        linhas: p.linhas.length,
        emBranco: p.emBranco,
        resumo: config.resumir(p),
        jaImportado: analise.ja_importado ?? null,
        impedimentos: analise.impedimentos ?? [],
        validacao,
      });
      setEtapa('conferir');
    } catch (e) {
      setErro(erroDe(e));
      setEtapa('escolher');
    }
  };

  const importar = async () => {
    if (!conf || !planilha) return;
    setErro(null);
    setEtapa('gravando');
    try {
      await api(`/integracoes/importacoes/${conf.importacaoId}/confirmar`, { metodo: 'POST', corpo: {} });
      const r = await gravarEmLotes({
        importacaoId: conf.importacaoId, planilha, colunasUsadas: config.colunasUsadas,
        aoProgredir: setProgresso,
      });
      setPlanilha(null); // libera a memoria das linhas
      if (r.pos_processar) {
        setEtapa('atualizando');
        await posProcessar(conf.importacaoId);
      }
      setResultado(r);
      setEtapa('concluido');
    } catch (e) {
      setErro(erroDe(e));
      setEtapa('concluido');
    }
  };

  const percentual = progresso ? Math.round((progresso.linhasEnviadas / progresso.totalLinhas) * 100) : 0;

  return (
    <Modal
      titulo={config.titulo}
      largo
      aoFechar={() => { if (!ocupado) aoFechar(etapa === 'concluido' && !!resultado); }}
      rodape={(
        <>
          {etapa === 'escolher' && (
            <button type="button" className="botao botao--primario" disabled={!arquivo} onClick={ler}>
              Ler arquivo
            </button>
          )}
          {etapa === 'conferir' && conf && (
            <>
              <button type="button" className="botao botao--fantasma"
                onClick={() => { setEtapa('escolher'); setConf(null); setPlanilha(null); }}>
                Trocar arquivo
              </button>
              <button type="button" className="botao botao--primario"
                disabled={conf.impedimentos.length > 0} onClick={importar}>
                Importar {numero(conf.linhas)} linhas
              </button>
            </>
          )}
          {etapa === 'concluido' && (
            <button type="button" className="botao botao--primario" onClick={() => aoFechar(!!resultado)}>
              Fechar
            </button>
          )}
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}

      {etapa === 'escolher' && (
        <>
          <p className="fraco">{config.instrucao}</p>
          <input type="file" accept=".xlsx,.xls,.csv,.txt"
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
          {arquivo && (
            <p className="fraco">
              {arquivo.name} · {(arquivo.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
        </>
      )}

      {etapa === 'lendo' && <p>{mensagem || 'Lendo...'}</p>}

      {etapa === 'conferir' && conf && (
        <>
          {conf.impedimentos.length > 0 && <Aviso>{conf.impedimentos.join(' · ')}</Aviso>}
          {conf.jaImportado && (
            <Aviso>
              Este arquivo parece ja ter sido importado em {data(conf.jaImportado.em)}
              {' '}({numero(conf.jaImportado.registros)} notas). Importar de novo atualiza as
              mesmas notas, sem duplicar.
            </Aviso>
          )}
          <div className="grade-indicadores">
            <Indicador rotulo="Linhas" valor={numero(conf.linhas)}
              nota={conf.emBranco ? `${numero(conf.emBranco)} linhas em branco ignoradas` : undefined} />
            {conf.resumo.map((d) => (
              <Indicador key={d.rotulo} rotulo={d.rotulo} valor={d.valor} nota={d.nota} />
            ))}
            <Indicador rotulo="Amostra validada"
              valor={`${numero(conf.validacao.validas)} ok`}
              tom={conf.validacao.com_erro > 0 ? 'alerta' : 'acento'}
              nota={conf.validacao.com_erro ? `${numero(conf.validacao.com_erro)} com erro` : 'sem erros'} />
          </div>
          {conf.validacao.ocorrencias.length > 0 && (
            <table className="tabela">
              <thead><tr><th>Ocorrencia na amostra</th><th className="dir">Casos</th><th>Exemplo</th></tr></thead>
              <tbody>
                {conf.validacao.ocorrencias.map((o, i) => (
                  <tr key={i}><td>{o.regra}</td><td className="dir">{numero(o.total)}</td>
                    <td className="fraco">{o.exemplo}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="fraco">{config.aviso}</p>
        </>
      )}

      {(etapa === 'gravando' || etapa === 'atualizando') && (
        <>
          <p>
            {etapa === 'gravando'
              ? progresso
                ? `Gravando parte ${progresso.lote} de ${progresso.totalLotes}: `
                  + `${numero(progresso.linhasEnviadas)} de ${numero(progresso.totalLinhas)} linhas`
                : 'Iniciando a gravacao...'
              : 'Atualizando as analises de demanda (dashboard, previsao e painel de compras)...'}
          </p>
          <div style={{ background: 'var(--superficie-2)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
            <div style={{
              width: `${etapa === 'atualizando' ? 100 : percentual}%`, height: '100%',
              background: 'var(--acento)', transition: 'width .3s',
            }} />
          </div>
          {progresso && etapa === 'gravando' && (
            <p className="fraco">
              {numero(progresso.ritmo)} linhas/s
              {progresso.restante ? ` · cerca de ${Math.ceil(progresso.restante / 60)} min restantes` : ''}
              {' '}· nao feche esta janela
            </p>
          )}
        </>
      )}

      {etapa === 'concluido' && resultado && (
        <>
          <Aviso tipo="ok">{config.sucesso}</Aviso>
          <div className="grade-indicadores">
            <Indicador rotulo={config.contadores[0]} valor={numero(resultado.criados)} tom="acento" />
            <Indicador rotulo={config.contadores[1]} valor={numero(resultado.atualizados)} />
            <Indicador rotulo={config.contadores[2]} valor={numero(resultado.descartados)}
              nota={config.notaDescartadas} />
            <Indicador rotulo={config.contadores[3]} valor={numero(resultado.rejeitados)}
              tom={resultado.rejeitados > 0 ? 'perigo' : 'neutro'} />
          </div>
          {Object.keys(resultado.motivos ?? {}).length > 0 && (
            <table className="tabela">
              <thead><tr><th>Detalhe</th><th className="dir">Linhas</th></tr></thead>
              <tbody>
                {Object.entries(resultado.motivos!).map(([m, n]) => (
                  <tr key={m}><td>{m}</td><td className="dir">{numero(n)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}
