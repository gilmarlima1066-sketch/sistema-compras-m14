/**
 * Botao "Importar vendas" da tela de Demanda: o Rel 7104 do ERP vira historico
 * de vendas e alimenta dashboard, analise, previsao e o painel de compras.
 *
 * Fluxo, todo numa janela:
 *   escolher arquivo -> leitura no navegador (Web Worker) -> conferencia
 *   (colunas, periodo, amostra validada no servidor) -> confirmacao ->
 *   gravacao em lotes com progresso -> atualizacao das analises -> resultado.
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

const TEMPLATE = 'REL7104_VENDAS';

/** Colunas que o gravador de vendas le. As demais nao viajam ate o servidor. */
const COLUNAS_USADAS = [
  'DTFATURAMENTO', 'CODPRODUTO', 'DESCRICAO', 'QTDE', 'TOTAL', 'VALORMEDIO',
  'FANTASIA', 'CIDADE', 'ESTADO', 'APELIDO', 'NUMNF', 'SUBGRUPO', 'SITUACAO',
  'ID_CIENTE', 'TIPO',
];
const OBRIGATORIAS = ['DTFATURAMENTO', 'CODPRODUTO', 'QTDE', 'TOTAL', 'NUMNF', 'ID_CIENTE'];

type Etapa = 'escolher' | 'lendo' | 'conferir' | 'gravando' | 'atualizando' | 'concluido';

interface Conferencia {
  importacaoId: number;
  linhas: number;
  emBranco: number;
  periodo: { de: string; ate: string } | null;
  produtos: number;
  notas: number;
  devolucoes: number;
  jaImportado: { em: string; registros: number } | null;
  impedimentos: string[];
  validacao: { validas: number; com_erro: number; ocorrencias: Array<{ regra: string; total: number; exemplo: string }> };
}

const erroDe = (e: unknown) =>
  (e instanceof ErroApi || e instanceof Error ? e.message : 'Falha inesperada');

/** "05/01/2026" -> "2026-01-05"; outros formatos voltam como vieram. */
const isoDe = (v: unknown) => {
  const s = String(v ?? '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
};

function resumir(p: PlanilhaLida) {
  const idx = (nome: string) => p.colunas.findIndex((c) => canonico(c) === nome);
  const iData = idx('DTFATURAMENTO');
  const iProd = idx('CODPRODUTO');
  const iNf = idx('NUMNF');
  const iCli = idx('IDCIENTE');
  const iTipo = idx('TIPO');

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
  return { periodo: de ? { de, ate } : null, produtos: produtos.size, notas: notas.size, devolucoes };
}

export function ImportarVendas({ aoConcluir }: { aoConcluir: () => void }) {
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <button type="button" className="botao botao--primario" onClick={() => setAberto(true)}>
        Importar vendas
      </button>
      {aberto && (
        <Assistente
          aoFechar={(importou) => { setAberto(false); if (importou) aoConcluir(); }}
        />
      )}
    </>
  );
}

function Assistente({ aoFechar }: { aoFechar: (importou: boolean) => void }) {
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
      const faltando = OBRIGATORIAS.filter((c) => !presentes.has(canonico(c)));
      if (faltando.length) {
        throw new Error(`O arquivo nao parece um Rel 7104: faltam as colunas ${faltando.join(', ')}.`);
      }
      if (!p.linhas.length) throw new Error('Nenhuma linha de venda no arquivo.');

      setMensagem('Conferindo com o servidor...');
      const amostra = p.linhas.slice(0, 100).map((l) => linhaParaObjeto(p.colunas, l));
      const { data: analise } = await api<any>('/integracoes/importacoes/iniciar-client', {
        metodo: 'POST',
        corpo: {
          nome_arquivo: arquivo.name, entidade: 'vendas', template: TEMPLATE,
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
        ...resumir(p),
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
        importacaoId: conf.importacaoId, planilha, colunasUsadas: COLUNAS_USADAS,
        aoProgredir: setProgresso,
      });
      setPlanilha(null); // libera a memoria das linhas
      setEtapa('atualizando');
      await posProcessar(conf.importacaoId);
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
      titulo="Importar vendas (Rel 7104)"
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
          <p className="fraco">
            Selecione o Rel 7104 exportado do ERP (XLSX, XLS ou CSV), com as colunas DTFATURAMENTO,
            CODPRODUTO, QTDE, TOTAL, NUMNF, ID_CIENTE e as demais do relatorio. O arquivo e lido no
            navegador e enviado em partes, entao pode ter centenas de milhares de linhas. Nada e
            gravado antes da sua confirmacao.
          </p>
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
            <Indicador rotulo="Linhas de venda" valor={numero(conf.linhas)}
              nota={conf.emBranco ? `${numero(conf.emBranco)} linhas em branco ignoradas` : undefined} />
            <Indicador rotulo="Periodo"
              valor={conf.periodo ? `${data(conf.periodo.de)} a ${data(conf.periodo.ate)}` : '—'} />
            <Indicador rotulo="Notas" valor={numero(conf.notas)} />
            <Indicador rotulo="Produtos" valor={numero(conf.produtos)} />
            <Indicador rotulo="Devolucoes" valor={numero(conf.devolucoes)}
              nota="Descartadas por configuracao" />
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
          <p className="fraco">
            Notas que ja existem sao atualizadas, nunca duplicadas. Produtos que ainda nao estao
            cadastrados entram com a categoria do SUBGRUPO. Mantenha esta janela aberta ate o fim.
          </p>
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
          <Aviso tipo="ok">
            Vendas importadas. O historico, o dashboard, a previsao e o painel de compras ja usam
            os novos dados.
          </Aviso>
          <div className="grade-indicadores">
            <Indicador rotulo="Notas novas" valor={numero(resultado.criados)} tom="acento" />
            <Indicador rotulo="Notas atualizadas" valor={numero(resultado.atualizados)} />
            <Indicador rotulo="Descartadas" valor={numero(resultado.descartados)} nota="Devolucoes" />
            <Indicador rotulo="Rejeitadas" valor={numero(resultado.rejeitados)}
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
