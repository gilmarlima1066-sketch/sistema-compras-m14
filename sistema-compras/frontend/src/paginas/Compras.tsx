import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras } from '../componentes/graficos';

/** Valor grande em cartao: milhoes abreviados, com o numero exato na nota. */
const moedaCurta = (v: unknown) => {
  const n = Number(v ?? 0);
  if (Math.abs(n) >= 1_000_000) return `R$ ${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  if (Math.abs(n) >= 10_000) return `R$ ${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return moeda(n);
};

type Aba = 'dashboard' | 'necessidades' | 'calendario' | 'consolidacao'
  | 'requisicoes' | 'simulacao' | 'parametros';

const ABAS: Array<{ id: Aba; texto: string }> = [
  { id: 'dashboard', texto: 'Dashboard' },
  { id: 'necessidades', texto: 'Necessidade de compra' },
  { id: 'calendario', texto: 'Calendario' },
  { id: 'consolidacao', texto: 'Consolidacao' },
  { id: 'requisicoes', texto: 'Requisicoes' },
  { id: 'simulacao', texto: 'Simulacao' },
  { id: 'parametros', texto: 'Parametros e alcadas' },
];

const TOM_PRIORIDADE: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  RUPTURA: 'perigo', CRITICA: 'perigo', ALTA: 'alerta',
  MEDIA: 'info', BAIXA: 'neutro', SEM_NECESSIDADE: 'neutro',
};

const TOM_STATUS: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  PENDENTE: 'neutro', EM_ANALISE: 'info', APROVADA: 'acento', AJUSTADA: 'alerta',
  REJEITADA: 'perigo', CANCELADA: 'perigo', CONVERTIDA_COTACAO: 'info', ATENDIDA: 'acento',
  RASCUNHO: 'neutro', AGUARDANDO_APROVACAO: 'alerta', ENVIADA_COTACAO: 'info',
};

const ORDEM_PRIORIDADE = ['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA'];

export function Compras() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('dashboard');

  return (
    <>
      <CabecalhoPagina
        titulo="Compras"
        descricao="Planejamento e necessidade de compra. O que comprar, quanto, quando e de quem."
      />

      <nav className="abas">
        {ABAS.map((a) => (
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

      {aba === 'dashboard' && <PainelDashboard podePlanejar={pode('compras.planejar')} />}
      {aba === 'necessidades' && (
        <PainelNecessidades podeAprovar={pode('compras.aprovar')} podeAjustar={pode('compras.planejar')} podeRequisitar={pode('compras.requisitar')} />
      )}
      {aba === 'calendario' && <PainelCalendario />}
      {aba === 'consolidacao' && <PainelConsolidacao />}
      {aba === 'requisicoes' && <PainelRequisicoes podeAprovar={pode('compras.aprovar')} />}
      {aba === 'simulacao' && <PainelSimulacao podeSimular={pode('compras.simular')} />}
      {aba === 'parametros' && <PainelParametros podeEditar={pode('compras.parametrizar')} />}
    </>
  );
}

/* ------------------------------------------------------------------ dashboard */

interface Dash {
  planejamento: {
    id: number; numero: string; data_planejamento: string; horizonte_dias: number;
    estrategia_padrao: string; status: string; produtos_analisados: number;
    necessidades_geradas: number; produtos_sem_necessidade: number; valor_total_estimado: number;
  } | null;
  indicadores: Record<string, number>;
  por_categoria: Array<{ categoria: string; itens: number; quantidade: number; valor: number }>;
  por_fornecedor: Array<{ fornecedor: string; fornecedor_id: number; itens: number; valor: number }>;
  por_prioridade: Array<{ prioridade: string; itens: number; valor: number }>;
  por_semana: Array<{ semana: string; itens: number; valor: number }>;
}

function PainelDashboard({ podePlanejar }: { podePlanejar: boolean }) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [horizonte, setHorizonte] = useState('60');
  const [estrategia, setEstrategia] = useState('');
  const [executando, setExecutando] = useState(false);

  const carregar = () => api<Dash>('/compras/dashboard')
    .then((r) => { setDash(r.data); setErro(null); })
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o dashboard'));

  useEffect(() => { void carregar(); }, []);

  async function planejar() {
    setExecutando(true);
    setAviso(null);
    try {
      const { data } = await api<any>('/compras/planejamentos', {
        metodo: 'POST',
        corpo: { horizonte_dias: Number(horizonte), ...(estrategia ? { estrategia } : {}) },
      });
      setAviso(
        `${data.numero}: ${numero(data.necessidades_geradas)} necessidades em `
        + `${numero(data.produtos_analisados)} produtos analisados. `
        + `${numero(data.produtos_sem_necessidade)} sem necessidade. `
        + `Valor estimado ${moeda(data.valor_total_estimado)}.`,
      );
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao executar o planejamento');
    } finally {
      setExecutando(false);
    }
  }

  if (erro && !dash) return <Aviso>{erro}</Aviso>;
  if (!dash) return <Vazio>Carregando…</Vazio>;

  const i = dash.indicadores ?? {};

  return (
    <>
      {podePlanejar && (
        <Cartao titulo="Executar planejamento">
          <div className="filtros">
            <Selecao
              rotulo="Horizonte" valor={horizonte} aoMudar={setHorizonte} vazio={null}
              opcoes={[7, 15, 30, 45, 60, 90, 180].map((d) => ({ valor: String(d), texto: `${d} dias` }))}
            />
            <Selecao
              rotulo="Estrategia" valor={estrategia} aoMudar={setEstrategia} vazio="Do produto"
              opcoes={[
                { valor: 'PONTO_PEDIDO', texto: 'Ponto de pedido' },
                { valor: 'ESTOQUE_MINIMO', texto: 'Estoque minimo' },
                { valor: 'ESTOQUE_MAXIMO', texto: 'Estoque maximo' },
                { valor: 'COBERTURA', texto: 'Cobertura' },
                { valor: 'DEMANDA_LEAD_TIME', texto: 'Demanda no lead time' },
              ]}
            />
            <button type="button" className="botao" disabled={executando} onClick={() => void planejar()}>
              {executando ? 'Calculando…' : 'Calcular necessidade'}
            </button>
          </div>
          {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
          {erro && <Aviso>{erro}</Aviso>}
        </Cartao>
      )}

      {dash.planejamento && (
        <Cartao titulo={`Planejamento ${dash.planejamento.numero}`}>
          <p className="fraco">
            {fmtData(dash.planejamento.data_planejamento)} · horizonte de {dash.planejamento.horizonte_dias} dias ·
            estrategia padrao {dash.planejamento.estrategia_padrao} ·
            {numero(dash.planejamento.produtos_analisados)} produtos analisados ·
            {numero(dash.planejamento.produtos_sem_necessidade)} sem necessidade
          </p>
        </Cartao>
      )}

      <div className="grade-indicadores">
        <Indicador rotulo="Valor sugerido" valor={moedaCurta(i.valor_total)} nota={moeda(i.valor_total)} tom="acento" />
        <Indicador rotulo="Itens a comprar" valor={numero(i.itens)} nota={`${numero(i.produtos)} produtos`} />
        <Indicador rotulo="Quantidade total" valor={numero(i.quantidade_total)} />
        <Indicador rotulo="Em ruptura" valor={numero(i.ruptura)} tom="perigo" />
        <Indicador rotulo="Risco de ruptura" valor={numero(i.risco_ruptura)} tom="perigo" />
        <Indicador rotulo="Abaixo do ponto de pedido" valor={numero(i.abaixo_ponto_pedido)} tom="alerta" />
        <Indicador rotulo="Com excesso" valor={numero(i.com_excesso)} tom="info" />
        <Indicador rotulo="Pedido atrasado" valor={numero(i.com_pedido_atrasado)} tom="alerta" />
        <Indicador rotulo="Atendivel por transferencia" valor={numero(i.atendiveis_por_transferencia)} tom="info" />
        <Indicador rotulo="Sem fornecedor" valor={numero(i.sem_fornecedor)} tom="alerta" />
        <Indicador rotulo="Sem base de demanda" valor={numero(i.sem_base_de_demanda)} tom="neutro" />
        <Indicador rotulo="Pendentes de decisao" valor={numero(i.pendentes)} />
        <Indicador rotulo="Proximos 7 dias" valor={moedaCurta(i.valor_7d)} nota={`${numero(i.itens_7d)} itens`} />
        <Indicador rotulo="Proximos 15 dias" valor={moedaCurta(i.valor_15d)} nota={`${numero(i.itens_15d)} itens`} />
        <Indicador rotulo="Proximos 30 dias" valor={moedaCurta(i.valor_30d)} nota={`${numero(i.itens_30d)} itens`} />
      </div>

      {dash.por_prioridade?.length > 0 && (
        <Cartao titulo="Necessidade por prioridade">
          <GraficoBarras
            dados={[...dash.por_prioridade]
              .sort((a, b) => ORDEM_PRIORIDADE.indexOf(a.prioridade) - ORDEM_PRIORIDADE.indexOf(b.prioridade))
              .map((p) => ({
                rotulo: p.prioridade,
                valor: Number(p.valor),
                cor: p.prioridade === 'RUPTURA' || p.prioridade === 'CRITICA' ? '#9a2b23'
                  : p.prioridade === 'ALTA' ? '#8a5a10' : '#2f6f4e',
              }))}
            formatar={(v) => `${(v / 1000).toFixed(0)}k`}
          />
        </Cartao>
      )}

      {dash.por_categoria?.length > 0 && (
        <Cartao titulo="Necessidade por categoria">
          <GraficoBarras
            dados={dash.por_categoria.slice(0, 12).map((c) => ({
              rotulo: c.categoria.split(/[ /]/)[0]!.slice(0, 8),
              valor: Number(c.valor),
            }))}
            formatar={(v) => `${(v / 1000).toFixed(0)}k`}
          />
        </Cartao>
      )}

      {dash.por_semana?.length > 0 && (
        <Cartao titulo="Compras previstas por semana">
          <GraficoBarras
            dados={dash.por_semana.map((s) => ({
              rotulo: fmtData(s.semana).slice(0, 5),
              valor: Number(s.valor),
            }))}
            formatar={(v) => `${(v / 1000).toFixed(0)}k`}
          />
        </Cartao>
      )}
    </>
  );
}

/* --------------------------------------------------------------- necessidades */

interface Necessidade {
  id: number; produto_id: number; codigo: string; descricao: string; categoria: string;
  classificacao_abc: string | null; classificacao_xyz: string | null;
  prioridade: string; indice_prioridade: number; status: string; estrategia: string;
  estoque_disponivel: number; estoque_em_transito: number; compra_em_aberto: number;
  demanda_diaria: number; demanda_periodo: number; demanda_lead_time: number;
  estoque_seguranca: number; estoque_alvo: number; ponto_pedido: number;
  necessidade_bruta: number; moq: number | null; multiplo_compra: number | null;
  quantidade_sugerida: number; quantidade_aprovada: number | null; quantidade_sistema: number;
  quantidade_unidade_compra: number; unidade_compra: string | null;
  fornecedor: string | null; fornecedor_id: number | null; origem_fornecedor: string | null;
  lead_time_dias: number; lead_time_total_dias: number;
  data_necessaria: string | null; data_ideal_compra: string | null; data_prevista_chegada: string | null;
  dias_cobertura: number | null; preco_estimado: number | null; valor_estimado: number | null;
  excesso: number | null; transferencia_possivel: number | null; transferencia_local: string | null;
  pedido_atrasado: boolean; previsao_confiabilidade: string | null; origem_demanda: string;
  alertas: Array<{ tipo: string; mensagem: string }>;
  justificativa: string | null;
}

function PainelNecessidades({ podeAprovar, podeAjustar, podeRequisitar }: {
  podeAprovar: boolean; podeAjustar: boolean; podeRequisitar: boolean;
}) {
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState('');
  const [prioridade, setPrioridade] = useState('');
  const [status, setStatus] = useState('');
  const [selecionadas, setSelecionadas] = useState<number[]>([]);
  const [detalhe, setDetalhe] = useState<Necessidade | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { itens, meta, carregando, recarregar } = useLista<Necessidade>('/compras/necessidades', {
    pagina, limite: 25, busca, prioridade, status,
  });

  async function acao(caminho: string, corpo?: unknown, mensagem?: string) {
    setErro(null);
    try {
      await api(caminho, { metodo: 'POST', corpo: corpo ?? {} });
      setAviso(mensagem ?? 'Operacao concluida');
      setDetalhe(null);
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha na operacao');
    }
  }

  async function gerarRequisicao() {
    setErro(null);
    try {
      const { data } = await api<any>('/compras/requisicoes', {
        metodo: 'POST', corpo: { necessidade_ids: selecionadas },
      });
      setAviso(`Requisicao ${data.numero} criada com ${selecionadas.length} item(ns), ${moeda(data.valor_estimado)}.`);
      setSelecionadas([]);
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao gerar a requisicao');
    }
  }

  const aprovadasSelecionadas = itens
    .filter((n) => selecionadas.includes(n.id))
    .every((n) => n.status === 'APROVADA' || n.status === 'AJUSTADA');

  return (
    <>
      <Cartao
        titulo="Necessidade de compra"
        acoes={(
          <div className="filtros">
            <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="codigo ou descricao" />
            <Selecao
              rotulo="Prioridade" valor={prioridade} aoMudar={(v) => { setPrioridade(v); setPagina(1); }}
              opcoes={ORDEM_PRIORIDADE.map((p) => ({ valor: p, texto: p }))}
            />
            <Selecao
              rotulo="Status" valor={status} aoMudar={(v) => { setStatus(v); setPagina(1); }}
              opcoes={['PENDENTE', 'EM_ANALISE', 'APROVADA', 'AJUSTADA', 'REJEITADA', 'CONVERTIDA_COTACAO']
                .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
            />
            {podeRequisitar && selecionadas.length > 0 && (
              <button
                type="button" className="botao"
                disabled={!aprovadasSelecionadas}
                title={aprovadasSelecionadas ? undefined : 'Somente necessidades aprovadas viram requisicao'}
                onClick={() => void gerarRequisicao()}
              >
                Gerar requisicao ({selecionadas.length})
              </button>
            )}
          </div>
        )}
        semCorpo
      >
        {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
        {erro && <Aviso>{erro}</Aviso>}
        {carregando && <Vazio>Carregando…</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhuma necessidade no filtro informado.</Vazio>}
        {!!itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th />
                  <th>Prio</th><th>Codigo</th><th>Produto</th>
                  <th>ABC</th>
                  <th className="num">Disponivel</th><th className="num">Em aberto</th>
                  <th className="num">Cobertura</th><th className="num">Demanda/dia</th>
                  <th className="num">Sugerido</th><th>Un. compra</th>
                  <th>Fornecedor</th><th className="num">Valor</th>
                  <th>Data ideal</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selecionadas.includes(n.id)}
                        onChange={(e) => setSelecionadas(e.target.checked
                          ? [...selecionadas, n.id]
                          : selecionadas.filter((x) => x !== n.id))}
                      />
                    </td>
                    <td><Etiqueta texto={n.prioridade} tom={TOM_PRIORIDADE[n.prioridade]} /></td>
                    <td className="mono">{n.codigo}</td>
                    <td>{n.descricao}</td>
                    <td>{n.classificacao_abc ? <Etiqueta texto={n.classificacao_abc} /> : '—'}</td>
                    <td className="num">{numero(n.estoque_disponivel)}</td>
                    <td className="num">{numero(n.compra_em_aberto)}</td>
                    <td className="num">{n.dias_cobertura === null ? '—' : numero(n.dias_cobertura, 0)}</td>
                    <td className="num">{numero(n.demanda_diaria, 2)}</td>
                    <td className="num">
                      <strong>{numero(n.quantidade_aprovada ?? n.quantidade_sugerida)}</strong>
                    </td>
                    <td className="num fraco">
                      {numero(n.quantidade_unidade_compra, 1)} {n.unidade_compra ?? ''}
                    </td>
                    <td>{n.fornecedor ?? <span className="fraco">sem fornecedor</span>}</td>
                    <td className="num">{moeda(n.valor_estimado)}</td>
                    <td>{fmtData(n.data_ideal_compra)}</td>
                    <td><Etiqueta texto={n.status} tom={TOM_STATUS[n.status]} /></td>
                    <td>
                      <button type="button" className="botao botao--pequeno botao--fantasma" onClick={() => setDetalhe(n)}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe && (
        <ModalNecessidade
          necessidade={detalhe}
          podeAprovar={podeAprovar}
          podeAjustar={podeAjustar}
          aoFechar={() => setDetalhe(null)}
          aoAgir={acao}
        />
      )}
    </>
  );
}

function ModalNecessidade({ necessidade, podeAprovar, podeAjustar, aoFechar, aoAgir }: {
  necessidade: Necessidade;
  podeAprovar: boolean;
  podeAjustar: boolean;
  aoFechar: () => void;
  aoAgir: (caminho: string, corpo?: unknown, mensagem?: string) => Promise<void>;
}) {
  const [memoria, setMemoria] = useState<Record<string, any> | null>(null);
  const [quantidade, setQuantidade] = useState(String(necessidade.quantidade_aprovada ?? necessidade.quantidade_sugerida));
  const [justificativa, setJustificativa] = useState('');
  const n = necessidade;

  useEffect(() => {
    api<any>(`/compras/necessidades/${n.id}`)
      .then((r) => setMemoria(r.data?.memoria_calculo ?? null))
      .catch(() => undefined);
  }, [n.id]);

  const decidivel = ['PENDENTE', 'EM_ANALISE', 'AJUSTADA'].includes(n.status);

  return (
    <Modal titulo={`${n.codigo} — ${n.descricao}`} aoFechar={aoFechar}>
      <div className="grade-indicadores">
        <Indicador rotulo="Prioridade" valor={<Etiqueta texto={n.prioridade} tom={TOM_PRIORIDADE[n.prioridade]} />} nota={`indice ${numero(n.indice_prioridade, 1)}`} />
        <Indicador rotulo="Quantidade sugerida" valor={numero(n.quantidade_sugerida)} nota={`sistema: ${numero(n.quantidade_sistema)}`} />
        <Indicador rotulo="Valor estimado" valor={moeda(n.valor_estimado)} />
        <Indicador rotulo="Cobertura" valor={n.dias_cobertura === null ? '—' : `${numero(n.dias_cobertura, 0)} dias`} />
        <Indicador rotulo="Lead time total" valor={`${numero(n.lead_time_total_dias)} dias`} nota={`fornecedor: ${numero(n.lead_time_dias)}`} />
        <Indicador rotulo="Data ideal do pedido" valor={fmtData(n.data_ideal_compra)} nota={`chega em ${fmtData(n.data_prevista_chegada)}`} />
      </div>

      {n.alertas?.length > 0 && (
        <Cartao titulo="Alertas">
          <ul className="lista-alertas">
            {n.alertas.map((a, i) => (
              <li key={i}><Etiqueta texto={a.tipo} tom={a.tipo === 'RUPTURA' ? 'perigo' : 'alerta'} /> {a.mensagem}</li>
            ))}
          </ul>
        </Cartao>
      )}

      <Cartao titulo="Como esta quantidade foi calculada">
        <table className="tabela">
          <tbody>
            <tr><th>Demanda diaria</th><td className="num">{numero(n.demanda_diaria, 4)}</td><td className="fraco">origem: {n.origem_demanda}</td></tr>
            <tr><th>Demanda do horizonte</th><td className="num">{numero(n.demanda_periodo, 2)}</td><td className="fraco">estrategia: {n.estrategia}</td></tr>
            <tr><th>Demanda no lead time</th><td className="num">{numero(n.demanda_lead_time, 2)}</td><td /></tr>
            <tr><th>Estoque disponivel</th><td className="num">{numero(n.estoque_disponivel, 2)}</td><td /></tr>
            <tr><th>Estoque em transito</th><td className="num">{numero(n.estoque_em_transito, 2)}</td><td /></tr>
            <tr><th>Compras em aberto</th><td className="num">{numero(n.compra_em_aberto, 2)}</td><td /></tr>
            <tr><th>Posicao de estoque</th><td className="num"><strong>{numero(memoria?.posicao ?? 0, 2)}</strong></td><td className="fraco">disponivel + transito + em aberto</td></tr>
            <tr><th>Estoque de seguranca</th><td className="num">{numero(n.estoque_seguranca, 2)}</td><td /></tr>
            <tr><th>Estoque alvo</th><td className="num">{numero(n.estoque_alvo, 2)}</td><td /></tr>
            <tr><th>Ponto de pedido</th><td className="num">{numero(n.ponto_pedido, 2)}</td><td /></tr>
            <tr><th>Necessidade bruta</th><td className="num"><strong>{numero(n.necessidade_bruta, 2)}</strong></td><td /></tr>
            <tr><th>MOQ</th><td className="num">{n.moq === null ? '—' : numero(n.moq)}</td><td className="fraco">minimo do fornecedor</td></tr>
            <tr><th>Multiplo de compra</th><td className="num">{n.multiplo_compra === null ? '—' : numero(n.multiplo_compra)}</td><td className="fraco">arredondamento para cima</td></tr>
            <tr><th>Quantidade sugerida</th><td className="num"><strong>{numero(n.quantidade_sugerida, 2)}</strong></td><td /></tr>
            <tr><th>Preco unitario</th><td className="num">{moeda(n.preco_estimado)}</td><td className="fraco">origem: {memoria?.origem_preco ?? '—'}</td></tr>
          </tbody>
        </table>
        {memoria?.formula && <p className="explicacao">{memoria.formula}</p>}
      </Cartao>

      {n.transferencia_possivel && (
        <Aviso tipo="ok">
          Ha {numero(n.transferencia_possivel)} disponivel em {n.transferencia_local ?? 'outro local'}.
          Avalie transferir antes de comprar — o sistema nao executa a transferencia sozinho.
        </Aviso>
      )}

      {n.justificativa && (
        <Cartao titulo="Justificativa registrada"><p>{n.justificativa}</p></Cartao>
      )}

      {decidivel && (podeAprovar || podeAjustar) && (
        <Cartao titulo="Decisao">
          <div className="filtros">
            {podeAjustar && (
              <Entrada rotulo="Quantidade" valor={quantidade} aoMudar={setQuantidade} tipo="number" />
            )}
            <Entrada
              rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa}
              placeholder="obrigatoria para ajustar ou rejeitar" className="campo--busca"
            />
          </div>
          <div className="filtros">
            {podeAjustar && (
              <button
                type="button" className="botao botao--fantasma"
                onClick={() => void aoAgir(`/compras/necessidades/${n.id}/ajustar`,
                  { quantidade_aprovada: Number(quantidade), justificativa },
                  'Quantidade ajustada')}
              >
                Ajustar quantidade
              </button>
            )}
            {podeAprovar && (
              <>
                <button
                  type="button" className="botao"
                  onClick={() => void aoAgir(`/compras/necessidades/${n.id}/aprovar`,
                    { justificativa }, 'Necessidade aprovada')}
                >
                  Aprovar
                </button>
                <button
                  type="button" className="botao botao--fantasma"
                  onClick={() => void aoAgir(`/compras/necessidades/${n.id}/rejeitar`,
                    { justificativa }, 'Necessidade rejeitada')}
                >
                  Rejeitar
                </button>
              </>
            )}
          </div>
          <p className="fraco">
            A quantidade calculada pelo sistema ({numero(n.quantidade_sistema)}) fica guardada mesmo
            depois do ajuste, para comparacao posterior.
          </p>
        </Cartao>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ calendario */

function PainelCalendario() {
  const [dados, setDados] = useState<any>(null);
  const [dias, setDias] = useState('30');

  useEffect(() => {
    api<any>('/compras/calendario', { query: { dias } })
      .then((r) => setDados(r.data)).catch(() => setDados(null));
  }, [dias]);

  if (!dados) return <Vazio>Carregando…</Vazio>;

  const rotulos: Record<string, string> = {
    HOJE: 'Hoje — analisar agora',
    PROXIMOS_7: 'Proximos 7 dias — urgente',
    PROXIMOS_15: 'Proximos 15 dias — planejado',
    PROXIMOS_30: 'Proximos 30 dias — futuro',
    FUTURO: 'Depois de 30 dias',
  };

  return (
    <>
      <Cartao
        titulo="Calendario de compras"
        acoes={<Selecao rotulo="Janela" valor={dias} aoMudar={setDias} vazio={null}
          opcoes={[7, 15, 30, 60, 90].map((d) => ({ valor: String(d), texto: `${d} dias` }))} />}
      >
        <div className="grade-indicadores">
          {(dados.janelas ?? []).map((j: any) => (
            <Indicador
              key={j.janela}
              rotulo={rotulos[j.janela] ?? j.janela}
              valor={moedaCurta(j.valor)}
              nota={`${numero(j.itens)} itens`}
              tom={j.janela === 'HOJE' ? 'perigo' : j.janela === 'PROXIMOS_7' ? 'alerta' : 'neutro'}
            />
          ))}
        </div>
      </Cartao>

      {(dados.itens ?? []).length > 0 && (
        <Cartao
          titulo={`Compras por data ideal${dados.itens_totais > dados.itens_exibidos
            ? ` — ${numero(dados.itens_exibidos)} de ${numero(dados.itens_totais)}, os mais urgentes` : ''}`}
          semCorpo
        >
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Data ideal</th><th>Codigo</th><th>Produto</th><th>Fornecedor</th>
                  <th className="num">Quantidade</th><th className="num">Valor</th>
                  <th>Prioridade</th><th>Chegada prevista</th>
                </tr>
              </thead>
              <tbody>
                {dados.itens.map((n: any) => (
                  <tr key={n.id}>
                    <td>{fmtData(n.data_ideal_compra)}</td>
                    <td className="mono">{n.codigo}</td>
                    <td>{n.descricao}</td>
                    <td>{n.fornecedor ?? '—'}</td>
                    <td className="num">{numero(n.quantidade_sugerida)}</td>
                    <td className="num">{moeda(n.valor_estimado)}</td>
                    <td><Etiqueta texto={n.prioridade} tom={TOM_PRIORIDADE[n.prioridade]} /></td>
                    <td>{fmtData(n.data_prevista_chegada)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- consolidacao */

function PainelConsolidacao() {
  const [criterio, setCriterio] = useState('FORNECEDOR');
  const [dados, setDados] = useState<any>(null);
  const [aberto, setAberto] = useState<string | null>(null);

  useEffect(() => {
    api<any>('/compras/consolidacao', { query: { criterio } })
      .then((r) => setDados(r.data)).catch(() => setDados(null));
  }, [criterio]);

  return (
    <Cartao
      titulo="Consolidacao de compras"
      acoes={(
        <Selecao
          rotulo="Agrupar por" valor={criterio} aoMudar={setCriterio} vazio={null}
          opcoes={[
            { valor: 'FORNECEDOR', texto: 'Fornecedor' },
            { valor: 'CATEGORIA', texto: 'Categoria' },
            { valor: 'LOCAL', texto: 'Local' },
            { valor: 'DATA_IDEAL', texto: 'Data ideal' },
            { valor: 'SEMANA', texto: 'Semana' },
            { valor: 'ORIGEM', texto: 'Nacional / importado' },
            { valor: 'MOEDA', texto: 'Moeda' },
          ]}
        />
      )}
      semCorpo
    >
      {!dados && <Vazio>Carregando…</Vazio>}
      {dados && !dados.grupos?.length && <Vazio>Nada a consolidar no planejamento vigente.</Vazio>}
      {dados?.grupos?.length > 0 && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Grupo</th><th className="num">Itens</th><th className="num">Quantidade</th>
                <th className="num">Valor</th><th className="num">Custo total</th>
                <th>Data ideal mais proxima</th><th />
              </tr>
            </thead>
            <tbody>
              {dados.grupos.map((g: any) => (
                <>
                  <tr key={g.grupo}>
                    <td><strong>{g.grupo ?? '—'}</strong></td>
                    <td className="num">{numero(g.itens)}</td>
                    <td className="num">{numero(g.quantidade)}</td>
                    <td className="num">{moeda(g.valor)}</td>
                    <td className="num">{moeda(g.custo_total)}</td>
                    <td>{fmtData(g.data_ideal)}</td>
                    <td>
                      <button
                        type="button" className="botao botao--pequeno botao--fantasma"
                        onClick={() => setAberto(aberto === g.grupo ? null : g.grupo)}
                      >
                        {aberto === g.grupo ? 'Fechar' : 'Itens'}
                      </button>
                    </td>
                  </tr>
                  {aberto === g.grupo && (g.itens_detalhe ?? []).map((i: any, idx: number) => (
                    <tr key={`${g.grupo}-${idx}`} className="linha-filha">
                      <td colSpan={2} className="mono">{i.codigo}</td>
                      <td colSpan={2}>{i.descricao}</td>
                      <td className="num">{moeda(i.valor)}</td>
                      <td colSpan={2} />
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

/* ----------------------------------------------------------------- requisicoes */

function PainelRequisicoes({ podeAprovar }: { podeAprovar: boolean }) {
  const [pagina, setPagina] = useState(1);
  const [status, setStatus] = useState('');
  const [detalhe, setDetalhe] = useState<any>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');

  const { itens, meta, carregando, recarregar } = useLista<any>('/compras/requisicoes', {
    pagina, limite: 25, status,
  });

  async function decidir(id: number, acao: 'aprovar' | 'rejeitar') {
    setErro(null);
    try {
      await api(`/compras/requisicoes/${id}/${acao}`, {
        metodo: 'POST', corpo: acao === 'rejeitar' ? { motivo } : {},
      });
      setAviso(`Requisicao ${acao === 'aprovar' ? 'aprovada' : 'rejeitada'}.`);
      setDetalhe(null);
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha na decisao');
    }
  }

  return (
    <>
      <Cartao
        titulo="Requisicoes de compra"
        acoes={(
          <Selecao
            rotulo="Status" valor={status} aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'REJEITADA', 'ENVIADA_COTACAO', 'ATENDIDA', 'CANCELADA']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
          />
        )}
        semCorpo
      >
        {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
        {erro && <Aviso>{erro}</Aviso>}
        {carregando && <Vazio>Carregando…</Vazio>}
        {!carregando && !itens.length && (
          <Vazio>Nenhuma requisicao. Aprove necessidades e gere a requisicao na aba anterior.</Vazio>
        )}
        {!!itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Numero</th><th>Data</th><th>Fornecedor</th><th>Prioridade</th>
                  <th className="num">Itens</th><th className="num">Valor</th>
                  <th>Data necessaria</th><th>Status</th><th>Alcada</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.numero}</td>
                    <td>{fmtData(r.data_requisicao)}</td>
                    <td>{r.fornecedor ?? '—'}</td>
                    <td><Etiqueta texto={r.prioridade ?? 'MEDIA'} tom={TOM_PRIORIDADE[r.prioridade]} /></td>
                    <td className="num">{numero(r.itens ?? r.total_itens ?? 0)}</td>
                    <td className="num">{moeda(r.valor_estimado)}</td>
                    <td>{fmtData(r.data_necessaria)}</td>
                    <td><Etiqueta texto={r.status} tom={TOM_STATUS[r.status]} /></td>
                    <td className="fraco">{r.nivel_aprovacao ?? '—'}</td>
                    <td>
                      <button
                        type="button" className="botao botao--pequeno botao--fantasma"
                        onClick={() => api<any>(`/compras/requisicoes/${r.id}`)
                          .then((x) => setDetalhe(x.data)).catch(() => undefined)}
                      >
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe && (
        <Modal titulo={`Requisicao ${detalhe.numero}`} aoFechar={() => setDetalhe(null)}>
          <div className="grade-indicadores">
            <Indicador rotulo="Valor estimado" valor={moeda(detalhe.valor_estimado)} tom="acento" />
            <Indicador rotulo="Status" valor={<Etiqueta texto={detalhe.status} tom={TOM_STATUS[detalhe.status]} />} />
            <Indicador rotulo="Solicitante" valor={detalhe.solicitante ?? '—'} />
            <Indicador rotulo="Fornecedor sugerido" valor={detalhe.fornecedor ?? '—'} />
          </div>

          <Cartao titulo="Itens">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Produto</th><th className="num">Quantidade</th>
                  <th className="num">Original</th><th className="num">Valor</th><th>Prioridade</th>
                </tr>
              </thead>
              <tbody>
                {(detalhe.itens ?? []).map((i: any) => (
                  <tr key={i.id}>
                    <td className="mono">{i.codigo}</td>
                    <td>{i.descricao}</td>
                    <td className="num">{numero(i.quantidade)}</td>
                    <td className="num fraco">{numero(i.quantidade_original)}</td>
                    <td className="num">{moeda(i.valor_estimado)}</td>
                    <td><Etiqueta texto={i.prioridade ?? '—'} tom={TOM_PRIORIDADE[i.prioridade]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Cartao>

          {podeAprovar && detalhe.status === 'AGUARDANDO_APROVACAO' && (
            <Cartao titulo="Decisao">
              <div className="filtros">
                <Entrada rotulo="Motivo (obrigatorio para rejeitar)" valor={motivo} aoMudar={setMotivo} className="campo--busca" />
                <button type="button" className="botao" onClick={() => void decidir(detalhe.id, 'aprovar')}>
                  Aprovar
                </button>
                <button type="button" className="botao botao--fantasma" onClick={() => void decidir(detalhe.id, 'rejeitar')}>
                  Rejeitar
                </button>
              </div>
              <p className="fraco">A aprovacao respeita a alcada configurada para o valor da requisicao.</p>
            </Cartao>
          )}
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- simulacao */

function PainelSimulacao({ podeSimular }: { podeSimular: boolean }) {
  const [cenario, setCenario] = useState({
    nome: '', horizonte_dias: '60', variacao_demanda_percentual: '0',
    lead_time_extra_dias: '0', variacao_seguranca_percentual: '0',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [executando, setExecutando] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [selecionadas, setSelecionadas] = useState<number[]>([]);
  const [comparacao, setComparacao] = useState<any>(null);

  const { itens, meta, carregando, recarregar } = useLista<any>('/compras/simulacoes', { pagina, limite: 25 });

  async function simular() {
    setExecutando(true);
    setErro(null);
    try {
      const { data } = await api<any>('/compras/simulacoes', {
        metodo: 'POST',
        corpo: {
          nome: cenario.nome || `Cenario ${new Date().toLocaleString('pt-BR')}`,
          horizonte_dias: Number(cenario.horizonte_dias),
          variacao_demanda_percentual: Number(cenario.variacao_demanda_percentual),
          lead_time_extra_dias: Number(cenario.lead_time_extra_dias),
          variacao_seguranca_percentual: Number(cenario.variacao_seguranca_percentual),
        },
      });
      setAviso(`${data.nome}: ${numero(data.itens ?? 0)} itens, ${moeda(data.valor_total_estimado)}.`);
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao simular');
    } finally {
      setExecutando(false);
    }
  }

  async function comparar() {
    try {
      const { data } = await api<any>('/compras/simulacoes/comparar', {
        query: { ids: selecionadas.join(',') },
      });
      setComparacao(data);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao comparar');
    }
  }

  return (
    <>
      {podeSimular && (
        <Cartao titulo="Simular cenario">
          <div className="filtros">
            <Entrada rotulo="Nome" valor={cenario.nome} aoMudar={(v) => setCenario({ ...cenario, nome: v })} placeholder="Demanda +20%" />
            <Selecao
              rotulo="Horizonte" valor={cenario.horizonte_dias} vazio={null}
              aoMudar={(v) => setCenario({ ...cenario, horizonte_dias: v })}
              opcoes={[30, 45, 60, 90, 180].map((d) => ({ valor: String(d), texto: `${d} dias` }))}
            />
            <Entrada rotulo="Demanda %" tipo="number" valor={cenario.variacao_demanda_percentual}
              aoMudar={(v) => setCenario({ ...cenario, variacao_demanda_percentual: v })} />
            <Entrada rotulo="Lead time extra (dias)" tipo="number" valor={cenario.lead_time_extra_dias}
              aoMudar={(v) => setCenario({ ...cenario, lead_time_extra_dias: v })} />
            <Entrada rotulo="Seguranca %" tipo="number" valor={cenario.variacao_seguranca_percentual}
              aoMudar={(v) => setCenario({ ...cenario, variacao_seguranca_percentual: v })} />
            <button type="button" className="botao" disabled={executando} onClick={() => void simular()}>
              {executando ? 'Simulando…' : 'Simular'}
            </button>
          </div>
          {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
          {erro && <Aviso>{erro}</Aviso>}
          <p className="fraco">A simulacao nao altera o planejamento oficial nem as necessidades gravadas.</p>
        </Cartao>
      )}

      <Cartao
        titulo="Cenarios salvos"
        acoes={selecionadas.length >= 2
          ? <button type="button" className="botao botao--pequeno" onClick={() => void comparar()}>Comparar ({selecionadas.length})</button>
          : undefined}
        semCorpo
      >
        {carregando && <Vazio>Carregando…</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhum cenario salvo.</Vazio>}
        {!!itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th /><th>Nome</th><th>Tipo</th><th className="num">Itens</th>
                  <th className="num">Quantidade</th><th className="num">Valor</th><th>Criado em</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selecionadas.includes(s.id)}
                        onChange={(e) => setSelecionadas(e.target.checked
                          ? [...selecionadas, s.id] : selecionadas.filter((x) => x !== s.id))}
                      />
                    </td>
                    <td>{s.nome}</td>
                    <td><Etiqueta texto={s.tipo_cenario} /></td>
                    <td className="num">{numero(s.itens ?? s.total_itens ?? 0)}</td>
                    <td className="num">{numero(s.quantidade_total ?? 0)}</td>
                    <td className="num">{moeda(s.valor_total_estimado)}</td>
                    <td>{fmtData(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {comparacao && (
        <Modal titulo="Comparacao de cenarios" aoFechar={() => setComparacao(null)}>
          <table className="tabela">
            <thead>
              <tr><th>Cenario</th><th className="num">Itens</th><th className="num">Quantidade</th><th className="num">Valor</th></tr>
            </thead>
            <tbody>
              {(comparacao.cenarios ?? comparacao ?? []).map((c: any) => (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td className="num">{numero(c.itens ?? 0)}</td>
                  <td className="num">{numero(c.quantidade_total ?? 0)}</td>
                  <td className="num">{moeda(c.valor_total_estimado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ parametros */

function PainelParametros({ podeEditar }: { podeEditar: boolean }) {
  const [parametros, setParametros] = useState<any[]>([]);
  const [alcadas, setAlcadas] = useState<any[]>([]);
  const [edicao, setEdicao] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<any[]>('/compras/parametros').then((r) => setParametros(r.data)).catch(() => undefined);
    api<any[]>('/compras/alcadas').then((r) => setAlcadas(r.data)).catch(() => undefined);
  }, []);

  async function salvar() {
    setErro(null);
    try {
      const { data } = await api<any[]>('/compras/parametros', { metodo: 'PUT', corpo: edicao });
      setParametros(data);
      setEdicao({});
      setAviso('Parametros atualizados.');
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao salvar');
    }
  }

  return (
    <>
      <Cartao
        titulo="Parametros do planejamento"
        acoes={podeEditar ? (
          <button type="button" className="botao" disabled={!Object.keys(edicao).length} onClick={() => void salvar()}>
            Salvar alteracoes
          </button>
        ) : undefined}
      >
        {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
        {erro && <Aviso>{erro}</Aviso>}
        <table className="tabela">
          <thead><tr><th>Parametro</th><th>Valor</th><th>Descricao</th></tr></thead>
          <tbody>
            {parametros.map((p) => (
              <tr key={p.chave}>
                <td className="mono">{p.chave.replace('planejamento.', '')}</td>
                <td>
                  {podeEditar ? (
                    <input value={edicao[p.chave] ?? p.valor}
                      onChange={(e) => setEdicao({ ...edicao, [p.chave]: e.target.value })} />
                  ) : p.valor}
                </td>
                <td className="fraco">{p.descricao}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Alcadas de aprovacao">
        <table className="tabela">
          <thead>
            <tr><th>Nivel</th><th>Perfil</th><th className="num">De</th><th className="num">Ate</th><th>Ativo</th></tr>
          </thead>
          <tbody>
            {alcadas.map((a) => (
              <tr key={a.id}>
                <td>{a.nome}</td>
                <td><Etiqueta texto={a.perfil} /></td>
                <td className="num">{moeda(a.valor_minimo)}</td>
                <td className="num">{a.valor_maximo === null ? 'sem teto' : moeda(a.valor_maximo)}</td>
                <td>{a.ativo ? 'Sim' : 'Nao'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fraco">
          Os valores sao configuraveis: a regra de aprovacao nao esta fixa no codigo.
        </p>
      </Cartao>
    </>
  );
}
