/**
 * Modulo 14 - central de integracoes.
 *
 * A tela responde duas perguntas, nesta ordem de importancia:
 *
 *   1. O que esta entrando e saindo do sistema, e esta funcionando?
 *   2. O que eu preciso configurar para funcionar?
 *
 * A segunda importa mais do que parece. Integracao nao configurada nao e um
 * erro - e o estado normal de quem acabou de instalar - mas fica igual a
 * integracao quebrada se a tela so tiver "verde" e "vermelho". Por isso o
 * semaforo tem QUATRO estados, e o branco (nao configurado) vem com a lista do
 * que falta, nao com um alerta.
 *
 * O importador segue o fluxo da secao 11 e para na pre-visualizacao de
 * proposito: um arquivo de 426 mil linhas com o mapeamento errado grava 426 mil
 * registros errados, e desfazer custa mais do que qualquer coisa que o
 * importador economize.
 */
import { useCallback, useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { GraficoLinha } from '../componentes/graficos';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Selecao, Vazio,
  dataHora, numero,
} from '../componentes/ui';

type Aba = 'central' | 'importar' | 'exportar' | 'erros' | 'execucoes'
  | 'conciliacoes' | 'configuracao';
type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

/** Secao 5: quatro estados, nao dois. */
const SEMAFORO: Record<string, { tom: Tom; texto: string }> = {
  OPERACIONAL: { tom: 'acento', texto: 'operacional' },
  ATENCAO: { tom: 'alerta', texto: 'atencao' },
  ERRO: { tom: 'perigo', texto: 'erro' },
  NAO_CONFIGURADO: { tom: 'neutro', texto: 'nao configurado' },
};

const TOM_STATUS: Record<string, Tom> = {
  CONCLUIDA: 'acento', CONCLUIDA_COM_ERROS: 'alerta', FALHOU: 'perigo',
  CANCELADA: 'neutro', EM_ANDAMENTO: 'info', PROCESSANDO: 'info',
  AGUARDANDO_CONFIRMACAO: 'alerta', AGUARDANDO_MAPEAMENTO: 'alerta',
  VALIDANDO: 'info', RECEBIDO: 'info', REJEITADA: 'perigo',
  DIVERGENTE: 'perigo', CONCILIADO: 'acento', ACEITO: 'info', IGNORADO: 'neutro',
  ABERTO: 'perigo', RESOLVIDO: 'acento', PENDENTE: 'alerta',
};

const erroDe = (e: unknown, padrao: string) =>
  (e instanceof ErroApi ? e.message : padrao);

export function Integracoes() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('central');

  const abas: Array<{ id: Aba; texto: string; visivel: boolean }> = [
    { id: 'central', texto: 'Central', visivel: pode('integracao.ler') },
    { id: 'importar', texto: 'Importar', visivel: pode('integracao.importar') },
    { id: 'exportar', texto: 'Exportar', visivel: pode('integracao.exportar') },
    { id: 'erros', texto: 'Erros', visivel: pode('integracao.ler') },
    { id: 'execucoes', texto: 'Execucoes', visivel: pode('integracao.ler') },
    { id: 'conciliacoes', texto: 'Conciliacoes', visivel: pode('integracao.ler') },
    { id: 'configuracao', texto: 'Configuracao', visivel: pode('integracao.configurar') },
  ];

  const visiveis = abas.filter((a) => a.visivel);
  if (!visiveis.length) {
    return <Aviso>Seu perfil nao tem acesso ao modulo de integracoes.</Aviso>;
  }

  return (
    <>
      <CabecalhoPagina
        titulo="Integracoes"
        descricao="O que entra e o que sai do sistema: ERP, planilha, e-mail, API,
          fornecedor e transportadora. Todo dado que chega vira evento e passa pelas
          regras dos modulos - nenhuma integracao escreve direto em estoque ou pedido."
      />

      <nav className="abas">
        {visiveis.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`abas__item${aba === a.id ? ' abas__item--ativo' : ''}`}
            onClick={() => setAba(a.id)}
          >
            {a.texto}
          </button>
        ))}
      </nav>

      {aba === 'central' && <Central />}
      {aba === 'importar' && <Importar />}
      {aba === 'exportar' && <Exportar />}
      {aba === 'erros' && <Erros />}
      {aba === 'execucoes' && <Execucoes />}
      {aba === 'conciliacoes' && <Conciliacoes />}
      {aba === 'configuracao' && <Configuracao />}
    </>
  );
}

// ---------------------------------------------------------------------------

function Central() {
  const { pode } = useAuth();
  const [central, setCentral] = useState<any>(null);
  const [indicadores, setIndicadores] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [serie, setSerie] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [c, i, d, s] = await Promise.all([
        api<any>('/integracoes/central'),
        api<any>('/integracoes/indicadores?dias=30'),
        api<any>('/integracoes/diagnostico'),
        api<any[]>('/integracoes/serie?dias=14'),
      ]);
      setCentral(c.data); setIndicadores(i.data); setDiag(d.data); setSerie(s.data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar a central'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const sincronizar = async (codigo: string) => {
    setOcupado(codigo);
    try {
      await api(`/integracoes/${codigo}/sincronizar`, { metodo: 'POST', corpo: {} });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, `Nao foi possivel sincronizar ${codigo}`));
    } finally {
      setOcupado(null);
    }
  };

  const testar = async (codigo: string) => {
    setOcupado(codigo);
    try {
      const { data } = await api<any>(`/integracoes/${codigo}/testar`,
        { metodo: 'POST', corpo: {} });
      setErro(null);
      alert(data?.diagnostico ?? 'Teste concluido');
    } catch (e) {
      setErro(erroDe(e, 'Falha ao testar a conexao'));
    } finally {
      setOcupado(null);
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!central) return <p className="fraco">Carregando...</p>;

  const exec = indicadores?.execucoes ?? {};

  return (
    <>
      {diag?.sintomas?.length > 0 && (
        <Cartao titulo={`Diagnostico: ${diag.gravidade}`}>
          <ul className="lista-sintomas">
            {diag.sintomas.map((s: any, i: number) => (
              <li key={i} className={`sintoma sintoma--${String(s.gravidade).toLowerCase()}`}>
                <Etiqueta texto={s.gravidade}
                  tom={s.gravidade === 'CRITICO' ? 'perigo'
                    : s.gravidade === 'ATENCAO' ? 'alerta' : 'acento'} />
                <div>
                  <strong>{s.descricao}</strong>
                  <div className="fraco">→ {s.acao}</div>
                </div>
              </li>
            ))}
          </ul>
        </Cartao>
      )}

      <div className="grade-indicadores">
        <Indicador rotulo="Operacionais" valor={numero(central.operacionais)}
          tom={central.operacionais > 0 ? 'acento' : 'neutro'}
          nota={`de ${numero(central.total)} integracoes`} />
        <Indicador rotulo="Com erro" valor={numero(central.erro)}
          tom={central.erro > 0 ? 'perigo' : 'neutro'} />
        <Indicador rotulo="Nao configuradas" valor={numero(central.nao_configuradas)}
          nota="Normal em instalacao nova: falta credencial ou endpoint" />
        <Indicador
          rotulo="Sucesso das execucoes"
          valor={exec.sem_base ? 'sem base' : `${numero(exec.taxa_sucesso, 1)}%`}
          tom={exec.sem_base ? 'neutro' : exec.taxa_sucesso >= 95 ? 'acento' : 'alerta'}
          nota={exec.sem_base
            ? 'Nenhuma execucao em 30 dias'
            : `${numero(exec.total)} execucoes, ${numero(exec.registros)} registros`} />
        <Indicador rotulo="Mensagens na fila"
          valor={numero(indicadores?.mensagens?.pendentes)}
          tom={Number(indicadores?.mensagens?.dead_letter ?? 0) > 0 ? 'perigo' : 'neutro'}
          nota={Number(indicadores?.mensagens?.dead_letter ?? 0) > 0
            ? `${numero(indicadores.mensagens.dead_letter)} na fila morta` : undefined} />
        <Indicador rotulo="Agendador"
          valor={central.sincronizacao_ativa ? 'ligado' : 'desligado'}
          tom={central.sincronizacao_ativa ? 'acento' : 'perigo'} />
      </div>

      <Cartao titulo="Integracoes">
        <table className="tabela">
          <thead>
            <tr>
              <th>Integracao</th><th>Sistema</th><th>Conector</th><th>Modo</th>
              <th>Situacao</th><th>Ultima sincronizacao</th><th /></tr>
          </thead>
          <tbody>
            {(central.integracoes ?? []).map((i: any) => {
              const s = SEMAFORO[i.semaforo] ?? SEMAFORO.NAO_CONFIGURADO!;
              return (
                <tr key={i.codigo} className={i.ativo ? '' : 'linha--inativa'}>
                  <td>
                    <strong>{i.nome}</strong>
                    <div className="fraco">{i.codigo} · {i.direcao}</div>
                    {/* A pendencia e o conteudo util do estado "nao configurado":
                        diz o que fazer, em vez de so dizer que falta algo. */}
                    {(i.pendencias ?? []).length > 0 && (
                      <div className="fraco">Falta: {i.pendencias.join('; ')}</div>
                    )}
                  </td>
                  <td className="fraco">{i.sistema}</td>
                  <td className="fraco">{i.conector}</td>
                  <td className="fraco">{i.modo}</td>
                  <td><Etiqueta texto={s.texto} tom={s.tom} /></td>
                  <td className="fraco">
                    {i.ultima_sincronizacao ? dataHora(i.ultima_sincronizacao) : '—'}
                    {i.proxima_sincronizacao && (
                      <div>proxima: {dataHora(i.proxima_sincronizacao)}</div>
                    )}
                  </td>
                  <td>
                    {pode('integracao.sincronizar') && (
                      <div className="acoes-linha">
                        <button type="button"
                          className="botao botao--fantasma botao--pequeno"
                          disabled={ocupado === i.codigo}
                          onClick={() => testar(i.codigo)}>
                          Testar
                        </button>
                        <button type="button" className="botao botao--pequeno"
                          disabled={ocupado === i.codigo || !i.ativo}
                          onClick={() => sincronizar(i.codigo)}>
                          Sincronizar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Volume por dia (14 dias)">
        <GraficoLinha
          rotulos={serie.map((d: any) => String(d.dia).slice(5))}
          series={[
            { nome: 'Execucoes', valores: serie.map((d: any) => Number(d.execucoes ?? 0)) },
            { nome: 'Registros', valores: serie.map((d: any) => Number(d.registros ?? 0)) },
            { nome: 'Erros', valores: serie.map((d: any) => Number(d.erros ?? 0)) },
          ]}
        />
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

const TAMANHO_LOTE = 8000;
const AMOSTRA_LINHAS = 100;

/**
 * XLSX (zip) e XLS binario (OLE) sao lidos como bytes. O resto e texto: CSV e
 * o ".xls" do ERP, que na verdade e uma tabela HTML em Windows-1252. Texto e
 * lido com raw para preservar zeros a esquerda e codigos de barras longos.
 */
function lerPastaDeTrabalho(bytes: Uint8Array): XLSX.WorkBook {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if (zip || ole) {
    return XLSX.read(bytes, { type: 'array', raw: false, dateNF: 'DD/MM/YYYY' });
  }
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder('windows-1252').decode(bytes);
  }
  return XLSX.read(texto, { type: 'string', raw: true });
}

function Importar() {
  const [entidades, setEntidades] = useState<string[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [importacoes, setImportacoes] = useState<any[]>([]);
  const [entidade, setEntidade] = useState('');
  const [arquivoSelecionado, setArquivoSelecionado] = useState<File | null>(null);
  const [linhasParsed, setLinhasParsed] = useState<Array<Record<string, unknown>>>([]);
  const [analise, setAnalise] = useState<any>(null);
  const [template, setTemplate] = useState('');
  const [validacao, setValidacao] = useState<any>(null);
  const [resultado, setResultado] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [progresso, setProgresso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [e, t, i] = await Promise.all([
        api<any>('/integracoes/importacoes/entidades'),
        api<any[]>('/integracoes/templates'),
        api<any>('/integracoes/importacoes?limite=15'),
      ]);
      setEntidades(e.data?.entidades ?? []);
      setTemplates(t.data ?? []);
      setImportacoes(i.data?.importacoes ?? i.data ?? []);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as importacoes'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const passo = async <T,>(caminho: string, corpo?: unknown): Promise<T | null> => {
    setOcupado(true);
    setErro(null);
    try {
      const { data } = await api<T>(caminho, { metodo: 'POST', corpo: corpo ?? {} });
      return data;
    } catch (e) {
      setErro(erroDe(e, 'A operacao falhou'));
      return null;
    } finally {
      setOcupado(false);
    }
  };

  /**
   * Le o arquivo no browser com SheetJS, envia apenas cabecalho + amostra ao
   * backend e guarda todas as linhas em estado para o processamento em lotes.
   * Contorna o limite de 4.5 MB da Vercel: o arquivo nunca sobe por inteiro.
   */
  const analisar = async () => {
    if (!arquivoSelecionado || !entidade) return;
    setValidacao(null); setResultado(null); setAnalise(null); setErro(null);
    setOcupado(true);
    setProgresso('Lendo arquivo...');

    try {
      const wb = lerPastaDeTrabalho(new Uint8Array(await arquivoSelecionado.arrayBuffer()));

      if (!wb.SheetNames.length) throw new Error('O arquivo nao contem planilhas validas');
      const planilha = wb.Sheets[wb.SheetNames[0]!];
      if (!planilha) throw new Error('Planilha vazia ou invalida');

      const linhas = XLSX.utils.sheet_to_json<Record<string, unknown>>(planilha, {
        defval: '',
        raw: false,
        dateNF: 'DD/MM/YYYY',
      });

      if (!linhas.length) throw new Error('Nenhuma linha encontrada no arquivo');

      const colunas = Object.keys(linhas[0]!);
      const amostra = linhas.slice(0, AMOSTRA_LINHAS);
      setLinhasParsed(linhas);

      setProgresso('Analisando estrutura...');
      // Passa o template automaticamente quando existe um para a entidade
      // (ex.: REL7104_VENDAS para vendas): elimina o passo manual de mapeamento.
      const sugerido = templates.find((t) => t.entidade === entidade);
      const { data } = await api<any>('/integracoes/importacoes/iniciar-client', {
        metodo: 'POST',
        corpo: {
          nome_arquivo: arquivoSelecionado.name,
          entidade,
          colunas,
          amostra,
          total_linhas: linhas.length,
          template: sugerido?.codigo ?? null,
        },
      });

      setAnalise(data);
      setTemplate(sugerido?.codigo ?? '');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao ler o arquivo');
    } finally {
      setOcupado(false);
      setProgresso(null);
    }
  };

  const mapear = async () => {
    const d = await passo<any>(`/integracoes/importacoes/${analise.importacao_id}/mapear`,
      { template });
    if (d) setAnalise({ ...analise, casamento: d.casamento, template: d.template });
  };

  const validar = async () => {
    const d = await passo<any>(`/integracoes/importacoes/${analise.importacao_id}/validar`);
    if (d) setValidacao(d);
  };

  /**
   * Confirma e processa em lotes: cada lote tem ate TAMANHO_LOTE linhas
   * (ca. 3 MB JSON), garantindo que cada requisicao fique abaixo do limite
   * da Vercel. O backend grava cada lote imediatamente via o gravador da
   * entidade; o progresso e exibido linha a linha.
   */
  const gravar = async () => {
    const c = await passo<any>(`/integracoes/importacoes/${analise.importacao_id}/confirmar`);
    if (!c) return;

    const totalLotes = Math.ceil(linhasParsed.length / TAMANHO_LOTE);
    setOcupado(true);
    setErro(null);

    try {
      const jwt = localStorage.getItem('compras.token') ?? '';
      let ultimoResultado: any = null;

      for (let lote = 0; lote < totalLotes; lote++) {
        const inicio = lote * TAMANHO_LOTE;
        const fim = Math.min(inicio + TAMANHO_LOTE, linhasParsed.length);
        const linhsLote = linhasParsed.slice(inicio, fim);
        const isLast = lote === totalLotes - 1;

        setProgresso(
          `Gravando lote ${lote + 1} de ${totalLotes} `
          + `(${numero(fim)} de ${numero(linhasParsed.length)} linhas)...`
        );

        const resp = await fetch(
          `/api/integracoes/importacoes/${analise.importacao_id}/processar-lote`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({ lote, total_lotes: totalLotes, linhas: linhsLote, is_last: isLast }),
          },
        );

        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
          throw new Error(json?.error?.message ?? `Falha no lote ${lote + 1}: ${resp.status}`);
        }

        if (isLast) ultimoResultado = json?.data ?? null;
      }

      setResultado(ultimoResultado);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao processar os lotes');
    } finally {
      setOcupado(false);
      setProgresso(null);
    }
  };

  const resetar = () => {
    setArquivoSelecionado(null);
    setLinhasParsed([]);
    setAnalise(null);
    setValidacao(null);
    setResultado(null);
    setErro(null);
    setTemplate('');
  };

  const nomeArquivo = arquivoSelecionado?.name;
  const tamanhoArquivo = arquivoSelecionado
    ? arquivoSelecionado.size < 1024 * 1024
      ? `${(arquivoSelecionado.size / 1024).toFixed(0)} KB`
      : `${(arquivoSelecionado.size / 1024 / 1024).toFixed(1)} MB`
    : null;

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {progresso && <p className="fraco">{progresso}</p>}

      <Cartao titulo="Nova importacao de planilha de vendas">
        <p className="fraco">
          Selecione um arquivo XLSX ou CSV exportado do ERP. O arquivo e lido
          diretamente no navegador — arquivos grandes (ate 800 mil linhas) sao
          enviados em lotes e nao encontram o limite de tamanho da Vercel.
          Nada e gravado no banco antes da confirmacao.
        </p>

        <div className="filtros" style={{ alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label className="rotulo" style={{ fontSize: '0.75rem', color: 'var(--cor-texto-fraco)' }}>
              Arquivo (XLSX ou CSV)
            </label>
            <label
              className="botao"
              style={{ cursor: 'pointer', display: 'inline-block', marginBottom: 0 }}
            >
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setArquivoSelecionado(f);
                  setLinhasParsed([]);
                  setAnalise(null);
                  setValidacao(null);
                  setResultado(null);
                  setErro(null);
                }}
              />
              {nomeArquivo ? 'Trocar arquivo' : 'Selecionar arquivo'}
            </label>
            {nomeArquivo && (
              <span className="fraco" style={{ fontSize: '0.75rem' }}>
                {nomeArquivo} ({tamanhoArquivo})
                {linhasParsed.length > 0 && ` · ${numero(linhasParsed.length)} linhas`}
              </span>
            )}
          </div>

          <Selecao
            rotulo="Tipo de dados"
            valor={entidade}
            aoMudar={(v) => { setEntidade(v); setAnalise(null); setValidacao(null); setResultado(null); }}
            opcoes={entidades.map((e) => ({ valor: e, texto: e }))}
          />

          <button
            type="button"
            className="botao botao--primario"
            disabled={ocupado || !arquivoSelecionado || !entidade}
            onClick={analisar}
          >
            {ocupado ? 'Processando...' : 'Ler e analisar'}
          </button>

          {(analise || erro) && (
            <button type="button" className="botao botao--fantasma" onClick={resetar}>
              Nova importacao
            </button>
          )}
        </div>
      </Cartao>

      {analise && (
        <Cartao titulo={`Importacao ${analise.importacao_id} — ${numero(analise.total_estimado ?? linhasParsed.length)} linhas`}>
          {analise.ja_importado && (
            <Aviso>
              Este arquivo ja foi importado em {dataHora(analise.ja_importado.em)}
              {' '}(importacao {analise.ja_importado.importacao_id},{' '}
              {numero(analise.ja_importado.registros)} registros). Prosseguir vai
              atualizar os registros existentes, nao duplicar.
            </Aviso>
          )}
          {(analise.impedimentos ?? []).length > 0 && (
            <Aviso>{analise.impedimentos.join(' · ')}</Aviso>
          )}

          <p className="fraco">
            {analise.colunas?.length} colunas detectadas:{' '}
            {(analise.colunas ?? []).join(', ')}
          </p>

          <div className="filtros">
            <Selecao rotulo="Modelo de mapeamento" valor={template} aoMudar={setTemplate}
              opcoes={templates
                .filter((t) => t.entidade === analise.entidade || !analise.entidade)
                .map((t) => ({ valor: t.codigo, texto: `${t.nome} (${t.codigo})` }))} />
            <button type="button" className="botao botao--pequeno"
              disabled={ocupado || !template} onClick={mapear}>
              Aplicar mapeamento
            </button>
            <button type="button" className="botao botao--pequeno"
              disabled={ocupado || !analise.casamento} onClick={validar}>
              Validar amostra
            </button>
          </div>

          {analise.casamento && (
            <table className="tabela">
              <thead><tr><th>Coluna do arquivo</th><th>Campo do sistema</th></tr></thead>
              <tbody>
                {Object.entries(analise.casamento.encontradas ?? {}).map(([campo, coluna]) => (
                  <tr key={campo}>
                    <td>{String(coluna)}</td>
                    <td className="fraco">{campo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(analise.sugestoes ?? []).length > 0 && !analise.casamento && (
            <>
              <p className="fraco">
                Sugestao automatica — confira antes de salvar como modelo:
              </p>
              <table className="tabela">
                <thead><tr><th>Coluna</th><th>Campo sugerido</th><th>Confianca</th></tr></thead>
                <tbody>
                  {analise.sugestoes.map((s: any, i: number) => (
                    <tr key={i}>
                      <td>{s.campo_externo}</td>
                      <td className="fraco">{s.campo_interno}</td>
                      <td>
                        <Etiqueta texto={s.confianca}
                          tom={s.confianca === 'ALTA' ? 'acento' : 'alerta'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Cartao>
      )}

      {validacao && (
        <Cartao titulo="Pre-visualizacao e validacao">
          {validacao.truncado && (
            <Aviso>
              Validacao baseada em amostra de {numero(validacao.validas + validacao.com_erro)} linhas.
              O arquivo completo ({numero(validacao.total_linhas)} linhas) sera processado em lotes
              apos a confirmacao.
            </Aviso>
          )}
          <div className="grade-indicadores">
            <Indicador rotulo="Validas (amostra)" valor={numero(validacao.validas)}
              tom="acento" />
            <Indicador rotulo="Com erro (amostra)" valor={numero(validacao.com_erro)}
              tom={validacao.com_erro > 0 ? 'perigo' : 'neutro'}
              nota="Nao serao gravadas" />
            <Indicador rotulo="Com alerta (amostra)" valor={numero(validacao.com_alerta)}
              tom={validacao.com_alerta > 0 ? 'alerta' : 'neutro'}
              nota="Serao gravadas, com ressalva" />
            <Indicador rotulo="Total no arquivo" valor={numero(validacao.total_linhas)} />
          </div>

          {(validacao.ocorrencias_por_regra ?? []).length > 0 && (
            <table className="tabela">
              <thead><tr><th>Regra</th><th>Severidade</th><th>Casos</th><th>Exemplo</th></tr></thead>
              <tbody>
                {validacao.ocorrencias_por_regra.map((o: any, i: number) => (
                  <tr key={i}>
                    <td>{o.regra}</td>
                    <td>
                      <Etiqueta texto={o.severidade}
                        tom={o.severidade === 'ERRO' ? 'perigo' : 'alerta'} />
                    </td>
                    <td>{numero(o.total)}</td>
                    <td className="fraco">{o.exemplo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="fraco">
            Confirmar inicia o processamento de {numero(linhasParsed.length)} linhas
            em {Math.ceil(linhasParsed.length / TAMANHO_LOTE)} lotes.
            Registros existentes sao atualizados, nunca duplicados.
          </p>
          <button type="button" className="botao botao--primario"
            disabled={ocupado} onClick={gravar}>
            Confirmar e gravar
          </button>
        </Cartao>
      )}

      {resultado && (
        <Cartao titulo="Resultado">
          {entidade === 'vendas' && (
            <Aviso tipo="ok">
              Historico de vendas atualizado. Os dados ja aparecem na aba Demanda
              (dashboard, analise por produto, previsao e sazonalidade).
            </Aviso>
          )}
          {entidade === 'estoque' && (
            <Aviso tipo="ok">
              Saldo de estoque do ERP atualizado no local "ERP". O planejamento de
              compras ja usa o novo saldo; cada diferenca ficou registrada como
              movimentacao de inventario.
            </Aviso>
          )}
          <div className="grade-indicadores">
            <Indicador rotulo="Criados" valor={numero(resultado.criados)} tom="acento" />
            <Indicador rotulo="Atualizados" valor={numero(resultado.atualizados)} />
            <Indicador rotulo="Descartados" valor={numero(resultado.descartados)}
              nota="Ja existiam, sem mudanca" />
            <Indicador rotulo="Rejeitados" valor={numero(resultado.rejeitados)}
              tom={resultado.rejeitados > 0 ? 'perigo' : 'neutro'} />
          </div>
        </Cartao>
      )}

      <Cartao titulo="Importacoes recentes">
        {!importacoes.length
          ? <Vazio>Nenhuma importacao ainda.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Arquivo</th><th>Entidade</th><th>Status</th>
                  <th>Linhas</th><th>Criados</th><th>Quando</th></tr>
              </thead>
              <tbody>
                {importacoes.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.nome_arquivo}<div className="fraco">{i.formato}</div></td>
                    <td className="fraco">{i.entidade}</td>
                    <td><Etiqueta texto={i.status}
                      tom={TOM_STATUS[i.status] ?? 'neutro'} /></td>
                    <td>{numero(i.total_linhas)}</td>
                    <td>{numero(i.registros_criados)}</td>
                    <td className="fraco">{dataHora(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Exportar() {
  const [conjuntos, setConjuntos] = useState<any[]>([]);
  const [historico, setHistorico] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([
        api<any[]>('/integracoes/exportacoes/conjuntos'),
        api<any[]>('/integracoes/exportacoes/historico?limite=20'),
      ]);
      setConjuntos(c.data ?? []);
      setHistorico(h.data ?? []);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as exportacoes'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /**
   * A exportacao devolve o ARQUIVO, nao JSON: o download e feito por `fetch`
   * direto com o token, porque o cliente padrao espera o envelope da API.
   */
  const baixar = async (conjunto: string, formato: string) => {
    setOcupado(`${conjunto}:${formato}`);
    setErro(null);
    try {
      const token = localStorage.getItem('compras.token') ?? '';
      const resposta = await fetch('/api/integracoes/exportacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conjunto, formato }),
      });

      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => null);
        throw new Error(corpo?.error?.message ?? `Falha ${resposta.status}`);
      }

      const blob = await resposta.blob();
      const nome = (resposta.headers.get('content-disposition') ?? '')
        .match(/filename="([^"]+)"/)?.[1] ?? `${conjunto}.${formato.toLowerCase()}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = nome; a.click();
      URL.revokeObjectURL(url);

      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao exportar');
    } finally {
      setOcupado(null);
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      <Cartao titulo="Exportar dados">
        <p className="fraco">
          Conjunto marcado como sensivel exige a permissao do proprio dado, nao
          apenas a de exportar — e a exportacao fica registrada em auditoria.
        </p>
        <table className="tabela">
          <thead>
            <tr><th>Conjunto</th><th>Conteudo</th><th>Formatos</th></tr>
          </thead>
          <tbody>
            {conjuntos.map((c: any) => (
              <tr key={c.codigo}>
                <td>
                  <strong>{c.nome}</strong>
                  {c.sensivel && <> <Etiqueta texto="sensivel" tom="alerta" /></>}
                  <div className="fraco">{c.codigo}</div>
                </td>
                <td className="fraco">{c.descricao}</td>
                <td>
                  <div className="acoes-linha">
                    {['XLSX', 'CSV', 'JSON', 'PDF'].map((f) => (
                      <button key={f} type="button"
                        className="botao botao--fantasma botao--pequeno"
                        disabled={ocupado === `${c.codigo}:${f}`}
                        onClick={() => baixar(c.codigo, f)}>
                        {f}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Exportacoes recentes">
        {!historico.length
          ? <Vazio>Nenhuma exportacao registrada.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr><th>Conjunto</th><th>Formato</th><th>Linhas</th>
                  <th>Usuario</th><th>Quando</th></tr>
              </thead>
              <tbody>
                {historico.map((h: any) => (
                  <tr key={h.id}>
                    <td>
                      {h.entidade}
                      {h.sensivel && <> <Etiqueta texto="sensivel" tom="alerta" /></>}
                    </td>
                    <td className="fraco">{h.formato}</td>
                    <td>{numero(h.total_linhas)}</td>
                    <td className="fraco">{h.usuario ?? '—'}</td>
                    <td className="fraco">{dataHora(h.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Erros() {
  const { pode } = useAuth();
  const [erros, setErros] = useState<any>(null);
  const [padroes, setPadroes] = useState<any[]>([]);
  const [filtro, setFiltro] = useState({ status: 'ABERTO', classe: '' });
  const [detalhe, setDetalhe] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filtro.status) params.set('status', filtro.status);
      if (filtro.classe) params.set('classe', filtro.classe);
      params.set('limite', '50');
      const [e, p] = await Promise.all([
        api<any>(`/integracoes/erros?${params}`),
        api<any[]>('/integracoes/erros/padroes?dias=30'),
      ]);
      setErros(e.data); setPadroes(p.data ?? []); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar os erros'));
    }
  }, [filtro]);

  useEffect(() => { void carregar(); }, [carregar]);

  const resolver = async (id: number) => {
    try {
      await api(`/integracoes/erros/${id}/resolver`, {
        metodo: 'POST', corpo: { observacao: 'Resolvido pela tela de integracoes' },
      });
      setDetalhe(null);
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel resolver'));
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;

  const linhas = erros?.erros ?? erros ?? [];

  return (
    <>
      {padroes.length > 0 && (
        <Cartao titulo="Padroes de erro (30 dias)">
          <p className="fraco">
            Erro que se repete nao e incidente, e configuracao errada. Aqui os
            agrupamentos que mais aparecem.
          </p>
          <table className="tabela">
            <thead><tr><th>Padrao</th><th>Integracao</th><th>Casos</th></tr></thead>
            <tbody>
              {padroes.map((p: any, i: number) => (
                <tr key={i}>
                  <td>{p.tipo ?? p.padrao}<div className="fraco">{p.mensagem}</div></td>
                  <td className="fraco">{p.integracao_codigo ?? '—'}</td>
                  <td>{numero(p.total ?? p.ocorrencias)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}

      <Cartao titulo="Erros de integracao" acoes={(
        <div className="filtros">
          <Selecao rotulo="Status" valor={filtro.status}
            aoMudar={(v) => setFiltro({ ...filtro, status: v })}
            opcoes={['ABERTO', 'EM_ANALISE', 'RESOLVIDO', 'IGNORADO']
              .map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="Classe" valor={filtro.classe}
            aoMudar={(v) => setFiltro({ ...filtro, classe: v })}
            opcoes={['RECUPERAVEL', 'DEFINITIVO', 'DESCONHECIDO']
              .map((s) => ({ valor: s, texto: s }))} />
        </div>
      )}>
        {!linhas.length
          ? <Vazio>Nenhum erro com esses filtros.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Erro</th><th>Integracao</th><th>Entidade</th>
                  <th>Classe</th><th>Casos</th><th>Quando</th><th /></tr>
              </thead>
              <tbody>
                {linhas.map((e: any) => (
                  <tr key={e.id}>
                    <td>
                      {e.mensagem}
                      {/* Secao 35: causa sugerida pela IA fica visivelmente
                          separada de erro confirmado. */}
                      {e.causa_provavel && (
                        <div className="fraco">
                          <Etiqueta
                            texto={e.confirmado ? 'causa confirmada' : 'causa provavel'}
                            tom={e.confirmado ? 'acento' : 'alerta'} />
                          {' '}{e.causa_provavel}
                        </div>
                      )}
                    </td>
                    <td className="fraco">{e.integracao_codigo ?? '—'}</td>
                    <td className="fraco">{e.entidade ?? '—'}</td>
                    <td>
                      <Etiqueta texto={e.classe}
                        tom={e.classe === 'DEFINITIVO' ? 'perigo' : 'alerta'} />
                    </td>
                    <td>{numero(e.ocorrencias)}</td>
                    <td className="fraco">{dataHora(e.created_at)}</td>
                    <td>
                      <button type="button"
                        className="botao botao--fantasma botao--pequeno"
                        onClick={() => setDetalhe(e)}>
                        Ver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>

      {detalhe && (
        <Modal titulo="Erro de integracao" largo aoFechar={() => setDetalhe(null)}
          rodape={pode('integracao.reprocessar') && detalhe.status === 'ABERTO' ? (
            <button type="button" className="botao botao--primario"
              onClick={() => resolver(detalhe.id)}>
              Marcar como resolvido
            </button>
          ) : undefined}
        >
          <dl className="definicoes">
            <dt>Mensagem</dt><dd>{detalhe.mensagem}</dd>
            <dt>Tipo</dt><dd>{detalhe.tipo} · {detalhe.classe}</dd>
            <dt>Linha</dt><dd>{detalhe.linha ?? '—'}</dd>
            {detalhe.causa_provavel && (
              <>
                <dt>{detalhe.confirmado ? 'Causa confirmada' : 'Causa provavel'}</dt>
                <dd>
                  {detalhe.causa_provavel}
                  {!detalhe.confirmado && (
                    <div className="fraco">
                      Sugestao de diagnostico ({detalhe.origem_diagnostico},
                      confianca {detalhe.confianca_diagnostico}) — confira antes de agir.
                    </div>
                  )}
                </dd>
              </>
            )}
            {detalhe.solucao_sugerida && (
              <>
                <dt>Solucao sugerida</dt><dd>{detalhe.solucao_sugerida}</dd>
              </>
            )}
          </dl>
          {detalhe.payload && (
            <>
              <p className="fraco">Payload (sem cabecalhos sensiveis):</p>
              <pre className="bloco-codigo">
                {JSON.stringify(detalhe.payload, null, 2)}
              </pre>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Execucoes() {
  const [execucoes, setExecucoes] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>('/integracoes/execucoes?limite=50');
        setExecucoes(data);
      } catch (e) {
        setErro(erroDe(e, 'Nao foi possivel carregar as execucoes'));
      }
    })();
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  const linhas = execucoes?.execucoes ?? execucoes ?? [];

  return (
    <Cartao titulo="Execucoes de integracao">
      <p className="fraco">
        Cada sincronizacao, importacao e envio deixa uma linha aqui, com quantos
        registros entraram, quantos foram rejeitados e quanto tempo levou.
      </p>
      {!linhas.length
        ? <Vazio>Nenhuma execucao registrada.</Vazio>
        : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Integracao</th><th>Tipo</th><th>Status</th><th>Lidos</th>
                <th>Criados</th><th>Rejeitados</th><th>Duracao</th><th>Quando</th></tr>
            </thead>
            <tbody>
              {linhas.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.integracao_codigo}<div className="fraco">{x.entidade ?? '—'}</div></td>
                  <td className="fraco">{x.tipo} · {x.direcao}</td>
                  <td><Etiqueta texto={x.status} tom={TOM_STATUS[x.status] ?? 'neutro'} /></td>
                  <td>{numero(x.registros_lidos)}</td>
                  <td>{numero(x.registros_criados)}</td>
                  <td>
                    {x.registros_rejeitados > 0
                      ? <Etiqueta texto={numero(x.registros_rejeitados)} tom="alerta" />
                      : <span className="fraco">0</span>}
                  </td>
                  <td className="fraco">
                    {x.duracao_ms === null ? '—' : `${numero(x.duracao_ms)} ms`}
                  </td>
                  <td className="fraco">{dataHora(x.iniciado_em)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------

function Conciliacoes() {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [resumo, setResumo] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        api<any>('/integracoes/conciliacoes?status=DIVERGENTE&limite=50'),
        api<any[]>('/integracoes/conciliacoes/resumo'),
      ]);
      setDados(c.data); setResumo(r.data ?? []); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as conciliacoes'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const decidir = async (id: number, acao: 'aceitar' | 'conciliar' | 'ignorar') => {
    try {
      await api(`/integracoes/conciliacoes/${id}/${acao}`, {
        metodo: 'POST',
        corpo: { justificativa: `Decidido na tela de integracoes: ${acao}` },
      });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel registrar a decisao'));
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;
  const linhas = dados?.conciliacoes ?? [];

  return (
    <>
      <Cartao titulo="Divergencias entre o sistema e a origem externa">
        <p className="fraco">
          A conciliacao compara e registra. Ela nunca corrige sozinha: ajustar saldo
          e movimentacao de estoque, e movimentacao passa pelas regras do modulo 03.
        </p>
        {resumo.length > 0 && (
          <div className="grade-indicadores">
            {resumo.map((r: any, i: number) => (
              <Indicador key={i} rotulo={`${r.entidade} · ${r.campo}`}
                valor={numero(r.total)}
                tom={r.status === 'DIVERGENTE' ? 'perigo' : 'neutro'}
                nota={`diferenca absoluta ${numero(r.diferenca_absoluta)}`} />
            ))}
          </div>
        )}
        {!linhas.length
          ? <Vazio>Nenhuma divergencia aberta.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Chave externa</th><th>Campo</th><th>No sistema</th>
                  <th>Na origem</th><th>Diferenca</th><th /></tr>
              </thead>
              <tbody>
                {linhas.map((c: any) => (
                  <tr key={c.id}>
                    <td>{c.chave_externa}<div className="fraco">{c.integracao}</div></td>
                    <td className="fraco">{c.entidade} · {c.campo}</td>
                    <td>{numero(c.valor_interno, 2)}</td>
                    <td>{numero(c.valor_externo, 2)}</td>
                    <td>
                      <Etiqueta
                        texto={`${numero(c.diferenca, 2)} (${numero(c.diferenca_percentual, 1)}%)`}
                        tom="perigo" />
                    </td>
                    <td>
                      {pode('integracao.conciliar') && (
                        <div className="acoes-linha">
                          <button type="button"
                            className="botao botao--fantasma botao--pequeno"
                            onClick={() => decidir(c.id, 'aceitar')}>
                            Aceitar
                          </button>
                          <button type="button"
                            className="botao botao--fantasma botao--pequeno"
                            onClick={() => decidir(c.id, 'ignorar')}>
                            Ignorar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Configuracao() {
  const [configs, setConfigs] = useState<any[]>([]);
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const { data } = await api<any[]>('/integracoes/configuracoes');
      setConfigs(data ?? []);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as configuracoes'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const salvar = async (chave: string) => {
    try {
      await api(`/integracoes/configuracoes/${chave}`, {
        metodo: 'PUT', corpo: { valor: editando[chave] ?? '' },
      });
      setAviso(`${chave} atualizado`);
      setEditando((e) => { const { [chave]: _, ...resto } = e; return resto; });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel salvar'));
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <Cartao titulo="Parametros de integracao">
        <p className="fraco">
          Os limites moram no banco. Vale destacar um: endereco de rede interna e
          recusado por padrao, para o sistema nao poder ser usado como ponte para
          dentro da rede. Para integrar com o ERP da empresa, que costuma ser
          interno, inclua o host em <code>hosts_internos_permitidos</code>.
        </p>
        <table className="tabela">
          <thead>
            <tr><th>Parametro</th><th>Valor</th><th>Descricao</th><th /></tr>
          </thead>
          <tbody>
            {configs.map((c: any) => {
              const emEdicao = editando[c.chave] !== undefined;
              return (
                <tr key={c.chave}>
                  <td className="fraco">{c.chave}</td>
                  <td>
                    {emEdicao
                      ? (
                        <Entrada rotulo="" valor={editando[c.chave]!}
                          aoMudar={(v) => setEditando({ ...editando, [c.chave]: v })} />
                      )
                      : <strong>{c.valor || <span className="fraco">(vazio)</span>}</strong>}
                  </td>
                  <td className="fraco">{c.descricao}</td>
                  <td>
                    {emEdicao
                      ? (
                        <div className="acoes-linha">
                          <button type="button"
                            className="botao botao--fantasma botao--pequeno"
                            onClick={() => setEditando((e) => {
                              const { [c.chave]: _, ...resto } = e; return resto;
                            })}>
                            Cancelar
                          </button>
                          <button type="button" className="botao botao--pequeno"
                            onClick={() => salvar(c.chave)}>
                            Salvar
                          </button>
                        </div>
                      )
                      : (
                        <button type="button"
                          className="botao botao--fantasma botao--pequeno"
                          onClick={() => setEditando({ ...editando, [c.chave]: c.valor })}>
                          Editar
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Cartao>
    </>
  );
}
