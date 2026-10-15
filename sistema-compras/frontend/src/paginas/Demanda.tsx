import { useEffect, useMemo, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { CONFIG_VENDAS, ImportarPlanilha } from '../componentes/ImportarPlanilha';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, dataHora, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras, GraficoLinha, Matriz } from '../componentes/graficos';
import {
  BarraComposicao, COR, Contagem, Delta, Divergente, Esqueleto, GraficoColunas, GraficoComparativo,
  Ranking, type PontoSerie,
} from '../componentes/painel';

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
  { valor: 'PERSONALIZADO', texto: 'Personalizado (data inicio e fim)' },
];

/**
 * Periodo compartilhado por Dashboard, Historico e Analise: escolher o
 * intervalo numa aba vale para as outras.
 */
interface Periodo { dias: string; inicio: string; fim: string }

/** Parametros para a API: o intervalo de datas, ou os ultimos N dias. */
const paramsPeriodo = (p: Periodo) => (p.dias === 'PERSONALIZADO'
  ? { data_inicio: p.inicio, data_fim: p.fim }
  : { dias: p.dias });

/**
 * O intervalo personalizado so e aplicado com as duas datas validas: aplicar a
 * cada tecla dispararia consultas com o periodo pela metade.
 */
function FiltroPeriodo({ periodo, aoMudar, chips }: {
  periodo: Periodo; aoMudar: (p: Periodo) => void;
  /** No dashboard os atalhos ficam a vista, um clique cada. */
  chips?: boolean;
}) {
  const [modo, setModo] = useState(periodo.dias);
  const [inicio, setInicio] = useState(periodo.inicio);
  const [fim, setFim] = useState(periodo.fim);

  const invalido = modo === 'PERSONALIZADO' && !!inicio && !!fim && fim < inicio;

  const trocarModo = (v: string) => {
    setModo(v);
    if (v !== 'PERSONALIZADO') aoMudar({ dias: v, inicio: '', fim: '' });
    else if (inicio && fim && fim >= inicio) aoMudar({ dias: v, inicio, fim });
  };
  const trocarData = (novoInicio: string, novoFim: string) => {
    setInicio(novoInicio);
    setFim(novoFim);
    if (novoInicio && novoFim && novoFim >= novoInicio) {
      aoMudar({ dias: 'PERSONALIZADO', inicio: novoInicio, fim: novoFim });
    }
  };

  return (
    <>
      {chips ? (
        <div className="chips-periodo" role="group" aria-label="Periodo">
          {PERIODOS.map((p) => (
            <button key={p.valor} type="button" aria-pressed={modo === p.valor}
              className={modo === p.valor ? 'ativo' : undefined} onClick={() => trocarModo(p.valor)}>
              {p.valor === 'PERSONALIZADO' ? 'Personalizado' : p.texto}
            </button>
          ))}
        </div>
      ) : (
        <Selecao rotulo="Periodo" valor={modo} aoMudar={trocarModo} opcoes={PERIODOS} vazio={null} />
      )}
      {modo === 'PERSONALIZADO' && (
        <>
          <Entrada rotulo="Data inicio" tipo="date" valor={inicio}
            aoMudar={(v) => trocarData(v, fim)} />
          <Entrada rotulo="Data fim" tipo="date" valor={fim}
            aoMudar={(v) => trocarData(inicio, v)}
            erro={invalido ? 'Anterior a data inicio' : undefined} />
        </>
      )}
    </>
  );
}

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
  const [periodo, setPeriodo] = useState<Periodo>({ dias: '90', inicio: '', fim: '' });
  // Trocar a chave remonta a aba aberta: depois de importar, tudo recarrega.
  const [versao, setVersao] = useState(0);
  const podeImportar = pode('demanda.importar') || pode('integracao.importar');

  return (
    <>
      <CabecalhoPagina
        titulo="Demanda"
        descricao="Historico de vendas, demanda, sazonalidade e previsao. Alimenta o planejamento de compras."
        acoes={podeImportar ? <ImportarPlanilha config={CONFIG_VENDAS} aoConcluir={() => setVersao((v) => v + 1)} /> : undefined}
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

      <div key={versao}>
        {aba === 'dashboard' && <PainelDashboard periodo={periodo} setPeriodo={setPeriodo} irPara={setAba} />}
        {aba === 'vendas' && <PainelVendas periodo={periodo} setPeriodo={setPeriodo} />}
        {aba === 'analise' && <PainelAnalise periodo={periodo} setPeriodo={setPeriodo} />}
        {aba === 'previsao' && <PainelPrevisao podeCalcular={pode('demanda.prever')} />}
        {aba === 'sazonalidade' && <PainelSazonalidade podeCalcular={pode('demanda.prever')} />}
        {aba === 'abc' && <PainelAbcXyz podeCalcular={pode('demanda.prever')} />}
        {aba === 'ruptura' && <PainelRuptura podeCalcular={pode('demanda.prever')} />}
        {aba === 'parametros' && <PainelParametros podeEditar={pode('demanda.ajustar')} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ dashboard */

interface ProdutoDash {
  produto_id: number; codigo: string; descricao: string; curva: string | null;
  quantidade: number; valor: number; quantidade_anterior: number; valor_anterior: number;
  diferenca_valor: number; participacao: number;
}

interface Dash {
  periodo: { inicio: string; fim: string; dias: number };
  periodo_anterior: { inicio: string; fim: string };
  comparar: Comparar;
  ultima_venda: string | null;
  quantidade_vendida: number; faturamento: number; documentos: number;
  produtos_com_venda: number; demanda_media_diaria: number; demanda_media_mensal: number;
  quantidade_anterior: number; faturamento_anterior: number; variacao_percentual: number | null;
  produtos_em_alta: number; produtos_em_queda: number; produtos_em_ruptura: number;
  produtos_sazonais: number; demanda_reprimida_estimada: number; valor_reprimido_estimado: number;
  serie: {
    atual: Array<{ dia: string; quantidade: number; valor: number }>;
    anterior: Array<{ dia: string; quantidade: number; valor: number }>;
  };
  top_produtos: ProdutoDash[];
  maiores_altas: ProdutoDash[];
  maiores_quedas: ProdutoDash[];
  curva_abc: Array<{ curva: string; produtos: number; valor: number; participacao: number }>;
  concentracao: { produtos_80: number; produtos: number };
}

interface PerfilTemporal {
  por_dia_semana: Array<{ nome: string; quantidade: number; media: number; participacao_percentual: number }>;
  por_mes: Array<{ ano: number; mes: number; quantidade: number; valor: number }>;
  por_ano: Array<{ ano: number; quantidade: number; valor: number }>;
}

/* Numeros compactos para eixo e cartao: 14,2 mi / 820 mil. */
const compacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const reaisCompacto = (v: number) => `R$ ${compacto.format(v)}`;
/** O numero que lidera: milhoes com duas casas, abaixo disso o valor inteiro. */
const reaisHeroi = (v: number) => (v >= 1_000_000
  ? `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`
  : moeda(v));
const variacao = (atual: number, anterior: number) => (anterior > 0 ? ((atual - anterior) / anterior) * 100 : null);
const dataCurta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const CORES_CURVA: Record<string, string> = { A: '#2f5220', B: '#5f8a46', C: '#a8c290', SEM: '#d3d7cc' };
const NOME_CURVA: Record<string, string> = { A: 'Curva A', B: 'Curva B', C: 'Curva C', SEM: 'Sem curva' };

type Medida = 'valor' | 'quantidade';
type Comparar = 'anterior' | 'ano_anterior';

/**
 * Agrupa a serie diaria em semanas quando o periodo passa de ~4 meses: 365
 * pontos diarios viram ruido; 52 semanas mostram a tendencia.
 */
function agrupar(dash: Dash, medida: Medida): { pontos: PontoSerie[]; semanal: boolean } {
  const { atual, anterior } = dash.serie;
  const semanal = atual.length > 120;
  if (!semanal) {
    return {
      semanal,
      pontos: atual.map((d, i) => ({
        rotulo: dataCurta(d.dia),
        titulo: `${fmtData(d.dia)}${anterior[i] ? ` x ${fmtData(anterior[i]!.dia)}` : ''}`,
        atual: d[medida],
        anterior: anterior[i] ? anterior[i]![medida] : null,
      })),
    };
  }
  const pontos: PontoSerie[] = [];
  for (let i = 0; i < atual.length; i += 7) {
    const fatia = atual.slice(i, i + 7);
    const fatiaAnt = anterior.slice(i, i + 7);
    pontos.push({
      rotulo: dataCurta(fatia[0]!.dia),
      titulo: `Semana de ${fmtData(fatia[0]!.dia)}${fatia.length < 7 ? ` (${fatia.length} dias)` : ''}`,
      atual: fatia.reduce((s, d) => s + d[medida], 0),
      anterior: fatiaAnt.length ? fatiaAnt.reduce((s, d) => s + d[medida], 0) : null,
    });
  }
  return { pontos, semanal };
}

function PainelDashboard({ periodo, setPeriodo, irPara }: {
  periodo: Periodo; setPeriodo: (p: Periodo) => void; irPara: (aba: Aba) => void;
}) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [perfil, setPerfil] = useState<PerfilTemporal | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [tentativa, setTentativa] = useState(0);
  const [medida, setMedida] = useState<Medida>('valor');
  const [comparar, setComparar] = useState<Comparar>('anterior');
  const [produtoAberto, setProdutoAberto] = useState<number | null>(null);

  useEffect(() => {
    setCarregando(true);
    Promise.all([
      api<Dash>('/demanda/dashboard', { query: { ...paramsPeriodo(periodo), comparar } }),
      perfil ? Promise.resolve({ data: perfil }) : api<PerfilTemporal>('/demanda/perfil-temporal', { query: { dias: 1100 } }),
    ])
      .then(([d, p]) => { setDash(d.data); setPerfil(p.data); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o dashboard'))
      .finally(() => setCarregando(false));
    // O perfil (24 meses, dia da semana) nao depende do periodo: busca uma vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodo, comparar, tentativa]);

  // As datas so sao mostradas quando correspondem ao filtro escolhido: durante
  // o carregamento, o periodo antigo na tela faria parecer que o filtro errou.
  const filtro = (
    <div className="painel-filtro">
      <div className="painel-filtro__controles">
        <FiltroPeriodo periodo={periodo} aoMudar={setPeriodo} chips />
        <div className="painel-filtro__comparar">
          <span>Comparar com</span>
          <div className="alternador" role="group" aria-label="Base de comparacao">
            {([['anterior', 'Dias anteriores'], ['ano_anterior', 'Mesmo periodo do ano passado']] as const).map(([v, t]) => (
              <button key={v} type="button" aria-pressed={comparar === v}
                className={comparar === v ? 'ativo' : undefined} onClick={() => setComparar(v)}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="painel-filtro__nota" aria-live="polite">
        {carregando || !dash ? 'Calculando o periodo...' : (
          <>
            Vendas de <strong>{fmtData(dash.periodo.inicio)} a {fmtData(dash.periodo.fim)}</strong>
            {' '}({dash.periodo.dias} {dash.periodo.dias === 1 ? 'dia' : 'dias'}), comparadas
            com <strong>{fmtData(dash.periodo_anterior.inicio)} a {fmtData(dash.periodo_anterior.fim)}</strong>.
            {periodo.dias !== 'PERSONALIZADO' && dash.ultima_venda && (
              <> Os periodos contam a partir da ultima venda importada, em {fmtData(dash.ultima_venda)}.</>
            )}
          </>
        )}
      </p>
    </div>
  );
  const nomeBase = comparar === 'ano_anterior' ? 'ao mesmo periodo do ano passado' : 'aos dias anteriores';
  const sufixoBase = comparar === 'ano_anterior' ? 'vs ano passado' : 'vs periodo anterior';

  if (erro && !dash) {
    return (
      <>
        {filtro}
        <div className="painel-erro">
          <Aviso>{erro}</Aviso>
          <button type="button" className="botao" onClick={() => setTentativa((t) => t + 1)}>Tentar de novo</button>
        </div>
      </>
    );
  }
  if (!dash) return <>{filtro}<EsqueletoDashboard /></>;

  const semVendas = dash.quantidade_vendida === 0;
  const { pontos, semanal } = agrupar(dash, medida);
  const fmtMedida = medida === 'valor' ? (v: number) => moeda(v) : (v: number) => `${numero(v)} emb.`;
  const eixoMedida = medida === 'valor' ? reaisCompacto : (v: number) => compacto.format(v);

  // O mes corrente esta sempre incompleto, e meses antes da primeira venda
  // importada nao sao "zero vendido": sao "sem dado". Os dois saem do grafico.
  const meses = (perfil?.por_mes ?? []).slice(0, -1);
  const primeiro = meses.findIndex((m) => Number(m.quantidade) > 0);
  const mensal = primeiro < 0 ? [] : meses.slice(primeiro).slice(-24);
  const mediaMensal = mensal.length ? mensal.reduce((s, m) => s + Number(m.quantidade), 0) / mensal.length : 0;
  const porDia = perfil?.por_dia_semana ?? [];
  const melhorDia = porDia.reduce<typeof porDia[number] | undefined>(
    (m, d) => (Number(d.media) > Number(m?.media ?? -1) ? d : m), undefined);

  const ticket = dash.documentos > 0 ? dash.faturamento / dash.documentos : 0;
  const classificados = dash.curva_abc.filter((c) => c.curva !== 'SEM').some((c) => c.produtos > 0);
  const comparados = dash.produtos_em_alta + dash.produtos_em_queda;

  const sinais: Array<{ nome: string; valor: number; texto: string; tom: string; explica: string; aba: Aba }> = [
    { nome: 'Em ruptura', valor: dash.produtos_em_ruptura, texto: numero(dash.produtos_em_ruptura),
      tom: 'perigo', explica: 'vendem e estao sem saldo agora', aba: 'ruptura' },
    { nome: 'Demanda reprimida', valor: dash.demanda_reprimida_estimada, texto: numero(dash.demanda_reprimida_estimada),
      tom: 'perigo',
      explica: dash.demanda_reprimida_estimada
        ? `embalagens que deixaram de vender, cerca de ${moeda(dash.valor_reprimido_estimado)}`
        : 'estimativa do que deixou de vender sem estoque', aba: 'ruptura' },
    { nome: 'Em queda', valor: dash.produtos_em_queda, texto: numero(dash.produtos_em_queda),
      tom: 'alerta', explica: 'venderam menos que na comparacao', aba: 'analise' },
    { nome: 'Em alta', valor: dash.produtos_em_alta, texto: numero(dash.produtos_em_alta),
      tom: 'ok', explica: 'venderam mais que na comparacao', aba: 'analise' },
    { nome: 'Sazonais', valor: dash.produtos_sazonais, texto: numero(dash.produtos_sazonais),
      tom: 'info', explica: 'com indice sazonal confirmado', aba: 'sazonalidade' },
  ];

  const nomeProduto = (p: ProdutoDash) => (
    <><span className="num">{p.codigo}</span> {p.descricao}</>
  );

  return (
    <div className={`painel${carregando ? ' painel--atualizando' : ''}`} aria-busy={carregando}>
      {carregando && <div className="painel__progresso" aria-hidden />}
      {filtro}
      {erro && <Aviso>{erro}</Aviso>}

      {semVendas ? (
        <Vazio>
          Nenhuma venda entre {fmtData(dash.periodo.inicio)} e {fmtData(dash.periodo.fim)}.
          Escolha outro periodo ou importe o Rel 7104 em "Importar vendas".
        </Vazio>
      ) : (
        <>
          {/* ------------------------------------------------ numeros do periodo */}
          <section className="kpis" aria-label="Numeros do periodo">
            <div className="kpi-heroi">
              <span className="kpi__rotulo">Faturamento</span>
              <span className="kpi-heroi__valor" title={moeda(dash.faturamento)}>
                <Contagem valor={dash.faturamento} formatar={reaisHeroi} />
              </span>
              <Delta valor={variacao(dash.faturamento, dash.faturamento_anterior)} sufixo={sufixoBase} />
              <span className="kpi__nota">
                {moeda(dash.faturamento)} de {fmtData(dash.periodo.inicio)} a {fmtData(dash.periodo.fim)}
                {' '}({dash.periodo.dias} dias). Na comparacao: {moeda(dash.faturamento_anterior)}.
              </span>
            </div>
            <div className="kpi">
              <span className="kpi__rotulo">Embalagens vendidas</span>
              <span className="kpi__valor"><Contagem valor={dash.quantidade_vendida} formatar={(v) => numero(v)} /></span>
              <Delta valor={dash.variacao_percentual} sufixo="" />
              <span className="kpi__nota">antes {numero(dash.quantidade_anterior)}</span>
            </div>
            <div className="kpi">
              <span className="kpi__rotulo">Ticket medio por nota</span>
              <span className="kpi__valor"><Contagem valor={ticket} formatar={moeda} /></span>
              <span className="kpi__nota">{numero(dash.documentos)} notas no periodo</span>
            </div>
            <div className="kpi">
              <span className="kpi__rotulo">Media por dia</span>
              <span className="kpi__valor"><Contagem valor={dash.demanda_media_diaria} formatar={(v) => numero(v)} /></span>
              <span className="kpi__nota">{numero(dash.demanda_media_mensal)} embalagens por mes</span>
            </div>
            <div className="kpi">
              <span className="kpi__rotulo">Produtos que venderam</span>
              <span className="kpi__valor"><Contagem valor={dash.produtos_com_venda} formatar={(v) => numero(v)} /></span>
              <span className="kpi__nota">
                {dash.concentracao.produtos_80 > 0
                  ? `${numero(dash.concentracao.produtos_80)} fazem 80% do faturamento`
                  : 'sem concentracao calculada'}
              </span>
            </div>
          </section>

          {/* ------------------------------------------- serie atual x anterior */}
          <Cartao
            titulo={`Venda por ${semanal ? 'semana' : 'dia'}, comparada ${nomeBase}`}
            acoes={(
              <div className="alternador" role="group" aria-label="Medida do grafico">
                {(['valor', 'quantidade'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={medida === m}
                    className={medida === m ? 'ativo' : undefined} onClick={() => setMedida(m)}>
                    {m === 'valor' ? 'Faturamento' : 'Embalagens'}
                  </button>
                ))}
              </div>
            )}
          >
            <GraficoComparativo
              key={`${dash.periodo.inicio}-${dash.periodo.fim}-${medida}`}
              pontos={pontos}
              formatar={fmtMedida}
              formatarEixo={eixoMedida}
              nomeAtual={`${fmtData(dash.periodo.inicio)} a ${fmtData(dash.periodo.fim)}`}
              nomeAnterior={`${fmtData(dash.periodo_anterior.inicio)} a ${fmtData(dash.periodo_anterior.fim)}`}
            />
          </Cartao>

          {/* ------------------------------------------ sinais e concentracao */}
          <div className="painel-grade">
            <Cartao titulo="Sinais da carteira">
              {comparados > 0 && (
                <div className="placar">
                  <div className="placar__barra" role="img"
                    aria-label={`${dash.produtos_em_alta} em alta e ${dash.produtos_em_queda} em queda`}>
                    <span className="anima-barra" style={{ flexGrow: dash.produtos_em_alta, background: COR.alta }} />
                    <span className="anima-barra" style={{ flexGrow: dash.produtos_em_queda, background: COR.queda }} />
                  </div>
                  <div className="placar__legenda">
                    <span>▲ {numero((dash.produtos_em_alta / comparados) * 100)}% dos produtos subiram</span>
                    <span>▼ {numero((dash.produtos_em_queda / comparados) * 100)}% cairam</span>
                  </div>
                </div>
              )}
              <ul className="sinais">
                {sinais.map((s) => (
                  <li key={s.nome}>
                    <button type="button" className={`sinal${s.valor ? '' : ' sinal--zero'}`} onClick={() => irPara(s.aba)}>
                      <span className={`sinal__marca sinal__marca--${s.tom}`} aria-hidden />
                      <span className="sinal__nome">{s.nome}</span>
                      <span className="sinal__valor"><Contagem valor={s.valor} formatar={(v) => numero(v)} /></span>
                      <span className="sinal__explica">{s.explica}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Cartao>

            <Cartao titulo="Faturamento por curva ABC">
              {classificados ? (
                <>
                  <BarraComposicao partes={dash.curva_abc.map((c) => ({
                    nome: NOME_CURVA[c.curva]!, valor: c.valor, cor: CORES_CURVA[c.curva]!,
                    texto: `${numero(c.participacao, 1)}%`,
                  }))} />
                  <table className="tabela-curva">
                    <thead>
                      <tr><th>Curva</th><th>Produtos</th><th>Faturamento</th><th>Parcela</th></tr>
                    </thead>
                    <tbody>
                      {dash.curva_abc.map((c) => (
                        <tr key={c.curva}>
                          <td><i style={{ background: CORES_CURVA[c.curva] }} />{NOME_CURVA[c.curva]}</td>
                          <td className="num">{numero(c.produtos)}</td>
                          <td className="num">{moeda(c.valor)}</td>
                          <td className="num">{numero(c.participacao, 1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <div className="vazio-acao">
                  <p>
                    Nenhum produto tem curva ABC ainda. A classificacao separa os poucos itens
                    que fazem a maior parte do faturamento, e eles merecem revisao mais frequente.
                  </p>
                  <p className="fraco">
                    Enquanto isso: {numero(dash.concentracao.produtos_80)} de {numero(dash.concentracao.produtos)} produtos
                    fazem 80% do faturamento deste periodo.
                  </p>
                  <button type="button" className="botao" onClick={() => irPara('abc')}>Classificar na aba ABC x XYZ</button>
                </div>
              )}
            </Cartao>
          </div>

          {/* ------------------------------------------------ produtos */}
          <div className="painel-grade painel-grade--larga">
            <Cartao titulo="Produtos que mais faturaram">
              <Ranking
                aoClicar={(id) => setProdutoAberto(Number(id))}
                itens={dash.top_produtos.map((p) => {
                  const v = variacao(p.valor, p.valor_anterior);
                  return {
                    chave: p.produto_id,
                    rotulo: nomeProduto(p),
                    sub: `${numero(p.quantidade)} emb., ${numero(p.participacao, 1)}% do faturamento`,
                    valor: p.valor,
                    texto: reaisCompacto(p.valor),
                    lado: v === null ? <span className="delta delta--neutro">novo</span>
                      : <span className={`delta delta--${Math.abs(v) < 0.5 ? 'neutro' : v > 0 ? 'alta' : 'queda'}`}>
                        {Math.abs(v) < 0.5 ? '=' : v > 0 ? '▲' : '▼'} {numero(Math.abs(v), 0)}%
                      </span>,
                  };
                })}
              />
            </Cartao>

            <Cartao titulo="Maiores altas e quedas em faturamento">
              {dash.maiores_altas.length + dash.maiores_quedas.length === 0 ? (
                <Vazio>Sem vendas no periodo de comparacao.</Vazio>
              ) : (
                <Divergente
                  aoClicar={(id) => setProdutoAberto(Number(id))}
                  itens={[...dash.maiores_altas, ...dash.maiores_quedas].map((p) => ({
                    chave: p.produto_id,
                    rotulo: nomeProduto(p),
                    valor: p.diferenca_valor,
                    texto: reaisCompacto(Math.abs(p.diferenca_valor)),
                  }))}
                />
              )}
              <p className="fraco nota-grafico">Diferenca em reais contra o periodo de comparacao. Clique para abrir o produto.</p>
            </Cartao>
          </div>
        </>
      )}

      {/* ------------------------------------------------ historico longo */}
      <div className="painel-grade painel-grade--larga">
        {mensal.length > 1 && (
          <Cartao titulo="Embalagens vendidas por mes">
            <GraficoColunas
              dados={mensal.map((m) => ({
                rotulo: `${MESES[m.mes - 1]}/${String(m.ano).slice(2)}`,
                titulo: `${MESES[m.mes - 1]} de ${m.ano}`,
                valor: Number(m.quantidade),
                extra: moeda(m.valor),
              }))}
              formatar={(v) => `${numero(v)} emb.`}
              formatarEixo={(v) => compacto.format(v)}
              referencia={mediaMensal}
              rotuloReferencia={`media ${compacto.format(mediaMensal)}`}
            />
            <p className="fraco nota-grafico">Meses fechados desde a primeira venda importada. A linha marca a media.</p>
          </Cartao>
        )}

        {porDia.length > 0 && (
          <Cartao titulo="Venda media por dia da semana">
            <GraficoColunas
              dados={porDia.map((d) => ({
                rotulo: d.nome.slice(0, 3),
                titulo: d.nome,
                valor: Number(d.media),
                destaque: d === melhorDia,
                extra: `${numero(d.participacao_percentual, 1)}% da semana`,
              }))}
              formatar={(v) => `${numero(v)} emb.`}
              formatarEixo={(v) => compacto.format(v)}
            />
            {melhorDia && (
              <p className="fraco nota-grafico">{melhorDia.nome} e o dia que mais vende, nos ultimos 365 dias.</p>
            )}
          </Cartao>
        )}
      </div>

      {(perfil?.por_ano?.length ?? 0) > 1 && (
        <Cartao titulo="Faturamento por ano">
          <GraficoColunas
            dados={perfil!.por_ano.map((a, i, todos) => ({
              rotulo: String(a.ano),
              valor: Number(a.valor),
              destaque: i === todos.length - 1,
              extra: `${numero(a.quantidade)} embalagens`,
            }))}
            formatar={moeda}
            formatarEixo={reaisCompacto}
            altura={200}
          />
          <p className="fraco nota-grafico">O ano atual ainda esta em curso e aparece menor.</p>
        </Cartao>
      )}

      {produtoAberto !== null && (
        <ModalProduto produtoId={produtoAberto} aoFechar={() => setProdutoAberto(null)} />
      )}
    </div>
  );
}

/** Mesmo desenho do painel, em blocos pulsando, para nao haver salto quando chegar. */
function EsqueletoDashboard() {
  return (
    <div className="painel" aria-busy="true" aria-label="Carregando o dashboard">
      <section className="kpis">
        <div className="kpi-heroi">
          <Esqueleto altura={12} largura={90} />
          <Esqueleto altura={44} largura="80%" />
          <Esqueleto altura={14} largura={160} />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div className="kpi" key={i}>
            <Esqueleto altura={11} largura={110} />
            <Esqueleto altura={26} largura="70%" />
            <Esqueleto altura={11} largura={130} />
          </div>
        ))}
      </section>
      <div className="cartao"><div className="cartao__corpo"><Esqueleto altura={290} /></div></div>
      <div className="painel-grade">
        <div className="cartao"><div className="cartao__corpo"><Esqueleto altura={240} /></div></div>
        <div className="cartao"><div className="cartao__corpo"><Esqueleto altura={240} /></div></div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- vendas */

interface LinhaVenda {
  data_venda: string; numero_documento: string; tipo_documento: string; canal: string | null;
  cliente: string | null; cidade: string | null; estado: string | null;
  codigo: string; descricao: string; unidade: string;
  quantidade: number; preco_unitario: number; valor_total: number; quantidade_liquida: number;
}

function PainelVendas({ periodo, setPeriodo }: { periodo: Periodo; setPeriodo: (p: Periodo) => void }) {
  const [busca, setBusca] = useState('');
  const [tipo, setTipo] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro } = useLista<LinhaVenda>('/demanda/vendas', {
    pagina, limite: 25, busca, tipo_documento: tipo, ...paramsPeriodo(periodo),
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
          <FiltroPeriodo periodo={periodo} aoMudar={(p) => { setPeriodo(p); setPagina(1); }} />
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
                  <td className="celula-produto" title={v.descricao}>
                    <span className="celula-produto__nome">{v.descricao}</span>
                  </td>
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

function PainelAnalise({ periodo, setPeriodo }: { periodo: Periodo; setPeriodo: (p: Periodo) => void }) {
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);
  const [ordenar, setOrdenar] = useState('quantidade');
  const [detalhe, setDetalhe] = useState<number | null>(null);

  const { itens, meta, carregando, erro } = useLista<LinhaAnalise>('/demanda', {
    pagina, limite: 25, busca, ...paramsPeriodo(periodo), ordenar_por: ordenar, ordem: 'desc',
  });

  return (
    <>
      <Cartao
        titulo="Demanda por produto"
        acoes={(
          <div className="filtros">
            <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="codigo ou descricao" />
            <FiltroPeriodo periodo={periodo} aoMudar={(p) => { setPeriodo(p); setPagina(1); }} />
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
                  <th className="num">Dias c/ venda</th><th>Variacao</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((l) => (
                  <tr key={l.produto_id} className="linha-clicavel" tabIndex={0}
                    title="Abrir o historico do produto"
                    onClick={() => setDetalhe(l.produto_id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setDetalhe(l.produto_id); }}>
                    <td className="mono">{l.codigo}</td>
                    <td className="celula-produto" title={l.descricao}>
                      <span className="celula-produto__nome">{l.descricao}</span>
                    </td>
                    <td className="fraco">{l.categoria}</td>
                    <td>{l.classificacao_abc ? <Etiqueta texto={l.classificacao_abc} /> : '—'}</td>
                    <td>{l.classificacao_xyz ? <Etiqueta texto={l.classificacao_xyz} /> : '—'}</td>
                    <td className="num">{numero(l.quantidade)}</td>
                    <td className="num">{moeda(l.valor)}</td>
                    <td className="num">{numero(l.media_diaria, 2)}</td>
                    <td className="num">{numero(l.media_mensal, 1)}</td>
                    <td className="num">{numero(l.dias_com_venda)}</td>
                    <td><Variacao valor={l.variacao_percentual} /></td>
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
        {dados && !dados.matriz.some((m) => m.xyz !== 'SEM' && Number(m.produtos) > 0) && (
          <Aviso>
            Nenhum produto foi classificado ainda.
            {podeCalcular
              ? ' Use "Reclassificar" para calcular as curvas ABC e XYZ com as vendas dos ultimos 365 dias.'
              : ' Peca a quem tem permissao de previsao para calcular as curvas.'}
          </Aviso>
        )}
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
