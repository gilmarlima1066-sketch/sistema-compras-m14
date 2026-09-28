import { useEffect, useMemo, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, dataHora, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras, GraficoLinha, Matriz } from '../componentes/graficos';

type Aba = 'dashboard' | 'vendas' | 'analise' | 'previsao' | 'sazonalidade' | 'abc' | 'ruptura' | 'parametros';

const ABAS: Array<{ id: Aba; texto: string }> = [
  { id: 'dashboard', texto: 'Dashboard' },
  { id: 'vendas', texto: 'Historico de vendas' },
  { id: 'analise', texto: 'Analise de demanda' },
  { id: 'previsao', texto: 'Previsao' },
  { id: 'sazonalidade', texto: 'Sazonalidade' },
  { id: 'abc', texto: 'ABC x XYZ' },
  { id: 'ruptura', texto: 'Ruptura e reprimida' },
  { id: 'parametros', texto: 'Parametros' },
];

const PERIODOS = [
  { valor: '7', texto: '7 dias' },
  { valor: '30', texto: '30 dias' },
  { valor: '60', texto: '60 dias' },
  { valor: '90', texto: '90 dias' },
  { valor: '180', texto: '180 dias' },
  { valor: '365', texto: '365 dias' },
];

const TOM_CONFIABILIDADE: Record<string, 'acento' | 'alerta' | 'perigo' | 'neutro'> = {
  ALTA: 'acento', MEDIA: 'alerta', BAIXA: 'perigo', INSUFICIENTE: 'neutro',
};

const TOM_TENDENCIA: Record<string, 'acento' | 'alerta' | 'perigo' | 'neutro'> = {
  CRESCIMENTO: 'acento', ESTAVEL: 'neutro', QUEDA: 'perigo', INDETERMINADA: 'neutro',
};

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function Variacao({ valor }: { valor: number | null }) {
  if (valor === null || valor === undefined) return <span className="fraco">—</span>;
  const tom = valor > 0 ? 'acento' : valor < 0 ? 'perigo' : 'neutro';
  const sinal = valor > 0 ? '+' : '';
  return <Etiqueta texto={`${sinal}${valor.toFixed(1)}%`} tom={tom} />;
}

export function Demanda() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('dashboard');
  const [dias, setDias] = useState('90');

  return (
    <>
      <CabecalhoPagina
        titulo="Demanda"
        descricao="Historico de vendas, demanda, sazonalidade e previsao. Alimenta o planejamento de compras."
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

      {aba === 'dashboard' && <PainelDashboard dias={dias} setDias={setDias} />}
      {aba === 'vendas' && <PainelVendas />}
      {aba === 'analise' && <PainelAnalise dias={dias} setDias={setDias} />}
      {aba === 'previsao' && <PainelPrevisao podeCalcular={pode('demanda.prever')} />}
      {aba === 'sazonalidade' && <PainelSazonalidade podeCalcular={pode('demanda.prever')} />}
      {aba === 'abc' && <PainelAbcXyz podeCalcular={pode('demanda.prever')} />}
      {aba === 'ruptura' && <PainelRuptura podeCalcular={pode('demanda.prever')} />}
      {aba === 'parametros' && <PainelParametros podeEditar={pode('demanda.ajustar')} />}
    </>
  );
}

/* ------------------------------------------------------------------ dashboard */

interface Dash {
  periodo: { inicio: string; fim: string; dias: number };
  periodo_anterior: { inicio: string; fim: string };
  quantidade_vendida: number; faturamento: number; documentos: number;
  produtos_com_venda: number; demanda_media_diaria: number; demanda_media_mensal: number;
  quantidade_anterior: number; faturamento_anterior: number; variacao_percentual: number | null;
  produtos_em_alta: number; produtos_em_queda: number; produtos_em_ruptura: number;
  produtos_sazonais: number; demanda_reprimida_estimada: number; valor_reprimido_estimado: number;
}

interface PerfilTemporal {
  por_dia_semana: Array<{ nome: string; quantidade: number; media: number; participacao_percentual: number }>;
  por_mes: Array<{ ano: number; mes: number; quantidade: number; valor: number }>;
  por_ano: Array<{ ano: number; quantidade: number; valor: number }>;
}

function PainelDashboard({ dias, setDias }: { dias: string; setDias: (v: string) => void }) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [perfil, setPerfil] = useState<PerfilTemporal | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    setCarregando(true);
    Promise.all([
      api<Dash>('/demanda/dashboard', { query: { dias } }),
      api<PerfilTemporal>('/demanda/perfil-temporal', { query: { dias: 1100 } }),
    ])
      .then(([d, p]) => { setDash(d.data); setPerfil(p.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o dashboard'))
      .finally(() => setCarregando(false));
  }, [dias]);

  if (carregando && !dash) return <Vazio>Carregando indicadores…</Vazio>;
  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dash) return null;

  // O mes corrente esta sempre incompleto e o primeiro mes da janela tambem
  // pode estar: os dois apareceriam como uma queda que nao existe.
  const mensal = (perfil?.por_mes ?? []).slice(0, -1).slice(-24);

  return (
    <>
      <Cartao
        titulo="Periodo"
        acoes={<Selecao rotulo="" valor={dias} aoMudar={setDias} opcoes={PERIODOS} vazio={null} />}
      >
        <p className="fraco">
          {fmtData(dash.periodo.inicio)} a {fmtData(dash.periodo.fim)} ({dash.periodo.dias} dias).
          Periodo anterior: {fmtData(dash.periodo_anterior.inicio)} a {fmtData(dash.periodo_anterior.fim)}.
        </p>
      </Cartao>

      <div className="grade-indicadores">
        <Indicador rotulo="Quantidade vendida" valor={numero(dash.quantidade_vendida)} nota="embalagens" />
        <Indicador
          rotulo="Faturamento"
          valor={`R$ ${(dash.faturamento / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`}
          nota={moeda(dash.faturamento)}
          tom="acento"
        />
        <Indicador rotulo="Demanda media diaria" valor={numero(dash.demanda_media_diaria, 1)} />
        <Indicador rotulo="Demanda media mensal" valor={numero(dash.demanda_media_mensal)} />
        <Indicador
          rotulo="Variacao x periodo anterior"
          valor={dash.variacao_percentual === null ? '—' : `${dash.variacao_percentual > 0 ? '+' : ''}${dash.variacao_percentual.toFixed(1)}%`}
          tom={dash.variacao_percentual === null ? 'neutro' : dash.variacao_percentual >= 0 ? 'acento' : 'perigo'}
          nota={`${numero(dash.quantidade_anterior)} antes`}
        />
        <Indicador rotulo="Produtos com venda" valor={numero(dash.produtos_com_venda)} />
        <Indicador rotulo="Produtos em alta" valor={numero(dash.produtos_em_alta)} tom="acento" />
        <Indicador rotulo="Produtos em queda" valor={numero(dash.produtos_em_queda)} tom="alerta" />
        <Indicador rotulo="Produtos em ruptura" valor={numero(dash.produtos_em_ruptura)} tom="perigo" />
        <Indicador rotulo="Produtos sazonais" valor={numero(dash.produtos_sazonais)} tom="info" />
        <Indicador
          rotulo="Demanda reprimida estimada"
          valor={numero(dash.demanda_reprimida_estimada)}
          nota={moeda(dash.valor_reprimido_estimado)}
          tom="info"
        />
      </div>

      {mensal.length > 0 && (
        <Cartao titulo="Demanda por mes (ultimos 24 meses fechados)">
          <GraficoLinha
            rotulos={mensal.map((m) => `${MESES[m.mes - 1]}/${String(m.ano).slice(2)}`)}
            series={[{ nome: 'Quantidade', valores: mensal.map((m) => Number(m.quantidade)) }]}
          />
        </Cartao>
      )}

      {(perfil?.por_ano?.length ?? 0) > 0 && (
        <Cartao titulo="Faturamento por ano">
          <GraficoBarras
            dados={perfil!.por_ano.map((a) => ({ rotulo: String(a.ano), valor: Number(a.valor) }))}
            formatar={(v) => `${(v / 1_000_000).toFixed(1)}M`}
          />
          <p className="fraco">O ano corrente esta incompleto e por isso aparece menor.</p>
        </Cartao>
      )}

      {(perfil?.por_dia_semana?.length ?? 0) > 0 && (
        <Cartao titulo="Demanda por dia da semana (365 dias)">
          <GraficoBarras
            dados={perfil!.por_dia_semana.map((d) => ({ rotulo: d.nome.slice(0, 3), valor: Number(d.media) }))}
            formatar={(v) => numero(v)}
          />
        </Cartao>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- vendas */

interface LinhaVenda {
  data_venda: string; numero_documento: string; tipo_documento: string; canal: string | null;
  cliente: string | null; cidade: string | null; estado: string | null;
  codigo: string; descricao: string; unidade: string;
  quantidade: number; preco_unitario: number; valor_total: number; quantidade_liquida: number;
}

function PainelVendas() {
  const [busca, setBusca] = useState('');
  const [tipo, setTipo] = useState('');
  const [dias, setDias] = useState('90');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro } = useLista<LinhaVenda>('/demanda/vendas', {
    pagina, limite: 25, busca, tipo_documento: tipo, dias,
  });

  return (
    <Cartao
      titulo="Historico de vendas"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="produto, NF ou cliente" />
          <Selecao
            rotulo="Tipo" valor={tipo} aoMudar={(v) => { setTipo(v); setPagina(1); }}
            opcoes={[{ valor: 'VENDA', texto: 'Venda' }, { valor: 'DEVOLUCAO', texto: 'Devolucao' }]}
          />
          <Selecao rotulo="Periodo" valor={dias} aoMudar={(v) => { setDias(v); setPagina(1); }} opcoes={PERIODOS} vazio={null} />
        </div>
      )}
      semCorpo
    >
      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Vazio>Carregando…</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhuma venda no filtro informado.</Vazio>}
      {!!itens.length && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Data</th><th>Documento</th><th>Cliente</th><th>UF</th>
                <th>Codigo</th><th>Produto</th>
                <th className="num">Qtd</th><th>Un</th>
                <th className="num">Preco</th><th className="num">Valor</th>
                <th>Canal</th><th>Tipo</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((v, i) => (
                <tr key={`${v.numero_documento}-${v.codigo}-${i}`}>
                  <td>{fmtData(v.data_venda)}</td>
                  <td className="mono">{v.numero_documento}</td>
                  <td>{v.cliente ?? '—'}</td>
                  <td>{v.estado ?? '—'}</td>
                  <td className="mono">{v.codigo}</td>
                  <td>{v.descricao}</td>
                  <td className="num">{numero(v.quantidade_liquida, 0)}</td>
                  <td>{v.unidade}</td>
                  <td className="num">{moeda(v.preco_unitario)}</td>
                  <td className="num">{moeda(v.valor_total)}</td>
                  <td>{v.canal ?? '—'}</td>
                  <td><Etiqueta texto={v.tipo_documento} tom={v.tipo_documento === 'DEVOLUCAO' ? 'alerta' : 'acento'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

/* -------------------------------------------------------------------- analise */

interface LinhaAnalise {
  produto_id: number; codigo: string; descricao: string; categoria: string;
  classificacao_abc: string | null; classificacao_xyz: string | null;
  quantidade: number; valor: number; dias_com_venda: number;
  media_diaria: number; media_semanal: number; media_mensal: number;
  quantidade_anterior: number; variacao_percentual: number | null;
}

function PainelAnalise({ dias, setDias }: { dias: string; setDias: (v: string) => void }) {
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);
  const [ordenar, setOrdenar] = useState('quantidade');
  const [detalhe, setDetalhe] = useState<number | null>(null);

  const { itens, meta, carregando, erro } = useLista<LinhaAnalise>('/demanda', {
    pagina, limite: 25, busca, dias, ordenar_por: ordenar, ordem: 'desc',
  });

  return (
    <>
      <Cartao
        titulo="Demanda por produto"
        acoes={(
          <div className="filtros">
            <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="codigo ou descricao" />
            <Selecao rotulo="Periodo" valor={dias} aoMudar={(v) => { setDias(v); setPagina(1); }} opcoes={PERIODOS} vazio={null} />
            <Selecao
              rotulo="Ordenar por" valor={ordenar} aoMudar={setOrdenar} vazio={null}
              opcoes={[
                { valor: 'quantidade', texto: 'Quantidade' },
                { valor: 'valor', texto: 'Faturamento' },
                { valor: 'variacao', texto: 'Variacao' },
              ]}
            />
          </div>
        )}
        semCorpo
      >
        {erro && <Aviso>{erro}</Aviso>}
        {carregando && <Vazio>Carregando…</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhum produto com venda no periodo.</Vazio>}
        {!!itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Produto</th><th>Categoria</th>
                  <th>ABC</th><th>XYZ</th>
                  <th className="num">Qtd</th><th className="num">Valor</th>
                  <th className="num">Media/dia</th><th className="num">Media/mes</th>
                  <th className="num">Dias c/ venda</th><th>Variacao</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((l) => (
                  <tr key={l.produto_id}>
                    <td className="mono">{l.codigo}</td>
                    <td>{l.descricao}</td>
                    <td className="fraco">{l.categoria}</td>
                    <td>{l.classificacao_abc ? <Etiqueta texto={l.classificacao_abc} /> : '—'}</td>
                    <td>{l.classificacao_xyz ? <Etiqueta texto={l.classificacao_xyz} /> : '—'}</td>
                    <td className="num">{numero(l.quantidade)}</td>
                    <td className="num">{moeda(l.valor)}</td>
                    <td className="num">{numero(l.media_diaria, 2)}</td>
                    <td className="num">{numero(l.media_mensal, 1)}</td>
                    <td className="num">{numero(l.dias_com_venda)}</td>
                    <td><Variacao valor={l.variacao_percentual} /></td>
                    <td>
                      <button type="button" className="botao botao--pequeno botao--fantasma" onClick={() => setDetalhe(l.produto_id)}>
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

      {detalhe !== null && <ModalProduto produtoId={detalhe} aoFechar={() => setDetalhe(null)} />}
    </>
  );
}

interface DetalheProduto {
  produto: Record<string, any>;
  periodo: { inicio: string; fim: string; dias: number };
  resumo: { quantidade: number; valor: number; dias_com_venda: number; media_diaria: number; media_mensal: number; cobertura_dias: number | null };
  estoque: Record<string, number> | null;
  serie_mensal: Array<{ mes: string; quantidade: number; valor: number }>;
  previsao: Record<string, any> | null;
  sazonalidade: Array<{ mes: number; indice: number; confirmado: boolean }>;
  fornecedor_principal: Record<string, any> | null;
  demanda_reprimida: Array<Record<string, any>>;
}

function ModalProduto({ produtoId, aoFechar }: { produtoId: number; aoFechar: () => void }) {
  const [d, setD] = useState<DetalheProduto | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<DetalheProduto>(`/demanda/produto/${produtoId}`, { query: { dias: 365 } })
      .then((r) => setD(r.data))
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o produto'));
  }, [produtoId]);

  return (
    <Modal titulo={d ? `${d.produto.codigo} — ${d.produto.descricao}` : 'Produto'} aoFechar={aoFechar}>
      {erro && <Aviso>{erro}</Aviso>}
      {!d && !erro && <Vazio>Carregando…</Vazio>}
      {d && (
        <>
          <div className="grade-indicadores">
            <Indicador rotulo="Quantidade 365d" valor={numero(d.resumo.quantidade)} />
            <Indicador rotulo="Faturamento 365d" valor={moeda(d.resumo.valor)} />
            <Indicador rotulo="Media diaria" valor={numero(d.resumo.media_diaria, 2)} />
            <Indicador rotulo="Estoque disponivel" valor={numero(d.estoque?.estoque_disponivel ?? 0)} />
            <Indicador
              rotulo="Cobertura"
              valor={d.resumo.cobertura_dias === null ? '—' : `${numero(d.resumo.cobertura_dias, 0)} dias`}
              tom={d.resumo.cobertura_dias !== null && d.resumo.cobertura_dias < 15 ? 'perigo' : 'neutro'}
            />
            <Indicador rotulo="Em transito" valor={numero(d.estoque?.estoque_em_transito ?? 0)} />
          </div>

          {d.serie_mensal.length > 0 && (
            <Cartao titulo="Demanda mensal">
              <GraficoLinha
                rotulos={d.serie_mensal.map((m) => {
                  const dt = new Date(m.mes);
                  return `${MESES[dt.getUTCMonth()]}/${String(dt.getUTCFullYear()).slice(2)}`;
                })}
                series={[{ nome: 'Quantidade', valores: d.serie_mensal.map((m) => Number(m.quantidade)) }]}
              />
            </Cartao>
          )}

          {d.sazonalidade.length > 0 && (
            <Cartao titulo="Indice sazonal por mes">
              <GraficoBarras
                dados={d.sazonalidade.map((s) => ({
                  rotulo: MESES[s.mes - 1] ?? String(s.mes),
                  valor: Number(s.indice),
                  cor: Number(s.indice) >= 1 ? '#2f6f4e' : '#c9873d',
                }))}
                referencia={1}
                formatar={(v) => v.toFixed(2)}
              />
              <p className="fraco">
                A linha tracejada e a media do ciclo. Acima dela, mes de demanda alta.
                {d.sazonalidade.every((s) => s.confirmado) ? ' Padrao confirmado.' : ' Padrao ainda nao confirmado.'}
              </p>
            </Cartao>
          )}

          <Cartao titulo="Previsao vigente">
            {d.previsao ? (
              <>
                <div className="grade-indicadores">
                  <Indicador rotulo="Previsao do periodo" valor={numero(d.previsao.demanda_prevista, 1)} />
                  <Indicador rotulo="Demanda diaria prevista" valor={numero(d.previsao.demanda_diaria, 2)} />
                  <Indicador rotulo="Metodo" valor={<Etiqueta texto={String(d.previsao.metodo)} />} />
                  <Indicador
                    rotulo="Confiabilidade"
                    valor={<Etiqueta texto={String(d.previsao.confiabilidade)} tom={TOM_CONFIABILIDADE[d.previsao.confiabilidade]} />}
                  />
                  <Indicador rotulo="Tendencia" valor={<Etiqueta texto={String(d.previsao.tendencia)} tom={TOM_TENDENCIA[d.previsao.tendencia]} />} />
                  <Indicador rotulo="MAPE do backtest" valor={d.previsao.mape === null ? '—' : `${numero(d.previsao.mape, 1)}%`} />
                </div>
                <p className="explicacao">{d.previsao.explicacao}</p>
                <p className="fraco">
                  Periodo {fmtData(d.previsao.periodo_inicio)} a {fmtData(d.previsao.periodo_fim)} ·
                  versao {d.previsao.versao} · calculada em {dataHora(d.previsao.created_at)}
                  {d.previsao.limite_inferior !== null && (
                    <> · intervalo {numero(d.previsao.limite_inferior, 0)} a {numero(d.previsao.limite_superior, 0)}</>
                  )}
                </p>
              </>
            ) : <Vazio>Nenhuma previsao calculada para este produto.</Vazio>}
          </Cartao>

          {d.fornecedor_principal && (
            <Cartao titulo="Fornecedor principal">
              <p>
                {d.fornecedor_principal.razao_social} · lead time {d.fornecedor_principal.lead_time_dias ?? '—'} dias ·
                preco {moeda(d.fornecedor_principal.preco_atual)} ·
                MOQ {numero(d.fornecedor_principal.moq ?? 0)}
              </p>
            </Cartao>
          )}

          {d.demanda_reprimida.length > 0 && (
            <Cartao titulo="Demanda reprimida estimada">
              <table className="tabela">
                <thead>
                  <tr><th>Periodo</th><th className="num">Dias</th><th className="num">Estimada</th><th className="num">Valor</th><th>Classificacao</th></tr>
                </thead>
                <tbody>
                  {d.demanda_reprimida.map((r, i) => (
                    <tr key={i}>
                      <td>{fmtData(r.periodo_inicio)} a {fmtData(r.periodo_fim)}</td>
                      <td className="num">{numero(r.dias_ruptura)}</td>
                      <td className="num">{numero(r.demanda_estimada, 1)}</td>
                      <td className="num">{moeda(r.valor_estimado)}</td>
                      <td><Etiqueta texto={r.classificacao} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Cartao>
          )}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------- previsao */

interface LinhaPrevisao {
  id: number; produto_id: number; codigo: string; descricao: string;
  periodo_inicio: string; periodo_fim: string; demanda_prevista: number; demanda_diaria: number;
  metodo: string; confiabilidade: string; tendencia: string; sazonal: boolean;
  mape: number | null; meses_historico: number; versao: number; explicacao: string;
  limite_inferior: number | null; limite_superior: number | null;
  classificacao_abc: string | null;
}

function PainelPrevisao({ podeCalcular }: { podeCalcular: boolean }) {
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState('');
  const [confiabilidade, setConfiabilidade] = useState('');
  const [horizonte, setHorizonte] = useState('30');
  const [metodo, setMetodo] = useState('AUTOMATICO');
  const [executando, setExecutando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [explicando, setExplicando] = useState<LinhaPrevisao | null>(null);

  const { itens, meta, carregando, recarregar } = useLista<LinhaPrevisao>('/demanda/previsao', {
    pagina, limite: 25, busca, confiabilidade,
  });

  async function calcular() {
    setExecutando(true);
    setErro(null);
    setResultado(null);
    try {
      const { data } = await api<any>('/demanda/previsao/calcular', {
        metodo: 'POST',
        corpo: { horizonte_dias: Number(horizonte), metodo, limite_produtos: 2500 },
      });
      setResultado(
        `${data.previsoes_geradas} previsoes geradas em ${data.produtos_avaliados} produtos avaliados. `
        + `${data.produtos_sem_historico} sem historico suficiente. `
        + `Periodo ${data.periodo_previsto.inicio} a ${data.periodo_previsto.fim}.`,
      );
      await recarregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao calcular a previsao');
    } finally {
      setExecutando(false);
    }
  }

  return (
    <>
      {podeCalcular && (
        <Cartao titulo="Calcular previsao">
          <div className="filtros">
            <Selecao
              rotulo="Horizonte" valor={horizonte} aoMudar={setHorizonte} vazio={null}
              opcoes={[7, 15, 30, 60, 90, 180].map((d) => ({ valor: String(d), texto: `${d} dias` }))}
            />
            <Selecao
              rotulo="Metodo" valor={metodo} aoMudar={setMetodo} vazio={null}
              opcoes={[
                { valor: 'AUTOMATICO', texto: 'Melhor metodo (backtest)' },
                { valor: 'MEDIA_SIMPLES', texto: 'Media simples' },
                { valor: 'MEDIA_MOVEL', texto: 'Media movel' },
                { valor: 'MEDIA_PONDERADA', texto: 'Media ponderada' },
                { valor: 'SUAVIZACAO_EXPONENCIAL', texto: 'Suavizacao exponencial' },
                { valor: 'TENDENCIA', texto: 'Tendencia' },
                { valor: 'SAZONALIDADE', texto: 'Sazonalidade' },
                { valor: 'COMBINADO', texto: 'Combinado' },
              ]}
            />
            <button type="button" className="botao" disabled={executando} onClick={() => void calcular()}>
              {executando ? 'Calculando…' : 'Calcular'}
            </button>
          </div>
          {resultado && <Aviso tipo="ok">{resultado}</Aviso>}
          {erro && <Aviso>{erro}</Aviso>}
          <p className="fraco">
            A previsao anterior nao e sobrescrita: cada execucao grava uma nova versao, para que o
            acerto de cada metodo possa ser conferido depois.
          </p>
        </Cartao>
      )}

      <Cartao
        titulo="Previsoes vigentes"
        acoes={(
          <div className="filtros">
            <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="codigo ou descricao" />
            <Selecao
              rotulo="Confiabilidade" valor={confiabilidade} aoMudar={(v) => { setConfiabilidade(v); setPagina(1); }}
              opcoes={['ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE'].map((c) => ({ valor: c, texto: c }))}
            />
          </div>
        )}
        semCorpo
      >
        {carregando && <Vazio>Carregando…</Vazio>}
        {!carregando && !itens.length && <Vazio>Nenhuma previsao calculada ainda.</Vazio>}
        {!!itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Produto</th><th>Periodo</th>
                  <th className="num">Previsao</th><th className="num">Por dia</th><th>Intervalo</th>
                  <th>Metodo</th><th>Tendencia</th><th>Confiabilidade</th>
                  <th className="num">MAPE</th><th className="num">Hist.</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.codigo}</td>
                    <td>{p.descricao}</td>
                    <td className="fraco">{fmtData(p.periodo_inicio)} a {fmtData(p.periodo_fim)}</td>
                    <td className="num">{numero(p.demanda_prevista, 1)}</td>
                    <td className="num">{numero(p.demanda_diaria, 2)}</td>
                    <td className="fraco">
                      {p.limite_inferior === null ? '—' : `${numero(p.limite_inferior, 0)}–${numero(p.limite_superior, 0)}`}
                    </td>
                    <td><Etiqueta texto={p.metodo} /></td>
                    <td><Etiqueta texto={p.tendencia} tom={TOM_TENDENCIA[p.tendencia]} /></td>
                    <td><Etiqueta texto={p.confiabilidade} tom={TOM_CONFIABILIDADE[p.confiabilidade]} /></td>
                    <td className="num">{p.mape === null ? '—' : `${numero(p.mape, 1)}%`}</td>
                    <td className="num">{p.meses_historico}</td>
                    <td>
                      <button type="button" className="botao botao--pequeno botao--fantasma" onClick={() => setExplicando(p)}>
                        Por que?
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

      {explicando && (
        <Modal titulo={`Como esta previsao foi calculada — ${explicando.codigo}`} aoFechar={() => setExplicando(null)}>
          <p className="explicacao">{explicando.explicacao}</p>
          <table className="tabela">
            <tbody>
              <tr><th>Produto</th><td>{explicando.descricao}</td></tr>
              <tr><th>Periodo previsto</th><td>{fmtData(explicando.periodo_inicio)} a {fmtData(explicando.periodo_fim)}</td></tr>
              <tr><th>Previsao</th><td>{numero(explicando.demanda_prevista, 2)}</td></tr>
              <tr><th>Intervalo</th><td>{explicando.limite_inferior === null ? 'Sem base estatistica para intervalo' : `${numero(explicando.limite_inferior, 0)} a ${numero(explicando.limite_superior, 0)}`}</td></tr>
              <tr><th>Meses de historico</th><td>{explicando.meses_historico}</td></tr>
              <tr><th>Erro do backtest (MAPE)</th><td>{explicando.mape === null ? '—' : `${numero(explicando.mape, 2)}%`}</td></tr>
              <tr><th>Versao</th><td>{explicando.versao}</td></tr>
            </tbody>
          </table>
        </Modal>
      )}
    </>
  );
}

/* --------------------------------------------------------------- sazonalidade */

interface LinhaSazonal {
  produto_id: number; codigo: string; descricao: string;
  meses_historico: number; ciclos: number; confirmado: boolean;
  indice_maximo: number; indice_minimo: number;
  indices: Record<string, number>; situacao: string;
}

function PainelSazonalidade({ podeCalcular }: { podeCalcular: boolean }) {
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState('');
  const [confirmado, setConfirmado] = useState('');
  const [executando, setExecutando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const { itens, meta, carregando, recarregar } = useLista<LinhaSazonal>('/demanda/sazonalidade', {
    pagina, limite: 25, busca, confirmado,
  });

  async function calcular() {
    setExecutando(true);
    try {
      const { data } = await api<any>('/demanda/sazonalidade/calcular', { metodo: 'POST', corpo: {} });
      setAviso(`${data.produtos_avaliados} produtos avaliados, ${data.indices_gravados} indices gravados.`);
      await recarregar();
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Falha ao calcular');
    } finally {
      setExecutando(false);
    }
  }

  return (
    <Cartao
      titulo="Sazonalidade"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="codigo ou descricao" />
          <Selecao
            rotulo="Situacao" valor={confirmado} aoMudar={(v) => { setConfirmado(v); setPagina(1); }}
            opcoes={[{ valor: 'true', texto: 'Confirmada' }, { valor: 'false', texto: 'Possivel' }]}
          />
          {podeCalcular && (
            <button type="button" className="botao" disabled={executando} onClick={() => void calcular()}>
              {executando ? 'Calculando…' : 'Recalcular'}
            </button>
          )}
        </div>
      )}
      semCorpo
    >
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {carregando && <Vazio>Carregando…</Vazio>}
      {!carregando && !itens.length && (
        <Vazio>Nenhum produto com historico suficiente para afirmar sazonalidade.</Vazio>
      )}
      {!!itens.length && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th><th>Produto</th><th>Situacao</th>
                <th className="num">Ciclos</th><th className="num">Meses</th>
                {MESES.map((m) => <th key={m} className="num">{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {itens.map((s) => (
                <tr key={s.produto_id}>
                  <td className="mono">{s.codigo}</td>
                  <td>{s.descricao}</td>
                  <td><Etiqueta texto={s.situacao} tom={s.confirmado ? 'acento' : 'info'} /></td>
                  <td className="num">{s.ciclos}</td>
                  <td className="num">{s.meses_historico}</td>
                  {MESES.map((_, i) => {
                    const valor = Number(s.indices?.[String(i + 1)] ?? 0);
                    return (
                      <td key={i} className="num" style={{ background: valor >= 1.15 ? 'rgba(47,111,78,.16)' : valor <= 0.85 ? 'rgba(201,135,61,.16)' : undefined }}>
                        {valor ? valor.toFixed(2) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

/* ------------------------------------------------------------------- ABC x XYZ */

interface MatrizAbc {
  periodo: { inicio: string; fim: string };
  matriz: Array<{ abc: string; xyz: string; produtos: number; quantidade: number; valor: number }>;
  por_classe_abc: Array<{ classe: string; produtos: number; quantidade: number; valor: number; media: number }>;
}

function PainelAbcXyz({ podeCalcular }: { podeCalcular: boolean }) {
  const [dados, setDados] = useState<MatrizAbc | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [executando, setExecutando] = useState(false);

  const carregar = () => api<MatrizAbc>('/demanda/abc-xyz').then((r) => setDados(r.data)).catch(() => undefined);
  useEffect(() => { void carregar(); }, []);

  async function classificar() {
    setExecutando(true);
    try {
      const { data } = await api<any>('/demanda/abc-xyz/classificar', { metodo: 'POST', corpo: { dias: 365 } });
      setAviso(`${data.produtos_classificados} produtos reclassificados com limites A=${data.limites.abc_a}%, B=${data.limites.abc_b}%, X=${data.limites.xyz_x}, Y=${data.limites.xyz_y}.`);
      await carregar();
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Falha ao classificar');
    } finally {
      setExecutando(false);
    }
  }

  const total = useMemo(
    () => (dados?.por_classe_abc ?? []).reduce((a, c) => a + Number(c.valor), 0),
    [dados],
  );

  return (
    <>
      <Cartao
        titulo="Matriz ABC x XYZ"
        acoes={podeCalcular ? (
          <button type="button" className="botao" disabled={executando} onClick={() => void classificar()}>
            {executando ? 'Classificando…' : 'Reclassificar'}
          </button>
        ) : undefined}
      >
        {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
        {!dados && <Vazio>Carregando…</Vazio>}
        {dados && (
          <>
            <Matriz
              linhas={['A', 'B', 'C']}
              colunas={['X', 'Y', 'Z']}
              valor={(l, c) => {
                const celula = dados.matriz.find((m) => m.abc === l && m.xyz === c);
                if (!celula) return null;
                return { numero: Number(celula.produtos), detalhe: moeda(celula.valor) };
              }}
            />
            <p className="fraco">
              Linhas: curva ABC (faturamento). Colunas: curva XYZ (regularidade da demanda).
              AX concentra os itens que mais faturam e sao mais previsiveis; CZ, o oposto.
            </p>
          </>
        )}
      </Cartao>

      {dados && (
        <Cartao titulo="Participacao por classe ABC">
          <table className="tabela">
            <thead>
              <tr><th>Classe</th><th className="num">Produtos</th><th className="num">Quantidade</th><th className="num">Faturamento</th><th className="num">% do total</th></tr>
            </thead>
            <tbody>
              {dados.por_classe_abc.map((c) => (
                <tr key={c.classe}>
                  <td><Etiqueta texto={c.classe} /></td>
                  <td className="num">{numero(c.produtos)}</td>
                  <td className="num">{numero(c.quantidade)}</td>
                  <td className="num">{moeda(c.valor)}</td>
                  <td className="num">{total > 0 ? `${((Number(c.valor) / total) * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- ruptura */

function PainelRuptura({ podeCalcular }: { podeCalcular: boolean }) {
  const [pagina, setPagina] = useState(1);
  const [aviso, setAviso] = useState<string | null>(null);
  const [executando, setExecutando] = useState(false);

  const ruptura = useLista<any>('/demanda/ruptura', { pagina, limite: 25, dias: 180 });
  const reprimida = useLista<any>('/demanda/reprimida', { pagina: 1, limite: 25 });

  async function calcular() {
    setExecutando(true);
    try {
      const { data } = await api<any>('/demanda/reprimida/calcular', { metodo: 'POST', corpo: { dias: 365 } });
      setAviso(`${data.registros_gravados} janelas de ruptura estimadas. ${data.observacao}.`);
      await reprimida.recarregar();
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Falha ao calcular');
    } finally {
      setExecutando(false);
    }
  }

  return (
    <>
      <Cartao titulo="Dias em ruptura (180 dias)" semCorpo>
        {ruptura.meta?.aviso ? <Aviso>{String(ruptura.meta.aviso)}</Aviso> : null}
        {ruptura.carregando && <Vazio>Carregando…</Vazio>}
        {!ruptura.carregando && !ruptura.itens.length && <Vazio>Nenhum produto com dias em ruptura no periodo.</Vazio>}
        {!!ruptura.itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Produto</th>
                  <th className="num">Dias em ruptura</th><th className="num">Dias disponivel</th>
                  <th className="num">Vendido</th><th className="num">Media nos dias disponiveis</th><th>Base</th>
                </tr>
              </thead>
              <tbody>
                {ruptura.itens.map((r) => (
                  <tr key={r.produto_id}>
                    <td className="mono">{r.codigo}</td>
                    <td>{r.descricao}</td>
                    <td className="num">{numero(r.dias_ruptura)}</td>
                    <td className="num">{numero(r.dias_disponivel)}</td>
                    <td className="num">{numero(r.quantidade_vendida)}</td>
                    <td className="num">{r.media_dias_disponiveis === null ? '—' : numero(r.media_dias_disponiveis, 2)}</td>
                    <td>
                      <Etiqueta
                        texto={r.base_confiavel ? 'COM MOVIMENTACAO' : 'SEM MOVIMENTACAO'}
                        tom={r.base_confiavel ? 'acento' : 'alerta'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacao meta={ruptura.meta} aoTrocar={setPagina} />
      </Cartao>

      <Cartao
        titulo="Demanda reprimida estimada"
        acoes={podeCalcular ? (
          <button type="button" className="botao" disabled={executando} onClick={() => void calcular()}>
            {executando ? 'Calculando…' : 'Recalcular'}
          </button>
        ) : undefined}
        semCorpo
      >
        {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
        <div className="cartao__corpo">
          <p className="fraco">
            Estimativa do que poderia ter sido vendido nos dias sem saldo, a partir da media dos 60 dias
            anteriores a cada ruptura. Nao e venda perdida confirmada.
          </p>
        </div>
        {!reprimida.itens.length && <Vazio>Nenhuma estimativa registrada.</Vazio>}
        {!!reprimida.itens.length && (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Produto</th><th>Periodo</th>
                  <th className="num">Dias</th><th className="num">Media/dia antes</th>
                  <th className="num">Estimada</th><th className="num">Valor</th><th>Classificacao</th>
                </tr>
              </thead>
              <tbody>
                {reprimida.itens.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.codigo}</td>
                    <td>{r.descricao}</td>
                    <td>{fmtData(r.periodo_inicio)} a {fmtData(r.periodo_fim)}</td>
                    <td className="num">{numero(r.dias_ruptura)}</td>
                    <td className="num">{numero(r.media_diaria_antes, 2)}</td>
                    <td className="num">{numero(r.demanda_estimada, 1)}</td>
                    <td className="num">{moeda(r.valor_estimado)}</td>
                    <td><Etiqueta texto={r.classificacao} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </>
  );
}

/* ----------------------------------------------------------------- parametros */

interface Parametro { chave: string; valor: string; tipo: string; descricao: string }

function PainelParametros({ podeEditar }: { podeEditar: boolean }) {
  const [parametros, setParametros] = useState<Parametro[]>([]);
  const [edicao, setEdicao] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api<Parametro[]>('/demanda/configuracoes')
      .then((r) => setParametros(r.data))
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar parametros'));
  }, []);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const { data } = await api<Parametro[]>('/demanda/configuracoes', { metodo: 'PUT', corpo: edicao });
      setParametros(data);
      setEdicao({});
      setAviso('Parametros atualizados.');
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Cartao
      titulo="Parametros de previsao"
      acoes={podeEditar ? (
        <button type="button" className="botao" disabled={!Object.keys(edicao).length || salvando} onClick={() => void salvar()}>
          {salvando ? 'Salvando…' : 'Salvar alteracoes'}
        </button>
      ) : undefined}
    >
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {erro && <Aviso>{erro}</Aviso>}
      <table className="tabela">
        <thead>
          <tr><th>Parametro</th><th>Valor</th><th>Descricao</th></tr>
        </thead>
        <tbody>
          {parametros.map((p) => (
            <tr key={p.chave}>
              <td className="mono">{p.chave.replace('forecast.', '')}</td>
              <td>
                {podeEditar ? (
                  <input
                    value={edicao[p.chave] ?? p.valor}
                    onChange={(e) => setEdicao({ ...edicao, [p.chave]: e.target.value })}
                  />
                ) : p.valor}
              </td>
              <td className="fraco">{p.descricao}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Cartao>
  );
}
