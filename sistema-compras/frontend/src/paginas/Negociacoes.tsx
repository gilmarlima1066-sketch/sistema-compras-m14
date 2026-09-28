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

type Aba = 'dashboard' | 'negociacoes' | 'pedidos' | 'alertas';

const TOM_STATUS: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  RASCUNHO: 'neutro', ABERTA: 'info', EM_NEGOCIACAO: 'info',
  AGUARDANDO_FORNECEDOR: 'alerta', CONTRAPROPOSTA_RECEBIDA: 'info',
  EM_ANALISE: 'info', ACORDADA: 'acento', APROVADA: 'acento',
  CONVERTIDA_PEDIDO: 'acento', REJEITADA: 'perigo', CANCELADA: 'perigo',
  AGUARDANDO_APROVACAO: 'alerta', ENVIADA: 'info', CONFIRMADA: 'acento',
  EM_PRODUCAO: 'info', EM_TRANSITO: 'info', RECEBIMENTO_PARCIAL: 'alerta',
  RECEBIDA: 'acento', FINALIZADA: 'acento', BLOQUEADA: 'perigo',
  CRITICO: 'perigo', ALERTA: 'alerta', ATENCAO: 'info',
};

const MOTIVOS_REJEICAO = [
  'PRECO', 'PRAZO', 'CONDICAO_COMERCIAL', 'ORCAMENTO', 'ESTOQUE',
  'PLANEJAMENTO', 'QUALIDADE', 'FORNECEDOR', 'OUTRO',
];

const MOTIVOS_CANCELAMENTO = [
  'ERRO', 'FORNECEDOR', 'PRECO', 'ESTOQUE', 'DEMANDA',
  'MUDANCA_COMERCIAL', 'NECESSIDADE_CANCELADA', 'OUTRO',
];

const num = (v: unknown) => Number(v ?? 0);
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)}%`);

export function Negociacoes() {
  const [aba, setAba] = useState<Aba>('dashboard');
  const [negociacaoAberta, setNegociacaoAberta] = useState<number | null>(null);
  const [pedidoAberto, setPedidoAberto] = useState<number | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Negociacao e Pedido de Compra"
        descricao="Rodadas com o fornecedor, economia apurada, aprovacao por alcada e o pedido oficial."
      />

      <nav className="abas">
        {([
          { id: 'dashboard' as Aba, texto: 'Dashboard' },
          { id: 'negociacoes' as Aba, texto: 'Negociacoes' },
          { id: 'pedidos' as Aba, texto: 'Pedidos' },
          { id: 'alertas' as Aba, texto: 'Alertas' },
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

      {aba === 'dashboard' && <PainelGeral />}
      {aba === 'negociacoes' && <ListaNegociacoes aoAbrir={setNegociacaoAberta} />}
      {aba === 'pedidos' && <ListaPedidos aoAbrir={setPedidoAberto} />}
      {aba === 'alertas' && (
        <PainelAlertas aoAbrirNegociacao={setNegociacaoAberta} aoAbrirPedido={setPedidoAberto} />
      )}

      {negociacaoAberta !== null && (
        <DetalheNegociacao
          id={negociacaoAberta}
          aoFechar={() => setNegociacaoAberta(null)}
          aoGerarPedido={(pedidoId) => { setNegociacaoAberta(null); setPedidoAberto(pedidoId); }}
        />
      )}
      {pedidoAberto !== null && (
        <DetalhePedido id={pedidoAberto} aoFechar={() => setPedidoAberto(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard (secoes 50, 51, 52 e 78)
// ---------------------------------------------------------------------------

function PainelGeral() {
  const [dias, setDias] = useState('180');
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    api<any>('/negociacoes/dashboard', { query: { dias } })
      .then((r) => vivo && setDados(r.data))
      .catch((e) => vivo && setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'))
      .finally(() => vivo && setCarregando(false));
    return () => { vivo = false; };
  }, [dias]);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (carregando || !dados) return <Vazio>Carregando indicadores...</Vazio>;

  const eco = dados.painel_economia ?? {};
  const kn = dados.kpi_negociacao ?? {};
  const kp = dados.kpi_pedido ?? {};
  const ic = dados.indicadores_compras ?? {};

  return (
    <>
      <Cartao
        titulo="Economia negociada"
        acoes={(
          <Selecao
            rotulo="Periodo"
            valor={dias}
            aoMudar={setDias}
            vazio={null}
            opcoes={[
              { valor: '30', texto: '30 dias' },
              { valor: '90', texto: '90 dias' },
              { valor: '180', texto: '180 dias' },
              { valor: '365', texto: '12 meses' },
            ]}
          />
        )}
      >
        <div className="grade-indicadores grade-indicadores--largo">
          <Indicador rotulo="Valor original" valor={moeda(eco.valor_original)} />
          <Indicador rotulo="Valor negociado" valor={moeda(eco.valor_negociado)} tom="info" />
          <Indicador rotulo="Economia" valor={moeda(eco.economia)} tom="acento" nota={pct(eco.percentual)} />
        </div>
        <div className="grade-indicadores grade-indicadores--largo" style={{ marginTop: 12 }}>
          <Indicador rotulo="Potencial" valor={moeda(eco.potencial)} nota="Estimada na cotacao" />
          <Indicador rotulo="Negociada" valor={moeda(eco.negociada)} nota="Fechada com o fornecedor" />
          <Indicador rotulo="Realizada" valor={moeda(eco.realizada)} nota="Reconhecida no pedido" />
        </div>
      </Cartao>

      <div className="grade-2">
        <Cartao titulo="KPI de negociacao">
          <div className="grade-indicadores">
            <Indicador rotulo="Negociacoes" valor={numero(kn.total)} />
            <Indicador rotulo="Taxa de negociacao" valor={pct(kn.taxa_negociacao)} />
            <Indicador rotulo="Rodadas medias" valor={numero(kn.rodadas_medias, 1)} />
            <Indicador rotulo="Tempo medio" valor={`${numero(kn.tempo_medio_dias, 1)} d`} />
            <Indicador rotulo="Reducao media" valor={pct(kn.reducao_media_percentual)} tom="acento" />
            <Indicador rotulo="Convertidas em pedido" valor={pct(kn.percentual_convertidas)} />
            <Indicador rotulo="Concluidas" valor={pct(kn.percentual_concluidas)} />
            <Indicador rotulo="Rejeitadas" valor={pct(kn.percentual_rejeitadas)} tom="alerta" />
          </div>
        </Cartao>

        <Cartao titulo="KPI do pedido de compra">
          <div className="grade-indicadores">
            <Indicador rotulo="Pedidos" valor={numero(kp.total)} />
            <Indicador rotulo="Lead time" valor={`${numero(kp.lead_time_dias, 1)} d`} />
            <Indicador rotulo="Tempo de aprovacao" valor={`${numero(kp.tempo_aprovacao_horas, 1)} h`} />
            <Indicador rotulo="Aprovacao ate envio" valor={`${numero(kp.tempo_aprovacao_envio_horas, 1)} h`} />
            <Indicador rotulo="Confirmados" valor={pct(kp.percentual_confirmados)} tom="acento" />
            <Indicador rotulo="Parciais" valor={pct(kp.percentual_parciais)} tom="alerta" />
            <Indicador rotulo="Alterados" valor={pct(kp.percentual_alterados)} />
            <Indicador rotulo="Cancelados" valor={pct(kp.percentual_cancelados)} tom="perigo" />
          </div>
        </Cartao>
      </div>

      <div className="grade-2">
        <Cartao titulo="Negociacoes por status">
          {(dados.negociacoes_por_status ?? []).length === 0
            ? <Vazio>Nenhuma negociacao no periodo</Vazio>
            : (
              <GraficoBarras
                dados={(dados.negociacoes_por_status ?? []).map((l: any) => ({
                  rotulo: String(l.status).replace(/_/g, ' '),
                  valor: num(l.quantidade),
                }))}
                formatar={(v) => numero(v)}
              />
            )}
        </Cartao>
        <Cartao titulo="Pedidos por status">
          {(dados.pedidos_por_status ?? []).length === 0
            ? <Vazio>Nenhum pedido no periodo</Vazio>
            : (
              <GraficoBarras
                dados={(dados.pedidos_por_status ?? []).map((l: any) => ({
                  rotulo: String(l.status).replace(/_/g, ' '),
                  valor: num(l.quantidade),
                }))}
                formatar={(v) => numero(v)}
              />
            )}
        </Cartao>
      </div>

      <Cartao titulo="Indicadores de compras">
        <div className="grade-indicadores">
          <Indicador rotulo="Saving" valor={pct(ic.saving?.percentual)} nota={moeda(ic.saving?.economia)} tom="acento" />
          <Indicador rotulo="Valor medio do pedido" valor={moeda(ic.valor_medio_pedido)} />
          <Indicador rotulo="Prazo negociado" valor={`${numero(ic.prazo_medio_negociado_dias, 1)} d`} />
          <Indicador rotulo="Prazo de pagamento" valor={`${numero(ic.prazo_medio_pagamento_dias, 1)} d`} />
          <Indicador rotulo="Atrasados" valor={numero(ic.pedidos_atrasados)} tom="perigo" />
          <Indicador rotulo="Parciais" valor={numero(ic.pedidos_parciais)} tom="alerta" />
          <Indicador rotulo="Cancelados" valor={numero(ic.pedidos_cancelados)} />
          <Indicador rotulo="Alteracao pos-aprovacao" valor={pct(ic.percentual_alteracoes_pos_aprovacao)} />
        </div>
      </Cartao>

      <div className="grade-saving">
        <TabelaSaving titulo="Saving por comprador" rotulo="Comprador" campo="comprador" linhas={ic.por_comprador} />
        <TabelaSaving titulo="Saving por fornecedor" rotulo="Fornecedor" campo="fornecedor" linhas={ic.por_fornecedor} />
        <TabelaSaving titulo="Saving por categoria" rotulo="Categoria" campo="categoria" linhas={ic.por_categoria} />
        <TabelaSaving titulo="Saving por periodo" rotulo="Periodo" campo="periodo" linhas={ic.por_periodo} />
      </div>
    </>
  );
}

function TabelaSaving({ titulo, rotulo, campo, linhas }: {
  titulo: string; rotulo: string; campo: string; linhas?: any[];
}) {
  return (
    <Cartao titulo={titulo}>
      {!linhas?.length ? <Vazio>Sem dados no periodo</Vazio> : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>{rotulo}</th>
                <th className="num">Pedidos</th>
                <th className="num">Valor</th>
                <th className="num">Economia</th>
                <th className="num">Saving</th>
              </tr>
            </thead>
            <tbody>
              {linhas.slice(0, 12).map((l: any, i: number) => (
                <tr key={`${l[campo]}-${i}`}>
                  <td>{l[campo] ?? '—'}</td>
                  <td className="num">{numero(l.pedidos)}</td>
                  <td className="num">{moeda(l.valor)}</td>
                  <td className="num">{moeda(l.economia)}</td>
                  <td className="num">{pct(l.saving_percentual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Alertas (secao 49)
// ---------------------------------------------------------------------------

function PainelAlertas({ aoAbrirNegociacao, aoAbrirPedido }: {
  aoAbrirNegociacao: (id: number) => void; aoAbrirPedido: (id: number) => void;
}) {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    api<any>('/negociacoes/alertas')
      .then((r) => vivo && setDados(r.data))
      .catch((e) => vivo && setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
    return () => { vivo = false; };
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando alertas...</Vazio>;

  const sev = dados.por_severidade ?? {};

  return (
    <Cartao titulo={`Alertas (${numero(dados.total)})`}>
      <div className="grade-indicadores">
        <Indicador rotulo="Criticos" valor={numero(sev.CRITICO)} tom="perigo" />
        <Indicador rotulo="Alertas" valor={numero(sev.ALERTA)} tom="alerta" />
        <Indicador rotulo="Atencao" valor={numero(sev.ATENCAO)} tom="info" />
      </div>

      {!dados.alertas?.length ? <Vazio>Nada pendente no momento</Vazio> : (
        <div className="tabela-rolagem" style={{ marginTop: 12 }}>
          <table className="tabela">
            <thead>
              <tr>
                <th>Severidade</th>
                <th>Tipo</th>
                <th>Referencia</th>
                <th>Mensagem</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dados.alertas.map((a: any, i: number) => (
                <tr key={`${a.tipo}-${a.referencia}-${i}`}>
                  <td><Etiqueta texto={a.severidade} tom={TOM_STATUS[a.severidade]} /></td>
                  <td>{String(a.tipo).replace(/_/g, ' ')}</td>
                  <td>{a.referencia ?? '—'}</td>
                  <td>{a.mensagem}</td>
                  <td>
                    <button
                      type="button"
                      className="botao botao--pequeno botao--fantasma"
                      onClick={() => (a.pedido_id
                        ? aoAbrirPedido(Number(a.pedido_id))
                        : aoAbrirNegociacao(Number(a.negociacao_id)))}
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
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Lista de negociacoes
// ---------------------------------------------------------------------------

function ListaNegociacoes({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);
  const { itens, meta, carregando, erro } = useLista<any>('/negociacoes', {
    status: status || undefined, busca: busca || undefined, pagina, limite: 20,
  });

  return (
    <Cartao
      titulo="Negociacoes"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="Numero ou fornecedor" />
          <Selecao
            rotulo="Status"
            valor={status}
            aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={[
              'ABERTA', 'EM_NEGOCIACAO', 'AGUARDANDO_FORNECEDOR', 'CONTRAPROPOSTA_RECEBIDA',
              'EM_ANALISE', 'ACORDADA', 'APROVADA', 'CONVERTIDA_PEDIDO', 'REJEITADA', 'CANCELADA',
            ].map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
          />
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando ? <Vazio>Carregando...</Vazio> : !itens.length ? <Vazio>Nenhuma negociacao</Vazio> : (
        <>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Fornecedor</th>
                  <th>Status</th>
                  <th className="num">Rodadas</th>
                  <th className="num">Custo inicial</th>
                  <th className="num">Custo atual</th>
                  <th className="num">Economia</th>
                  <th>Abertura</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {itens.map((n) => (
                  <tr key={n.id}>
                    <td>{n.numero}</td>
                    <td>{n.fornecedor}</td>
                    <td><Etiqueta texto={n.status} tom={TOM_STATUS[n.status]} /></td>
                    <td className="num">{numero(n.rodada_atual)}</td>
                    <td className="num">{moeda(n.custo_total_inicial)}</td>
                    <td className="num">{moeda(n.custo_total_atual)}</td>
                    <td className="num">{moeda(n.economia_negociada)}</td>
                    <td>{fmtData(n.data_abertura)}</td>
                    <td>
                      <button type="button" className="botao botao--pequeno" onClick={() => aoAbrir(Number(n.id))}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao meta={meta} aoTrocar={setPagina} />
        </>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Detalhe da negociacao (secoes 9 a 23 e 78)
// ---------------------------------------------------------------------------

function DetalheNegociacao({ id, aoFechar, aoGerarPedido }: {
  id: number; aoFechar: () => void; aoGerarPedido: (pedidoId: number) => void;
}) {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [formRodada, setFormRodada] = useState(false);
  const [rejeitando, setRejeitando] = useState(false);

  const carregar = () => api<any>(`/negociacoes/${id}`)
    .then((r) => setDados(r.data))
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));

  useEffect(() => { void carregar(); }, [id]);

  const acao = async (caminho: string, corpo: unknown, sucesso: string) => {
    setOcupado(true); setErro(null); setAviso(null);
    try {
      const r = await api<any>(caminho, { metodo: 'POST', corpo });
      setAviso(sucesso);
      if (caminho.endsWith('/converter-pedido')) { aoGerarPedido(Number(r.data.id)); return; }
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel concluir');
    } finally {
      setOcupado(false);
    }
  };

  if (!dados) {
    return <Modal titulo="Negociacao" aoFechar={aoFechar} largo>{erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}</Modal>;
  }

  const emAberto = !['APROVADA', 'CONVERTIDA_PEDIDO', 'REJEITADA', 'CANCELADA'].includes(dados.status);

  return (
    <Modal
      titulo={`Negociacao ${dados.numero} — ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {emAberto && pode('compras.negociar') && (
            <button type="button" className="botao botao--pequeno" disabled={ocupado} onClick={() => setFormRodada(true)}>
              Nova rodada
            </button>
          )}
          {dados.status !== 'ACORDADA' && emAberto && pode('compras.negociar') && (
            <button
              type="button"
              className="botao botao--pequeno"
              disabled={ocupado}
              onClick={() => acao(`/negociacoes/${id}/acordar`, {}, 'Acordo registrado')}
            >
              Fechar acordo
            </button>
          )}
          {dados.status === 'ACORDADA' && pode('compras.aprovar_negociacao') && (
            <button
              type="button"
              className="botao botao--pequeno botao--primario"
              disabled={ocupado}
              onClick={() => acao(`/negociacoes/${id}/aprovar`, {}, 'Negociacao aprovada')}
            >
              Aprovar
            </button>
          )}
          {dados.status === 'APROVADA' && pode('ordens_compra.criar') && (
            <button
              type="button"
              className="botao botao--pequeno botao--primario"
              disabled={ocupado}
              onClick={() => acao(`/negociacoes/${id}/converter-pedido`, {}, 'Pedido gerado')}
            >
              Gerar pedido de compra
            </button>
          )}
          {emAberto && pode('compras.aprovar_negociacao') && (
            <button type="button" className="botao botao--pequeno botao--perigo" disabled={ocupado} onClick={() => setRejeitando(true)}>
              Rejeitar
            </button>
          )}
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <div className="grade-indicadores">
        <Indicador rotulo="Status" valor={<Etiqueta texto={dados.status} tom={TOM_STATUS[dados.status]} />} />
        <Indicador rotulo="Custo inicial" valor={moeda(dados.economia?.custo_inicial)} />
        <Indicador rotulo="Custo atual" valor={moeda(dados.economia?.custo_atual)} tom="info" />
        <Indicador
          rotulo="Economia"
          valor={moeda(dados.economia?.negociada)}
          nota={pct(dados.economia?.percentual)}
          tom="acento"
        />
        <Indicador rotulo="Rodadas" valor={numero(dados.rodada_atual)} />
        <Indicador rotulo="Prazo de entrega" valor={`${numero(dados.prazo_entrega_atual)} d`} />
        <Indicador rotulo="Pagamento" valor={`${numero(dados.prazo_pagamento_atual)} d`} />
        <Indicador rotulo="Cotacao" valor={dados.cotacao ?? 'Manual'} />
      </div>

      {dados.desvio_relevante && (
        <Aviso>{dados.motivo_desvio ?? 'Condicoes mudaram em relacao a cotacao aprovada'}</Aviso>
      )}

      <Cartao titulo="Antes e depois">
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Criterio</th>
                <th className="num">Antes</th>
                <th className="num">Depois</th>
                <th className="num">Variacao</th>
              </tr>
            </thead>
            <tbody>
              {(dados.comparativo ?? []).map((l: any) => (
                <tr key={l.criterio}>
                  <td>{l.criterio}</td>
                  <td className="num">{l.antes === null ? '—' : numero(l.antes, 2)}</td>
                  <td className="num">{l.depois === null ? '—' : numero(l.depois, 2)}</td>
                  <td className="num">{pct(l.variacaoPercentual ?? l.variacao_percentual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      <Cartao titulo="Itens">
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Produto</th>
                <th className="num">Quantidade</th>
                <th className="num">Preco inicial</th>
                <th className="num">Preco atual</th>
                <th className="num">Alvo</th>
                <th className="num">Minimo historico</th>
                <th className="num">Valor</th>
              </tr>
            </thead>
            <tbody>
              {(dados.itens ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{i.codigo} — {i.descricao}</td>
                  <td className="num">{numero(i.quantidade_atual, 2)}</td>
                  <td className="num">{moeda(i.preco_inicial)}</td>
                  <td className="num">
                    {moeda(i.preco_atual)}
                    {i.preco_alvo !== null && num(i.preco_atual) > num(i.preco_alvo)
                      && <> <Etiqueta texto="ACIMA DO ALVO" tom="alerta" /></>}
                  </td>
                  <td className="num">{i.preco_alvo === null ? '—' : moeda(i.preco_alvo)}</td>
                  <td className="num">{i.preco_minimo_historico === null ? '—' : moeda(i.preco_minimo_historico)}</td>
                  <td className="num">{moeda(i.valor_atual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      <Cartao titulo="Rodadas">
        <ol className="linha-tempo">
          {(dados.rodadas ?? []).map((r: any) => (
            <li key={r.id}>
              <div className="linha-tempo__topo">
                <strong>Rodada {numero(r.rodada)}</strong>
                <Etiqueta texto={r.autor} tom={r.autor === 'FORNECEDOR' ? 'info' : 'neutro'} />
                <span className="num">{moeda(r.custo_total)}</span>
                <span>{dataHora(r.created_at)}</span>
              </div>
              {r.justificativa && <p>{r.justificativa}</p>}
              <div className="linha-tempo__dados">
                <span>Entrega: {numero(r.prazo_entrega_dias)} d</span>
                <span>Pagamento: {numero(r.prazo_pagamento_dias)} d</span>
                <span>Frete: {moeda(r.frete)}</span>
                <span>Economia acumulada: {moeda(r.economia_acumulada)}</span>
              </div>
            </li>
          ))}
        </ol>
      </Cartao>

      {formRodada && (
        <FormularioRodada
          negociacaoId={id}
          itens={dados.itens ?? []}
          aoFechar={() => setFormRodada(false)}
          aoSalvar={async () => { setFormRodada(false); await carregar(); }}
        />
      )}

      {rejeitando && (
        <FormularioMotivo
          titulo="Rejeitar negociacao"
          motivos={MOTIVOS_REJEICAO}
          aoFechar={() => setRejeitando(false)}
          aoConfirmar={async (corpo) => {
            setRejeitando(false);
            await acao(`/negociacoes/${id}/rejeitar`, corpo, 'Negociacao rejeitada');
          }}
        />
      )}
    </Modal>
  );
}

function FormularioRodada({ negociacaoId, itens, aoFechar, aoSalvar }: {
  negociacaoId: number;
  itens: any[];
  aoFechar: () => void;
  aoSalvar: () => Promise<void>;
}) {
  const [autor, setAutor] = useState('FORNECEDOR');
  const [justificativa, setJustificativa] = useState('');
  const [frete, setFrete] = useState('');
  const [prazoEntrega, setPrazoEntrega] = useState('');
  const [prazoPagamento, setPrazoPagamento] = useState('');
  const [precos, setPrecos] = useState<Record<number, string>>({});
  const [quantidades, setQuantidades] = useState<Record<number, string>>({});
  const [bonificadas, setBonificadas] = useState<Record<number, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async () => {
    setOcupado(true); setErro(null);
    const linhas = itens
      .map((i) => {
        const linha: any = { negociacao_item_id: Number(i.id) };
        if (precos[i.id] !== undefined && precos[i.id] !== '') linha.preco_unitario = Number(precos[i.id]);
        if (quantidades[i.id] !== undefined && quantidades[i.id] !== '') linha.quantidade = Number(quantidades[i.id]);
        if (bonificadas[i.id] !== undefined && bonificadas[i.id] !== '') linha.quantidade_bonificada = Number(bonificadas[i.id]);
        return linha;
      })
      .filter((l) => Object.keys(l).length > 1);

    const corpo: any = { autor, itens: linhas };
    if (justificativa) corpo.justificativa = justificativa;
    if (frete !== '') corpo.frete = Number(frete);
    if (prazoEntrega !== '') corpo.prazo_entrega_dias = Number(prazoEntrega);
    if (prazoPagamento !== '') corpo.prazo_pagamento_dias = Number(prazoPagamento);

    try {
      await api(`/negociacoes/${negociacaoId}/rodadas`, { metodo: 'POST', corpo });
      await aoSalvar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel registrar a rodada');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal
      titulo="Nova rodada"
      aoFechar={aoFechar}
      largo
      rodape={(
        <button type="button" className="botao botao--primario botao--pequeno" disabled={ocupado} onClick={enviar}>
          Registrar rodada
        </button>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      <p className="explicacao">
        Deixe em branco o que nao mudou. Uma rodada precisa alterar ao menos uma condicao.
      </p>
      <div className="formulario-grade">
        <Selecao
          rotulo="Autor"
          valor={autor}
          aoMudar={setAutor}
          vazio={null}
          opcoes={[
            { valor: 'FORNECEDOR', texto: 'Proposta do fornecedor' },
            { valor: 'COMPRADOR', texto: 'Contraproposta do comprador' },
          ]}
        />
        <Entrada rotulo="Frete" valor={frete} aoMudar={setFrete} tipo="number" />
        <Entrada rotulo="Prazo de entrega (dias)" valor={prazoEntrega} aoMudar={setPrazoEntrega} tipo="number" />
        <Entrada rotulo="Prazo de pagamento (dias)" valor={prazoPagamento} aoMudar={setPrazoPagamento} tipo="number" />
      </div>
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa} />

      <div className="tabela-rolagem" style={{ marginTop: 12 }}>
        <table className="tabela">
          <thead>
            <tr>
              <th>Produto</th>
              <th className="num">Preco atual</th>
              <th className="num">Novo preco</th>
              <th className="num">Nova quantidade</th>
              <th className="num">Bonificacao</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((i) => (
              <tr key={i.id}>
                <td>{i.codigo} — {i.descricao}</td>
                <td className="num">{moeda(i.preco_atual)}</td>
                <td className="num">
                  <input
                    type="number"
                    value={precos[i.id] ?? ''}
                    onChange={(e) => setPrecos({ ...precos, [i.id]: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    value={quantidades[i.id] ?? ''}
                    onChange={(e) => setQuantidades({ ...quantidades, [i.id]: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    value={bonificadas[i.id] ?? ''}
                    onChange={(e) => setBonificadas({ ...bonificadas, [i.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function FormularioMotivo({ titulo, motivos, aoFechar, aoConfirmar }: {
  titulo: string;
  motivos: string[];
  aoFechar: () => void;
  aoConfirmar: (corpo: { motivo: string; justificativa: string }) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState(motivos[0]!);
  const [justificativa, setJustificativa] = useState('');

  return (
    <Modal
      titulo={titulo}
      aoFechar={aoFechar}
      rodape={(
        <button
          type="button"
          className="botao botao--perigo botao--pequeno"
          disabled={justificativa.trim().length < 5}
          onClick={() => aoConfirmar({ motivo, justificativa })}
        >
          Confirmar
        </button>
      )}
    >
      <Selecao
        rotulo="Motivo"
        valor={motivo}
        aoMudar={setMotivo}
        vazio={null}
        opcoes={motivos.map((m) => ({ valor: m, texto: m.replace(/_/g, ' ') }))}
      />
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa} />
      <p className="explicacao">A justificativa fica no historico e nao pode ser apagada.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Lista de pedidos
// ---------------------------------------------------------------------------

function ListaPedidos({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [atrasados, setAtrasados] = useState(false);
  const [parciais, setParciais] = useState(false);
  const [pagina, setPagina] = useState(1);
  const { itens, meta, carregando, erro } = useLista<any>('/pedidos-compra', {
    status: status || undefined,
    busca: busca || undefined,
    apenas_atrasados: atrasados || undefined,
    apenas_parciais: parciais || undefined,
    pagina,
    limite: 20,
  });

  return (
    <Cartao
      titulo="Pedidos de compra"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="Numero ou fornecedor" />
          <Selecao
            rotulo="Status"
            valor={status}
            aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={[
              'RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'ENVIADA', 'CONFIRMADA',
              'EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA', 'FINALIZADA',
              'CANCELADA', 'REJEITADA',
            ].map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
          />
          <label className="checkbox">
            <input type="checkbox" checked={atrasados} onChange={(e) => { setAtrasados(e.target.checked); setPagina(1); }} />
            Somente atrasados
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={parciais} onChange={(e) => { setParciais(e.target.checked); setPagina(1); }} />
            Somente parciais
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando ? <Vazio>Carregando...</Vazio> : !itens.length ? <Vazio>Nenhum pedido</Vazio> : (
        <>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Fornecedor</th>
                  <th>Status</th>
                  <th className="num">Valor</th>
                  <th className="num">Economia</th>
                  <th>Emissao</th>
                  <th>Entrega</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {itens.map((p) => (
                  <tr key={p.id}>
                    <td>{p.numero}</td>
                    <td>{p.fornecedor}</td>
                    <td>
                      <Etiqueta texto={p.status} tom={TOM_STATUS[p.status]} />
                      {num(p.itens_pendentes) > 0 && <> <Etiqueta texto="PARCIAL" tom="alerta" /></>}
                    </td>
                    <td className="num">{moeda(p.valor_total)}</td>
                    <td className="num">{moeda(p.economia_negociada)}</td>
                    <td>{fmtData(p.data_emissao)}</td>
                    <td>{fmtData(p.data_prometida ?? p.data_prevista_entrega)}</td>
                    <td>
                      <button type="button" className="botao botao--pequeno" onClick={() => aoAbrir(Number(p.id))}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao meta={meta} aoTrocar={setPagina} />
        </>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Detalhe do pedido (secoes 47, 48 e 79)
// ---------------------------------------------------------------------------

type AbaPedido = 'resumo' | 'itens' | 'validacao' | 'timeline' | 'aprovacoes' | 'documento';

function DetalhePedido({ id, aoFechar }: { id: number; aoFechar: () => void }) {
  const { pode } = useAuth();
  const [aba, setAba] = useState<AbaPedido>('resumo');
  const [dados, setDados] = useState<any>(null);
  const [validacao, setValidacao] = useState<any>(null);
  const [timeline, setTimeline] = useState<any>(null);
  const [documento, setDocumento] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [justificando, setJustificando] = useState(false);

  const carregar = () => api<any>(`/pedidos-compra/${id}`)
    .then((r) => setDados(r.data))
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));

  useEffect(() => {
    void carregar();
    // A validacao vem junto porque e ela que diz se o botao de aprovar pode
    // sequer aparecer habilitado (secoes 28 a 31).
    api<any>(`/pedidos-compra/${id}/validacao`).then((r) => setValidacao(r.data)).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (aba === 'timeline' && !timeline) {
      api<any>(`/pedidos-compra/${id}/timeline`).then((r) => setTimeline(r.data)).catch(() => {});
    }
    if (aba === 'documento' && !documento) {
      api<any>(`/pedidos-compra/${id}/documento`).then((r) => setDocumento(r.data)).catch(() => {});
    }
  }, [aba, id, validacao, timeline, documento]);

  const acao = async (caminho: string, corpo: unknown, sucesso: string) => {
    setOcupado(true); setErro(null); setAviso(null);
    try {
      await api(caminho, { metodo: 'POST', corpo });
      setAviso(sucesso);
      setTimeline(null); setDocumento(null);
      await Promise.all([
        carregar(),
        api<any>(`/pedidos-compra/${id}/validacao`).then((r) => setValidacao(r.data)).catch(() => {}),
      ]);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel concluir');
    } finally {
      setOcupado(false);
    }
  };

  if (!dados) {
    return <Modal titulo="Pedido" aoFechar={aoFechar} largo>{erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}</Modal>;
  }

  return (
    <Modal
      titulo={`Pedido ${dados.numero} — ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {dados.status === 'RASCUNHO' && pode('ordens_compra.criar') && (
            <button type="button" className="botao botao--pequeno" disabled={ocupado}
              onClick={() => acao(`/pedidos-compra/${id}/enviar-aprovacao`, {}, 'Enviado para aprovacao')}>
              Enviar para aprovacao
            </button>
          )}
          {dados.status === 'AGUARDANDO_APROVACAO' && pode('ordens_compra.aprovar') && (
            <>
              <button
                type="button"
                className="botao botao--pequeno botao--primario"
                disabled={ocupado || validacao?.pode_aprovar === false}
                title={validacao?.pode_aprovar === false
                  ? 'A validacao aponta problemas de quantidade. Veja a aba Validacao'
                  : undefined}
                onClick={() => setJustificando(true)}
              >
                Aprovar
              </button>
              <button type="button" className="botao botao--pequeno botao--perigo" disabled={ocupado}
                onClick={() => setCancelando(true)}>
                Rejeitar ou cancelar
              </button>
            </>
          )}
          {dados.status === 'APROVADA' && pode('ordens_compra.enviar') && (
            <button type="button" className="botao botao--pequeno botao--primario" disabled={ocupado}
              onClick={() => acao(`/pedidos-compra/${id}/enviar`, { canal: 'EMAIL' }, 'Pedido enviado ao fornecedor')}>
              Enviar ao fornecedor
            </button>
          )}
          {dados.status === 'ENVIADA' && pode('ordens_compra.enviar') && (
            <button type="button" className="botao botao--pequeno botao--primario" disabled={ocupado}
              onClick={() => setConfirmando(true)}>
              Registrar confirmacao
            </button>
          )}
          {!['CANCELADA', 'REJEITADA', 'FINALIZADA'].includes(dados.status) && pode('ordens_compra.cancelar') && (
            <button type="button" className="botao botao--pequeno botao--perigo" disabled={ocupado}
              onClick={() => setCancelando(true)}>
              Cancelar pedido
            </button>
          )}
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {validacao?.pode_aprovar === false && dados.status === 'AGUARDANDO_APROVACAO' && (
        <Aviso>
          A validacao bloqueia a aprovacao: {(validacao.bloqueios ?? [])
            .map((x: any) => `${x.produto} — ${x.mensagem}`).join('; ')}
        </Aviso>
      )}

      <nav className="abas">
        {([
          { id: 'resumo' as AbaPedido, texto: 'Resumo' },
          { id: 'itens' as AbaPedido, texto: 'Itens' },
          { id: 'validacao' as AbaPedido, texto: 'Validacao' },
          { id: 'aprovacoes' as AbaPedido, texto: 'Aprovacoes' },
          { id: 'timeline' as AbaPedido, texto: 'Timeline' },
          { id: 'documento' as AbaPedido, texto: 'Documento' },
        ]).map((a) => (
          <button key={a.id} type="button"
            className={`abas__item${aba === a.id ? ' abas__item--ativo' : ''}`}
            onClick={() => setAba(a.id)}>
            {a.texto}
          </button>
        ))}
      </nav>

      {aba === 'resumo' && (
        <>
          <div className="grade-indicadores grade-indicadores--largo">
            <Indicador rotulo="Status" valor={<Etiqueta texto={dados.status} tom={TOM_STATUS[dados.status]} />} />
            <Indicador rotulo="Valor total" valor={moeda(dados.valor_total)} />
            <Indicador rotulo="Economia negociada" valor={moeda(dados.economia_negociada)} tom="acento" />
            <Indicador rotulo="Economia realizada" valor={moeda(dados.economia_realizada)} />
            <Indicador rotulo="Emissao" valor={fmtData(dados.data_emissao)} />
            <Indicador rotulo="Entrega prevista" valor={fmtData(dados.data_prometida ?? dados.data_prevista_entrega)} />
            <Indicador rotulo="Comprador" valor={dados.comprador ?? '—'} />
            <Indicador rotulo="Aprovador" valor={dados.aprovador ?? '—'} nota={dados.nivel_aprovacao ?? undefined} />
          </div>

          <div className="grade-2">
            <Cartao titulo="Condicoes">
              <dl className="descricao">
                <dt>Condicao de pagamento</dt><dd>{dados.condicao_pagamento ?? '—'}</dd>
                <dt>Moeda</dt><dd>{dados.moeda}</dd>
                <dt>Incoterm</dt><dd>{dados.incoterm ?? '—'}</dd>
                <dt>Local de entrega</dt><dd>{dados.local_entrega ?? '—'}</dd>
                <dt>Pedido do fornecedor</dt><dd>{dados.numero_pedido_fornecedor ?? '—'}</dd>
                <dt>Origem</dt>
                <dd>{dados.negociacao ? `Negociacao ${dados.negociacao}` : 'Direto'}{dados.cotacao ? ` · Cotacao ${dados.cotacao}` : ''}</dd>
              </dl>
            </Cartao>

            <Cartao titulo="Pagamento">
              {!dados.parcelas?.length ? <Vazio>Sem parcelas geradas</Vazio> : (
                <table className="tabela">
                  <thead>
                    <tr><th className="num">Parcela</th><th>Vencimento</th><th className="num">Valor</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {dados.parcelas.map((p: any) => (
                      <tr key={p.id}>
                        <td className="num">{numero(p.parcela)}</td>
                        <td>{fmtData(p.data_vencimento ?? p.vencimento)}</td>
                        <td className="num">{moeda(p.valor)}</td>
                        <td><Etiqueta texto={p.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Cartao>
          </div>

          {(dados.excecoes ?? []).length > 0 && (
            <Cartao titulo="Excecoes registradas">
              <ul className="lista-alertas">
                {dados.excecoes.map((e: any, i: number) => (
                  <li key={i}>
                    <strong>{String(e.tipo).replace(/_/g, ' ')}</strong> — {e.motivo}
                    {e.data && <> · {dataHora(e.data)}</>}
                  </li>
                ))}
              </ul>
            </Cartao>
          )}

          {(dados.alteracoes ?? []).length > 0 && (
            <Cartao titulo="Solicitacoes de alteracao">
              <table className="tabela">
                <thead>
                  <tr><th>Campo</th><th>De</th><th>Para</th><th>Motivo</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {dados.alteracoes.map((a: any) => (
                    <tr key={a.id}>
                      <td>{String(a.campo).replace(/_/g, ' ')}</td>
                      <td>{a.valor_anterior ?? '—'}</td>
                      <td>{a.valor_novo}</td>
                      <td>{a.motivo}</td>
                      <td>
                        <Etiqueta texto={a.status} tom={TOM_STATUS[a.status]} />
                        {a.exige_reaprovacao && <> <Etiqueta texto="REAPROVAR" tom="alerta" /></>}
                      </td>
                      <td>
                        {a.status === 'SOLICITADA' && pode('ordens_compra.aprovar') && (
                          <>
                            <button type="button" className="botao botao--pequeno" disabled={ocupado}
                              onClick={() => acao(`/pedidos-compra/alteracoes/${a.id}`, { aprovar: true }, 'Alteracao aprovada')}>
                              Aprovar
                            </button>{' '}
                            <button type="button" className="botao botao--pequeno botao--fantasma" disabled={ocupado}
                              onClick={() => acao(`/pedidos-compra/alteracoes/${a.id}`, { aprovar: false }, 'Alteracao recusada')}>
                              Recusar
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Cartao>
          )}
        </>
      )}

      {aba === 'itens' && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Produto</th>
                <th className="num">Pedida</th>
                <th className="num">Confirmada</th>
                <th className="num">Pendente</th>
                <th className="num">Bonificada</th>
                <th className="num">Preco</th>
                <th className="num">Original</th>
                <th className="num">Frete rateado</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(dados.itens ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{i.codigo} — {i.descricao}</td>
                  <td className="num">{numero(i.quantidade_pedida, 2)}</td>
                  <td className="num">{numero(i.quantidade_confirmada, 2)}</td>
                  <td className="num">
                    {num(i.quantidade_pendente) > 0
                      ? <strong className="texto-alerta">{numero(i.quantidade_pendente, 2)}</strong>
                      : numero(0, 2)}
                  </td>
                  <td className="num">{numero(i.quantidade_bonificada, 2)}</td>
                  <td className="num">{moeda(i.preco_unitario)}</td>
                  <td className="num">{i.preco_original === null ? '—' : moeda(i.preco_original)}</td>
                  <td className="num">{moeda(i.frete_rateado)}</td>
                  <td className="num">{moeda(i.valor_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aba === 'validacao' && (
        !validacao ? <Vazio>Carregando validacao...</Vazio> : (
          <>
            <div className="grade-indicadores">
              <Indicador
                rotulo="Pode aprovar"
                valor={validacao.pode_aprovar ? 'Sim' : 'Nao'}
                tom={validacao.pode_aprovar ? 'acento' : 'perigo'}
              />
              <Indicador
                rotulo="Exige justificativa"
                valor={validacao.exige_justificativa ? 'Sim' : 'Nao'}
                tom={validacao.exige_justificativa ? 'alerta' : 'neutro'}
              />
              <Indicador
                rotulo="Quem aprova"
                valor={validacao.alcada_necessaria?.perfil ?? '—'}
                nota={validacao.alcada_necessaria?.nome}
              />
              <Indicador rotulo="Valor avaliado" valor={moeda(validacao.valor_total)} />
            </div>

            {(validacao.alertas ?? []).length > 0 && (
              <Cartao titulo="Alertas da validacao">
                <ul className="lista-alertas">
                  {validacao.alertas.map((a: any, i: number) => (
                    <li key={i}>
                      <Etiqueta
                        texto={a.tipo}
                        tom={a.tipo.includes('RUPTURA') || a.tipo.includes('MOQ') ? 'perigo' : 'alerta'}
                      />{' '}
                      {a.produto ? <strong>{a.produto}: </strong> : null}{a.mensagem}
                    </li>
                  ))}
                </ul>
              </Cartao>
            )}

            <div className="tabela-rolagem">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th className="num">Pedida</th>
                    <th className="num">Necessidade</th>
                    <th className="num">Estoque</th>
                    <th className="num">Demanda/dia</th>
                    <th className="num">Cobertura</th>
                    <th className="num">Apos compra</th>
                    <th>Riscos</th>
                  </tr>
                </thead>
                <tbody>
                  {(validacao.itens ?? []).map((l: any) => (
                    <tr key={l.ordem_compra_item_id}>
                      <td>{l.codigo} — {l.descricao}</td>
                      <td className="num">{numero(l.quantidade_pedida, 2)}</td>
                      <td className="num">{l.necessidade_planejada === null ? '—' : numero(l.necessidade_planejada, 2)}</td>
                      <td className="num">{numero(l.estoque?.disponivel, 2)}</td>
                      <td className="num">{l.demanda?.media_diaria === null ? '—' : numero(l.demanda?.media_diaria, 2)}</td>
                      <td className="num">{l.impacto?.coberturaAtualDias === null ? '—' : `${numero(l.impacto?.coberturaAtualDias)} d`}</td>
                      <td className="num">{l.impacto?.coberturaAposCompraDias === null ? '—' : `${numero(l.impacto?.coberturaAposCompraDias)} d`}</td>
                      <td>
                        {l.impacto?.riscoExcesso && <Etiqueta texto="EXCESSO" tom="alerta" />}
                        {l.impacto?.riscoRuptura && <Etiqueta texto="RUPTURA" tom="perigo" />}
                        {!l.quantidade?.atende && <Etiqueta texto="QUANTIDADE" tom="perigo" />}
                        {!l.impacto?.riscoExcesso && !l.impacto?.riscoRuptura && l.quantidade?.atende
                          && <Etiqueta texto="OK" tom="acento" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {aba === 'aprovacoes' && (
        !dados.aprovacoes?.length ? <Vazio>Nenhuma aprovacao registrada</Vazio> : (
          <table className="tabela">
            <thead>
              <tr><th>Nivel</th><th>Perfil exigido</th><th className="num">Valor</th><th>Status</th><th>Quem</th><th>Quando</th></tr>
            </thead>
            <tbody>
              {dados.aprovacoes.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.nivel}</td>
                  <td>{a.perfil_exigido ?? '—'}</td>
                  <td className="num">{moeda(a.valor_avaliado)}</td>
                  <td><Etiqueta texto={a.status} tom={TOM_STATUS[a.status]} /></td>
                  <td>{a.usuario ?? '—'}</td>
                  <td>{dataHora(a.decidido_em)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {aba === 'timeline' && (
        !timeline ? <Vazio>Carregando timeline...</Vazio> : (
          <ol className="linha-tempo">
            {(timeline.eventos ?? []).map((e: any, i: number) => (
              <li key={i}>
                <div className="linha-tempo__topo">
                  <Etiqueta texto={e.origem} tom={e.origem === 'PEDIDO' ? 'acento' : 'info'} />
                  <strong>{String(e.evento ?? '').replace(/_/g, ' ')}</strong>
                  <span>{dataHora(e.momento)}</span>
                  {e.usuario && <span>{e.usuario}</span>}
                </div>
                {e.descricao && <p>{e.descricao}</p>}
              </li>
            ))}
          </ol>
        )
      )}

      {aba === 'documento' && (
        !documento ? <Vazio>Carregando documento...</Vazio> : (
          <div className="documento">
            <h4>Pedido de Compra {documento.cabecalho?.numero}</h4>
            <dl className="descricao">
              <dt>Fornecedor</dt><dd>{documento.cabecalho?.fornecedor} ({documento.cabecalho?.cnpj})</dd>
              <dt>Contato</dt><dd>{documento.cabecalho?.email ?? '—'} · {documento.cabecalho?.telefone ?? '—'}</dd>
              <dt>Emissao</dt><dd>{fmtData(documento.cabecalho?.data_emissao)}</dd>
              <dt>Entrega</dt><dd>{fmtData(documento.cabecalho?.data_prevista_entrega)} em {documento.cabecalho?.local_entrega ?? '—'}</dd>
              <dt>Pagamento</dt><dd>{documento.cabecalho?.condicao_pagamento ?? '—'}</dd>
            </dl>
            <table className="tabela">
              <thead>
                <tr>
                  <th>Produto</th><th className="num">Qtde</th><th>Un</th>
                  <th className="num">Preco</th><th className="num">Frete</th><th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {(documento.itens ?? []).map((i: any, k: number) => (
                  <tr key={k}>
                    <td>{i.codigo} — {i.descricao}</td>
                    <td className="num">{numero(i.quantidade, 2)}</td>
                    <td>{i.unidade ?? '—'}</td>
                    <td className="num">{moeda(i.preco_unitario)}</td>
                    <td className="num">{moeda(i.frete_rateado)}</td>
                    <td className="num">{moeda(i.valor_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="grade-indicadores" style={{ marginTop: 12 }}>
              <Indicador rotulo="Produtos" valor={moeda(documento.totais?.valor_produtos)} />
              <Indicador rotulo="Frete" valor={moeda(documento.totais?.frete)} />
              <Indicador rotulo="Impostos" valor={moeda(documento.totais?.impostos)} />
              <Indicador rotulo="Total" valor={moeda(documento.totais?.valor_total)} tom="acento" />
            </div>
            <p className="explicacao">{documento.condicoes_gerais}</p>
          </div>
        )
      )}

      {justificando && (
        <FormularioAprovacao
          validacao={validacao}
          aoFechar={() => setJustificando(false)}
          aoConfirmar={async (corpo) => {
            setJustificando(false);
            await acao(`/pedidos-compra/${id}/aprovar`, corpo, 'Pedido aprovado');
          }}
        />
      )}

      {cancelando && (
        <FormularioMotivo
          titulo="Cancelar pedido"
          motivos={MOTIVOS_CANCELAMENTO}
          aoFechar={() => setCancelando(false)}
          aoConfirmar={async (corpo) => {
            setCancelando(false);
            await acao(`/pedidos-compra/${id}/cancelar`, corpo, 'Pedido cancelado');
          }}
        />
      )}

      {confirmando && (
        <FormularioConfirmacao
          itens={dados.itens ?? []}
          aoFechar={() => setConfirmando(false)}
          aoConfirmar={async (corpo) => {
            setConfirmando(false);
            await acao(`/pedidos-compra/${id}/confirmar`, corpo, 'Confirmacao registrada');
          }}
        />
      )}
    </Modal>
  );
}

/** Secao 79: quem aprova, qual o valor, qual o impacto e qual a justificativa. */
function FormularioAprovacao({ validacao, aoFechar, aoConfirmar }: {
  validacao: any;
  aoFechar: () => void;
  aoConfirmar: (corpo: any) => Promise<void>;
}) {
  const [justificativa, setJustificativa] = useState('');
  const [excecao, setExcecao] = useState('');
  const exige = validacao?.exige_justificativa === true;

  return (
    <Modal
      titulo="Aprovar pedido"
      aoFechar={aoFechar}
      rodape={(
        <button
          type="button"
          className="botao botao--primario botao--pequeno"
          disabled={exige && justificativa.trim().length < 5}
          onClick={() => aoConfirmar({
            justificativa: justificativa || undefined,
            excecoes: excecao
              ? [{ tipo: 'APROVACAO_EXCEPCIONAL', motivo: excecao }]
              : undefined,
          })}
        >
          Confirmar aprovacao
        </button>
      )}
    >
      <dl className="descricao">
        <dt>Quem precisa aprovar</dt><dd>{validacao?.alcada_necessaria?.perfil ?? '—'}</dd>
        <dt>Valor</dt><dd>{moeda(validacao?.valor_total)}</dd>
        <dt>Impacto no estoque</dt>
        <dd>
          {(validacao?.itens ?? []).some((i: any) => i.impacto?.riscoExcesso)
            ? 'Risco de excesso em ao menos um item'
            : (validacao?.itens ?? []).some((i: any) => i.impacto?.riscoRuptura)
              ? 'Risco de ruptura em ao menos um item'
              : 'Sem risco apontado'}
        </dd>
        <dt>Desvio do planejamento</dt>
        <dd>
          {(validacao?.itens ?? []).some((i: any) => i.divergencia_planejamento)
            ? 'Quantidade diferente do planejado'
            : 'Alinhado ao planejamento'}
        </dd>
      </dl>

      {exige && <Aviso>Este pedido esta acima da necessidade ou com risco de excesso. Justifique para aprovar.</Aviso>}
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa} />
      <Entrada rotulo="Excecao (opcional)" valor={excecao} aoMudar={setExcecao} placeholder="Motivo da aprovacao excepcional" />
    </Modal>
  );
}

function FormularioConfirmacao({ itens, aoFechar, aoConfirmar }: {
  itens: any[];
  aoFechar: () => void;
  aoConfirmar: (corpo: any) => Promise<void>;
}) {
  const [numeroFornecedor, setNumeroFornecedor] = useState('');
  const [dataPrometida, setDataPrometida] = useState('');
  const [quantidades, setQuantidades] = useState<Record<number, string>>(
    Object.fromEntries(itens.map((i) => [i.id, String(num(i.quantidade_pedida))])),
  );

  return (
    <Modal
      titulo="Confirmacao do fornecedor"
      aoFechar={aoFechar}
      largo
      rodape={(
        <button
          type="button"
          className="botao botao--primario botao--pequeno"
          onClick={() => aoConfirmar({
            numero_pedido_fornecedor: numeroFornecedor || undefined,
            data_prometida: dataPrometida || undefined,
            itens: itens.map((i) => ({
              ordem_compra_item_id: Number(i.id),
              quantidade_confirmada: Number(quantidades[i.id] ?? 0),
            })),
          })}
        >
          Registrar confirmacao
        </button>
      )}
    >
      <p className="explicacao">
        O pedido original nao muda. O que entra aqui e a quantidade confirmada; a diferenca
        vira quantidade pendente e divergencia.
      </p>
      <div className="formulario-grade">
        <Entrada rotulo="Numero do pedido no fornecedor" valor={numeroFornecedor} aoMudar={setNumeroFornecedor} />
        <Entrada rotulo="Data prometida" valor={dataPrometida} aoMudar={setDataPrometida} tipo="date" />
      </div>
      <table className="tabela">
        <thead>
          <tr><th>Produto</th><th className="num">Pedida</th><th className="num">Confirmada</th></tr>
        </thead>
        <tbody>
          {itens.map((i) => (
            <tr key={i.id}>
              <td>{i.codigo} — {i.descricao}</td>
              <td className="num">{numero(i.quantidade_pedida, 2)}</td>
              <td className="num">
                <input
                  type="number"
                  value={quantidades[i.id] ?? ''}
                  onChange={(e) => setQuantidades({ ...quantidades, [i.id]: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
