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

type Aba = 'dashboard' | 'carteira' | 'calendario' | 'entregas' | 'ocorrencias'
  | 'performance' | 'parametros';

const TOM_SEMAFORO: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  VERMELHO: 'perigo', LARANJA: 'perigo', AMARELO: 'alerta', VERDE: 'acento', CINZA: 'neutro',
};

const TOM_SITUACAO: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  ATRASADO: 'perigo', EM_RISCO: 'alerta', NO_PRAZO: 'acento', ENTREGUE: 'acento',
  SEM_DADOS: 'neutro',
  CRITICO: 'perigo', ALTO: 'perigo', MEDIO: 'alerta', BAIXO: 'info',
  CRITICA: 'perigo', ALTA: 'perigo', MEDIA: 'alerta', BAIXA: 'info',
  NAO_CALCULAVEL: 'neutro', SEM_RISCO: 'acento',
  ABERTA: 'alerta', EM_TRATAMENTO: 'info', AGUARDANDO_FORNECEDOR: 'alerta',
  RESOLVIDA: 'acento', CANCELADA: 'neutro',
  VENCIDO: 'perigo', EM_ALERTA: 'alerta', DENTRO: 'acento', ENCERRADA: 'neutro',
  NAO_CONFIRMADO: 'alerta', CONFIRMADO: 'acento', CONFIRMADO_PARCIALMENTE: 'alerta',
  RECUSADO: 'perigo',
};

const STATUS_LOGISTICO = [
  'AGUARDANDO_CONFIRMACAO', 'AGUARDANDO_PRODUCAO', 'EM_PRODUCAO', 'PRONTO_EXPEDICAO',
  'EXPEDIDO', 'EM_TRANSITO', 'CHEGOU_DESTINO', 'AGUARDANDO_RECEBIMENTO',
  'RECEBIDO', 'ENTREGA_PARCIAL', 'ATRASADO', 'CANCELADO',
];

const num = (v: unknown) => Number(v ?? 0);
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)}%`);
const dias = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)} d`);

export function Entregas() {
  const [aba, setAba] = useState<Aba>('dashboard');
  const [pedidoAberto, setPedidoAberto] = useState<number | null>(null);
  const [ocorrenciaAberta, setOcorrenciaAberta] = useState<number | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Entregas"
        descricao="Acompanhamento dos pedidos, prazos, atrasos, ocorrencias e performance logistica."
      />

      <nav className="abas">
        {([
          { id: 'dashboard' as Aba, texto: 'Dashboard' },
          { id: 'carteira' as Aba, texto: 'Carteira' },
          { id: 'calendario' as Aba, texto: 'Calendario' },
          { id: 'entregas' as Aba, texto: 'Entregas' },
          { id: 'ocorrencias' as Aba, texto: 'Ocorrencias' },
          { id: 'performance' as Aba, texto: 'Performance' },
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

      {aba === 'dashboard' && <PainelGeral aoAbrirPedido={setPedidoAberto} />}
      {aba === 'carteira' && <Carteira aoAbrirPedido={setPedidoAberto} />}
      {aba === 'calendario' && <Calendario aoAbrirPedido={setPedidoAberto} />}
      {aba === 'entregas' && <ListaEntregas />}
      {aba === 'ocorrencias' && <ListaOcorrencias aoAbrir={setOcorrenciaAberta} />}
      {aba === 'performance' && <Performance />}
      {aba === 'parametros' && <Parametros />}

      {pedidoAberto !== null && (
        <DetalhePedido id={pedidoAberto} aoFechar={() => setPedidoAberto(null)} />
      )}
      {ocorrenciaAberta !== null && (
        <DetalheOcorrencia id={ocorrenciaAberta} aoFechar={() => setOcorrenciaAberta(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard (secoes 5, 6, 55, 58 e 59)
// ---------------------------------------------------------------------------

function PainelGeral({ aoAbrirPedido }: { aoAbrirPedido: (id: number) => void }) {
  const [periodo, setPeriodo] = useState('90');
  const [dados, setDados] = useState<any>(null);
  const [alertas, setAlertas] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    Promise.all([
      api<any>('/entregas/dashboard', { query: { dias: periodo } }),
      api<any>('/entregas/alertas'),
    ])
      .then(([d, a]) => { if (vivo) { setDados(d.data); setAlertas(a.data); } })
      .catch((e) => vivo && setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
    return () => { vivo = false; };
  }, [periodo]);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando indicadores...</Vazio>;

  const i = dados.indicadores ?? {};
  const otif = dados.otif_detalhado ?? {};

  return (
    <>
      <Cartao
        titulo="Situacao da carteira"
        acoes={(
          <Selecao
            rotulo="Periodo dos indicadores"
            valor={periodo}
            aoMudar={setPeriodo}
            vazio={null}
            opcoes={[
              { valor: '30', texto: '30 dias' },
              { valor: '60', texto: '60 dias' },
              { valor: '90', texto: '90 dias' },
              { valor: '180', texto: '180 dias' },
              { valor: '365', texto: '12 meses' },
            ]}
          />
        )}
      >
        <div className="grade-indicadores grade-indicadores--largo">
          <Indicador rotulo="Pedidos em aberto" valor={numero(i.pedidos_em_aberto)} />
          <Indicador rotulo="Sem confirmacao" valor={numero(i.pedidos_aguardando_confirmacao)} tom="alerta" />
          <Indicador rotulo="Confirmados" valor={numero(i.pedidos_confirmados)} />
          <Indicador rotulo="Em producao" valor={numero(i.pedidos_em_producao)} />
          <Indicador rotulo="Em transito" valor={numero(i.pedidos_em_transito)} tom="info" />
          <Indicador rotulo="Entregas hoje" valor={numero(i.entregas_hoje)} />
          <Indicador rotulo="Atrasadas" valor={numero(i.entregas_atrasadas)} tom="perigo" />
          <Indicador rotulo="Em risco" valor={numero(i.entregas_em_risco)} tom="alerta" />
          <Indicador rotulo="Parciais" valor={numero(i.entregas_parciais)} tom="alerta" />
          <Indicador rotulo="Sem previsao" valor={numero(i.pedidos_sem_previsao)} />
          <Indicador rotulo="Quantidade pendente" valor={numero(i.quantidade_pendente, 2)} />
          <Indicador rotulo="Valor pendente" valor={moeda(i.valor_pendente)} />
          <Indicador rotulo="Fornecedores com atraso" valor={numero(i.fornecedores_com_atraso)} tom="alerta" />
          <Indicador rotulo="Ocorrencias abertas" valor={numero(i.ocorrencias_abertas)} />
        </div>
      </Cartao>

      <div className="grade-2">
        <Cartao titulo="Performance de entrega">
          <div className="grade-indicadores">
            <Indicador rotulo="OTIF" valor={pct(i.otif)} tom="acento" />
            <Indicador rotulo="OTD" valor={pct(i.otd)} />
            <Indicador rotulo="In Full" valor={pct(i.in_full)} />
            <Indicador rotulo="Lead time medio" valor={dias(i.lead_time_medio)} />
            <Indicador rotulo="Atraso medio" valor={dias(i.atraso_medio)} tom="alerta" />
          </div>
          {/* Secao 79: o numero nao anda sozinho. */}
          <p className="explicacao">
            {otif.avaliadas ?? 0} entrega(s) avaliada(s) entre {fmtData(otif.periodo?.inicio)} e{' '}
            {fmtData(otif.periodo?.fim)}, sobre {otif.base_de_dados}.
            {otif.ignoradas ? ` ${otif.ignoradas} sem data de referencia ficaram de fora.` : ''}
            {' '}Pontualidade medida contra {String(otif.regra?.referencia ?? '').replace(/_/g, ' ').toLowerCase()},
            com tolerancia de {otif.regra?.toleranciaDias ?? 0} dia(s) e{' '}
            {otif.regra?.toleranciaQuantidadePercentual ?? 0}% na quantidade.
          </p>
        </Cartao>

        <Cartao titulo="Semaforo operacional">
          <div className="grade-indicadores">
            <Indicador rotulo="Verde" valor={numero(dados.semaforo?.VERDE)} tom="acento" />
            <Indicador rotulo="Amarelo" valor={numero(dados.semaforo?.AMARELO)} tom="alerta" />
            <Indicador rotulo="Laranja" valor={numero(dados.semaforo?.LARANJA)} tom="perigo" />
            <Indicador rotulo="Vermelho" valor={numero(dados.semaforo?.VERMELHO)} tom="perigo" />
            <Indicador rotulo="Cinza" valor={numero(dados.semaforo?.CINZA)} nota="Sem informacao" />
          </div>
          <table className="tabela" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Situacao</th><th className="num">Baixo</th><th className="num">Medio</th>
                <th className="num">Alto</th><th className="num">Critico</th>
                <th className="num">Sem dados</th><th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(dados.matriz ?? []).map((l: any) => (
                <tr key={l.situacao}>
                  <td><Etiqueta texto={l.situacao} tom={TOM_SITUACAO[l.situacao]} /></td>
                  <td className="num">{numero(l.BAIXO)}</td>
                  <td className="num">{numero(l.MEDIO)}</td>
                  <td className="num">{numero(l.ALTO)}</td>
                  <td className="num">{numero(l.CRITICO)}</td>
                  <td className="num">{numero(l.SEM_DADOS)}</td>
                  <td className="num"><strong>{numero(l.total)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      </div>

      <div className="grade-2">
        <Cartao titulo="Pedidos por status comercial">
          {(dados.pedidos_por_status ?? []).length === 0 ? <Vazio>Sem pedidos em aberto</Vazio> : (
            <GraficoBarras
              dados={(dados.pedidos_por_status ?? []).map((l: any) => ({
                rotulo: String(l.status).replace(/_/g, ' '), valor: num(l.quantidade),
              }))}
              formatar={(v) => numero(v)}
            />
          )}
        </Cartao>
        <Cartao titulo="Pedidos por status logistico">
          {(dados.pedidos_por_status_logistico ?? []).length === 0
            ? <Vazio>Sem pedidos em aberto</Vazio> : (
              <GraficoBarras
                dados={(dados.pedidos_por_status_logistico ?? []).map((l: any) => ({
                  rotulo: String(l.status).replace(/_/g, ' '), valor: num(l.quantidade),
                }))}
                formatar={(v) => numero(v)}
              />
            )}
        </Cartao>
      </div>

      {(dados.produtos_em_risco ?? []).length > 0 && (
        <Cartao titulo="Produtos em risco de ruptura">
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Produto</th><th>Pedido</th><th>Fornecedor</th>
                  <th className="num">Pendente</th><th className="num">Cobertura</th>
                  <th>Ruptura provavel</th><th className="num">Atraso</th>
                  <th>Risco</th><th>Impacto</th><th />
                </tr>
              </thead>
              <tbody>
                {dados.produtos_em_risco.map((p: any, k: number) => (
                  <tr key={k}>
                    <td>{p.codigo} — {p.produto}</td>
                    <td>{p.pedido}</td>
                    <td>{p.fornecedor}</td>
                    <td className="num">{numero(p.quantidade_pendente, 2)}</td>
                    <td className="num">{dias(p.cobertura_dias)}</td>
                    <td>{fmtData(p.data_provavel_ruptura)}</td>
                    <td className="num">{p.atraso_dias === null ? '—' : `${numero(p.atraso_dias)} d`}</td>
                    <td><Etiqueta texto={p.risco} tom={TOM_SITUACAO[p.risco]} /></td>
                    <td><Etiqueta texto={p.impacto} tom={TOM_SITUACAO[p.impacto]} /></td>
                    <td>
                      <button type="button" className="botao botao--pequeno"
                        onClick={() => aoAbrirPedido(Number(p.pedido_id ?? 0))}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}

      {alertas && (
        <Cartao titulo={`Alertas (${numero(alertas.total)})`}>
          <div className="grade-indicadores">
            <Indicador rotulo="Criticos" valor={numero(alertas.por_severidade?.CRITICA)} tom="perigo" />
            <Indicador rotulo="Altos" valor={numero(alertas.por_severidade?.ALTA)} tom="perigo" />
            <Indicador rotulo="Medios" valor={numero(alertas.por_severidade?.MEDIA)} tom="alerta" />
            <Indicador rotulo="Baixos" valor={numero(alertas.por_severidade?.BAIXA)} />
          </div>
          {!alertas.alertas?.length ? <Vazio>Nada pendente</Vazio> : (
            <div className="tabela-rolagem" style={{ marginTop: 10 }}>
              <table className="tabela">
                <thead>
                  <tr><th>Severidade</th><th>Tipo</th><th>Pedido</th><th>Mensagem</th><th /></tr>
                </thead>
                <tbody>
                  {alertas.alertas.slice(0, 15).map((a: any, k: number) => (
                    <tr key={k}>
                      <td><Etiqueta texto={a.severidade} tom={TOM_SITUACAO[a.severidade]} /></td>
                      <td>{String(a.tipo).replace(/_/g, ' ')}</td>
                      <td>{a.pedido ?? '—'}</td>
                      <td>{a.mensagem}</td>
                      <td>
                        {a.pedido_id && (
                          <button type="button" className="botao botao--pequeno botao--fantasma"
                            onClick={() => aoAbrirPedido(Number(a.pedido_id))}>
                            Abrir
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {alertas.alertas.length > 15 && (
                <p className="explicacao">
                  Mostrando os 15 mais graves de {numero(alertas.total)}. A aba Carteira lista
                  tudo, com filtro por situacao e prioridade.
                </p>
              )}
            </div>
          )}
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Carteira (secoes 7, 22 e 27)
// ---------------------------------------------------------------------------

function Carteira({ aoAbrirPedido }: { aoAbrirPedido: (id: number) => void }) {
  const [situacao, setSituacao] = useState('');
  const [prioridade, setPrioridade] = useState('');
  const [statusLogistico, setStatusLogistico] = useState('');
  const [origem, setOrigem] = useState('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro } = useLista<any>('/entregas/acompanhamento', {
    situacao: situacao || undefined,
    prioridade: prioridade || undefined,
    status_logistico: statusLogistico || undefined,
    origem: origem || undefined,
    busca: busca || undefined,
    pagina,
    limite: 25,
  });

  const trocar = (fn: () => void) => { fn(); setPagina(1); };

  return (
    <Cartao
      titulo="Pedidos em acompanhamento"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => trocar(() => setBusca(v))}
            placeholder="Pedido, fornecedor ou produto" />
          <Selecao rotulo="Situacao" valor={situacao} aoMudar={(v) => trocar(() => setSituacao(v))}
            opcoes={['ATRASADO', 'EM_RISCO', 'NO_PRAZO', 'SEM_DADOS']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
          <Selecao rotulo="Prioridade" valor={prioridade} aoMudar={(v) => trocar(() => setPrioridade(v))}
            opcoes={['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'].map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="Status logistico" valor={statusLogistico}
            aoMudar={(v) => trocar(() => setStatusLogistico(v))}
            opcoes={STATUS_LOGISTICO.map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
          <Selecao rotulo="Origem" valor={origem} aoMudar={(v) => trocar(() => setOrigem(v))}
            opcoes={[{ valor: 'NACIONAL', texto: 'Nacional' }, { valor: 'IMPORTADO', texto: 'Importado' }]} />
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando ? <Vazio>Carregando...</Vazio> : !itens.length ? <Vazio>Nenhum item</Vazio> : (
        <>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th />
                  <th>Pedido</th>
                  <th>Fornecedor</th>
                  <th>Produto</th>
                  <th className="num">Pendente</th>
                  <th className="num">Valor</th>
                  <th>Necessaria</th>
                  <th>Prometida</th>
                  <th>Previsao</th>
                  <th className="num">Desvio</th>
                  <th>Risco</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.ordem_compra_item_id}>
                    <td><Etiqueta texto={i.semaforo} tom={TOM_SEMAFORO[i.semaforo]} /></td>
                    <td>{i.pedido}</td>
                    <td>{i.fornecedor}</td>
                    <td>{i.produto_codigo}</td>
                    <td className="num">{numero(i.saldo?.pendenteEntrega, 2)}</td>
                    <td className="num">{moeda(i.valor_pendente)}</td>
                    <td>{fmtData(i.datas?.necessaria)}</td>
                    <td>{fmtData(i.datas?.prometida)}</td>
                    <td>
                      {i.eta?.data ? fmtData(i.eta.data) : <span className="fraco">SEM INFORMACAO</span>}
                      {i.eta?.confianca && i.eta.confianca !== 'SEM_DADOS'
                        && <> <span className="fraco">{i.eta.confianca}</span></>}
                    </td>
                    <td className="num">
                      {i.atraso?.contraPromessa === null ? '—' : (
                        <>
                          {numero(i.atraso.contraPromessa)} d
                          {i.atraso.projetado?.contraPromessa !== null
                            && i.atraso.projetado?.contraPromessa !== undefined
                            && <span className="fraco"> → {numero(i.atraso.projetado.contraPromessa)}</span>}
                        </>
                      )}
                    </td>
                    <td><Etiqueta texto={i.risco_ruptura?.nivel} tom={TOM_SITUACAO[i.risco_ruptura?.nivel]} /></td>
                    <td>
                      <button type="button" className="botao botao--pequeno"
                        onClick={() => aoAbrirPedido(Number(i.ordem_compra_id))}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao meta={meta} aoTrocar={setPagina} />
          {meta?.parametros ? (() => {
            const pm = meta.parametros as any;
            return (
              <p className="explicacao">
                Avaliado em {fmtData(String(meta.avaliado_em ?? ''))}. Risco a partir de{' '}
                {pm.dias_antecedencia_risco} dia(s) da data prevista e{' '}
                {pm.dias_sem_confirmacao} dia(s) sem confirmacao. Atraso leve ate{' '}
                {pm.faixas_atraso?.leveAte}d, moderado ate{' '}
                {pm.faixas_atraso?.moderadoAte}d, alto ate{' '}
                {pm.faixas_atraso?.altoAte}d.
              </p>
            );
          })() : null}
        </>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Calendario (secoes 20 e 21)
// ---------------------------------------------------------------------------

function Calendario({ aoAbrirPedido }: { aoAbrirPedido: (id: number) => void }) {
  const [dias, setDias] = useState('30');
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    api<any>('/entregas/calendario', { query: { dias } })
      .then((r) => vivo && setDados(r.data))
      .catch((e) => vivo && setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
    return () => { vivo = false; };
  }, [dias]);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando calendario...</Vazio>;

  const hoje = new Date().toISOString().slice(0, 10);

  return (
    <Cartao
      titulo="Calendario de entregas"
      acoes={(
        <Selecao rotulo="Janela" valor={dias} aoMudar={setDias} vazio={null}
          opcoes={[
            { valor: '7', texto: '7 dias' },
            { valor: '15', texto: '15 dias' },
            { valor: '30', texto: '30 dias' },
            { valor: '60', texto: '60 dias' },
          ]} />
      )}
    >
      <div className="grade-indicadores">
        <Indicador rotulo="Eventos" valor={numero(dados.totais?.total)} />
        <Indicador rotulo="Entregas" valor={numero(dados.totais?.entregas)} tom="acento" />
        <Indicador rotulo="Programadas" valor={numero(dados.totais?.programadas)} tom="info" />
        <Indicador rotulo="Previstas" valor={numero(dados.totais?.previstas)} />
        <Indicador rotulo="Vencidas" valor={numero(dados.totais?.vencidas)} tom="perigo" />
      </div>

      {!dados.dias?.length ? <Vazio>Nenhuma entrega no periodo</Vazio> : (
        <div className="calendario">
          {dados.dias.map((d: any) => (
            <DiaCalendario key={d.data} dia={d} hoje={hoje} aoAbrirPedido={aoAbrirPedido} />
          ))}
        </div>
      )}
      {num(dados.omitidos) > 0 && (
        <p className="explicacao">
          {numero(dados.omitidos)} evento(s) alem do limite da tela nao foram exibidos. Refine o periodo.
        </p>
      )}
    </Cartao>
  );
}

/** Um dia do calendario. Dia cheio nao vira parede: mostra o comeco e conta o resto. */
function DiaCalendario({ dia, hoje, aoAbrirPedido }: {
  dia: any; hoje: string; aoAbrirPedido: (id: number) => void;
}) {
  const [tudo, setTudo] = useState(false);
  const LIMITE = 12;
  const eventos = tudo ? dia.eventos : dia.eventos.slice(0, LIMITE);
  const escondidos = dia.eventos.length - eventos.length;

  return (
            <div className={`calendario__dia${dia.data === hoje ? ' calendario__dia--hoje' : ''}`}>
              <div className="calendario__data">
                {fmtData(dia.data)}{dia.data === hoje && <strong> · hoje</strong>}
                <span className="fraco"> {dia.eventos.length} evento(s)</span>
              </div>
              <table className="tabela">
                <tbody>
                  {eventos.map((e: any, k: number) => (
                    <tr key={k}>
                      <td><Etiqueta texto={e.origem} tom={e.origem === 'ENTREGA' ? 'acento' : 'info'} /></td>
                      <td>{e.pedido}</td>
                      <td>{e.fornecedor}</td>
                      <td className="num">{e.quantidade === null ? '—' : numero(e.quantidade, 2)}</td>
                      <td>{e.horario_previsto ?? '—'}</td>
                      <td>{e.transportadora ?? '—'}</td>
                      <td>{e.local ?? '—'}</td>
                      <td>
                        <button type="button" className="botao botao--pequeno botao--fantasma"
                          onClick={() => aoAbrirPedido(Number(e.ordem_compra_id))}>
                          Abrir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(escondidos > 0 || tudo) && (
                <button type="button" className="botao botao--pequeno botao--fantasma"
                  onClick={() => setTudo(!tudo)}>
                  {tudo ? 'Mostrar menos' : `Mostrar mais ${escondidos} evento(s)`}
                </button>
              )}
            </div>
  );
}

// ---------------------------------------------------------------------------
// Entregas registradas
// ---------------------------------------------------------------------------

function ListaEntregas() {
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [pendentes, setPendentes] = useState(false);
  const [pagina, setPagina] = useState(1);
  const { itens, meta, carregando, erro } = useLista<any>('/entregas', {
    status: status || undefined,
    busca: busca || undefined,
    apenas_pendentes_recebimento: pendentes || undefined,
    pagina,
    limite: 25,
  });

  return (
    <Cartao
      titulo="Entregas registradas"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
            placeholder="Entrega, pedido ou fornecedor" />
          <Selecao rotulo="Status" valor={status} aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={['PENDENTE', 'CONFIRMADA', 'EM_TRANSITO', 'PARCIAL', 'ENTREGUE', 'ATRASADA', 'CANCELADA']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
          <label className="checkbox">
            <input type="checkbox" checked={pendentes}
              onChange={(e) => { setPendentes(e.target.checked); setPagina(1); }} />
            Aguardando recebimento
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando ? <Vazio>Carregando...</Vazio> : !itens.length ? <Vazio>Nenhuma entrega</Vazio> : (
        <>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Entrega</th><th>Pedido</th><th>Fornecedor</th><th>Status</th>
                  <th className="num">Itens</th><th className="num">Quantidade</th>
                  <th>Prometida</th><th>Realizada</th><th className="num">Atraso</th>
                  <th>NF</th><th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((e) => (
                  <tr key={e.id}>
                    <td>{e.numero ?? `#${e.id}`}</td>
                    <td>{e.pedido}</td>
                    <td>{e.fornecedor}</td>
                    <td>
                      <Etiqueta texto={e.status} />
                      {e.pronta_recebimento && !e.recebimento_id
                        && <> <Etiqueta texto="AGUARDA RECEBIMENTO" tom="alerta" /></>}
                    </td>
                    <td className="num">{numero(e.itens)}</td>
                    <td className="num">{numero(e.quantidade_entregue, 2)}</td>
                    <td>{fmtData(e.data_prometida)}</td>
                    <td>{fmtData(e.data_real)}</td>
                    <td className="num">
                      {e.atraso_contra_promessa === null ? '—'
                        : num(e.atraso_contra_promessa) > 0
                          ? <strong className="texto-alerta">{numero(e.atraso_contra_promessa)} d</strong>
                          : `${numero(e.atraso_contra_promessa)} d`}
                    </td>
                    <td>{e.numero_nota_fiscal ?? '—'}</td>
                    <td>{e.motivo_atraso ?? '—'}</td>
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
// Ocorrencias (secoes 30 e 31)
// ---------------------------------------------------------------------------

function ListaOcorrencias({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const [prioridade, setPrioridade] = useState('');
  const [slaVencido, setSlaVencido] = useState(false);
  const [pagina, setPagina] = useState(1);
  const { itens, meta, carregando, erro } = useLista<any>('/entregas/ocorrencias', {
    status: status || undefined,
    prioridade: prioridade || undefined,
    apenas_sla_vencido: slaVencido || undefined,
    pagina,
    limite: 25,
  });

  return (
    <Cartao
      titulo="Ocorrencias logisticas"
      acoes={(
        <div className="filtros">
          <Selecao rotulo="Status" valor={status} aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={['ABERTA', 'EM_TRATAMENTO', 'AGUARDANDO_FORNECEDOR', 'RESOLVIDA', 'CANCELADA']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
          <Selecao rotulo="Prioridade" valor={prioridade}
            aoMudar={(v) => { setPrioridade(v); setPagina(1); }}
            opcoes={['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'].map((s) => ({ valor: s, texto: s }))} />
          <label className="checkbox">
            <input type="checkbox" checked={slaVencido}
              onChange={(e) => { setSlaVencido(e.target.checked); setPagina(1); }} />
            SLA vencido
          </label>
        </div>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando ? <Vazio>Carregando...</Vazio> : !itens.length ? <Vazio>Nenhuma ocorrencia</Vazio> : (
        <>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Numero</th><th>Pedido</th><th>Fornecedor</th><th>Tipo</th>
                  <th>Prioridade</th><th>Status</th><th>SLA</th><th>Abertura</th>
                  <th className="num">Acoes</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((o) => (
                  <tr key={o.id}>
                    <td>{o.numero}</td>
                    <td>{o.pedido}</td>
                    <td>{o.fornecedor}</td>
                    <td>{String(o.tipo).replace(/_/g, ' ')}</td>
                    <td><Etiqueta texto={o.prioridade} tom={TOM_SITUACAO[o.prioridade]} /></td>
                    <td><Etiqueta texto={o.status} tom={TOM_SITUACAO[o.status]} /></td>
                    <td>
                      <Etiqueta texto={o.sla?.situacao ?? 'SEM_SLA'} tom={TOM_SITUACAO[o.sla?.situacao]} />
                      {o.sla?.percentualConsumido !== null && o.sla?.percentualConsumido !== undefined
                        && <span className="fraco"> {numero(o.sla.percentualConsumido)}%</span>}
                    </td>
                    <td>{dataHora(o.data_abertura)}</td>
                    <td className="num">{numero(o.acoes_pendentes)}</td>
                    <td>
                      <button type="button" className="botao botao--pequeno"
                        onClick={() => aoAbrir(Number(o.id))}>
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

function DetalheOcorrencia({ id, aoFechar }: { id: number; aoFechar: () => void }) {
  const { pode } = useAuth();
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [solucao, setSolucao] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = () => api<any>(`/entregas/ocorrencias/${id}`)
    .then((r) => setDados(r.data))
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));

  useEffect(() => { void carregar(); }, [id]);

  const tratar = async (status: string) => {
    setOcupado(true); setErro(null);
    try {
      await api(`/entregas/ocorrencias/${id}/tratar`, {
        metodo: 'POST',
        corpo: { status, solucao: solucao || undefined },
      });
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel concluir');
    } finally {
      setOcupado(false);
    }
  };

  if (!dados) {
    return (
      <Modal titulo="Ocorrencia" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  const aberta = !['RESOLVIDA', 'CANCELADA'].includes(dados.status);

  return (
    <Modal
      titulo={`Ocorrencia ${dados.numero} — ${dados.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={aberta && pode('entregas.ocorrencias') ? (
        <>
          <button type="button" className="botao botao--pequeno" disabled={ocupado}
            onClick={() => tratar('EM_TRATAMENTO')}>
            Em tratamento
          </button>
          <button type="button" className="botao botao--pequeno" disabled={ocupado}
            onClick={() => tratar('AGUARDANDO_FORNECEDOR')}>
            Aguardando fornecedor
          </button>
          <button type="button" className="botao botao--pequeno botao--primario"
            disabled={ocupado || solucao.trim().length < 5}
            title={solucao.trim().length < 5 ? 'Descreva a solucao para resolver' : undefined}
            onClick={() => tratar('RESOLVIDA')}>
            Resolver
          </button>
        </>
      ) : undefined}
    >
      {erro && <Aviso>{erro}</Aviso>}

      <div className="grade-indicadores">
        <Indicador rotulo="Status" valor={<Etiqueta texto={dados.status} tom={TOM_SITUACAO[dados.status]} />} />
        <Indicador rotulo="Prioridade" valor={<Etiqueta texto={dados.prioridade} tom={TOM_SITUACAO[dados.prioridade]} />} />
        <Indicador rotulo="SLA" valor={<Etiqueta texto={dados.sla?.situacao} tom={TOM_SITUACAO[dados.sla?.situacao]} />}
          nota={dados.sla?.horasRestantes !== null && dados.sla?.horasRestantes !== undefined
            ? `${numero(dados.sla.horasRestantes, 1)} h restantes` : undefined} />
        <Indicador rotulo="Abertura" valor={dataHora(dados.data_abertura)} />
        <Indicador rotulo="Prazo" valor={dataHora(dados.prazo_resolucao)} />
        <Indicador rotulo="Responsavel" valor={dados.responsavel ?? '—'} />
      </div>

      <dl className="descricao">
        <dt>Pedido</dt><dd>{dados.pedido}</dd>
        <dt>Produto</dt><dd>{dados.produto ?? 'Pedido inteiro'}</dd>
        <dt>Tipo</dt><dd>{String(dados.tipo).replace(/_/g, ' ')}</dd>
        <dt>Motivo</dt><dd>{dados.motivo ?? '—'}</dd>
        <dt>Descricao</dt><dd>{dados.descricao}</dd>
        {dados.solucao && (<><dt>Solucao</dt><dd>{dados.solucao}</dd></>)}
      </dl>

      {aberta && pode('entregas.ocorrencias') && (
        <Entrada rotulo="Solucao (obrigatoria para resolver)" valor={solucao} aoMudar={setSolucao} />
      )}

      <Cartao titulo="Acoes">
        {!dados.acoes?.length ? <Vazio>Nenhuma acao registrada</Vazio> : (
          <table className="tabela">
            <thead>
              <tr><th>Tipo</th><th>Descricao</th><th>Responsavel</th><th>Prazo</th><th>Status</th><th>Resultado</th></tr>
            </thead>
            <tbody>
              {dados.acoes.map((a: any) => (
                <tr key={a.id}>
                  <td>{String(a.tipo).replace(/_/g, ' ')}</td>
                  <td>{a.descricao ?? '—'}</td>
                  <td>{a.responsavel ?? '—'}</td>
                  <td>{fmtData(a.prazo)}</td>
                  <td><Etiqueta texto={a.status} /></td>
                  <td>{a.resultado ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Cartao>

      <Cartao titulo="Contatos com o fornecedor">
        {!dados.contatos?.length ? <Vazio>Nenhum contato registrado</Vazio> : (
          <ol className="linha-tempo">
            {dados.contatos.map((c: any) => (
              <li key={c.id}>
                <div className="linha-tempo__topo">
                  <Etiqueta texto={c.canal} tom="info" />
                  <strong>{c.assunto}</strong>
                  <span>{dataHora(c.data_contato)}</span>
                </div>
                {c.resposta && <p>{c.resposta}</p>}
                {c.nova_previsao && (
                  <div className="linha-tempo__dados">
                    <span>Nova previsao informada: {fmtData(c.nova_previsao)}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Cartao>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Performance (secoes 40 a 43 e 81)
// ---------------------------------------------------------------------------

function Performance() {
  const [dias, setDias] = useState('90');
  const [dados, setDados] = useState<any>(null);
  const [atrasos, setAtrasos] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setDados(null);
    Promise.all([
      api<any>('/indicadores/performance-entrega', { query: { dias } }),
      api<any>('/indicadores/atrasos', { query: { dias } }),
    ])
      .then(([p, a]) => { if (vivo) { setDados(p.data); setAtrasos(a.data); } })
      .catch((e) => vivo && setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
    return () => { vivo = false; };
  }, [dias]);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando performance...</Vazio>;

  return (
    <>
      <Cartao
        titulo="Performance logistica por fornecedor"
        acoes={(
          <Selecao rotulo="Periodo" valor={dias} aoMudar={setDias} vazio={null}
            opcoes={[
              { valor: '30', texto: '30 dias' },
              { valor: '60', texto: '60 dias' },
              { valor: '90', texto: '90 dias' },
              { valor: '180', texto: '180 dias' },
              { valor: '365', texto: '365 dias' },
            ]} />
        )}
      >
        <p className="explicacao">
          Periodo de {fmtData(dados.periodo?.inicio)} a {fmtData(dados.periodo?.fim)}.{' '}
          {dados.observacao} Pontualidade contra{' '}
          {String(dados.regra?.referencia ?? '').replace(/_/g, ' ').toLowerCase()}, tolerancia de{' '}
          {dados.regra?.toleranciaDias}d e {dados.regra?.toleranciaQuantidadePercentual}% na
          quantidade. Abaixo de {dados.minimo_entregas} entregas a amostra e considerada insuficiente.
        </p>

        {!dados.fornecedores?.length ? <Vazio>Nenhuma entrega no periodo</Vazio> : (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Fornecedor</th>
                  <th className="num">Entregas</th>
                  <th className="num">OTIF</th>
                  <th className="num">OTD</th>
                  <th className="num">In Full</th>
                  <th className="num">Atraso medio</th>
                  <th className="num">Atraso max</th>
                  <th className="num">Lead time</th>
                  <th className="num">Parciais</th>
                  <th className="num">Alterou prazo</th>
                  <th className="num">Sem confirmar</th>
                  <th className="num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {dados.fornecedores.map((f: any) => (
                  <tr key={f.fornecedor_id}>
                    <td>
                      {f.fornecedor}
                      {!f.amostra_suficiente
                        && <> <Etiqueta texto="AMOSTRA INSUFICIENTE" tom="alerta" /></>}
                    </td>
                    <td className="num">{numero(f.entregas_avaliadas)}</td>
                    <td className="num">{pct(f.otif)}</td>
                    <td className="num">{pct(f.otd)}</td>
                    <td className="num">{pct(f.in_full)}</td>
                    <td className="num">{dias_(f.atraso_medio)}</td>
                    <td className="num">{dias_(f.atraso_maximo)}</td>
                    <td className="num">{dias_(f.lead_time?.media)}</td>
                    <td className="num">{pct(f.percentual_parciais)}</td>
                    <td className="num">{pct(f.percentual_alteracoes_prazo)}</td>
                    <td className="num">{pct(f.percentual_sem_confirmacao)}</td>
                    <td className="num">{moeda(f.valor_comprado)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>

      {atrasos && (
        <div className="grade-2">
          <Cartao titulo="Distribuicao dos atrasos">
            <div className="grade-indicadores">
              <Indicador rotulo="Entregas" valor={numero(atrasos.entregas_no_periodo)} />
              <Indicador rotulo="Atrasadas" valor={numero(atrasos.entregas_atrasadas)} tom="perigo" />
              <Indicador rotulo="% atrasadas" valor={pct(atrasos.percentual_atrasadas)} />
              <Indicador rotulo="Atraso medio" valor={dias_(atrasos.atraso_medio)} />
              <Indicador rotulo="Mediana" valor={dias_(atrasos.atraso_mediano)} />
              <Indicador rotulo="Maximo" valor={dias_(atrasos.atraso_maximo)} tom="alerta" />
            </div>
            <GraficoBarras
              dados={Object.entries(atrasos.faixas ?? {}).map(([k, v]) => ({
                rotulo: k.replace(/_/g, ' '), valor: Number(v),
              }))}
              formatar={(v) => numero(v)}
            />
            <p className="explicacao">
              Leve ate {atrasos.limites?.leveAte}d, moderado ate {atrasos.limites?.moderadoAte}d,
              alto ate {atrasos.limites?.altoAte}d, critico acima disso.
            </p>
          </Cartao>

          <Cartao titulo="Motivos de atraso">
            {!atrasos.motivos?.length ? <Vazio>Nenhum motivo registrado no periodo</Vazio> : (
              <table className="tabela">
                <thead>
                  <tr><th>Motivo</th><th>Responsavel</th><th className="num">Ocorrencias</th></tr>
                </thead>
                <tbody>
                  {atrasos.motivos.map((m: any) => (
                    <tr key={m.codigo}>
                      <td>{m.descricao}</td>
                      <td><Etiqueta texto={m.responsavel} /></td>
                      <td className="num">{numero(m.ocorrencias)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Cartao>
        </div>
      )}
    </>
  );
}

const dias_ = (v: unknown) => (v === null || v === undefined ? '—' : `${numero(v, 1)} d`);

// ---------------------------------------------------------------------------
// Parametros (secao 4, item 18)
// ---------------------------------------------------------------------------

function Parametros() {
  const { pode } = useAuth();
  const [itens, setItens] = useState<any[]>([]);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = () => api<any[]>('/entregas/parametros')
    .then((r) => {
      setItens(r.data);
      setValores(Object.fromEntries(r.data.map((p) => [p.chave, String(p.valor)])));
    })
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));

  useEffect(() => { void carregar(); }, []);

  const salvar = async () => {
    setOcupado(true); setErro(null); setAviso(null);
    const mudados = itens
      .filter((p) => valores[p.chave] !== String(p.valor))
      .map((p) => ({ chave: p.chave, valor: valores[p.chave]! }));
    if (!mudados.length) { setAviso('Nada mudou'); setOcupado(false); return; }
    try {
      const r = await api<any>('/entregas/parametros', { metodo: 'PUT', corpo: { parametros: mudados } });
      setAviso(`${r.data.atualizados.length} parametro(s) atualizado(s)`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel salvar');
    } finally {
      setOcupado(false);
    }
  };

  const editavel = pode('entregas.parametrizar');

  return (
    <Cartao
      titulo="Parametros de entrega"
      acoes={editavel ? (
        <button type="button" className="botao botao--primario botao--pequeno"
          disabled={ocupado} onClick={salvar}>
          Salvar
        </button>
      ) : undefined}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      <p className="explicacao">
        Estes valores alimentam o semaforo, as faixas de atraso, o risco de ruptura, o SLA das
        ocorrencias e a metodologia do OTIF. Mudar um deles muda o que as telas mostram — e a
        regra usada sai junto dos indicadores.
      </p>
      {!itens.length ? <Vazio>Carregando...</Vazio> : (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr><th>Parametro</th><th>Descricao</th><th className="num">Valor</th></tr>
            </thead>
            <tbody>
              {itens.map((p) => (
                <tr key={p.chave}>
                  <td className="mono">{p.chave.replace('entrega.', '')}</td>
                  <td>{p.descricao}</td>
                  <td className="num">
                    {editavel ? (
                      <input
                        value={valores[p.chave] ?? ''}
                        onChange={(e) => setValores({ ...valores, [p.chave]: e.target.value })}
                      />
                    ) : p.valor}
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
// Detalhe do pedido (secoes 8, 33, 56 e 79)
// ---------------------------------------------------------------------------

type AbaPedido = 'itens' | 'entregas' | 'prazos' | 'timeline' | 'risco';

function DetalhePedido({ id, aoFechar }: { id: number; aoFechar: () => void }) {
  const { pode } = useAuth();
  const [aba, setAba] = useState<AbaPedido>('itens');
  const [dados, setDados] = useState<any>(null);
  const [risco, setRisco] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [formPrazo, setFormPrazo] = useState(false);
  const [formStatus, setFormStatus] = useState(false);

  const carregar = () => api<any>(`/pedidos-compra/${id}/entrega`)
    .then((r) => setDados(r.data))
    .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));

  useEffect(() => { void carregar(); }, [id]);

  useEffect(() => {
    if (aba === 'risco' && !risco) {
      api<any>(`/pedidos-compra/${id}/risco`).then((r) => setRisco(r.data)).catch(() => {});
    }
  }, [aba, id, risco]);

  const acao = async (caminho: string, corpo: unknown, sucesso: string) => {
    setOcupado(true); setErro(null); setAviso(null);
    try {
      await api(caminho, { metodo: 'POST', corpo });
      setAviso(sucesso);
      setRisco(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel concluir');
    } finally {
      setOcupado(false);
    }
  };

  if (!dados) {
    return (
      <Modal titulo="Acompanhamento" aoFechar={aoFechar} largo>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando...</Vazio>}
      </Modal>
    );
  }

  const p = dados.pedido;
  const r = dados.resumo;

  return (
    <Modal
      titulo={`Pedido ${p.numero} — ${p.fornecedor}`}
      aoFechar={aoFechar}
      largo
      rodape={(
        <>
          {pode('entregas.previsao') && (
            <>
              <button type="button" className="botao botao--pequeno" disabled={ocupado}
                onClick={() => acao(`/pedidos-compra/${id}/previsao`, { recalcular: true },
                  'Previsao recalculada')}>
                Recalcular previsao
              </button>
              <button type="button" className="botao botao--pequeno" disabled={ocupado}
                onClick={() => setFormPrazo(true)}>
                Alterar prazo
              </button>
            </>
          )}
          {pode('entregas.registrar') && (
            <button type="button" className="botao botao--pequeno" disabled={ocupado}
              onClick={() => setFormStatus(true)}>
              Atualizar status
            </button>
          )}
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <div className="grade-indicadores grade-indicadores--largo">
        <Indicador rotulo="Situacao" valor={<Etiqueta texto={r.situacao} tom={TOM_SITUACAO[r.situacao]} />} />
        <Indicador rotulo="Semaforo" valor={<Etiqueta texto={r.semaforo} tom={TOM_SEMAFORO[r.semaforo]} />} />
        <Indicador rotulo="Status comercial" valor={<Etiqueta texto={p.status} />} />
        <Indicador rotulo="Status logistico"
          valor={p.status_logistico
            ? <Etiqueta texto={p.status_logistico} tom="info" />
            : <span className="fraco">SEM INFORMACAO</span>} />
        <Indicador rotulo="Confirmacao"
          valor={<Etiqueta texto={p.status_confirmacao} tom={TOM_SITUACAO[p.status_confirmacao]} />} />
        <Indicador rotulo="Atendido" valor={pct(r.percentual_atendido)} />
        <Indicador rotulo="Pendente" valor={numero(r.quantidade_pendente, 2)}
          nota={moeda(r.valor_pendente)} />
        <Indicador rotulo="Maior atraso" valor={`${numero(r.maior_atraso_dias)} d`}
          tom={num(r.maior_atraso_dias) > 0 ? 'perigo' : 'neutro'} />
      </div>

      <div className="grade-2">
        <Cartao titulo="Datas">
          <dl className="descricao">
            <dt>Emissao</dt><dd>{fmtData(p.datas?.emissao)}</dd>
            <dt>Envio</dt><dd>{fmtData(p.datas?.envio)}</dd>
            <dt>Confirmacao</dt><dd>{fmtData(p.datas?.confirmacao)}</dd>
            <dt>Necessaria</dt><dd>{fmtData(p.datas?.necessaria)}</dd>
            <dt>Prometida (original)</dt><dd>{fmtData(p.datas?.prometida_original)}</dd>
            <dt>Prometida (atual)</dt><dd>{fmtData(p.datas?.prometida)}</dd>
            <dt>ETA original</dt><dd>{fmtData(p.datas?.eta_original)}</dd>
            <dt>ETA atual</dt>
            <dd>
              {p.datas?.eta_atual ? fmtData(p.datas.eta_atual)
                : <span className="fraco">SEM INFORMACAO</span>}
              {p.eta_fonte && <span className="fraco"> · {String(p.eta_fonte).replace(/_/g, ' ')} · confianca {p.eta_confianca}</span>}
            </dd>
            <dt>Entrega efetiva</dt><dd>{fmtData(p.datas?.efetiva)}</dd>
          </dl>
        </Cartao>

        <Cartao titulo="Fornecedor e transporte">
          <dl className="descricao">
            <dt>Fornecedor</dt><dd>{p.fornecedor} ({p.cnpj})</dd>
            <dt>Contato</dt><dd>{p.email ?? '—'} · {p.telefone ?? '—'}</dd>
            <dt>Origem</dt><dd>{p.origem_fornecedor}</dd>
            <dt>Comprador</dt><dd>{p.comprador ?? '—'}</dd>
            <dt>Pedido no fornecedor</dt><dd>{p.numero_pedido_fornecedor ?? '—'}</dd>
            <dt>Local de entrega</dt><dd>{p.local_entrega ?? '—'}</dd>
            <dt>Motivo de atraso</dt><dd>{p.motivo_atraso ?? '—'}</dd>
          </dl>
          {(dados.transportes ?? []).length > 0 && (
            <table className="tabela" style={{ marginTop: 8 }}>
              <thead>
                <tr><th>Transportadora</th><th>Modal</th><th>Rastreio</th><th>Coleta</th><th>Prevista</th></tr>
              </thead>
              <tbody>
                {dados.transportes.map((t: any) => (
                  <tr key={t.id}>
                    <td>{t.transportadora ?? '—'}</td>
                    <td>{t.modal ?? '—'}</td>
                    <td className="mono">{t.codigo_rastreio ?? '—'}</td>
                    <td>{fmtData(t.data_coleta)}</td>
                    <td>{fmtData(t.data_prevista ?? t.eta_final)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Cartao>
      </div>

      <nav className="abas">
        {([
          { id: 'itens' as AbaPedido, texto: 'Itens' },
          { id: 'entregas' as AbaPedido, texto: `Entregas (${(dados.entregas ?? []).length})` },
          { id: 'prazos' as AbaPedido, texto: 'Prazos e previsoes' },
          { id: 'timeline' as AbaPedido, texto: 'Historico' },
          { id: 'risco' as AbaPedido, texto: 'Risco' },
        ]).map((a) => (
          <button key={a.id} type="button"
            className={`abas__item${aba === a.id ? ' abas__item--ativo' : ''}`}
            onClick={() => setAba(a.id)}>
            {a.texto}
          </button>
        ))}
      </nav>

      {aba === 'itens' && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th />
                <th>Produto</th>
                <th className="num">Pedida</th>
                <th className="num">Confirmada</th>
                <th className="num">Entregue</th>
                <th className="num">Pendente</th>
                <th className="num">Atendido</th>
                <th>Necessaria</th>
                <th>Prometida</th>
                <th>Previsao</th>
                <th className="num">Atraso</th>
                <th>Risco</th>
                <th>Impacto</th>
              </tr>
            </thead>
            <tbody>
              {(dados.itens ?? []).map((i: any) => (
                <tr key={i.ordem_compra_item_id}>
                  <td><Etiqueta texto={i.semaforo} tom={TOM_SEMAFORO[i.semaforo]} /></td>
                  <td>{i.produto_codigo} — {i.produto}</td>
                  <td className="num">{numero(i.saldo?.pedida, 2)}</td>
                  <td className="num">{numero(i.saldo?.confirmada, 2)}</td>
                  <td className="num">{numero(i.saldo?.entregue, 2)}</td>
                  <td className="num">{numero(i.saldo?.pendenteEntrega, 2)}</td>
                  <td className="num">{pct(i.saldo?.percentualAtendido)}</td>
                  <td>{fmtData(i.datas?.necessaria)}</td>
                  <td>{fmtData(i.datas?.prometida)}</td>
                  <td>{i.eta?.data ? fmtData(i.eta.data) : <span className="fraco">—</span>}</td>
                  <td className="num">
                    {i.atraso?.contraPromessa === null ? '—' : `${numero(i.atraso.contraPromessa)} d`}
                  </td>
                  <td><Etiqueta texto={i.risco_ruptura?.nivel} tom={TOM_SITUACAO[i.risco_ruptura?.nivel]} /></td>
                  <td><Etiqueta texto={i.impacto} tom={TOM_SITUACAO[i.impacto]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {(dados.itens ?? []).some((i: any) => (i.motivos_risco ?? []).length > 0) && (
            <Cartao titulo="Por que estes itens estao sinalizados">
              <ul className="lista-alertas">
                {(dados.itens ?? []).flatMap((i: any) =>
                  (i.motivos_risco ?? []).map((m: any, k: number) => (
                    <li key={`${i.ordem_compra_item_id}-${k}`}>
                      <Etiqueta texto={m.regra} tom="alerta" />
                      <strong>{i.produto_codigo}:</strong> {m.detalhe}
                    </li>
                  )))}
              </ul>
            </Cartao>
          )}
        </div>
      )}

      {aba === 'entregas' && (
        !dados.entregas?.length ? <Vazio>Nenhuma entrega registrada</Vazio> : (
          <>
            {dados.entregas.map((e: any) => (
              <Cartao key={e.id} titulo={`${e.numero ?? `Entrega #${e.id}`} — ${fmtData(e.data_real ?? e.data_prevista)}`}>
                <div className="grade-indicadores">
                  <Indicador rotulo="Status" valor={<Etiqueta texto={e.status} />} />
                  <Indicador rotulo="Quantidade" valor={numero(e.quantidade_entregue ?? e.quantidade_prevista, 2)} />
                  <Indicador rotulo="Atraso" valor={e.dias_atraso === null ? '—' : `${numero(e.dias_atraso)} d`} />
                  <Indicador rotulo="Nota fiscal" valor={e.numero_nota_fiscal ?? '—'} />
                  <Indicador rotulo="Transportadora" valor={e.transportadora ?? '—'} />
                  <Indicador rotulo="Motivo" valor={e.motivo_atraso ?? '—'} />
                </div>
                {(e.itens ?? []).length > 0 && (
                  <table className="tabela">
                    <thead>
                      <tr><th>Produto</th><th className="num">Quantidade</th><th>Data efetiva</th></tr>
                    </thead>
                    <tbody>
                      {e.itens.map((i: any) => (
                        <tr key={i.id}>
                          <td>{i.codigo} — {i.descricao}</td>
                          <td className="num">{numero(i.quantidade, 2)}</td>
                          <td>{fmtData(i.data_efetiva)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Cartao>
            ))}
            {(dados.programacoes ?? []).length > 0 && (
              <Cartao titulo="Programacoes">
                <table className="tabela">
                  <thead>
                    <tr><th>Data</th><th>Horario</th><th>Local</th><th>Transportadora</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {dados.programacoes.map((pr: any) => (
                      <tr key={pr.id}>
                        <td>{fmtData(pr.data_prevista)}</td>
                        <td>{pr.horario_previsto ?? '—'}</td>
                        <td>{pr.local ?? '—'}</td>
                        <td>{pr.transportadora ?? '—'}</td>
                        <td><Etiqueta texto={pr.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Cartao>
            )}
          </>
        )
      )}

      {aba === 'prazos' && (
        <>
          <Cartao titulo="Alteracoes de prazo">
            {!dados.alteracoes_prazo?.length ? <Vazio>Nenhuma alteracao registrada</Vazio> : (
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Quando</th><th>Campo</th><th>De</th><th>Para</th>
                    <th className="num">Dias</th><th>Motivo</th><th>Quem</th><th />
                  </tr>
                </thead>
                <tbody>
                  {dados.alteracoes_prazo.map((a: any) => (
                    <tr key={a.id}>
                      <td>{dataHora(a.created_at)}</td>
                      <td>{String(a.campo).replace(/_/g, ' ')}</td>
                      <td>{fmtData(a.data_anterior)}</td>
                      <td>{fmtData(a.data_nova)}</td>
                      <td className="num">
                        {a.diferenca_dias === null ? '—'
                          : `${num(a.diferenca_dias) > 0 ? '+' : ''}${numero(a.diferenca_dias)}`}
                      </td>
                      <td>{a.motivo ?? a.justificativa ?? '—'}</td>
                      <td>{a.usuario ?? '—'}</td>
                      <td>{a.ultrapassa_necessidade
                        && <Etiqueta texto="PASSOU DA NECESSIDADE" tom="perigo" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Cartao>

          <Cartao titulo="Historico de previsao (ETA)">
            {!dados.previsoes?.length ? <Vazio>Nenhuma previsao registrada</Vazio> : (
              <ol className="linha-tempo">
                {dados.previsoes.map((pv: any) => (
                  <li key={pv.id}>
                    <div className="linha-tempo__topo">
                      <strong>{pv.eta ? fmtData(pv.eta) : 'SEM PREVISAO'}</strong>
                      <Etiqueta texto={pv.fonte} tom="info" />
                      <Etiqueta texto={pv.confianca} tom={pv.confianca === 'ALTA' ? 'acento'
                        : pv.confianca === 'SEM_DADOS' ? 'neutro' : 'alerta'} />
                      {pv.variacao_dias !== null && (
                        <span className="num">
                          {num(pv.variacao_dias) > 0 ? '+' : ''}{numero(pv.variacao_dias)} d
                        </span>
                      )}
                      <span>{dataHora(pv.created_at)}</span>
                    </div>
                    <p>{pv.memoria?.regra ?? pv.justificativa ?? ''}</p>
                  </li>
                ))}
              </ol>
            )}
          </Cartao>
        </>
      )}

      {aba === 'timeline' && (
        <>
          <Cartao titulo="Status logistico">
            {!dados.status_logistico_historico?.length ? <Vazio>Sem mudancas registradas</Vazio> : (
              <ol className="linha-tempo">
                {dados.status_logistico_historico.map((h: any) => (
                  <li key={h.id}>
                    <div className="linha-tempo__topo">
                      <strong>{String(h.status_novo).replace(/_/g, ' ')}</strong>
                      {h.status_anterior && (
                        <span className="fraco">de {String(h.status_anterior).replace(/_/g, ' ')}</span>
                      )}
                      <span>{dataHora(h.created_at)}</span>
                    </div>
                    {h.justificativa && <p>{h.justificativa}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Cartao>

          <Cartao titulo="Contatos com o fornecedor">
            {!dados.contatos?.length ? <Vazio>Nenhum contato registrado</Vazio> : (
              <ol className="linha-tempo">
                {dados.contatos.map((c: any) => (
                  <li key={c.id}>
                    <div className="linha-tempo__topo">
                      <Etiqueta texto={c.canal} tom="info" />
                      <strong>{c.assunto}</strong>
                      <span>{dataHora(c.data_contato)}</span>
                    </div>
                    {c.resposta && <p>{c.resposta}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Cartao>

          <Cartao titulo="Ocorrencias">
            {!dados.ocorrencias?.length ? <Vazio>Nenhuma ocorrencia</Vazio> : (
              <table className="tabela">
                <thead>
                  <tr><th>Numero</th><th>Tipo</th><th>Prioridade</th><th>Status</th><th>Abertura</th></tr>
                </thead>
                <tbody>
                  {dados.ocorrencias.map((o: any) => (
                    <tr key={o.id}>
                      <td>{o.numero}</td>
                      <td>{String(o.tipo).replace(/_/g, ' ')}</td>
                      <td><Etiqueta texto={o.prioridade} tom={TOM_SITUACAO[o.prioridade]} /></td>
                      <td><Etiqueta texto={o.status} tom={TOM_SITUACAO[o.status]} /></td>
                      <td>{dataHora(o.data_abertura)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Cartao>
        </>
      )}

      {aba === 'risco' && (
        !risco ? <Vazio>Carregando risco...</Vazio> : (
          <>
            <div className="grade-indicadores">
              <Indicador rotulo="Risco geral"
                valor={<Etiqueta texto={risco.risco_geral} tom={TOM_SITUACAO[risco.risco_geral]} />} />
              <Indicador rotulo="Cobertura critica" valor={`${risco.faixas?.criticaAte} d`} />
              <Indicador rotulo="Cobertura alta" valor={`${risco.faixas?.altaAte} d`} />
              <Indicador rotulo="Cobertura media" valor={`${risco.faixas?.mediaAte} d`} />
            </div>
            <div className="tabela-rolagem">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Produto</th><th>ABC</th><th className="num">Pendente</th>
                    <th className="num">Disponivel</th><th className="num">Demanda/dia</th>
                    <th className="num">Cobertura</th><th>Ruptura provavel</th>
                    <th>Chega a tempo</th><th>Risco</th><th>Impacto</th>
                  </tr>
                </thead>
                <tbody>
                  {(risco.itens ?? []).map((i: any) => (
                    <tr key={i.produto_id}>
                      <td>{i.codigo} — {i.descricao}</td>
                      <td>{i.classificacao_abc ?? '—'}</td>
                      <td className="num">{numero(i.quantidade_pendente, 2)}</td>
                      <td className="num">{numero(i.estoque?.disponivel, 2)}</td>
                      <td className="num">
                        {i.demanda?.media_diaria === null ? '—' : numero(i.demanda.media_diaria, 2)}
                      </td>
                      <td className="num">
                        {i.risco?.coberturaDias === null ? '—' : dias_(i.risco.coberturaDias)}
                      </td>
                      <td>
                        {i.risco?.dataProvavelRuptura
                          ? fmtData(i.risco.dataProvavelRuptura)
                          : <span className="fraco">NAO CALCULAVEL</span>}
                      </td>
                      <td>
                        {i.risco?.chegaATempo === null ? '—'
                          : <Etiqueta texto={i.risco.chegaATempo ? 'SIM' : 'NAO'}
                              tom={i.risco.chegaATempo ? 'acento' : 'perigo'} />}
                      </td>
                      <td><Etiqueta texto={i.risco?.nivel} tom={TOM_SITUACAO[i.risco?.nivel]} /></td>
                      <td><Etiqueta texto={i.impacto} tom={TOM_SITUACAO[i.impacto]} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="explicacao">
              {(risco.itens ?? [])[0]?.risco?.memoria?.regra
                ?? 'Cobertura = estoque disponivel / demanda media diaria'}
              . Sem demanda apurada a cobertura nao e calculavel e nenhuma data e estimada.
            </p>
          </>
        )
      )}

      {formPrazo && (
        <FormularioPrazo
          pedidoId={id}
          aoFechar={() => setFormPrazo(false)}
          aoSalvar={async () => { setFormPrazo(false); setRisco(null); await carregar(); }}
        />
      )}

      {formStatus && (
        <FormularioStatus
          aoFechar={() => setFormStatus(false)}
          aoConfirmar={async (corpo) => {
            setFormStatus(false);
            await acao(`/pedidos-compra/${id}/status-logistico`, corpo, 'Status atualizado');
          }}
        />
      )}
    </Modal>
  );
}

function FormularioPrazo({ pedidoId, aoFechar, aoSalvar }: {
  pedidoId: number; aoFechar: () => void; aoSalvar: () => Promise<void>;
}) {
  const [campo, setCampo] = useState('DATA_PROMETIDA');
  const [dataNova, setDataNova] = useState('');
  const [motivo, setMotivo] = useState('');
  const [justificativa, setJustificativa] = useState('');
  const [motivos, setMotivos] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    api<any[]>('/entregas/motivos-atraso').then((r) => setMotivos(r.data)).catch(() => {});
  }, []);

  const enviar = async () => {
    setOcupado(true); setErro(null);
    try {
      await api(`/pedidos-compra/${pedidoId}/alterar-prazo`, {
        metodo: 'POST',
        corpo: {
          campo,
          data_nova: dataNova,
          motivo_codigo: motivo || undefined,
          justificativa,
        },
      });
      await aoSalvar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel alterar o prazo');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal
      titulo="Alterar prazo"
      aoFechar={aoFechar}
      rodape={(
        <button type="button" className="botao botao--primario botao--pequeno"
          disabled={ocupado || !dataNova || justificativa.trim().length < 5}
          onClick={enviar}>
          Registrar alteracao
        </button>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      <p className="explicacao">
        A promessa original nunca e apagada: ela fica guardada e o que muda e a promessa atual.
        A alteracao entra no historico com motivo, usuario e diferenca em dias.
      </p>
      <div className="formulario-grade">
        <Selecao rotulo="O que muda" valor={campo} aoMudar={setCampo} vazio={null}
          opcoes={[
            { valor: 'DATA_PROMETIDA', texto: 'Data prometida pelo fornecedor' },
            { valor: 'DATA_PREVISTA_ENTREGA', texto: 'Data prevista de entrega' },
            { valor: 'ETA', texto: 'Previsao de chegada (ETA)' },
          ]} />
        <Entrada rotulo="Nova data" valor={dataNova} aoMudar={setDataNova} tipo="date" />
      </div>
      <Selecao rotulo="Motivo" valor={motivo} aoMudar={setMotivo}
        opcoes={motivos.map((m) => ({ valor: m.codigo, texto: m.descricao }))} />
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa} />
    </Modal>
  );
}

function FormularioStatus({ aoFechar, aoConfirmar }: {
  aoFechar: () => void;
  aoConfirmar: (corpo: { status: string; justificativa?: string }) => Promise<void>;
}) {
  const [status, setStatus] = useState(STATUS_LOGISTICO[0]!);
  const [justificativa, setJustificativa] = useState('');

  return (
    <Modal
      titulo="Atualizar status logistico"
      aoFechar={aoFechar}
      rodape={(
        <button type="button" className="botao botao--primario botao--pequeno"
          onClick={() => aoConfirmar({ status, justificativa: justificativa || undefined })}>
          Atualizar
        </button>
      )}
    >
      <Selecao rotulo="Novo status" valor={status} aoMudar={setStatus} vazio={null}
        opcoes={STATUS_LOGISTICO.map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
      <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa} />
      <p className="explicacao">Toda mudanca entra no historico e nao pode ser apagada.</p>
    </Modal>
  );
}
