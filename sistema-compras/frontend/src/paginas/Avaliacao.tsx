import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, dataHora, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras, GraficoLinha } from '../componentes/graficos';

type Aba = 'painel' | 'ranking' | 'avaliacoes' | 'comparativo' | 'planos'
  | 'riscos' | 'precos' | 'metodologia';

type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM: Record<string, Tom> = {
  // Homologacao
  HOMOLOGADO: 'acento', HOMOLOGADO_COM_RESTRICAO: 'alerta', EM_HOMOLOGACAO: 'info',
  EM_MONITORAMENTO: 'alerta', BLOQUEADO: 'perigo', INATIVO: 'neutro',
  // Completude e confiabilidade
  COMPLETA: 'acento', DADOS_PARCIAIS: 'alerta', DADOS_INSUFICIENTES: 'perigo',
  SEM_HISTORICO: 'neutro',
  ALTA: 'acento', MEDIA: 'alerta', BAIXA: 'perigo', INSUFICIENTE: 'neutro',
  // Avaliacao
  RASCUNHO: 'neutro', CALCULADA: 'info', VALIDADA: 'acento', CANCELADA: 'neutro',
  // Plano de acao
  ABERTO: 'alerta', EM_ANALISE: 'info', ACAO_DEFINIDA: 'info', EM_EXECUCAO: 'info',
  AGUARDANDO_FORNECEDOR: 'alerta', VALIDACAO: 'info', ENCERRADO: 'acento',
  // Severidade
  CRITICA: 'perigo',
  // Tendencia
  MELHORIA: 'acento', ESTAVEL: 'neutro', PIORA: 'perigo', SEM_DADOS: 'neutro',
  INFO: 'info',
};

const GRUPOS = [
  'LOGISTICA', 'QUALIDADE', 'COMERCIAL', 'ATENDIMENTO',
  'PRECO', 'PAGAMENTO', 'FLEXIBILIDADE',
] as const;

const num = (v: unknown) => Number(v ?? 0);
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)}%`);
const rotulo = (v: unknown) => String(v ?? '—').replace(/_/g, ' ');
const nota = (v: unknown) => (v === null || v === undefined ? '—' : numero(v, 1));

function Estado({ valor }: { valor?: string | null }) {
  if (!valor) return <span className="fraco">—</span>;
  return <Etiqueta texto={rotulo(valor)} tom={TOM[valor] ?? 'neutro'} />;
}

export function Avaliacao() {
  const [aba, setAba] = useState<Aba>('painel');
  const [fornecedorAberto, setFornecedorAberto] = useState<number | null>(null);
  const [planoAberto, setPlanoAberto] = useState<number | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Avaliacao de fornecedores"
        descricao="Scorecard sobre dados de compra, entrega, recebimento e qualidade, com plano de acao."
      />

      <nav className="abas">
        {([
          { id: 'painel' as Aba, texto: 'Painel' },
          { id: 'ranking' as Aba, texto: 'Ranking' },
          { id: 'avaliacoes' as Aba, texto: 'Avaliacoes' },
          { id: 'comparativo' as Aba, texto: 'Comparativo' },
          { id: 'planos' as Aba, texto: 'Planos de acao' },
          { id: 'riscos' as Aba, texto: 'Riscos' },
          { id: 'precos' as Aba, texto: 'Historico de precos' },
          { id: 'metodologia' as Aba, texto: 'Metodologia' },
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

      {aba === 'painel' && <Painel />}
      {aba === 'ranking' && <Ranking aoAbrir={setFornecedorAberto} />}
      {aba === 'avaliacoes' && <Avaliacoes aoAbrir={setFornecedorAberto} />}
      {aba === 'comparativo' && <Comparativo />}
      {aba === 'planos' && <Planos aoAbrir={setPlanoAberto} />}
      {aba === 'riscos' && <Riscos />}
      {aba === 'precos' && <HistoricoPrecos />}
      {aba === 'metodologia' && <Metodologias />}

      {fornecedorAberto !== null && (
        <Scorecard fornecedorId={fornecedorAberto} aoFechar={() => setFornecedorAberto(null)} />
      )}
      {planoAberto !== null && (
        <DetalhePlano planoId={planoAberto} aoFechar={() => setPlanoAberto(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Painel (secoes 5 e 69)
// ---------------------------------------------------------------------------

function Painel() {
  const [dados, setDados] = useState<any>(null);
  const [alertas, setAlertas] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [d, a] = await Promise.all([
          api<any>('/avaliacao/dashboard', { query: { dias: 180 } }),
          api<any>('/avaliacao/alertas'),
        ]);
        setDados(d.data);
        setAlertas(a.data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o painel');
      }
    })();
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando o painel...</Vazio>;

  const f = dados.fornecedores ?? {};
  const a = dados.avaliacoes ?? {};
  const l = dados.logistica ?? {};
  const q = dados.qualidade ?? {};
  const p = dados.planos_acao ?? {};
  const r = dados.riscos ?? {};

  return (
    <>
      <div className="grade-indicadores">
        <Indicador rotulo="Fornecedores ativos" valor={numero(f.ativos)}
          nota={`${numero(f.total)} cadastrados`} />
        <Indicador rotulo="Homologados" valor={numero(f.homologados)} tom="acento"
          nota={`${numero(f.homologados_com_restricao)} com restricao`} />
        <Indicador rotulo="Em monitoramento" valor={numero(f.em_monitoramento)}
          tom={num(f.em_monitoramento) > 0 ? 'alerta' : 'neutro'} />
        <Indicador rotulo="Bloqueados" valor={numero(f.bloqueados)}
          tom={num(f.bloqueados) > 0 ? 'perigo' : 'acento'} />
        <Indicador rotulo="Nunca avaliados" valor={numero(f.nunca_avaliados)}
          tom={num(f.nunca_avaliados) > 0 ? 'alerta' : 'acento'}
          nota="sem nenhuma avaliacao" />
        <Indicador rotulo="Aguardando validacao" valor={numero(a.aguardando_validacao)}
          nota={`${numero(a.total)} avaliacoes no periodo`} />
        <Indicador rotulo="OTIF medio" valor={pct(l.otif_medio)} tom="acento"
          nota={`${numero(l.amostras)} avaliacoes`} />
        <Indicador rotulo="OTD medio" valor={pct(l.otd_medio)} />
        <Indicador rotulo="In Full medio" valor={pct(l.in_full_medio)} />
        <Indicador rotulo="Taxa de nao conformidade" valor={pct(q.taxa_nao_conformidade)}
          tom={num(q.taxa_nao_conformidade) > 10 ? 'perigo' : 'acento'} />
        <Indicador rotulo="NCs criticas" valor={numero(q.ncs_criticas)}
          tom={num(q.ncs_criticas) > 0 ? 'perigo' : 'acento'} />
        <Indicador rotulo="Taxa de devolucao" valor={pct(q.taxa_devolucao)}
          tom={num(q.taxa_devolucao) > 5 ? 'alerta' : 'acento'} />
        <Indicador rotulo="Planos abertos" valor={numero(p.abertos)}
          nota={`${numero(p.atrasados)} atrasados`}
          tom={num(p.atrasados) > 0 ? 'perigo' : 'neutro'} />
        <Indicador rotulo="Produtos monoprovedor" valor={numero(r.produtos_monoprovedor)}
          nota={pct(r.percentual_monoprovedor)}
          tom={num(r.produtos_monoprovedor) > 0 ? 'alerta' : 'acento'} />
        <Indicador rotulo="Score medio" valor={nota(a.score_medio)}
          nota={`${numero(a.completas)} avaliacoes completas`} />
        <Indicador rotulo="Sem dados suficientes" valor={numero(a.sem_dados)}
          tom={num(a.sem_dados) > 0 ? 'alerta' : 'acento'}
          nota="avaliacoes sem score" />
      </div>

      {alertas && num(alertas.total) > 0 && (
        <Cartao titulo={`Alertas (${numero(alertas.total)})`}>
          <p className="explicacao">
            Limites configuraveis: OTIF minimo de {numero(alertas.limites?.otif_minimo)}%,
            NC maxima de {numero(alertas.limites?.nc_maximo)}%,
            variacao de preco de {numero(alertas.limites?.variacao_preco)}%.
          </p>
          <table className="tabela">
            <thead>
              <tr>
                <th>Severidade</th><th>Tipo</th><th>Fornecedor</th><th>Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {(alertas.alertas ?? []).slice(0, 15).map((x: any, i: number) => (
                <tr key={i}>
                  <td><Estado valor={x.severidade} /></td>
                  <td>{rotulo(x.tipo)}</td>
                  <td>{x.fornecedor ?? '—'}</td>
                  <td>{x.mensagem}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function Ranking({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [dias, setDias] = useState('180');

  useEffect(() => {
    void api<any>('/avaliacao/ranking', { query: { dias: Number(dias), limite: 50 } })
      .then((r) => { setDados(r.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
  }, [dias]);

  return (
    <Cartao
      titulo="Ranking de fornecedores"
      acoes={(
        <Selecao rotulo="Periodo" valor={dias} aoMudar={setDias} vazio=""
          opcoes={[
            { valor: '90', texto: '90 dias' }, { valor: '180', texto: '180 dias' },
            { valor: '365', texto: '1 ano' },
          ]} />
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Carregando...</Vazio>}

      {dados && (
        <>
          <p className="explicacao">{dados.regra}</p>
          {!(dados.fornecedores ?? []).length && <Vazio>Nenhuma avaliacao no periodo.</Vazio>}
          {!!(dados.fornecedores ?? []).length && (
            <table className="tabela">
              <thead>
                <tr>
                  <th>#</th><th>Fornecedor</th><th>Homologacao</th>
                  <th className="num">Score</th><th>Completude</th><th>Confiabilidade</th>
                  <th className="num">Eventos</th><th className="num">Comprado</th>
                  <th>Metodologia</th><th />
                </tr>
              </thead>
              <tbody>
                {dados.fornecedores.map((f: any, i: number) => (
                  <tr key={f.fornecedor_id}>
                    <td className="num">{f.amostra_suficiente ? i + 1 : '—'}</td>
                    <td>{f.fornecedor}</td>
                    <td><Estado valor={f.status_homologacao} /></td>
                    <td className="num"><strong>{nota(f.score_final)}</strong></td>
                    <td><Estado valor={f.completude} /></td>
                    <td><Estado valor={f.confiabilidade} /></td>
                    <td className="num">{numero(f.eventos_avaliados)}</td>
                    <td className="num">{moeda(f.valor_comprado)}</td>
                    <td className="fraco">{f.metodologia_versao ?? '—'}</td>
                    <td className="num">
                      <button type="button" className="botao botao--pequeno"
                        onClick={() => aoAbrir(Number(f.fornecedor_id))}>
                        Scorecard
                      </button>
                    </td>
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
// Scorecard: a tabela da secao 27
// ---------------------------------------------------------------------------

function Scorecard({ fornecedorId, aoFechar }: {
  fornecedorId: number; aoFechar: () => void;
}) {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [perfil, setPerfil] = useState<any>(null);
  const [evolucao, setEvolucao] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [dias, setDias] = useState('180');
  const [salvando, setSalvando] = useState(false);

  const carregar = async () => {
    setErro(null);
    try {
      const [s, p, e] = await Promise.all([
        api<any>(`/fornecedores/${fornecedorId}/scorecard`, { query: { dias: Number(dias) } }),
        api<any>(`/fornecedores/${fornecedorId}/perfil`, { query: { dias: Number(dias) } }),
        api<any>(`/fornecedores/${fornecedorId}/evolucao`),
      ]);
      setDados(s.data);
      setPerfil(p.data);
      setEvolucao(e.data);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o scorecard');
    }
  };

  useEffect(() => { void carregar(); }, [fornecedorId, dias]);

  const gravar = async () => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await api<any>(`/fornecedores/${fornecedorId}/avaliacoes`, {
        metodo: 'POST', corpo: { dias: Number(dias) },
      });
      setAviso(`Avaliacao ${r.data?.avaliacao?.numero} registrada`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel registrar');
    } finally {
      setSalvando(false);
    }
  };

  if (!dados) {
    return (
      <Modal titulo="Scorecard" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  const s = dados.score ?? {};
  const semScore = s.score === null || s.score === undefined;

  return (
    <Modal
      titulo={`Scorecard - ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {pode('fornecedores.avaliar') && (
            <button type="button" className="botao botao--pequeno botao--primario"
              disabled={salvando} onClick={() => void gravar()}>
              Registrar avaliacao
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

      <div className="filtros">
        <Selecao rotulo="Periodo" valor={dias} aoMudar={setDias} vazio=""
          opcoes={[
            { valor: '30', texto: '30 dias' }, { valor: '90', texto: '90 dias' },
            { valor: '180', texto: '180 dias' }, { valor: '365', texto: '1 ano' },
          ]} />
      </div>

      <dl className="descricao">
        <dt>Periodo</dt>
        <dd>{fmtData(dados.periodo?.inicio)} a {fmtData(dados.periodo?.fim)}</dd>
        <dt>Metodologia</dt>
        <dd>{dados.metodologia?.nome} (versao {dados.metodologia?.versao})</dd>
        <dt>Score</dt>
        <dd>
          {semScore
            ? <Etiqueta texto="SEM SCORE" tom="perigo" />
            : <strong className="num">{nota(s.score)}</strong>}
        </dd>
        <dt>Completude</dt><dd><Estado valor={s.completude} /></dd>
        <dt>Confiabilidade</dt><dd><Estado valor={s.confiabilidade} /></dd>
        <dt>Eventos</dt><dd>{numero(s.eventos)}</dd>
        <dt>Criterios calculados</dt>
        <dd>{numero(s.criteriosCalculados)} de {numero(s.criteriosTotais)}</dd>
        <dt>Volume comprado</dt>
        <dd>{moeda(dados.volume?.valor)} em {numero(dados.volume?.pedidos)} pedido(s)</dd>
        <dt>Homologacao</dt>
        <dd><Estado valor={perfil?.cadastro?.status_homologacao} /></dd>
      </dl>

      {s.motivo && <Aviso>{s.motivo}</Aviso>}

      {/* A tabela exigida pela secao 27: nunca so o total */}
      <Cartao titulo="Como o score foi formado">
        <table className="tabela">
          <thead>
            <tr>
              <th>Criterio</th><th className="num">Nota</th><th className="num">Peso</th>
              <th className="num">Contribuicao</th><th>Situacao</th>
            </tr>
          </thead>
          <tbody>
            {(dados.memoria ?? []).map((m: any) => (
              <tr key={m.grupo}>
                <td>{m.criterio}</td>
                <td className="num">{nota(m.nota)}</td>
                <td className="num">{numero(m.peso, 0)}%</td>
                <td className="num">{m.contribuicao === null ? '—' : numero(m.contribuicao, 2)}</td>
                <td>
                  {m.calculavel
                    ? <Etiqueta texto="Calculado" tom="acento" />
                    : <Etiqueta texto="Sem dados" tom="neutro" />}
                  {m.motivo && <div className="fraco">{m.motivo}</div>}
                </td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong></td>
              <td className="num" />
              <td className="num"><strong>{numero(s.pesoCalculado, 0)}%</strong></td>
              <td className="num"><strong>{nota(s.score)}</strong></td>
              <td className="fraco">{s.formula}</td>
            </tr>
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Indicadores">
        <p className="explicacao">
          Cada indicador traz o periodo, a quantidade de eventos, a formula e a fonte.
          Indicador sem amostra suficiente nao vira nota — fica identificado.
        </p>
        <table className="tabela">
          <thead>
            <tr>
              <th>Grupo</th><th>Indicador</th><th className="num">Valor</th>
              <th className="num">Nota</th><th className="num">Peso</th>
              <th className="num">Eventos</th><th>Fonte</th>
            </tr>
          </thead>
          <tbody>
            {(dados.indicadores ?? []).map((i: any) => (
              <tr key={i.codigo}>
                <td className="fraco">{rotulo(i.grupo)}</td>
                <td>
                  {i.nome}
                  {i.motivo && <div className="fraco">{i.motivo}</div>}
                </td>
                <td className="num">
                  {i.valor === null ? '—' : `${numero(i.valor, 2)}${i.unidade === '%' ? '%' : ''}`}
                  {i.unidade && i.unidade !== '%' && <span className="fraco"> {i.unidade}</span>}
                </td>
                <td className="num">{nota(i.nota)}</td>
                <td className="num">{i.peso > 0 ? `${numero(i.peso, 0)}%` : '—'}</td>
                <td className="num">{numero(i.eventos)}</td>
                <td className="fraco">{i.fonte}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      {!!(evolucao?.serie ?? []).length && (
        <Cartao titulo="Evolucao do score">
          <GraficoLinha
            rotulos={evolucao.serie.map((p: any) => fmtData(p.periodo_fim))}
            series={[{
              nome: 'Score',
              valores: evolucao.serie.map((p: any) => num(p.score)),
            }]}
          />
        </Cartao>
      )}

      {!!(perfil?.avaliacoes ?? []).length && (
        <Cartao titulo="Historico de avaliacoes">
          <table className="tabela">
            <thead>
              <tr>
                <th>Avaliacao</th><th>Periodo</th><th className="num">Score</th>
                <th>Status</th><th>Completude</th><th>Metodologia</th>
              </tr>
            </thead>
            <tbody>
              {perfil.avaliacoes.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.numero}</td>
                  <td>{fmtData(a.periodo_inicio)} a {fmtData(a.periodo_fim)}</td>
                  <td className="num">{nota(a.score_final)}</td>
                  <td><Estado valor={a.status} /></td>
                  <td><Estado valor={a.completude} /></td>
                  <td className="fraco">{a.metodologia_versao ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}

      {!!(perfil?.planos_acao ?? []).length && (
        <Cartao titulo="Planos de acao">
          <table className="tabela">
            <thead>
              <tr><th>Plano</th><th>Problema</th><th>Grupo</th><th>Status</th><th>Prazo</th></tr>
            </thead>
            <tbody>
              {perfil.planos_acao.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.numero}</td>
                  <td>{p.problema}</td>
                  <td>{rotulo(p.grupo)}</td>
                  <td><Estado valor={p.status} /></td>
                  <td>{fmtData(p.prazo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Avaliacoes
// ---------------------------------------------------------------------------

function Avaliacoes({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const { pode } = useAuth();
  const [pagina, setPagina] = useState(1);
  const [status, setStatus] = useState('');
  const [completude, setCompletude] = useState('');
  const [detalhe, setDetalhe] = useState<number | null>(null);

  const { itens, meta, carregando, erro, recarregar } = useLista<any>(
    '/avaliacoes-fornecedores', {
      pagina, limite: 25, status: status || undefined, completude: completude || undefined,
    });

  return (
    <>
      <Cartao
        titulo="Avaliacoes"
        acoes={(
          <div className="filtros">
            <Selecao rotulo="Status" valor={status}
              aoMudar={(v) => { setStatus(v); setPagina(1); }}
              opcoes={['RASCUNHO', 'CALCULADA', 'VALIDADA', 'CANCELADA']
                .map((s) => ({ valor: s, texto: rotulo(s) }))} />
            <Selecao rotulo="Completude" valor={completude}
              aoMudar={(v) => { setCompletude(v); setPagina(1); }}
              opcoes={['COMPLETA', 'DADOS_PARCIAIS', 'DADOS_INSUFICIENTES', 'SEM_HISTORICO']
                .map((s) => ({ valor: s, texto: rotulo(s) }))} />
          </div>
        )}
      >
        {erro && <Aviso>{erro}</Aviso>}
        {carregando && <Vazio>Carregando...</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhuma avaliacao registrada.</Vazio>}

        {!!itens.length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>Avaliacao</th><th>Fornecedor</th><th>Periodo</th>
                <th className="num">Score</th><th>Status</th><th>Completude</th>
                <th>Confiabilidade</th><th className="num">Criterios</th>
                <th>Metodologia</th><th />
              </tr>
            </thead>
            <tbody>
              {itens.map((a) => (
                <tr key={a.id}>
                  <td>{a.numero}</td>
                  <td>{a.fornecedor}</td>
                  <td>{fmtData(a.periodo_inicio)} a {fmtData(a.periodo_fim)}</td>
                  <td className="num">
                    {a.score_final === null
                      ? <Etiqueta texto="sem score" tom="neutro" />
                      : <strong>{nota(a.score_final)}</strong>}
                  </td>
                  <td><Estado valor={a.status} /></td>
                  <td><Estado valor={a.completude} /></td>
                  <td><Estado valor={a.confiabilidade} /></td>
                  <td className="num">
                    {numero(a.criterios_calculados)}/{numero(a.criterios_totais)}
                  </td>
                  <td className="fraco">{a.metodologia_versao ?? '—'}</td>
                  <td className="num">
                    <button type="button" className="botao botao--pequeno"
                      onClick={() => setDetalhe(Number(a.id))}>
                      Abrir
                    </button>
                    <button type="button" className="botao botao--pequeno"
                      onClick={() => aoAbrir(Number(a.fornecedor_id))}>
                      Scorecard
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe !== null && (
        <DetalheAvaliacao
          avaliacaoId={detalhe}
          podeValidar={pode('fornecedores.validar')}
          aoFechar={() => setDetalhe(null)}
          aoMudar={recarregar}
        />
      )}
    </>
  );
}

function DetalheAvaliacao({ avaliacaoId, podeValidar, aoFechar, aoMudar }: {
  avaliacaoId: number; podeValidar: boolean;
  aoFechar: () => void; aoMudar: () => Promise<void> | void;
}) {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = async () => {
    try {
      const r = await api<any>(`/avaliacoes-fornecedores/${avaliacaoId}`);
      setDados(r.data);
      setErro(null);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar');
    }
  };

  useEffect(() => { void carregar(); }, [avaliacaoId]);

  const validar = async () => {
    setSalvando(true);
    try {
      await api(`/avaliacoes-fornecedores/${avaliacaoId}/validar`, {
        metodo: 'POST', corpo: {},
      });
      await carregar();
      await aoMudar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel validar');
    } finally {
      setSalvando(false);
    }
  };

  if (!dados) {
    return (
      <Modal titulo="Avaliacao" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  const m = dados.memoria_do_score ?? {};

  return (
    <Modal
      titulo={`Avaliacao ${dados.numero} - ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {podeValidar && dados.status === 'CALCULADA' && (
            <button type="button" className="botao botao--pequeno botao--primario"
              disabled={salvando} onClick={() => void validar()}>
              Validar avaliacao
            </button>
          )}
          <button type="button" className="botao botao--pequeno" onClick={aoFechar}>
            Fechar
          </button>
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}

      <dl className="descricao">
        <dt>Periodo</dt>
        <dd>{fmtData(dados.periodo_inicio)} a {fmtData(dados.periodo_fim)}</dd>
        <dt>Metodologia</dt>
        <dd>{dados.metodologia_nome} (versao {dados.metodologia_versao})</dd>
        <dt>Status</dt><dd><Estado valor={dados.status} /></dd>
        <dt>Completude</dt><dd><Estado valor={dados.completude} /></dd>
        <dt>Confiabilidade</dt><dd><Estado valor={dados.confiabilidade} /></dd>
        <dt>Eventos</dt><dd>{numero(dados.eventos_avaliados)}</dd>
        <dt>Calculada em</dt><dd>{dataHora(dados.calculado_em)}</dd>
        <dt>Validada por</dt>
        <dd>{dados.validado_por_nome ?? '—'} {dados.validado_em
          ? `em ${dataHora(dados.validado_em)}` : ''}</dd>
      </dl>

      <Cartao titulo="Como o score foi formado">
        <table className="tabela">
          <thead>
            <tr>
              <th>Criterio</th><th className="num">Nota</th><th className="num">Peso</th>
              <th className="num">Contribuicao</th><th>Situacao</th>
            </tr>
          </thead>
          <tbody>
            {(m.linhas ?? []).map((l: any) => (
              <tr key={l.grupo}>
                <td>{l.criterio}</td>
                <td className="num">{nota(l.nota)}</td>
                <td className="num">{numero(l.peso, 0)}%</td>
                <td className="num">{l.contribuicao === null ? '—' : numero(l.contribuicao, 2)}</td>
                <td>
                  {l.calculavel
                    ? <Etiqueta texto="Calculado" tom="acento" />
                    : <Etiqueta texto="Sem dados" tom="neutro" />}
                  {l.motivo && <div className="fraco">{l.motivo}</div>}
                </td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong></td>
              <td className="num" />
              <td className="num"><strong>{numero(m.peso_calculado, 0)}%</strong></td>
              <td className="num"><strong>{nota(m.score)}</strong></td>
              <td className="fraco">{m.formula}</td>
            </tr>
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Indicadores que sustentam as notas">
        <table className="tabela">
          <thead>
            <tr>
              <th>Grupo</th><th>Indicador</th><th className="num">Valor</th>
              <th className="num">Nota</th><th className="num">Eventos</th><th>Formula</th>
            </tr>
          </thead>
          <tbody>
            {(dados.indicadores ?? []).map((i: any) => (
              <tr key={i.id}>
                <td className="fraco">{rotulo(i.grupo)}</td>
                <td>{i.nome}</td>
                <td className="num">
                  {i.valor === null ? '—' : numero(i.valor, 2)}
                  {i.unidade && <span className="fraco"> {i.unidade}</span>}
                </td>
                <td className="num">{nota(i.nota)}</td>
                <td className="num">{numero(i.eventos)}</td>
                <td className="fraco">{i.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Comparativo (secao 31)
// ---------------------------------------------------------------------------

function Comparativo() {
  const [fornecedores, setFornecedores] = useState<any[]>([]);
  const [selecionados, setSelecionados] = useState<number[]>([]);
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [dias, setDias] = useState('180');
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    void api<any[]>('/fornecedores', { query: { limite: 100, ativo: true } })
      .then((r) => setFornecedores(r.data))
      .catch(() => setFornecedores([]));
  }, []);

  const alternar = (id: number) =>
    setSelecionados((s) => (s.includes(id) ? s.filter((x) => x !== id)
      : s.length >= 8 ? s : [...s, id]));

  const comparar = async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<any>('/avaliacao/comparativo', {
        query: { fornecedores: selecionados.join(','), dias: Number(dias) },
      });
      setDados(r.data);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel comparar');
      setDados(null);
    } finally {
      setCarregando(false);
    }
  };

  return (
    <>
      <Cartao
        titulo="Escolha de 2 a 8 fornecedores"
        acoes={(
          <div className="filtros">
            <Selecao rotulo="Periodo" valor={dias} aoMudar={setDias} vazio=""
              opcoes={[
                { valor: '90', texto: '90 dias' }, { valor: '180', texto: '180 dias' },
                { valor: '365', texto: '1 ano' },
              ]} />
            <button type="button" className="botao botao--pequeno botao--primario"
              disabled={selecionados.length < 2 || carregando}
              onClick={() => void comparar()}>
              Comparar ({selecionados.length})
            </button>
          </div>
        )}
      >
        {erro && <Aviso>{erro}</Aviso>}
        <div className="filtros">
          {fornecedores.slice(0, 40).map((f) => (
            <label key={f.id} className="checkbox">
              <input type="checkbox" checked={selecionados.includes(Number(f.id))}
                onChange={() => alternar(Number(f.id))} />
              {f.razao_social}
            </label>
          ))}
        </div>
      </Cartao>

      {dados && (
        <Cartao titulo="Comparativo">
          <p className="explicacao">{dados.base}. {dados.observacao}.</p>
          <table className="tabela">
            <thead>
              <tr>
                <th>Criterio</th>
                {dados.fornecedores.map((f: any) => (
                  <th key={f.fornecedor_id} className="num">{f.fornecedor}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Score</strong></td>
                {dados.fornecedores.map((f: any) => (
                  <td key={f.fornecedor_id} className="num">
                    <strong>{nota(f.score)}</strong>
                  </td>
                ))}
              </tr>
              <tr>
                <td>Completude</td>
                {dados.fornecedores.map((f: any) => (
                  <td key={f.fornecedor_id} className="num">
                    <Estado valor={f.completude} />
                  </td>
                ))}
              </tr>
              <tr>
                <td>Eventos</td>
                {dados.fornecedores.map((f: any) => (
                  <td key={f.fornecedor_id} className="num">{numero(f.eventos)}</td>
                ))}
              </tr>
              {GRUPOS.map((g) => (
                <tr key={g}>
                  <td>{rotulo(g)}</td>
                  {dados.fornecedores.map((f: any) => (
                    <td key={f.fornecedor_id} className="num">{nota(f.criterios?.[g])}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>Volume comprado</td>
                {dados.fornecedores.map((f: any) => (
                  <td key={f.fornecedor_id} className="num">{moeda(f.volume?.valor)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Planos de acao
// ---------------------------------------------------------------------------

function Planos({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [pagina, setPagina] = useState(1);
  const [abertos, setAbertos] = useState(true);
  const [atrasados, setAtrasados] = useState(false);
  const { itens, meta, carregando, erro } = useLista<any>('/planos-acao', {
    pagina, limite: 25, apenas_abertos: abertos || undefined,
    apenas_atrasados: atrasados || undefined,
  });

  return (
    <Cartao
      titulo="Planos de acao"
      acoes={(
        <div className="filtros">
          <label className="checkbox">
            <input type="checkbox" checked={abertos}
              onChange={(e) => { setAbertos(e.target.checked); setPagina(1); }} />
            Só abertos
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={atrasados}
              onChange={(e) => { setAtrasados(e.target.checked); setPagina(1); }} />
            Só atrasados
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando...</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhum plano de acao.</Vazio>}

      {!!itens.length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Plano</th><th>Fornecedor</th><th>Problema</th><th>Grupo</th>
              <th>Severidade</th><th>Status</th><th>Prazo</th>
              <th className="num">Acoes</th><th />
            </tr>
          </thead>
          <tbody>
            {itens.map((p) => (
              <tr key={p.id}>
                <td>{p.numero}</td>
                <td>{p.fornecedor}</td>
                <td>{p.problema}</td>
                <td>{rotulo(p.grupo)}</td>
                <td><Estado valor={p.severidade} /></td>
                <td><Estado valor={p.status} /></td>
                <td>
                  {fmtData(p.prazo)}
                  {p.atrasado && <div><Etiqueta texto="atrasado" tom="perigo" /></div>}
                </td>
                <td className="num">
                  {numero(p.acoes_abertas)}/{numero(p.acoes)}
                </td>
                <td className="num">
                  <button type="button" className="botao botao--pequeno"
                    onClick={() => aoAbrir(Number(p.id))}>
                    Abrir
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

function DetalhePlano({ planoId, aoFechar }: { planoId: number; aoFechar: () => void }) {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [resultado, setResultado] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = async () => {
    try {
      const r = await api<any>(`/planos-acao/${planoId}`);
      setDados(r.data);
      setStatus('');
      setErro(null);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar');
    }
  };

  useEffect(() => { void carregar(); }, [planoId]);

  const tratar = async () => {
    setSalvando(true);
    setErro(null);
    try {
      await api(`/planos-acao/${planoId}`, {
        metodo: 'PUT',
        corpo: { status, resultado: resultado || undefined },
      });
      setResultado('');
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel atualizar');
    } finally {
      setSalvando(false);
    }
  };

  if (!dados) {
    return (
      <Modal titulo="Plano de acao" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  return (
    <Modal
      titulo={`Plano ${dados.numero} - ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {pode('fornecedores.plano_acao') && (dados.proximos_status ?? []).length > 0 && (
            <button type="button" className="botao botao--pequeno botao--primario"
              disabled={salvando || !status} onClick={() => void tratar()}>
              Gravar tratativa
            </button>
          )}
          <button type="button" className="botao botao--pequeno" onClick={aoFechar}>
            Fechar
          </button>
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}

      <dl className="descricao">
        <dt>Problema</dt><dd>{dados.problema}</dd>
        <dt>Causa</dt><dd>{dados.causa ?? '—'}</dd>
        <dt>Grupo</dt><dd>{rotulo(dados.grupo)}</dd>
        <dt>Indicador</dt>
        <dd>
          {dados.indicador ?? '—'}
          {dados.valor_indicador !== null && dados.valor_indicador !== undefined
            && ` (atual ${numero(dados.valor_indicador, 1)}, meta ${numero(dados.meta_indicador, 1)})`}
        </dd>
        <dt>Severidade</dt><dd><Estado valor={dados.severidade} /></dd>
        <dt>Status</dt><dd><Estado valor={dados.status} /></dd>
        <dt>Responsavel</dt><dd>{dados.responsavel ?? '—'}</dd>
        <dt>Prazo</dt><dd>{fmtData(dados.prazo)}</dd>
        <dt>Avaliacao</dt><dd>{dados.avaliacao ?? '—'}</dd>
        <dt>Resultado</dt><dd>{dados.resultado ?? '—'}</dd>
      </dl>

      {pode('fornecedores.plano_acao') && (dados.proximos_status ?? []).length > 0 && (
        <Cartao titulo="Tratativa">
          <div className="filtros">
            <Selecao rotulo="Proximo status" valor={status} aoMudar={setStatus}
              opcoes={dados.proximos_status.map((s: string) =>
                ({ valor: s, texto: rotulo(s) }))} />
            <Entrada rotulo="Resultado" valor={resultado} aoMudar={setResultado}
              placeholder="obrigatorio ao encerrar" />
          </div>
        </Cartao>
      )}

      <Cartao titulo="Acoes">
        {!(dados.acoes ?? []).length && <Vazio>Nenhuma acao cadastrada.</Vazio>}
        {!!(dados.acoes ?? []).length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>Acao</th><th>Responsavel</th><th>Prazo</th><th>Status</th><th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {dados.acoes.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.acao}</td>
                  <td>{a.responsavel ?? '—'}</td>
                  <td>{fmtData(a.prazo)}</td>
                  <td><Estado valor={a.status} /></td>
                  <td>{a.resultado ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Cartao>

      <Cartao titulo="Historico">
        <table className="tabela">
          <thead><tr><th>Quando</th><th>Evento</th><th>Descricao</th><th>Usuario</th></tr></thead>
          <tbody>
            {(dados.historico ?? []).map((h: any) => (
              <tr key={h.id}>
                <td>{dataHora(h.created_at)}</td>
                <td>{rotulo(h.evento)}</td>
                <td>{h.descricao}</td>
                <td>{h.usuario ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Riscos (secoes 48, 49 e 50)
// ---------------------------------------------------------------------------

function Riscos() {
  const [concentracao, setConcentracao] = useState<any>(null);
  const [unico, setUnico] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, u] = await Promise.all([
          api<any>('/avaliacao/concentracao', { query: { dias: 365 } }),
          api<any>('/avaliacao/fornecedor-unico'),
        ]);
        setConcentracao(c.data);
        setUnico(u.data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar');
      }
    })();
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!concentracao) return <Vazio>Carregando...</Vazio>;

  const c = concentracao.consolidada ?? {};

  return (
    <>
      <Cartao titulo="Concentracao de fornecimento">
        <p className="explicacao">
          {concentracao.observacao}. Limite de alerta: {numero(concentracao.limite_alerta)}%.
        </p>
        <div className="grade-indicadores">
          <Indicador rotulo="Fornecedores no periodo"
            valor={numero((c.participacoes ?? []).length)} />
          <Indicador rotulo="Maior participacao"
            valor={pct(c.participacoes?.[0]?.percentual)}
            nota={c.participacoes?.[0]?.fornecedor}
            tom={c.concentrado ? 'alerta' : 'acento'} />
          <Indicador rotulo="Produtos concentrados"
            valor={numero(concentracao.produtos_concentrados)}
            tom={num(concentracao.produtos_concentrados) > 0 ? 'alerta' : 'acento'} />
          <Indicador rotulo="Total comprado" valor={moeda(c.total)} />
        </div>

        {!!(c.participacoes ?? []).length && (
          <GraficoBarras
            dados={c.participacoes.slice(0, 12).map((p: any) => ({
              rotulo: String(p.fornecedor).slice(0, 18), valor: num(p.percentual),
            }))}
            formatar={(v) => `${v.toFixed(1)}%`}
          />
        )}
      </Cartao>

      <Cartao titulo="Concentracao por produto">
        {!(concentracao.por_produto ?? []).length && <Vazio>Sem compras no periodo.</Vazio>}
        {!!(concentracao.por_produto ?? []).length && (
          <table className="tabela">
            <thead>
              <tr>
                <th>Produto</th><th>Fornecedor principal</th>
                <th className="num">Participacao</th><th className="num">Fornecedores</th>
                <th className="num">Alternativas cadastradas</th><th>Risco</th>
              </tr>
            </thead>
            <tbody>
              {concentracao.por_produto.slice(0, 30).map((p: any) => (
                <tr key={p.produto_id}>
                  <td>{p.produto}</td>
                  <td>{p.principal}</td>
                  <td className="num">{pct(p.participacao_principal)}</td>
                  <td className="num">{numero(p.fornecedores)}</td>
                  <td className="num">{numero(p.alternativas_cadastradas)}</td>
                  <td>
                    {p.monoprovedor
                      ? <Etiqueta texto="monoprovedor" tom="perigo" />
                      : num(p.participacao_principal) >= num(concentracao.limite_alerta)
                        ? <Etiqueta texto="concentrado" tom="alerta" />
                        : <Etiqueta texto="distribuido" tom="acento" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Cartao>

      {unico && (
        <Cartao titulo={`Fornecimento monoprovedor (${numero(unico.total)})`}>
          <p className="explicacao">{unico.observacao}.</p>
          {!(unico.produtos ?? []).length && <Vazio>Nenhum produto monoprovedor.</Vazio>}
          {!!(unico.produtos ?? []).length && (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Produto</th><th>ABC</th><th>Categoria</th><th>Unico fornecedor</th>
                  <th>Homologacao</th><th className="num">Score</th>
                  <th className="num">Lead time</th>
                </tr>
              </thead>
              <tbody>
                {unico.produtos.slice(0, 30).map((p: any) => (
                  <tr key={p.produto_id}>
                    <td>{p.produto}</td>
                    <td>{p.classificacao_abc ?? '—'}</td>
                    <td>{p.categoria ?? '—'}</td>
                    <td>{p.fornecedor}</td>
                    <td><Estado valor={p.status_homologacao} /></td>
                    <td className="num">{nota(p.score_atual)}</td>
                    <td className="num">{numero(p.lead_time_padrao_dias)} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Historico de precos (secao 51)
// ---------------------------------------------------------------------------

function HistoricoPrecos() {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [dias, setDias] = useState('365');

  useEffect(() => {
    void api<any>('/avaliacao/historico-precos', { query: { dias: Number(dias) } })
      .then((r) => { setDados(r.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
  }, [dias]);

  return (
    <Cartao
      titulo="Historico de precos"
      acoes={(
        <Selecao rotulo="Periodo" valor={dias} aoMudar={setDias} vazio=""
          opcoes={[
            { valor: '90', texto: '90 dias' }, { valor: '365', texto: '1 ano' },
            { valor: '730', texto: '2 anos' },
          ]} />
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Carregando...</Vazio>}
      {dados && !(dados.registros ?? []).length && <Vazio>Nenhum preco no periodo.</Vazio>}

      {dados && !!(dados.registros ?? []).length && (
        <table className="tabela">
          <thead>
            <tr>
              <th>Data</th><th>Produto</th><th>Fornecedor</th>
              <th className="num">Quantidade</th><th className="num">Preco</th>
              <th className="num">Anterior</th><th className="num">Variacao</th>
              <th>Moeda</th><th>Pedido</th>
            </tr>
          </thead>
          <tbody>
            {dados.registros.slice(0, 100).map((r: any) => (
              <tr key={r.id}>
                <td>{fmtData(r.data)}</td>
                <td>{r.produto}</td>
                <td>{r.fornecedor}</td>
                <td className="num">{numero(r.quantidade, 3)}</td>
                <td className="num">{moeda(r.preco_unitario)}</td>
                <td className="num">
                  {r.preco_anterior === null ? '—' : moeda(r.preco_anterior)}
                </td>
                <td className="num">
                  {r.variacao_percentual === null
                    ? <span className="fraco">—</span>
                    : (
                      <span className={num(r.variacao_percentual) > 0 ? 'texto-alerta' : ''}>
                        {num(r.variacao_percentual) > 0 ? '+' : ''}
                        {numero(r.variacao_percentual, 2)}%
                      </span>
                    )}
                </td>
                <td>{r.moeda}</td>
                <td className="fraco">{r.pedido ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Metodologia (secoes 9, 10, 11 e 36)
// ---------------------------------------------------------------------------

function Metodologias() {
  const [dados, setDados] = useState<any>(null);
  const [detalhe, setDetalhe] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void api<any>('/avaliacao/parametros')
      .then((r) => { setDados(r.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
  }, []);

  const abrir = async (id: number) => {
    try {
      const r = await api<any>(`/metodologias-avaliacao/${id}`);
      setDetalhe(r.data);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar a metodologia');
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando...</Vazio>;

  return (
    <>
      <Cartao titulo="Metodologias">
        <p className="explicacao">
          Os pesos precisam somar 100%. Metodologia publicada nao muda: alterar peso
          cria uma versao nova, e as avaliacoes antigas continuam valendo pela versao
          que usaram.
        </p>
        <table className="tabela">
          <thead>
            <tr>
              <th>Versao</th><th>Nome</th><th>Escopo</th><th>Frequencia</th>
              <th className="num">Criterios</th><th className="num">Soma dos pesos</th>
              <th>Situacao</th><th />
            </tr>
          </thead>
          <tbody>
            {(dados.metodologias ?? []).map((m: any) => (
              <tr key={m.id}>
                <td>{m.versao}</td>
                <td>{m.nome}</td>
                <td>{rotulo(m.escopo)}</td>
                <td>{rotulo(m.frequencia)}</td>
                <td className="num">{numero(m.criterios)}</td>
                <td className="num">
                  {numero(m.soma_pesos, 0)}%
                  {num(m.soma_pesos) !== 100 && (
                    <Etiqueta texto="invalida" tom="perigo" />
                  )}
                </td>
                <td>
                  {m.vigente
                    ? <Etiqueta texto="vigente" tom="acento" />
                    : m.publicada_em
                      ? <Etiqueta texto="publicada" tom="info" />
                      : <Etiqueta texto="rascunho" tom="neutro" />}
                </td>
                <td className="num">
                  <button type="button" className="botao botao--pequeno"
                    onClick={() => void abrir(Number(m.id))}>
                    Ver pesos
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Parametros de avaliacao">
        <table className="tabela">
          <thead><tr><th>Parametro</th><th>Valor</th><th>Descricao</th></tr></thead>
          <tbody>
            {(dados.configuracoes ?? []).map((c: any) => (
              <tr key={c.chave}>
                <td><code>{c.chave}</code></td>
                <td className="num">{c.valor}</td>
                <td className="fraco">{c.descricao ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      {detalhe && (
        <Modal titulo={`Metodologia ${detalhe.versao}`} aoFechar={() => setDetalhe(null)} largo
          rodape={(
            <button type="button" className="botao botao--pequeno"
              onClick={() => setDetalhe(null)}>
              Fechar
            </button>
          )}>
          <dl className="descricao">
            <dt>Nome</dt><dd>{detalhe.nome}</dd>
            <dt>Escopo</dt><dd>{rotulo(detalhe.escopo)}</dd>
            <dt>Frequencia</dt><dd>{rotulo(detalhe.frequencia)}</dd>
            <dt>Situacao</dt>
            <dd>{detalhe.vigente ? 'vigente' : detalhe.publicada ? 'publicada' : 'rascunho'}</dd>
            <dt>Soma dos pesos</dt><dd>{numero(detalhe.soma_pesos, 0)}%</dd>
            <dt>Avaliacoes que a usaram</dt><dd>{numero(detalhe.uso?.avaliacoes)}</dd>
          </dl>

          {(detalhe.criterios ?? []).map((c: any) => (
            <Cartao key={c.grupo} titulo={`${c.nome} — peso ${numero(c.peso, 0)}%`}>
              {c.descricao && <p className="explicacao">{c.descricao}</p>}
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Indicador</th><th className="num">Peso interno</th><th>Direcao</th>
                    <th className="num">Nota 0 em</th><th className="num">Nota 100 em</th>
                    <th className="num">Minimo de eventos</th>
                  </tr>
                </thead>
                <tbody>
                  {(c.indicadores ?? []).map((i: any) => (
                    <tr key={i.codigo}>
                      <td>{i.nome} <span className="fraco">({i.codigo})</span></td>
                      <td className="num">{numero(i.peso, 0)}%</td>
                      <td>{i.direcao === 'MAIOR_MELHOR' ? 'maior e melhor' : 'menor e melhor'}</td>
                      <td className="num">{numero(i.valorPior, 2)}{i.unidade}</td>
                      <td className="num">{numero(i.valorMelhor, 2)}{i.unidade}</td>
                      <td className="num">{numero(i.minimoEventos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Cartao>
          ))}
        </Modal>
      )}
    </>
  );
}
