import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, dataHora, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras } from '../componentes/graficos';

type Aba = 'painel' | 'recebimentos' | 'divergencias' | 'qualidade' | 'quarentenas'
  | 'devolucoes' | 'validade' | 'parametros';

type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM_SEMAFORO: Record<string, Tom> = {
  VERMELHO: 'perigo', AMARELO: 'alerta', VERDE: 'acento', CINZA: 'neutro',
};

const TOM: Record<string, Tom> = {
  // Status de recebimento
  AGUARDANDO_CHEGADA: 'neutro', CHEGOU: 'info', EM_CONFERENCIA: 'info',
  AGUARDANDO_QUALIDADE: 'alerta', APROVADO: 'acento', APROVADO_PARCIALMENTE: 'alerta',
  REJEITADO: 'perigo', QUARENTENA: 'alerta', DEVOLVIDO: 'perigo', CANCELADO: 'neutro',
  CONCLUIDO: 'acento',
  // Validade
  ADEQUADA: 'acento', PROXIMA: 'alerta', CRITICA: 'perigo', INSUFICIENTE: 'perigo',
  VENCIDO: 'perigo', SEM_CONTROLE: 'neutro',
  // Destino
  DISPONIVEL: 'acento', BLOQUEADO: 'perigo', AREA_RECEBIMENTO: 'alerta', RECUSADO: 'perigo',
  // Severidade / decisao / NC
  ALTA: 'perigo', MEDIA: 'alerta', BAIXA: 'info',
  PENDENTE: 'alerta', ACEITAR: 'acento', ACEITAR_PARCIAL: 'alerta', DEVOLVER: 'perigo',
  RECUSAR: 'perigo', AUTORIZAR_COMERCIAL: 'info',
  ABERTA: 'alerta', EM_ANALISE: 'info', ACAO_DEFINIDA: 'info',
  AGUARDANDO_FORNECEDOR: 'alerta', EM_TRATATIVA: 'info', RESOLVIDA: 'acento',
  VALIDADA: 'acento', ENCERRADA: 'neutro', CANCELADA: 'neutro',
  LIBERADA: 'acento', DEVOLVIDA: 'perigo',
  RASCUNHO: 'neutro', AUTORIZADA: 'info', EM_TRANSITO: 'info',
  // Item
  ACEITO: 'acento', ACEITO_PARCIAL: 'alerta', EM_QUARENTENA: 'alerta',
  // Resultado de inspecao
  APROVADO_COM_RESSALVA: 'alerta', REPROVADO: 'perigo',
};

const num = (v: unknown) => Number(v ?? 0);
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)}%`);
const qtd = (v: unknown) => numero(v, 3);
const rotulo = (v: unknown) => String(v ?? '—').replace(/_/g, ' ');

/** Semaforo da secao 52 em forma de etiqueta. */
function Sinal({ cor, texto }: { cor?: string; texto?: string }) {
  if (!cor) return <span className="fraco">—</span>;
  return <Etiqueta texto={texto ?? rotulo(cor)} tom={TOM_SEMAFORO[cor] ?? 'neutro'} />;
}

function Estado({ valor }: { valor?: string | null }) {
  if (!valor) return <span className="fraco">—</span>;
  return <Etiqueta texto={rotulo(valor)} tom={TOM[valor] ?? 'neutro'} />;
}

export function Recebimento() {
  const [aba, setAba] = useState<Aba>('painel');
  const [conferindo, setConferindo] = useState<number | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Recebimento e qualidade"
        descricao="Conferencia da carga, lote e validade, inspecao, divergencias, quarentena e entrada no estoque."
      />

      <nav className="abas">
        {([
          { id: 'painel' as Aba, texto: 'Painel' },
          { id: 'recebimentos' as Aba, texto: 'Recebimentos' },
          { id: 'divergencias' as Aba, texto: 'Divergencias' },
          { id: 'qualidade' as Aba, texto: 'Nao conformidades' },
          { id: 'quarentenas' as Aba, texto: 'Quarentenas' },
          { id: 'devolucoes' as Aba, texto: 'Devolucoes' },
          { id: 'validade' as Aba, texto: 'Validade (FEFO)' },
          { id: 'parametros' as Aba, texto: 'Parametros' },
        ]).map((a) => (
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

      {aba === 'painel' && <Painel aoConferir={setConferindo} />}
      {aba === 'recebimentos' && <ListaRecebimentos aoConferir={setConferindo} />}
      {aba === 'divergencias' && <Divergencias />}
      {aba === 'qualidade' && <NaoConformidades />}
      {aba === 'quarentenas' && <Quarentenas />}
      {aba === 'devolucoes' && <Devolucoes />}
      {aba === 'validade' && <ControleValidade />}
      {aba === 'parametros' && <Parametros />}

      {conferindo !== null && (
        <TelaConferencia recebimentoId={conferindo} aoFechar={() => setConferindo(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Painel (secao 44)
// ---------------------------------------------------------------------------

function Painel({ aoConferir }: { aoConferir: (id: number) => void }) {
  const [dados, setDados] = useState<any>(null);
  const [taxas, setTaxas] = useState<any>(null);
  const [alertas, setAlertas] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [d, t, a] = await Promise.all([
          api<any>('/recebimentos/dashboard', { query: { dias: 90 } }),
          api<any>('/recebimentos/indicadores', { query: { dias: 90 } }),
          api<any>('/recebimentos/alertas'),
        ]);
        setDados(d.data);
        setTaxas(t.data);
        setAlertas(a.data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o painel');
      }
    })();
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando o painel...</Vazio>;

  const i = dados.indicadores ?? {};
  const t = taxas ?? {};

  return (
    <>
      <div className="grade-indicadores">
        <Indicador rotulo="Previstos hoje" valor={numero(i.previstos_hoje)}
          nota={`${numero(i.realizados_hoje)} já recebidos`} />
        <Indicador rotulo="Em conferencia" valor={numero(i.em_conferencia)}
          nota={`${numero(i.pendentes)} pendentes na fila`}
          tom={num(i.em_conferencia) > 0 ? 'info' : 'neutro'} />
        <Indicador rotulo="Aguardando qualidade" valor={numero(i.aguardando_qualidade)}
          tom={num(i.aguardando_qualidade) > 0 ? 'alerta' : 'neutro'} />
        <Indicador rotulo="Divergencias abertas" valor={numero(i.divergencias_abertas)}
          tom={num(i.divergencias_abertas) > 0 ? 'perigo' : 'acento'}
          nota="esperando decisao" />
        <Indicador rotulo="NC abertas" valor={numero(i.nao_conformidades_abertas)}
          tom={num(i.nao_conformidades_abertas) > 0 ? 'alerta' : 'acento'} />
        <Indicador rotulo="Em quarentena" valor={numero(i.em_quarentena)}
          nota={`${qtd(i.quantidade_em_quarentena)} retidos`}
          tom={num(i.em_quarentena) > 0 ? 'alerta' : 'neutro'} />
        <Indicador rotulo="Validade critica" valor={numero(i.validade_critica)}
          tom={num(i.validade_critica) > 0 ? 'perigo' : 'acento'}
          nota="itens na doca" />
        <Indicador rotulo="Lote irregular" valor={numero(i.lote_irregular)}
          tom={num(i.lote_irregular) > 0 ? 'perigo' : 'acento'}
          nota="sem lote informado" />
        <Indicador rotulo="Taxa de aprovacao" valor={pct(t.taxaAprovacao)} tom="acento"
          nota="ultimos 90 dias" />
        <Indicador rotulo="Taxa de divergencia" valor={pct(t.taxaDivergencia)}
          tom={num(t.taxaDivergencia) > 20 ? 'alerta' : 'neutro'}
          nota="ultimos 90 dias" />
        <Indicador rotulo="Tempo de conferencia"
          valor={t.tempoMedioConferenciaHoras === null || t.tempoMedioConferenciaHoras === undefined
            ? '—' : `${numero(t.tempoMedioConferenciaHoras, 1)} h`}
          nota="media do periodo" />
        <Indicador rotulo="Valor recebido" valor={moeda(i.valor_recebido)}
          nota={`${qtd(i.quantidade_recebida)} unidades`} />
      </div>

      {alertas && num(alertas.total) > 0 && (
        <Cartao titulo={`Alertas (${numero(alertas.total)})`}>
          <table className="tabela">
            <thead>
              <tr><th>Severidade</th><th>Tipo</th><th>Mensagem</th><th /></tr>
            </thead>
            <tbody>
              {(alertas.alertas ?? []).slice(0, 12).map((a: any, idx: number) => (
                <tr key={idx}>
                  <td><Estado valor={a.severidade} /></td>
                  <td>{rotulo(a.tipo)}</td>
                  <td>{a.mensagem}</td>
                  <td className="num">
                    {a.recebimento_id && (
                      <button type="button" className="botao botao--pequeno"
                        onClick={() => aoConferir(Number(a.recebimento_id))}>
                        Abrir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}

      {Array.isArray(dados.por_status) && dados.por_status.length > 0 && (
        <Cartao titulo="Recebimentos por status">
          <GraficoBarras
            dados={dados.por_status.map((s: any) => ({
              rotulo: rotulo(s.status), valor: num(s.quantidade),
            }))}
          />
        </Cartao>
      )}

      {dados.divergencias && (
        <Cartao titulo="Divergencias por natureza">
          <table className="tabela">
            <thead>
              <tr>
                <th>Natureza</th><th className="num">Total</th><th className="num">Abertas</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Quantidade</td>
                <td className="num">{numero(dados.divergencias.quantidade)}</td>
                <td className="num" />
              </tr>
              <tr>
                <td>Validade</td>
                <td className="num">{numero(dados.divergencias.validade)}</td>
                <td className="num" />
              </tr>
              <tr>
                <td>Lote</td>
                <td className="num">{numero(dados.divergencias.lote)}</td>
                <td className="num" />
              </tr>
              <tr >
                <td><strong>Total</strong></td>
                <td className="num"><strong>{numero(dados.divergencias.total)}</strong></td>
                <td className="num">
                  <strong>{numero(dados.divergencias.abertas)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Lista de recebimentos
// ---------------------------------------------------------------------------

function ListaRecebimentos({ aoConferir }: { aoConferir: (id: number) => void }) {
  const [pagina, setPagina] = useState(1);
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [pendentes, setPendentes] = useState(false);
  const [divergentes, setDivergentes] = useState(false);

  const { itens, meta, carregando, erro } = useLista<any>('/recebimentos', {
    pagina, limite: 25, status: status || undefined, busca: busca || undefined,
    apenas_pendentes: pendentes || undefined, apenas_divergentes: divergentes || undefined,
  });

  return (
    <Cartao
      titulo="Recebimentos"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca}
            aoMudar={(v) => { setBusca(v); setPagina(1); }}
            placeholder="numero, NF, fornecedor" />
          <Selecao rotulo="Status" valor={status}
            aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={[
              'AGUARDANDO_CHEGADA', 'CHEGOU', 'EM_CONFERENCIA', 'AGUARDANDO_QUALIDADE',
              'APROVADO', 'APROVADO_PARCIALMENTE', 'REJEITADO', 'QUARENTENA', 'DEVOLVIDO',
            ].map((s) => ({ valor: s, texto: rotulo(s) }))} />
          <label className="checkbox">
            <input type="checkbox" checked={pendentes}
              onChange={(e) => { setPendentes(e.target.checked); setPagina(1); }} />
            Só pendentes
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={divergentes}
              onChange={(e) => { setDivergentes(e.target.checked); setPagina(1); }} />
            Com divergencia
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando...</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhum recebimento encontrado.</Vazio>}

      {!!itens.length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Recebimento</th><th>Pedido</th><th>Fornecedor</th><th>NF</th>
              <th>Data</th><th>Status</th><th className="num">Itens</th>
              <th className="num">Divergencias</th><th />
            </tr>
          </thead>
          <tbody>
            {itens.map((r) => (
              <tr key={r.id}>
                <td>{r.numero}</td>
                <td>{r.pedido ?? '—'}</td>
                <td>{r.fornecedor}</td>
                <td>{r.numero_nota_fiscal ?? '—'}</td>
                <td>{fmtData(r.data_recebimento)}</td>
                <td><Estado valor={r.status} /></td>
                <td className="num">{numero(r.itens_conferidos)}/{numero(r.itens)}</td>
                <td className="num">
                  {num(r.divergencias_pendentes) > 0
                    ? <Etiqueta texto={`${numero(r.divergencias_pendentes)} pendente(s)`} tom="perigo" />
                    : numero(r.divergencias)}
                </td>
                <td className="num">
                  <button type="button" className="botao botao--pequeno"
                    onClick={() => aoConferir(Number(r.id))}>
                    Conferir
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Tela de conferencia (secao 51)
// ---------------------------------------------------------------------------

function TelaConferencia({ recebimentoId, aoFechar }: {
  recebimentoId: number; aoFechar: () => void;
}) {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [validacao, setValidacao] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [rascunho, setRascunho] = useState<Record<number, any>>({});

  const podeRegistrar = pode('recebimento.registrar');
  const podeAprovar = pode('recebimento.aprovar');
  const podeInspecionar = pode('qualidade.inspecionar');

  const carregar = async () => {
    setErro(null);
    try {
      const [d, v] = await Promise.all([
        api<any>(`/recebimentos/${recebimentoId}`),
        api<any>(`/recebimentos/${recebimentoId}/validar`),
      ]);
      setDados(d.data);
      setValidacao(v.data);
      setRascunho({});
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o recebimento');
    }
  };

  useEffect(() => { void carregar(); }, [recebimentoId]);

  const editar = (itemId: number, campo: string, valor: string) =>
    setRascunho((r) => ({ ...r, [itemId]: { ...(r[itemId] ?? {}), [campo]: valor } }));

  const acao = async (caminho: string, corpo: unknown, mensagem: string) => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await api(caminho, { metodo: 'POST', corpo });
      setAviso(mensagem);
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel concluir a operacao');
    } finally {
      setSalvando(false);
    }
  };

  const gravarConferencia = async () => {
    const itens = Object.entries(rascunho)
      .filter(([, v]) => v.quantidade_recebida !== undefined && v.quantidade_recebida !== '')
      .map(([id, v]) => ({
        recebimento_item_id: Number(id),
        quantidade_recebida: Number(v.quantidade_recebida),
        numero_lote: v.numero_lote || undefined,
        data_fabricacao: v.data_fabricacao || undefined,
        data_validade: v.data_validade || undefined,
        localizacao: v.localizacao || undefined,
        observacao: v.observacao || undefined,
      }));
    if (!itens.length) {
      setErro('Informe a quantidade conferida de pelo menos um item');
      return;
    }
    await acao(`/recebimentos/${recebimentoId}/conferencia`, { itens },
      `${itens.length} item(ns) conferido(s)`);
  };

  if (!dados) {
    return (
      <Modal titulo="Conferencia" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  const r = dados.recebimento ?? dados;
  const itens: any[] = dados.itens ?? [];
  const resumo = dados.resumo ?? {};
  const encerrado = ['APROVADO', 'APROVADO_PARCIALMENTE', 'REJEITADO', 'DEVOLVIDO',
    'CANCELADO', 'CONCLUIDO'].includes(r.status);

  return (
    <Modal
      titulo={`Conferencia ${r.numero}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {podeRegistrar && !encerrado && (
            <>
              <button type="button" className="botao botao--pequeno" disabled={salvando}
                onClick={() => void gravarConferencia()}>
                Gravar conferencia
              </button>
              <button type="button" className="botao botao--pequeno" disabled={salvando}
                onClick={() => void acao(`/recebimentos/${recebimentoId}/conferencia/concluir`, {},
                  'Conferencia concluida')}>
                Concluir conferencia
              </button>
            </>
          )}
          {podeAprovar && !encerrado && (
            <button type="button" className="botao botao--pequeno botao--primario"
              disabled={salvando || !validacao?.pode_aprovar}
              title={validacao?.pode_aprovar ? undefined
                : 'Resolva os bloqueios antes de aprovar'}
              onClick={() => void acao(`/recebimentos/${recebimentoId}/aprovar`,
                { justificativa: 'Aprovado na tela de conferencia' },
                'Recebimento aprovado e estoque atualizado')}>
              Aprovar e dar entrada
            </button>
          )}
          <button type="button" className="botao botao--pequeno" onClick={aoFechar}>
            Fechar
          </button>
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      {/* Cabecalho da secao 51: pedido, fornecedor, NF, data, status */}
      <dl className="descricao">
        <dt>Pedido</dt><dd>{r.pedido ?? '—'}</dd>
        <dt>Fornecedor</dt><dd>{r.fornecedor}</dd>
        <dt>Nota fiscal</dt><dd>{r.numero_nota_fiscal ?? '—'}</dd>
        <dt>Data</dt><dd>{fmtData(r.data_recebimento)}</dd>
        <dt>Status</dt><dd><Estado valor={r.status} /></dd>
        <dt>Semaforo</dt><dd><Sinal cor={dados.semaforo} /></dd>
        <dt>Local</dt><dd>{r.local ?? '—'}</dd>
        <dt>Chegada</dt><dd>{dataHora(r.data_chegada)}</dd>
        <dt>Valor da NF</dt><dd>{moeda(r.valor_nota)}</dd>
        <dt>Conferidos</dt>
        <dd>{numero(resumo.conferidos)} de {numero(resumo.itens)}</dd>
      </dl>

      {r.status === 'AGUARDANDO_CHEGADA' && podeRegistrar && (
        <Cartao titulo="Chegada">
          <p className="explicacao">
            Registre a chegada da carga antes de comecar a conferencia.
          </p>
          <button type="button" className="botao botao--pequeno" disabled={salvando}
            onClick={() => void acao(`/recebimentos/${recebimentoId}/chegada`, {},
              'Chegada registrada')}>
            Registrar chegada
          </button>
        </Cartao>
      )}

      {/* Bloqueios e avisos em portugues (secao 57) */}
      {validacao && (!!validacao.bloqueios?.length || !!validacao.avisos?.length) && (
        <Cartao titulo="O que falta para aprovar">
          <ul className="lista-alertas">
            {(validacao.bloqueios ?? []).map((x: any, i: number) => (
              <li key={`b${i}`}>
                <Etiqueta texto="Bloqueio" tom="perigo" /> {x.mensagem}
              </li>
            ))}
            {(validacao.avisos ?? []).map((x: any, i: number) => (
              <li key={`a${i}`}>
                <Etiqueta texto={x.exige_excecao ? 'Exige excecao' : 'Atencao'}
                  tom={x.exige_excecao ? 'alerta' : 'info'} /> {x.mensagem}
              </li>
            ))}
          </ul>
        </Cartao>
      )}

      {/* Grade da secao 51: esperado versus recebido, lado a lado */}
      <Cartao titulo="Itens">
        <table className="tabela">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="num">Pedido</th>
              <th className="num">Recebido</th>
              <th className="num">Diferenca</th>
              <th>Lote</th>
              <th>Validade</th>
              <th>Qualidade</th>
              <th>Destino</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((i) => {
              const edit = rascunho[i.id] ?? {};
              const editavel = podeRegistrar && !encerrado;
              const recebida = edit.quantidade_recebida ?? i.quantidade_recebida ?? '';
              const diferenca = num(recebida) - num(i.quantidade_pedida);
              return (
                <tr key={i.id}>
                  <td>
                    <strong>{i.codigo}</strong>
                    <div className="fraco">{i.descricao}</div>
                  </td>
                  <td className="num">{qtd(i.quantidade_pedida)}</td>
                  <td className="num">
                    {editavel ? (
                      <input
                        className="campo__entrada"
                        type="number" min={0} step="0.001"
                        value={recebida}
                        onChange={(e) => editar(i.id, 'quantidade_recebida', e.target.value)}
                      />
                    ) : qtd(i.quantidade_recebida)}
                  </td>
                  <td className="num">
                    <span className={diferenca === 0 ? '' : 'texto-alerta'}>
                      {diferenca > 0 ? '+' : ''}{qtd(diferenca)}
                    </span>
                    <div><Sinal cor={i.semaforo?.quantidade} /></div>
                  </td>
                  <td>
                    {editavel && i.controla_lote ? (
                      <input className="campo__entrada" type="text"
                        value={edit.numero_lote ?? i.numero_lote ?? ''}
                        placeholder="obrigatorio"
                        onChange={(e) => editar(i.id, 'numero_lote', e.target.value)} />
                    ) : (i.numero_lote ?? (i.controla_lote ? '—' : 'nao controla'))}
                    <div><Sinal cor={i.semaforo?.lote} /></div>
                  </td>
                  <td>
                    {editavel && i.controla_validade ? (
                      <input className="campo__entrada" type="date"
                        value={edit.data_validade ?? i.data_validade ?? ''}
                        onChange={(e) => editar(i.id, 'data_validade', e.target.value)} />
                    ) : fmtData(i.data_validade)}
                    <div>
                      <Estado valor={i.situacao_validade} />
                      {i.vida_util_restante_percentual !== null
                        && i.vida_util_restante_percentual !== undefined && (
                        <span className="fraco"> {pct(i.vida_util_restante_percentual)}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <Estado valor={i.resultado_qualidade} />
                    <div><Sinal cor={i.semaforo?.qualidade} /></div>
                  </td>
                  <td><Estado valor={i.destino} /></td>
                  <td>
                    <Estado valor={i.status} />
                    <div><Sinal cor={i.semaforo?.geral} /></div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {podeRegistrar && !encerrado && (
          <p className="explicacao">
            Preencha a quantidade contada. Produto com controle de lote ou validade exige
            o lote e a data: sem eles a aprovacao fica bloqueada.
          </p>
        )}
      </Cartao>

      {!!(dados.divergencias ?? []).length && (
        <Cartao titulo={`Divergencias (${dados.divergencias.length})`}>
          <table className="tabela">
            <thead>
              <tr><th>Tipo</th><th>Severidade</th><th>Descricao</th><th>Decisao</th><th /></tr>
            </thead>
            <tbody>
              {dados.divergencias.map((d: any) => (
                <tr key={d.id}>
                  <td>{rotulo(d.tipo)}</td>
                  <td><Estado valor={d.severidade} /></td>
                  <td>
                    {d.descricao}
                    {d.valor_esperado && (
                      <div className="fraco">
                        esperado {d.valor_esperado} · recebido {d.valor_recebido}
                      </div>
                    )}
                  </td>
                  <td><Estado valor={d.decisao} /></td>
                  <td className="num">
                    {podeAprovar && d.decisao === 'PENDENTE' && (
                      <DecidirDivergencia divergenciaId={d.id} aoDecidir={carregar} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}

      {!!(dados.inspecoes ?? []).length && (
        <Cartao titulo="Inspecoes de qualidade">
          <table className="tabela">
            <thead>
              <tr>
                <th>Data</th><th>Produto</th><th>Resultado</th>
                <th className="num">Amostra</th><th>Restricao</th>
              </tr>
            </thead>
            <tbody>
              {dados.inspecoes.map((x: any) => (
                <tr key={x.id}>
                  <td>{dataHora(x.data_inspecao)}</td>
                  <td>{x.produto ?? x.codigo ?? '—'}</td>
                  <td><Estado valor={x.resultado} /></td>
                  <td className="num">{qtd(x.quantidade_amostrada)}</td>
                  <td>{x.restricao ?? x.observacoes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}

      {podeInspecionar && !encerrado && (
        <p className="explicacao">
          A inspecao de qualidade e registrada pela aba Nao conformidades ou pelo
          endpoint de inspecao do recebimento.
        </p>
      )}
    </Modal>
  );
}

function DecidirDivergencia({ divergenciaId, aoDecidir }: {
  divergenciaId: number; aoDecidir: () => Promise<void> | void;
}) {
  const [aberto, setAberto] = useState(false);
  const [decisao, setDecisao] = useState('ACEITAR');
  const [justificativa, setJustificativa] = useState('');
  const [abrirNc, setAbrirNc] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const enviar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      await api(`/divergencias/${divergenciaId}/decidir`, {
        metodo: 'POST',
        corpo: { decisao, justificativa, abrir_nao_conformidade: abrirNc },
      });
      setAberto(false);
      await aoDecidir();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel decidir');
    } finally {
      setSalvando(false);
    }
  };

  if (!aberto) {
    return (
      <button type="button" className="botao botao--pequeno" onClick={() => setAberto(true)}>
        Decidir
      </button>
    );
  }

  return (
    <Modal titulo="Decidir divergencia" aoFechar={() => setAberto(false)} rodape={(
      <>
        <button type="button" className="botao botao--pequeno botao--primario"
          disabled={salvando || justificativa.trim().length < 5}
          onClick={() => void enviar()}>
          Gravar decisao
        </button>
        <button type="button" className="botao botao--pequeno" onClick={() => setAberto(false)}>
          Cancelar
        </button>
      </>
    )}>
      {erro && <Aviso>{erro}</Aviso>}
      <Selecao rotulo="Decisao" valor={decisao} aoMudar={setDecisao} vazio=""
        opcoes={['ACEITAR', 'ACEITAR_PARCIAL', 'DEVOLVER', 'RECUSAR', 'AUTORIZAR_COMERCIAL']
          .map((d) => ({ valor: d, texto: rotulo(d) }))} />
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa}
        placeholder="por que esta decisao (fica no historico)" />
      <label className="checkbox">
        <input type="checkbox" checked={abrirNc} onChange={(e) => setAbrirNc(e.target.checked)} />
        Abrir nao conformidade para o fornecedor
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Divergencias
// ---------------------------------------------------------------------------

function Divergencias() {
  const [pagina, setPagina] = useState(1);
  const [pendentes, setPendentes] = useState(true);
  const [severidade, setSeveridade] = useState('');
  const { itens, meta, carregando, erro, recarregar } = useLista<any>('/divergencias', {
    pagina, limite: 25, apenas_pendentes: pendentes || undefined,
    severidade: severidade || undefined,
  });
  const { pode } = useAuth();

  return (
    <Cartao
      titulo="Divergencias"
      acoes={(
        <div className="filtros">
          <Selecao rotulo="Severidade" valor={severidade}
            aoMudar={(v) => { setSeveridade(v); setPagina(1); }}
            opcoes={['CRITICA', 'ALTA', 'MEDIA', 'BAIXA']
              .map((s) => ({ valor: s, texto: rotulo(s) }))} />
          <label className="checkbox">
            <input type="checkbox" checked={pendentes}
              onChange={(e) => { setPendentes(e.target.checked); setPagina(1); }} />
            Só pendentes
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando...</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhuma divergencia.</Vazio>}

      {!!itens.length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Detectada</th><th>Recebimento</th><th>Fornecedor</th><th>Produto</th>
              <th>Tipo</th><th>Severidade</th><th>Decisao</th><th />
            </tr>
          </thead>
          <tbody>
            {itens.map((d) => (
              <tr key={d.id}>
                <td>{dataHora(d.detectada_em)}</td>
                <td>{d.recebimento}</td>
                <td>{d.fornecedor}</td>
                <td>{d.produto ?? '—'}</td>
                <td>{rotulo(d.tipo)}</td>
                <td><Estado valor={d.severidade} /></td>
                <td><Estado valor={d.decisao} /></td>
                <td className="num">
                  {pode('recebimento.aprovar') && d.decisao === 'PENDENTE' && (
                    <DecidirDivergencia divergenciaId={d.id} aoDecidir={recarregar} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Nao conformidades
// ---------------------------------------------------------------------------

function NaoConformidades() {
  const [pagina, setPagina] = useState(1);
  const [abertas, setAbertas] = useState(true);
  const [painel, setPainel] = useState<any>(null);
  const { itens, meta, carregando, erro } = useLista<any>('/nao-conformidades', {
    pagina, limite: 25, apenas_abertas: abertas || undefined,
  });

  useEffect(() => {
    void api<any>('/nao-conformidades/dashboard', { query: { dias: 90 } })
      .then((r) => setPainel(r.data))
      .catch(() => setPainel(null));
  }, []);

  return (
    <>
      {painel && (
        <>
          <div className="grade-indicadores">
            <Indicador rotulo="NC no periodo"
              valor={numero(painel.nao_conformidades?.total ?? 0)} />
            <Indicador rotulo="Aprovados sem ressalva"
              valor={pct(painel.percentuais?.aprovados_sem_ressalva)} tom="acento" />
            <Indicador rotulo="Rejeitados" valor={pct(painel.percentuais?.rejeitados)}
              tom={num(painel.percentuais?.rejeitados) > 0 ? 'perigo' : 'acento'} />
            <Indicador rotulo="Em quarentena" valor={pct(painel.percentuais?.em_quarentena)}
              tom={num(painel.percentuais?.em_quarentena) > 0 ? 'alerta' : 'acento'} />
            <Indicador rotulo="Quantidade recusada"
              valor={qtd(painel.quantidade_recusada)} nota="no periodo" />
            <Indicador rotulo="Resolucao de NC"
              valor={painel.nao_conformidades?.tempo_medio_resolucao_dias === null
                || painel.nao_conformidades?.tempo_medio_resolucao_dias === undefined
                ? '—'
                : `${numero(painel.nao_conformidades.tempo_medio_resolucao_dias, 1)} d`}
              nota="tempo medio" />
          </div>

          {!!(painel.nao_conformidades?.por_fornecedor ?? []).length && (
            <Cartao titulo="Nao conformidades por fornecedor">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Fornecedor</th><th className="num">NC</th><th className="num">Criticas</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.nao_conformidades.por_fornecedor.map((l: any) => (
                    <tr key={l.fornecedor_id}>
                      <td>{l.fornecedor}</td>
                      <td className="num">{numero(l.total)}</td>
                      <td className="num">
                        {num(l.criticas) > 0
                          ? <Etiqueta texto={numero(l.criticas)} tom="perigo" />
                          : '0'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Cartao>
          )}
        </>
      )}

      <Cartao
        titulo="Nao conformidades"
        acoes={(
          <label className="checkbox">
            <input type="checkbox" checked={abertas}
              onChange={(e) => { setAbertas(e.target.checked); setPagina(1); }} />
            Só abertas
          </label>
        )}
      >
        {erro && <Aviso>{erro}</Aviso>}
        {carregando && <Vazio>Carregando...</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhuma nao conformidade.</Vazio>}

        {!!itens.length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>NC</th><th>Aberta</th><th>Fornecedor</th><th>Produto</th>
                <th>Tipo</th><th>Severidade</th><th>Status</th><th>Prazo</th>
                <th className="num">Acoes abertas</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((n) => (
                <tr key={n.id}>
                  <td>{n.numero}</td>
                  <td>{fmtData(n.created_at)}</td>
                  <td>{n.fornecedor ?? '—'}</td>
                  <td>{n.produto ?? '—'}</td>
                  <td>{rotulo(n.tipo)}</td>
                  <td><Estado valor={n.severidade} /></td>
                  <td><Estado valor={n.status} /></td>
                  <td>{fmtData(n.prazo)}</td>
                  <td className="num">{numero(n.acoes_abertas ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------
// Quarentenas
// ---------------------------------------------------------------------------

function Quarentenas() {
  const [pagina, setPagina] = useState(1);
  const [status, setStatus] = useState('ABERTA');
  const { itens, meta, carregando, erro } = useLista<any>('/quarentenas', {
    pagina, limite: 25, status: status || undefined,
  });

  return (
    <Cartao
      titulo="Quarentenas"
      acoes={(
        <Selecao rotulo="Status" valor={status}
          aoMudar={(v) => { setStatus(v); setPagina(1); }}
          opcoes={['ABERTA', 'LIBERADA', 'REJEITADA', 'DEVOLVIDA']
            .map((s) => ({ valor: s, texto: rotulo(s) }))} />
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando...</Vazio>}
      {!carregando && !itens.length && <Vazio>Nada em quarentena.</Vazio>}

      {!!itens.length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Quarentena</th><th>Aberta</th><th>Produto</th><th>Lote</th>
              <th className="num">Quantidade</th><th className="num">Liberada</th>
              <th>Motivo</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((q) => (
              <tr key={q.id}>
                <td>{q.numero}</td>
                <td>{dataHora(q.aberta_em)}</td>
                <td>{q.produto ?? '—'}</td>
                <td>{q.lote ?? '—'}</td>
                <td className="num">{qtd(q.quantidade)}</td>
                <td className="num">{qtd(q.quantidade_liberada)}</td>
                <td>{q.motivo}</td>
                <td><Estado valor={q.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Devolucoes
// ---------------------------------------------------------------------------

function Devolucoes() {
  const [pagina, setPagina] = useState(1);
  const { itens, meta, carregando, erro } = useLista<any>('/devolucoes', {
    pagina, limite: 25,
  });

  return (
    <Cartao titulo="Devolucoes ao fornecedor">
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando...</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhuma devolucao registrada.</Vazio>}

      {!!itens.length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Devolucao</th><th>Criada</th><th>Fornecedor</th><th>Motivo</th>
              <th className="num">Itens</th><th className="num">Quantidade</th>
              <th className="num">Valor</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((d) => (
              <tr key={d.id}>
                <td>{d.numero}</td>
                <td>{fmtData(d.created_at)}</td>
                <td>{d.fornecedor}</td>
                <td>{rotulo(d.motivo)}</td>
                <td className="num">{numero(d.itens ?? 0)}</td>
                <td className="num">{qtd(d.quantidade_total)}</td>
                <td className="num">{moeda(d.valor_total)}</td>
                <td><Estado valor={d.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Controle de validade (FEFO)
// ---------------------------------------------------------------------------

function ControleValidade() {
  const [dias, setDias] = useState('180');
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void api<any>('/recebimentos/controle-validade', { query: { dias: Number(dias) || 180 } })
      .then((r) => { setDados(r.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
  }, [dias]);

  return (
    <Cartao
      titulo="Lotes por validade (FEFO)"
      acoes={(
        <Selecao rotulo="Janela" valor={dias} aoMudar={setDias} vazio=""
          opcoes={[
            { valor: '30', texto: '30 dias' }, { valor: '90', texto: '90 dias' },
            { valor: '180', texto: '180 dias' }, { valor: '365', texto: '1 ano' },
          ]} />
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Carregando...</Vazio>}

      {dados && (
        <>
          <div className="grade-indicadores">
            <Indicador rotulo="Lotes na janela" valor={numero(dados.total ?? 0)}
              nota={dados.regra} />
            <Indicador rotulo="Vencidos"
              valor={numero((dados.lotes ?? [])
                .filter((l: any) => l.situacao === 'VENCIDO').length)}
              tom="perigo" />
            <Indicador rotulo="Criticos (ate 15 dias)"
              valor={numero((dados.lotes ?? [])
                .filter((l: any) => l.situacao === 'CRITICA').length)}
              tom="alerta" />
            <Indicador rotulo="Proximos (ate 30 dias)"
              valor={numero((dados.lotes ?? [])
                .filter((l: any) => l.situacao === 'PROXIMA').length)}
              tom="info" />
          </div>

          {!(dados.lotes ?? []).length && <Vazio>Nenhum lote nessa janela.</Vazio>}

          {!!(dados.lotes ?? []).length && (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Produto</th><th>Lote</th><th>Validade</th>
                  <th className="num">Dias</th><th className="num">Saldo</th>
                  <th>Local</th><th>Situacao</th>
                </tr>
              </thead>
              <tbody>
                {dados.lotes.map((l: any) => (
                  <tr key={l.id}>
                    <td>{l.produto ?? l.codigo}</td>
                    <td>{l.numero_lote}</td>
                    <td>{fmtData(l.data_validade)}</td>
                    <td className="num">{numero(l.dias_restantes)}</td>
                    <td className="num">{qtd(l.quantidade_atual)}</td>
                    <td>{l.local ?? '—'}</td>
                    <td><Estado valor={l.situacao} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Parametros (secao 13 e 56)
// ---------------------------------------------------------------------------

function Parametros() {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [edicao, setEdicao] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const podeParametrizar = pode('recebimento.parametrizar');

  const carregar = async () => {
    try {
      const r = await api<any>('/recebimentos/parametros');
      setDados(r.data);
      setEdicao({});
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar os parametros');
    }
  };

  useEffect(() => { void carregar(); }, []);

  const salvar = async () => {
    const parametros = Object.entries(edicao)
      .filter(([, v]) => v !== '')
      .map(([chave, valor]) => ({ chave, valor }));
    if (!parametros.length) return;
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await api('/recebimentos/parametros', { metodo: 'PUT', corpo: { parametros } });
      setAviso(`${parametros.length} parametro(s) atualizado(s)`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel salvar');
    } finally {
      setSalvando(false);
    }
  };

  if (!dados) return <Vazio>Carregando...</Vazio>;

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <Cartao
        titulo="Configuracoes do recebimento"
        acoes={podeParametrizar ? (
          <button type="button" className="botao botao--pequeno botao--primario"
            disabled={salvando || !Object.keys(edicao).length}
            onClick={() => void salvar()}>
            Salvar alteracoes
          </button>
        ) : undefined}
      >
        <table className="tabela">
          <thead><tr><th>Parametro</th><th>Valor</th><th>Descricao</th></tr></thead>
          <tbody>
            {(dados.configuracoes ?? []).map((c: any) => (
              <tr key={c.chave}>
                <td><code>{c.chave}</code></td>
                <td>
                  {podeParametrizar ? (
                    <input className="campo__entrada" type="text"
                      value={edicao[c.chave] ?? c.valor}
                      onChange={(e) => setEdicao((x) => ({ ...x, [c.chave]: e.target.value }))} />
                  ) : c.valor}
                </td>
                <td className="fraco">{c.descricao ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Tolerancias por escopo">
        <p className="explicacao">
          A tolerancia vale do mais especifico para o mais geral: produto, fornecedor,
          categoria, operacao e, por fim, a linha da empresa.
        </p>
        {!(dados.tolerancias ?? []).length && <Vazio>Somente a tolerancia da empresa.</Vazio>}
        {!!(dados.tolerancias ?? []).length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>Escopo</th><th>Alvo</th><th className="num">Quantidade</th>
                <th className="num">Peso</th><th className="num">Valor</th>
                <th className="num">Validade (dias)</th>
              </tr>
            </thead>
            <tbody>
              {dados.tolerancias.map((t: any) => (
                <tr key={t.id}>
                  <td>{rotulo(t.escopo)}</td>
                  <td>{t.produto ?? t.fornecedor ?? t.categoria ?? t.tipo_operacao ?? 'todos'}</td>
                  <td className="num">{pct(t.quantidade_percentual)}</td>
                  <td className="num">{pct(t.peso_percentual)}</td>
                  <td className="num">{pct(t.valor_percentual)}</td>
                  <td className="num">{numero(t.validade_dias)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Cartao>

      <Cartao titulo="Checklists de qualidade">
        {!(dados.checklists ?? []).length && <Vazio>Nenhum checklist cadastrado.</Vazio>}
        {!!(dados.checklists ?? []).length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th><th>Nome</th><th>Amostragem</th>
                <th className="num">Criterios</th><th className="num">Eliminatorios</th>
              </tr>
            </thead>
            <tbody>
              {dados.checklists.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.codigo}</td>
                  <td>{c.nome}</td>
                  <td>
                    {rotulo(c.tipo_amostragem)}
                    {c.percentual_amostra ? ` (${pct(c.percentual_amostra)})` : ''}
                  </td>
                  <td className="num">{numero(c.criterios ?? 0)}</td>
                  <td className="num">{numero(c.eliminatorios ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Cartao>
    </>
  );
}
