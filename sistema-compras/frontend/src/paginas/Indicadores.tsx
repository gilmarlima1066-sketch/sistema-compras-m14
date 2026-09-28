/**
 * Modulo 11 - dashboards gerenciais, indicadores e analises.
 *
 * Tres compromissos guiam esta tela:
 *
 * 1. Um filtro so (secoes 7 e 8). O periodo e as dimensoes escolhidas no topo
 *    valem para todos os KPIs do painel. Quando um indicador nao sabe aplicar
 *    uma dimensao, a tela DIZ que ignorou - nao finge que filtrou.
 *
 * 2. Ausencia de dado nao e zero (regra 6). KPI nao calculavel aparece como
 *    "sem dados", em cinza, com o motivo - nunca como 0 em vermelho.
 *
 * 3. Daqui nao se altera dado operacional (regras 9 e 10). Todo caminho que
 *    sai de um numero leva a lista e dela ao modulo que cuida do registro.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Selecao, Vazio,
  data as fmtData, dataHora, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras, GraficoLinha, Matriz } from '../componentes/graficos';

type Aba = 'paineis' | 'analises' | 'dicionario';
type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

/** Semaforo da secao 47. CINZA e ausencia de dado ou de meta, nao um estado ruim. */
const TOM_SEMAFORO: Record<string, Tom> = {
  VERDE: 'acento', AMARELO: 'alerta', VERMELHO: 'perigo', CINZA: 'neutro',
};

const TOM_RISCO: Record<string, Tom> = {
  CRITICO: 'perigo', ALTO: 'perigo', MODERADO: 'alerta', BAIXO: 'acento',
};

const PAINEIS = [
  { codigo: 'executivo', texto: 'Executivo', permissao: 'bi.executivo' },
  { codigo: 'compras', texto: 'Compras' },
  { codigo: 'estoque', texto: 'Estoque' },
  { codigo: 'demanda', texto: 'Demanda' },
  { codigo: 'fornecedores', texto: 'Fornecedores' },
  { codigo: 'logistica', texto: 'Logistica' },
  { codigo: 'recebimento', texto: 'Recebimento' },
  { codigo: 'qualidade', texto: 'Qualidade' },
  { codigo: 'financeiro', texto: 'Financeiro' },
  { codigo: 'importacoes', texto: 'Importacoes' },
  { codigo: 'comprador', texto: 'Comprador' },
  { codigo: 'riscos', texto: 'Riscos', permissao: 'bi.executivo' },
];

const PERIODOS = [
  { valor: 'SEMANA', texto: 'Ultimos 7 dias' },
  { valor: 'MES', texto: 'Ultimos 30 dias' },
  { valor: 'TRIMESTRE', texto: 'Ultimos 90 dias' },
  { valor: 'SEMESTRE', texto: 'Ultimos 180 dias' },
  { valor: 'ANO_ATUAL', texto: 'Ano atual' },
  { valor: 'ANO_ANTERIOR', texto: 'Ano anterior' },
];

export interface Filtro {
  periodo: string;
  categoria_id: string;
  fornecedor_id: string;
}

const FILTRO_INICIAL: Filtro = { periodo: 'TRIMESTRE', categoria_id: '', fornecedor_id: '' };

const paraQuery = (f: Filtro) => ({
  periodo: f.periodo || undefined,
  categoria_id: f.categoria_id || undefined,
  fornecedor_id: f.fornecedor_id || undefined,
});

/** Formata o valor conforme a unidade oficial do indicador (secao 51). */
export function formatarKpi(valor: number | null, unidade: string, casas = 2): string {
  if (valor === null || valor === undefined) return 'sem dados';
  switch (unidade) {
    case 'PERCENTUAL': return `${numero(valor, casas)}%`;
    case 'MOEDA': return moeda(valor);
    case 'DIAS': return `${numero(valor, casas)} dias`;
    case 'VEZES': return `${numero(valor, casas)}x`;
    case 'QUANTIDADE': return numero(valor, casas);
    default: return numero(valor, casas);
  }
}

// ---------------------------------------------------------------------------

export function Indicadores() {
  const [aba, setAba] = useState<Aba>('paineis');
  const [filtro, setFiltro] = useState<Filtro>(FILTRO_INICIAL);
  const [kpiAberto, setKpiAberto] = useState<string | null>(null);
  const [drill, setDrill] = useState<string | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Indicadores e dashboards"
        descricao="Camada de analise sobre os modulos operacionais. Cada numero tem definicao
          oficial, meta e caminho ate o registro de origem."
      />

      <BarraFiltros filtro={filtro} aoMudar={setFiltro} />

      <nav className="abas">
        {([
          { id: 'paineis' as Aba, texto: 'Paineis' },
          { id: 'analises' as Aba, texto: 'Analises' },
          { id: 'dicionario' as Aba, texto: 'Dicionario de indicadores' },
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

      {aba === 'paineis' && (
        <Paineis filtro={filtro} aoAbrirKpi={setKpiAberto} aoAbrirDrill={setDrill} />
      )}
      {aba === 'analises' && <Analises filtro={filtro} aoAbrirDrill={setDrill} />}
      {aba === 'dicionario' && <Dicionario aoAbrirKpi={setKpiAberto} />}

      {kpiAberto && (
        <DetalheKpi
          codigo={kpiAberto}
          filtro={filtro}
          aoFechar={() => setKpiAberto(null)}
          aoAbrirDrill={setDrill}
        />
      )}
      {drill && <Drilldown destino={drill} filtro={filtro} aoFechar={() => setDrill(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Filtro global (secoes 7 e 8)
// ---------------------------------------------------------------------------

function BarraFiltros({ filtro, aoMudar }: {
  filtro: Filtro; aoMudar: (f: Filtro) => void;
}) {
  const [categorias, setCategorias] = useState<any[]>([]);
  const [fornecedores, setFornecedores] = useState<any[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [c, f] = await Promise.all([
          api<any[]>('/cadastros/categorias'),
          api<any[]>('/fornecedores', { query: { limite: 200, ativo: true } }),
        ]);
        setCategorias(c.data ?? []);
        setFornecedores(f.data ?? []);
      } catch { /* filtros opcionais: a tela funciona sem eles */ }
    })();
  }, []);

  return (
    <Cartao titulo="Filtros">
      <div className="filtros">
        <Selecao
          rotulo="Periodo"
          valor={filtro.periodo}
          aoMudar={(v) => aoMudar({ ...filtro, periodo: v })}
          opcoes={PERIODOS}
          vazio={null}
        />
        <Selecao
          rotulo="Categoria"
          valor={filtro.categoria_id}
          aoMudar={(v) => aoMudar({ ...filtro, categoria_id: v })}
          opcoes={categorias.map((c) => ({ valor: String(c.id), texto: c.nome }))}
          vazio="Todas"
        />
        <Selecao
          rotulo="Fornecedor"
          valor={filtro.fornecedor_id}
          aoMudar={(v) => aoMudar({ ...filtro, fornecedor_id: v })}
          opcoes={fornecedores.map((f) => ({
            valor: String(f.id), texto: f.razao_social ?? f.nome_fantasia,
          }))}
          vazio="Todos"
        />
        <button
          type="button"
          className="botao botao--fantasma"
          style={{ alignSelf: 'flex-end' }}
          onClick={() => aoMudar(FILTRO_INICIAL)}
        >
          Limpar
        </button>
      </div>
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Cartao de KPI
// ---------------------------------------------------------------------------

function CartaoKpi({ kpi, aoAbrir }: { kpi: any; aoAbrir: () => void }) {
  const semDados = !kpi.calculavel;
  const nota = semDados
    ? kpi.motivo ?? 'Sem dados no periodo'
    : kpi.meta
      ? `Meta ${formatarKpi(kpi.meta.meta, kpi.unidade, kpi.casas_decimais)}`
        + (kpi.desvio_texto ? ` · ${kpi.desvio_texto}` : '')
      : 'Sem meta definida';

  return (
    <button type="button" className="indicador-botao" onClick={aoAbrir} title={kpi.formula}>
      <Indicador
        rotulo={kpi.nome}
        valor={semDados
          ? <span className="fraco">sem dados</span>
          : formatarKpi(kpi.valor, kpi.unidade, kpi.casas_decimais)}
        nota={nota}
        tom={TOM_SEMAFORO[kpi.semaforo] ?? 'neutro'}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Paineis (secoes 5, 6 e 54)
// ---------------------------------------------------------------------------

function Paineis({ filtro, aoAbrirKpi, aoAbrirDrill }: {
  filtro: Filtro;
  aoAbrirKpi: (c: string) => void;
  aoAbrirDrill: (d: string) => void;
}) {
  const { pode } = useAuth();
  const disponiveis = PAINEIS.filter((p) => !p.permissao || pode(p.permissao));
  const [painel, setPainel] = useState(disponiveis[0]?.codigo ?? 'compras');
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    void (async () => {
      try {
        const { data } = await api<any>(`/dashboard/${painel}`, { query: paraQuery(filtro) });
        if (vivo) { setDados(data); setErro(null); }
      } catch (e) {
        if (vivo) { setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o painel'); }
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, [painel, filtro]);

  return (
    <>
      <nav className="abas abas--secundaria">
        {disponiveis.map((p) => (
          <button
            key={p.codigo}
            type="button"
            className={`abas__item${painel === p.codigo ? ' abas__item--ativo' : ''}`}
            onClick={() => setPainel(p.codigo)}
          >
            {p.texto}
          </button>
        ))}
      </nav>

      {erro && <Aviso>{erro}</Aviso>}
      {carregando && <Cartao><Vazio>Apurando indicadores…</Vazio></Cartao>}

      {dados && !carregando && (
        <>
          <Cartao
            titulo={dados.titulo}
            acoes={(
              <span className="fraco">
                {dados.periodo.inicio} a {dados.periodo.fim} ·
                {' '}atualizado em {dataHora(dados.atualizado_em)}
                {dados.tempo_real ? ' (tempo real)' : ''}
              </span>
            )}
          >
            <div className="grade-indicadores">
              <Indicador rotulo="Indicadores" valor={dados.resumo.total} />
              <Indicador rotulo="Dentro da meta" valor={dados.resumo.verde} tom="acento" />
              <Indicador rotulo="Em atencao" valor={dados.resumo.amarelo} tom="alerta" />
              <Indicador rotulo="Fora da meta" valor={dados.resumo.vermelho} tom="perigo" />
              <Indicador rotulo="Sem dados" valor={dados.resumo.sem_dados} />
            </div>

            {/* Secao 8: dimensao que algum indicador nao soube aplicar. */}
            {dados.filtros_ignorados?.length > 0 && (
              <Aviso tipo="erro">
                Filtro nao aplicavel a todos os indicadores deste painel:
                {' '}{dados.filtros_ignorados.join(', ')}. Os numeros marcados abaixo
                consideram a base completa nessa dimensao.
              </Aviso>
            )}
          </Cartao>

          {dados.blocos
            ? Object.entries(dados.blocos).map(([nome, kpis]: [string, any]) => (
              <Cartao key={nome} titulo={nome.replace(/_/g, ' ').toUpperCase()}>
                <div className="grade-indicadores">
                  {kpis.map((k: any) => (
                    <CartaoKpi key={k.codigo} kpi={k} aoAbrir={() => aoAbrirKpi(k.codigo)} />
                  ))}
                </div>
              </Cartao>
            ))
            : (
              <Cartao titulo="Indicadores">
                <div className="grade-indicadores">
                  {dados.kpis.map((k: any) => (
                    <CartaoKpi key={k.codigo} kpi={k} aoAbrir={() => aoAbrirKpi(k.codigo)} />
                  ))}
                </div>
              </Cartao>
            )}

          {painel === 'riscos' && dados.extras?.mapa && (
            <MapaRiscos mapa={dados.extras.mapa} aoAbrirDrill={aoAbrirDrill} />
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detalhe do KPI: definicao, serie, comparacao e drill-down
// ---------------------------------------------------------------------------

function DetalheKpi({ codigo, filtro, aoFechar, aoAbrirDrill }: {
  codigo: string;
  filtro: Filtro;
  aoFechar: () => void;
  aoAbrirDrill: (d: string) => void;
}) {
  const [dados, setDados] = useState<any>(null);
  const [serie, setSerie] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, s] = await Promise.all([
          api<any>(`/kpis/${codigo}/comparacao`, { query: paraQuery(filtro) }),
          api<any>(`/kpis/${codigo}/serie`, { query: { ...paraQuery(filtro), meses: 6 } }),
        ]);
        setDados(c.data);
        setSerie(s.data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao abrir o indicador');
      }
    })();
  }, [codigo, filtro]);

  const pontos: any[] = serie?.pontos ?? [];

  return (
    <Modal titulo={dados?.nome ?? codigo} aoFechar={aoFechar} largo>
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Apurando…</Vazio>}

      {dados && (
        <>
          <div className="grade-indicadores">
            <Indicador
              rotulo={dados.pontual ? 'Posicao atual' : 'Valor no periodo'}
              valor={dados.calculavel
                ? formatarKpi(dados.valor, dados.unidade, dados.casas_decimais)
                : <span className="fraco">sem dados</span>}
              nota={dados.calculavel
                ? `${dados.eventos} evento(s) considerados`
                : dados.motivo}
              tom={TOM_SEMAFORO[dados.semaforo] ?? 'neutro'}
            />
            <Indicador
              rotulo="Meta vigente"
              valor={dados.meta
                ? formatarKpi(dados.meta.meta, dados.unidade, dados.casas_decimais)
                : '—'}
              nota={dados.meta ? `Escopo ${dados.meta.escopo}` : 'Sem meta definida'}
            />
            <Indicador
              rotulo="Desvio"
              valor={dados.desvio_texto ?? '—'}
              nota={dados.desvio_unidade === 'PONTOS_PERCENTUAIS'
                ? 'Diferenca em pontos percentuais'
                : 'Diferenca absoluta'}
            />
            {dados.pontual && (
              <Indicador
                rotulo="Natureza do indicador"
                valor="Posicao atual"
                nota="Mede como esta agora, nao o que aconteceu no periodo"
              />
            )}
            {dados.comparacao?.periodo_anterior && (
              <Indicador
                rotulo="Periodo anterior"
                valor={dados.comparacao.periodo_anterior.texto
                  ?? formatarKpi(dados.comparacao.periodo_anterior.anterior ?? null,
                    dados.unidade, dados.casas_decimais)}
                nota={`${dados.comparacao.periodo_anterior.periodo.inicio} a `
                  + `${dados.comparacao.periodo_anterior.periodo.fim}`}
              />
            )}
            {dados.comparacao?.ano_anterior && (
              <Indicador
                rotulo="Mesmo periodo do ano anterior"
                valor={dados.comparacao.ano_anterior.texto ?? '—'}
                nota={dados.comparacao.ano_anterior.periodo.inicio.slice(0, 4)}
              />
            )}
          </div>

          {/* Regras 2, 3 e 7: definicao oficial, rastreavel e datada. */}
          <Cartao titulo="Definicao oficial">
            <dl className="definicoes">
              <dt>Formula</dt><dd>{dados.formula}</dd>
              <dt>Fonte</dt><dd>{dados.fonte}</dd>
              <dt>Periodicidade</dt><dd>{dados.periodicidade}</dd>
              <dt>Direcao</dt>
              <dd>{dados.direcao === 'MAIOR_MELHOR' ? 'Maior e melhor' : 'Menor e melhor'}</dd>
              {dados.interpretacao && (<><dt>Como ler</dt><dd>{dados.interpretacao}</dd></>)}
              <dt>Apurado em</dt><dd>{dataHora(dados.atualizado_em)}</dd>
              <dt>Referencia</dt>
              <dd>
                {dados.pontual
                  ? 'Posicao no momento da consulta - o filtro de periodo nao se aplica'
                  : `Periodo de ${dados.periodo.inicio} a ${dados.periodo.fim}`}
              </dd>
            </dl>
            {dados.motivo_comparacao && (
              <p className="fraco">{dados.motivo_comparacao}</p>
            )}
            {dados.filtros_ignorados?.length > 0 && (
              <Aviso tipo="erro">
                Este indicador nao aplica o filtro de: {dados.filtros_ignorados.join(', ')}.
              </Aviso>
            )}
          </Cartao>

          {serie?.pontual && (
            <Cartao titulo="Evolucao mensal">
              <Vazio>{serie.motivo}</Vazio>
            </Cartao>
          )}

          {pontos.length > 0 && (
            <Cartao titulo="Evolucao mensal">
              <GraficoLinha
                rotulos={pontos.map((p: any) => p.periodo ?? '')}
                series={[
                  {
                    nome: dados.nome,
                    // Mes sem apuracao fica como NaN: o grafico o omite em vez
                    // de desenhar um zero que nunca aconteceu (regra 6).
                    valores: pontos.map((p: any) => (p.calculavel
                      ? Number(p.valor)
                      : Number.NaN)),
                  },
                  ...(dados.meta ? [{
                    nome: 'Meta',
                    valores: pontos.map(() => Number(dados.meta.meta)),
                    tracejada: true,
                  }] : []),
                ]}
                formatar={(v) => formatarKpi(v, dados.unidade, dados.casas_decimais)}
              />
              {pontos.some((p: any) => p.calculavel === false) && (
                <p className="fraco">
                  Meses sem movimentacao aparecem sem ponto: ausencia de dado nao e zero.
                </p>
              )}
            </Cartao>
          )}

          {dados.drilldown && (
            <button
              type="button"
              className="botao botao--primario"
              onClick={() => { aoFechar(); aoAbrirDrill(dados.drilldown); }}
            >
              Ver os registros que compoem este numero
            </button>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Drill-down (secoes 43 a 46)
// ---------------------------------------------------------------------------

function celula(valor: unknown, tipo: string) {
  if (valor === null || valor === undefined) return <span className="fraco">—</span>;
  switch (tipo) {
    case 'moeda': return <span className="num">{moeda(valor)}</span>;
    case 'numero': return <span className="num">{numero(valor, 2)}</span>;
    case 'percentual': return <span className="num">{numero(valor, 2)}%</span>;
    case 'data': return fmtData(String(valor));
    case 'etiqueta': return <Etiqueta texto={String(valor)} />;
    default: return String(valor);
  }
}

function Drilldown({ destino, filtro, aoFechar }: {
  destino: string; filtro: Filtro; aoFechar: () => void;
}) {
  const navegar = useNavigate();
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [contexto, setContexto] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>('/dashboard/drilldown', {
          query: { ...paraQuery(filtro), destino },
        });
        setDados(data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao abrir o detalhamento');
      }
    })();
  }, [destino, filtro]);

  if (contexto !== null) {
    return <ContextoDecisao produtoId={contexto} aoFechar={() => setContexto(null)} />;
  }

  return (
    <Modal titulo={dados?.titulo ?? 'Detalhamento'} aoFechar={aoFechar} largo>
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Carregando…</Vazio>}

      {dados && (
        <>
          <p className="fraco">
            Origem: {dados.origem} · {dados.periodo.inicio} a {dados.periodo.fim}
            {dados.truncado
              && ` · mostrando ${dados.exibidas} de ${dados.total} — refine os filtros`}
          </p>

          {dados.linhas.length === 0
            ? <Vazio>Nenhum registro no periodo e nos filtros selecionados.</Vazio>
            : (
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr>
                      {dados.colunas.map((c: any) => <th key={c.campo}>{c.titulo}</th>)}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dados.linhas.map((l: any, i: number) => (
                      <tr key={l.id ?? l.produto_id ?? i}>
                        {dados.colunas.map((c: any) => (
                          <td key={c.campo}>{celula(l[c.campo], c.tipo)}</td>
                        ))}
                        <td>
                          {/* Regra 10: daqui se NAVEGA ate o modulo operacional. */}
                          {dados.entidade === 'produto' && l.produto_id && (
                            <button
                              type="button"
                              className="botao botao--pequeno botao--fantasma"
                              onClick={() => setContexto(Number(l.produto_id))}
                            >
                              Contexto
                            </button>
                          )}
                          <button
                            type="button"
                            className="botao botao--pequeno botao--fantasma"
                            onClick={() => { aoFechar(); navegar(dados.rota); }}
                          >
                            Abrir modulo
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          <p className="fraco">
            {dados.total} registro(s) no recorte
            {dados.truncado && `, ${dados.exibidas} listados aqui`}.
            Esta e uma visao de analise: alteracoes sao feitas no modulo de origem.
          </p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Contexto de decisao (secao 72)
// ---------------------------------------------------------------------------

function ContextoDecisao({ produtoId, aoFechar }: {
  produtoId: number; aoFechar: () => void;
}) {
  const navegar = useNavigate();
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>(`/dashboard/contexto/${produtoId}`);
        setDados(data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao montar o contexto');
      }
    })();
  }, [produtoId]);

  return (
    <Modal titulo={dados ? `Contexto: ${dados.produto.descricao}` : 'Contexto'} aoFechar={aoFechar} largo>
      {erro && <Aviso>{erro}</Aviso>}
      {!dados && !erro && <Vazio>Reunindo o quadro…</Vazio>}

      {dados && (
        <>
          <div className="grade-indicadores">
            <Indicador rotulo="Disponivel" valor={numero(dados.situacao.disponivel, 2)}
              tom={dados.situacao.em_ruptura ? 'perigo' : 'neutro'} />
            <Indicador rotulo="Em transito" valor={numero(dados.situacao.em_transito, 2)} />
            <Indicador rotulo="Em quarentena" valor={numero(dados.situacao.quarentena, 2)} />
            <Indicador rotulo="Demanda/dia" valor={numero(dados.situacao.demanda_diaria, 2)} />
            <Indicador
              rotulo="Cobertura"
              valor={dados.situacao.cobertura_dias === null
                ? <span className="fraco">sem demanda</span>
                : `${numero(dados.situacao.cobertura_dias, 1)} dias`}
              nota={dados.situacao.cobertura_dias === null
                ? 'Sem consumo no periodo: cobertura nao se aplica' : undefined}
            />
            <Indicador
              rotulo="Impacto diario"
              valor={moeda(dados.impacto.valor_demanda_diaria)}
              nota={`Classe ${dados.impacto.classificacao_abc ?? '—'}`}
            />
          </div>

          <Cartao titulo="Origem: o que explica a situacao">
            <ul className="lista-causas">
              {dados.origem.map((o: any, i: number) => (
                <li key={i}><strong>{o.causa}</strong> — <span className="fraco">{o.evidencia}</span></li>
              ))}
            </ul>
          </Cartao>

          <Cartao titulo="Registros relacionados">
            <TabelaSimples titulo="Pedidos em aberto" linhas={dados.relacionados.pedidos_abertos}
              campos={['numero', 'fornecedor', 'quantidade_pendente', 'data_prometida', 'dias_atraso']} />
            <TabelaSimples titulo="Necessidades de compra" linhas={dados.relacionados.necessidades}
              campos={['prioridade', 'quantidade_sugerida', 'data_necessaria', 'status']} />
            <TabelaSimples titulo="Recebimentos recentes" linhas={dados.relacionados.recebimentos_recentes}
              campos={['numero', 'fornecedor', 'data_recebimento', 'status']} />
            <TabelaSimples titulo="Nao conformidades" linhas={dados.relacionados.nao_conformidades}
              campos={['numero', 'tipo', 'severidade', 'status']} />
            <TabelaSimples titulo="Fornecedores do produto" linhas={dados.relacionados.fornecedores}
              campos={['razao_social', 'status_homologacao', 'score_atual', 'preco_atual', 'lead_time']} />
          </Cartao>

          <Cartao titulo="Acoes disponiveis">
            <p className="fraco">{dados.observacao}</p>
            <div className="acoes">
              {dados.acoes_disponiveis.map((a: any) => (
                <button
                  key={a.rota}
                  type="button"
                  className="botao botao--fantasma"
                  onClick={() => { aoFechar(); navegar(a.rota); }}
                >
                  {a.rotulo}
                </button>
              ))}
            </div>
          </Cartao>
        </>
      )}
    </Modal>
  );
}

function TabelaSimples({ titulo, linhas, campos }: {
  titulo: string; linhas: any[]; campos: string[];
}) {
  if (!linhas?.length) {
    return <p className="fraco">{titulo}: nenhum registro.</p>;
  }
  return (
    <>
      <h4>{titulo}</h4>
      <div className="tabela-rolagem">
        <table className="tabela">
          <thead>
            <tr>{campos.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
          </thead>
          <tbody>
            {linhas.map((l, i) => (
              <tr key={l.id ?? i}>
                {campos.map((c) => (
                  <td key={c}>
                    {l[c] === null || l[c] === undefined
                      ? <span className="fraco">—</span>
                      : String(l[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Analises: Pareto, ABC-XYZ e riscos (secoes 33, 35 e 36)
// ---------------------------------------------------------------------------

function Analises({ filtro, aoAbrirDrill }: {
  filtro: Filtro; aoAbrirDrill: (d: string) => void;
}) {
  const [analises, setAnalises] = useState<any[]>([]);
  const [escolhida, setEscolhida] = useState('COMPRAS_FORNECEDOR');
  const [pareto, setPareto] = useState<any>(null);
  const [matriz, setMatriz] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any[]>('/dashboard/pareto-analises');
        setAnalises(data ?? []);
      } catch { /* a lista de analises e opcional */ }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [p, m] = await Promise.all([
          api<any>('/dashboard/pareto', { query: { ...paraQuery(filtro), analise: escolhida } }),
          api<any>('/dashboard/matriz-abc-xyz', { query: paraQuery(filtro) }),
        ]);
        setPareto(p.data);
        setMatriz(m.data);
        setErro(null);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar as analises');
      }
    })();
  }, [escolhida, filtro]);

  const linhasAbc = ['A', 'B', 'C', 'SEM_CLASSE'];
  const colunasXyz = ['X', 'Y', 'Z', 'SEM_CLASSE'];

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      <Cartao
        titulo="Curva de Pareto"
        acoes={(
          <Selecao
            rotulo=""
            valor={escolhida}
            aoMudar={setEscolhida}
            opcoes={analises.map((a) => ({ valor: a.codigo, texto: a.titulo ?? a.codigo }))}
            vazio={null}
          />
        )}
      >
        {!pareto ? <Vazio>Carregando…</Vazio> : pareto.linhas?.length === 0
          ? <Vazio>Sem dados no periodo e nos filtros selecionados.</Vazio>
          : (
            <>
              <div className="grade-indicadores">
                <Indicador rotulo="Itens vitais" valor={pareto.vitais}
                  nota="Concentram a maior parte do total" tom="alerta" />
                <Indicador rotulo="Itens triviais"
                  valor={(pareto.linhas?.length ?? 0) - pareto.vitais} />
                <Indicador rotulo="Total analisado" valor={moeda(pareto.total)}
                  nota={pareto.leitura} />
                <Indicador rotulo="Corte" valor={`${numero(pareto.corte, 0)}%`}
                  nota="Percentual acumulado que separa vitais de triviais" />
              </div>
              <GraficoBarras
                dados={(pareto.linhas ?? []).slice(0, 12).map((l: any) => ({
                  rotulo: String(l.rotulo ?? l.nome ?? '').slice(0, 12),
                  valor: Number(l.valor ?? 0),
                  cor: l.vital ? undefined : '#b9c2cf',
                }))}
                formatar={(v) => moeda(v)}
              />
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>#</th><th>Item</th><th>Valor</th><th>%</th><th>% acumulado</th><th>Classe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pareto.linhas ?? []).map((l: any, i: number) => (
                      <tr key={l.id ?? i}>
                        <td className="num">{l.ordem ?? i + 1}</td>
                        <td>{l.rotulo ?? l.nome}</td>
                        <td className="num">{moeda(l.valor)}</td>
                        <td className="num">{numero(l.percentual, 2)}%</td>
                        <td className="num">{numero(l.acumulado, 2)}%</td>
                        <td>
                          <Etiqueta
                            texto={l.vital ? 'VITAL' : 'TRIVIAL'}
                            tom={l.vital ? 'alerta' : 'neutro'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </Cartao>

      <Cartao titulo="Matriz ABC x XYZ">
        {!matriz ? <Vazio>Carregando…</Vazio> : (
          <>
            <Matriz
              linhas={linhasAbc}
              colunas={colunasXyz}
              valor={(l, c) => {
                const q = (matriz.quadrantes ?? []).find(
                  (x: any) => x.abc === l && x.xyz === c);
                if (!q || !q.produtos) return null;
                return {
                  numero: Number(q.produtos),
                  detalhe: q.em_ruptura ? `${q.em_ruptura} em ruptura` : undefined,
                };
              }}
              rotulo={(
                <p className="fraco">
                  {matriz.total_produtos} produtos. Linhas: classe ABC (valor).
                  Colunas: classe XYZ (regularidade da demanda). {matriz.observacao}.
                </p>
              )}
            />
            <button
              type="button"
              className="botao botao--fantasma"
              onClick={() => aoAbrirDrill('estoque')}
            >
              Ver produtos
            </button>
          </>
        )}
      </Cartao>
    </>
  );
}

function MapaRiscos({ mapa, aoAbrirDrill }: {
  mapa: any; aoAbrirDrill: (d: string) => void;
}) {
  const produtos: any[] = mapa.produtos ?? [];
  const niveis = ['CRITICO', 'ALTO', 'MODERADO', 'BAIXO'];
  const linhas = ['ALTA', 'MEDIA', 'BAIXA'];
  const colunas = ['BAIXA', 'MEDIA', 'ALTA'];

  return (
    <>
      <Cartao titulo="Mapa de riscos">
        <p className="fraco">{mapa.observacao}</p>
        <div className="grade-indicadores">
          {niveis.map((n) => (
            <Indicador
              key={n}
              rotulo={n}
              valor={mapa.por_nivel?.[n] ?? 0}
              tom={TOM_RISCO[n] ?? 'neutro'}
            />
          ))}
          <Indicador rotulo="Produtos avaliados" valor={mapa.total} />
        </div>

        <Matriz
          linhas={linhas}
          colunas={colunas}
          valor={(l, c) => {
            const linha = (mapa.matriz ?? []).find((m: any) => m.probabilidade === l);
            const celula = (linha?.celulas ?? []).find((x: any) => x.impacto === c);
            return celula && celula.produtos
              ? { numero: Number(celula.produtos) }
              : null;
          }}
          rotulo={<p className="fraco">Linhas: probabilidade. Colunas: impacto.</p>}
        />
      </Cartao>

      {produtos.length > 0 && (
        <Cartao titulo="Produtos de maior risco">
          <p className="fraco">
            Os 25 produtos de maior risco entre os {produtos.length} avaliados. O nivel
            vem de fatores objetivos apurados nos registros - cada um esta listado junto
            ao produto, com o peso que teve, para conferencia.
          </p>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Produto</th><th>Probabilidade</th><th>Impacto</th>
                  <th>Nivel</th><th>Fatores</th><th />
                </tr>
              </thead>
              <tbody>
                {produtos.slice(0, 25).map((r: any, i: number) => (
                  <tr key={r.produto_id ?? i}>
                    <td>
                      {r.produto}
                      <div className="fraco">{r.codigo} · {r.categoria} · classe {r.abc ?? '—'}</div>
                    </td>
                    <td>
                      <Etiqueta texto={String(r.faixaProbabilidade ?? '—')} />
                      <div className="fraco">{numero(r.probabilidade, 0)} pts</div>
                    </td>
                    <td>
                      <Etiqueta texto={String(r.faixaImpacto ?? '—')} />
                      <div className="fraco">{numero(r.impacto, 0)} pts</div>
                    </td>
                    <td>
                      <Etiqueta texto={String(r.nivel ?? '—')} tom={TOM_RISCO[r.nivel] ?? 'neutro'} />
                    </td>
                    <td className="fraco">
                      <ul className="lista-causas">
                        {(r.fatores ?? []).map((f: any, n: number) => (
                          <li key={n}>{f.descricao} <em>({f.dimensao.toLowerCase()}, {f.peso} pts)</em></li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="botao botao--pequeno botao--fantasma"
                        onClick={() => aoAbrirDrill('criticos')}
                      >
                        Ver lista
                      </button>
                    </td>
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

// ---------------------------------------------------------------------------
// Dicionario de indicadores (secoes 65 e 66)
// ---------------------------------------------------------------------------

function Dicionario({ aoAbrirKpi }: { aoAbrirKpi: (c: string) => void }) {
  const { pode } = useAuth();
  const [verbetes, setVerbetes] = useState<any[]>([]);
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [metaDe, setMetaDe] = useState<any | null>(null);

  const carregar = async () => {
    try {
      const { data } = await api<any>('/kpis/dicionario');
      setVerbetes(Array.isArray(data) ? data : (data.indicadores ?? []));
      setErro(null);
    } catch (e) {
      setErro(e instanceof ErroApi
        ? e.message
        : 'Falha ao carregar o dicionario');
    }
  };

  useEffect(() => { void carregar(); }, []);

  const filtrados = verbetes.filter((v) => {
    const t = busca.trim().toLowerCase();
    if (!t) return true;
    return [v.codigo, v.nome, v.modulo, v.categoria, v.formula]
      .some((c) => String(c ?? '').toLowerCase().includes(t));
  });

  if (erro) {
    return (
      <Cartao titulo="Dicionario de indicadores">
        <Aviso>{erro}</Aviso>
        <p className="fraco">
          O dicionario faz parte da governanca dos indicadores e exige a permissao
          bi.kpi.
        </p>
      </Cartao>
    );
  }

  return (
    <>
      <Cartao
        titulo="Dicionario de indicadores"
        acoes={<Entrada rotulo="" valor={busca} aoMudar={setBusca} placeholder="Buscar indicador…" />}
      >
        <p className="fraco">
          Cada indicador tem UMA definicao. Toda tela que mostra este numero usa esta
          formula - nao existe calculo paralelo por painel.
        </p>
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th><th>Nome</th><th>Modulo</th><th>Formula</th>
                <th>Fonte</th><th>Periodicidade</th><th>Meta vigente</th><th />
              </tr>
            </thead>
            <tbody>
              {filtrados.map((v) => (
                <tr key={v.codigo}>
                  <td><code>{v.codigo}</code></td>
                  <td>{v.nome}</td>
                  <td><Etiqueta texto={String(v.modulo)} /></td>
                  <td className="fraco">{v.formula}</td>
                  <td className="fraco">{v.fonte}</td>
                  <td>{v.periodicidade}</td>
                  <td>
                    {(v.metas ?? []).length === 0
                      ? <span className="fraco">—</span>
                      : (v.metas ?? []).map((m: any, i: number) => (
                        <div key={i}>
                          {formatarKpi(m.meta, v.unidade, v.casas_decimais ?? 2)}
                          <span className="fraco"> ({m.escopo} desde {fmtData(m.vigencia_inicio)})</span>
                        </div>
                      ))}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="botao botao--pequeno botao--fantasma"
                      onClick={() => aoAbrirKpi(v.codigo)}
                    >
                      Apurar
                    </button>
                    {pode('bi.meta') && (
                      <button
                        type="button"
                        className="botao botao--pequeno botao--fantasma"
                        onClick={() => setMetaDe(v)}
                      >
                        Definir meta
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtrados.length === 0 && <Vazio>Nenhum indicador corresponde a busca.</Vazio>}
      </Cartao>

      {metaDe && (
        <FormularioMeta
          kpi={metaDe}
          aoFechar={() => setMetaDe(null)}
          aoSalvar={async () => { setMetaDe(null); await carregar(); }}
        />
      )}
    </>
  );
}

function FormularioMeta({ kpi, aoFechar, aoSalvar }: {
  kpi: any; aoFechar: () => void; aoSalvar: () => void | Promise<void>;
}) {
  const [meta, setMeta] = useState('');
  const [atencao, setAtencao] = useState('');
  const [critico, setCritico] = useState('');
  const [observacao, setObservacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const maiorMelhor = kpi.direcao === 'MAIOR_MELHOR';

  const salvar = async () => {
    setSalvando(true);
    try {
      await api('/kpis/metas', {
        metodo: 'POST',
        corpo: {
          codigo: kpi.codigo,
          escopo: 'EMPRESA',
          meta: Number(meta),
          limite_atencao: atencao === '' ? undefined : Number(atencao),
          limite_critico: critico === '' ? undefined : Number(critico),
          observacao: observacao || undefined,
        },
      });
      await aoSalvar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao salvar a meta');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal
      titulo={`Meta de ${kpi.nome}`}
      aoFechar={aoFechar}
      rodape={(
        <>
          <button type="button" className="botao botao--fantasma" onClick={aoFechar}>Cancelar</button>
          <button
            type="button"
            className="botao botao--primario"
            disabled={salvando || meta === ''}
            onClick={() => void salvar()}
          >
            Salvar meta
          </button>
        </>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      <p className="fraco">
        {maiorMelhor
          ? 'Neste indicador, maior e melhor: a meta deve ficar ACIMA do limite de atencao, '
            + 'e este acima do critico.'
          : 'Neste indicador, menor e melhor: a meta deve ficar ABAIXO do limite de atencao, '
            + 'e este abaixo do critico.'}
      </p>
      <Entrada rotulo="Meta" valor={meta} aoMudar={setMeta} tipo="number" />
      <Entrada rotulo="Limite de atencao (amarelo)" valor={atencao} aoMudar={setAtencao} tipo="number" />
      <Entrada rotulo="Limite critico (vermelho)" valor={critico} aoMudar={setCritico} tipo="number" />
      <Entrada rotulo="Observacao" valor={observacao} aoMudar={setObservacao} />
      <p className="fraco">
        A meta anterior e encerrada e fica no historico. Avaliacoes ja registradas
        mantem a meta que valia na epoca.
      </p>
    </Modal>
  );
}
