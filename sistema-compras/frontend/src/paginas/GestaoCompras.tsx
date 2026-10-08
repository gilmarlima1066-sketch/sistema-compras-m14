/**
 * Painel de Gestao de Compras: a aba "GESTAO DE COMPRAS" da planilha, agora
 * alimentada pelo sistema (vendas do Rel 7104, saldo do Rel 9054, pedidos e
 * cotacoes abertos).
 *
 * As colunas seguem a planilha para a equipe reconhecer o que ja usa. O que
 * muda e o que estava errado nela: datas sem hora, dias uteis convertidos,
 * sugestao que desconta o lead time e o pedido em aberto, e a "memoria de
 * calculo" de cada linha, para treinar quem esta chegando.
 */
import { useCallback, useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, ErroApi } from '../api/client';
import type { Meta } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data, moeda, numero,
} from '../componentes/ui';

type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const STATUS: Record<string, { texto: string; tom: Tom; ajuda: string }> = {
  RUPTURA_PREVISTA: { texto: 'Ruptura prevista', tom: 'perigo',
    ajuda: 'O pedido em aberto chega depois de o estoque acabar' },
  ESTOQUE_ZERADO: { texto: 'Estoque zerado', tom: 'perigo',
    ajuda: 'Sem saldo disponivel e sem pedido em aberto' },
  COMPRA_ATRASADA: { texto: 'Compra atrasada', tom: 'perigo',
    ajuda: 'A data de inicio da compra ja passou' },
  COMPRAR_HOJE: { texto: 'Comprar hoje', tom: 'alerta',
    ajuda: 'A data de inicio da compra e hoje' },
  ENTREGA_ATRASADA: { texto: 'Entrega atrasada', tom: 'perigo',
    ajuda: 'A data prevista do pedido ja passou' },
  COMPRAR_EM_BREVE: { texto: 'Comprar em breve', tom: 'info',
    ajuda: 'Inicio da compra nos proximos 7 dias' },
  PEDIDO_EM_ANDAMENTO: { texto: 'Pedido em andamento', tom: 'info',
    ajuda: 'Ha pedido em aberto que chega antes de o estoque acabar' },
  OK: { texto: 'OK', tom: 'acento', ajuda: 'Estoque cobre o lead time e o estoque minimo' },
  SEM_GIRO: { texto: 'Sem giro', tom: 'neutro', ajuda: 'Tem estoque e nao vendeu no periodo' },
  SEM_DEMANDA: { texto: 'Sem demanda', tom: 'neutro', ajuda: 'Sem estoque e sem venda' },
  FORA_DE_LINHA: { texto: 'Fora de linha', tom: 'neutro', ajuda: 'Nao trabalhamos mais' },
  SUBSTITUIDO: { texto: 'Substituido', tom: 'neutro', ajuda: 'Usando outro codigo' },
  FRACIONADO: { texto: 'Fracionado', tom: 'neutro', ajuda: 'Sai do fracionamento de outro item' },
  PRODUCAO_PROPRIA: { texto: 'Producao propria', tom: 'neutro', ajuda: 'Industria VG' },
};

const SITUACOES = [
  { valor: 'NORMAL', texto: 'Normal' },
  { valor: 'FORA_DE_LINHA', texto: 'Fora de linha (FORA)' },
  { valor: 'SUBSTITUIDO', texto: 'Substituido (NOVO)' },
  { valor: 'FRACIONADO', texto: 'Fracionado (FRACIONA)' },
  { valor: 'PRODUCAO_PROPRIA', texto: 'Producao propria (Industria VG)' },
];

const ORIGEM: Record<string, string> = {
  PRODUTO: 'do produto', FORNECEDOR: 'do fornecedor', CURVA: 'da curva', GLOBAL: 'padrao',
};

const erroDe = (e: unknown, padrao: string) => (e instanceof ErroApi ? e.message : padrao);

export function GestaoCompras() {
  const [aba, setAba] = useState<'painel' | 'politicas'>('painel');

  return (
    <>
      <CabecalhoPagina
        titulo="Gestao de compras"
        descricao="O painel da planilha GESTAO DE COMPRAS: cobertura, data de inicio da compra,
          status e quantidade sugerida por produto, com venda, estoque e pedidos do sistema."
      />
      <nav className="abas">
        <button type="button" className={`abas__item${aba === 'painel' ? ' abas__item--ativo' : ''}`}
          onClick={() => setAba('painel')}>Painel</button>
        <button type="button" className={`abas__item${aba === 'politicas' ? ' abas__item--ativo' : ''}`}
          onClick={() => setAba('politicas')}>Politicas de compra</button>
      </nav>
      {aba === 'painel' ? <Painel /> : <Politicas />}
    </>
  );
}

// ---------------------------------------------------------------------------

function Painel() {
  const { pode } = useAuth();
  const [metodo, setMetodo] = useState('PLANILHA');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [curva, setCurva] = useState('');
  const [status, setStatus] = useState('');
  const [situacao, setSituacao] = useState('');
  const [acompanhamento, setAcompanhamento] = useState('');
  const [somenteComprar, setSomenteComprar] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [dados, setDados] = useState<{ linhas: any[]; resumo: any } | null>(null);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [detalhe, setDetalhe] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [exportando, setExportando] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setBuscaAplicada(busca); setPagina(1); }, 350);
    return () => clearTimeout(t);
  }, [busca]);

  const filtros = useCallback(() => ({
    metodo, busca: buscaAplicada, curva, status, situacao, acompanhamento,
    somente_comprar: somenteComprar ? 'true' : undefined,
  }), [metodo, buscaAplicada, curva, status, situacao, acompanhamento, somenteComprar]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api<any>('/compras/painel', { query: { ...filtros(), pagina, limite: 100 } });
      setDados(r.data);
      setMeta(r.meta);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar o painel'));
    } finally {
      setCarregando(false);
    }
  }, [filtros, pagina]);

  useEffect(() => { void carregar(); }, [carregar]);

  const trocar = (fn: () => void) => { fn(); setPagina(1); };

  const mudarSituacao = async (produtoId: number, nova: string) => {
    try {
      await api(`/compras/painel/produtos/${produtoId}/situacao`,
        { metodo: 'PATCH', corpo: { situacao: nova } });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel alterar a situacao'));
    }
  };

  /** Exporta TODAS as linhas do filtro atual, nao so a pagina visivel. */
  const exportar = async () => {
    setExportando(true);
    try {
      const todas: any[] = [];
      for (let p = 1; ; p++) {
        const r = await api<any>('/compras/painel', { query: { ...filtros(), pagina: p, limite: 500 } });
        todas.push(...r.data.linhas);
        if (!r.meta || p >= Number(r.meta.paginas)) break;
      }
      const planilha = XLSX.utils.json_to_sheet(todas.map((l) => ({
        COMPRAR: l.comprar ? 'X' : '',
        CODIGO: l.codigo,
        DESCRICAO: l.descricao,
        SITUACAO: l.situacao,
        CURVA: l.curva ?? '',
        ESTOQUE_DISPONIVEL: l.disponivel,
        VENDA_DIA_UTIL_PLANILHA: arred(l.venda_dia_util_planilha, 3),
        VENDA_DIA_90D: arred(l.venda_dia_sistema, 3),
        DEMANDA_USADA_DIA: arred(l.demanda_dia, 3),
        COBERTURA_DIAS: arred(l.cobertura_dias, 1),
        SHELF_LIFE: l.dias_validade ?? '',
        ESTOQUE_MINIMO_DIAS: l.estoque_minimo_dias,
        LEAD_TIME_DIAS: l.lead_time_dias,
        HORIZONTE_DIAS: l.horizonte_dias,
        INICIO_COMPRA: l.data_inicio_compra ?? '',
        ESTOQUE_ATE: l.data_ruptura ?? '',
        STATUS: STATUS[l.status]?.texto ?? l.status,
        PEDIDO: l.pedido ?? '',
        CHEGADA: l.chegada ?? '',
        ACOMPANHAMENTO: l.acompanhamento ?? '',
        EM_COTACAO: l.cotacao ?? '',
        QTD_SUGERIDA: l.sugerida,
        FORNECEDOR: l.fornecedor ?? '',
        PRECO: l.preco ?? '',
        VALOR_SUGERIDO: l.valor_sugerido ?? '',
      })));
      const livro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(livro, planilha, 'GESTAO DE COMPRAS');
      XLSX.writeFile(livro, `gestao-compras-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel exportar'));
    } finally {
      setExportando(false);
    }
  };

  const r = dados?.resumo;
  const porStatus: Record<string, number> = r?.por_status ?? {};

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      {r && (
        <div className="grade-indicadores">
          <Indicador rotulo="Itens para comprar" valor={numero(r.itens_comprar)}
            tom={r.itens_comprar > 0 ? 'perigo' : 'acento'}
            nota={`de ${numero(r.produtos)} produtos no filtro`} />
          <Indicador rotulo="Compra atrasada" valor={numero(porStatus.COMPRA_ATRASADA ?? 0)}
            tom={(porStatus.COMPRA_ATRASADA ?? 0) > 0 ? 'perigo' : 'neutro'} />
          <Indicador rotulo="Estoque zerado" valor={numero(porStatus.ESTOQUE_ZERADO ?? 0)}
            tom={(porStatus.ESTOQUE_ZERADO ?? 0) > 0 ? 'perigo' : 'neutro'} />
          <Indicador rotulo="Ruptura prevista" valor={numero(porStatus.RUPTURA_PREVISTA ?? 0)}
            tom={(porStatus.RUPTURA_PREVISTA ?? 0) > 0 ? 'perigo' : 'neutro'}
            nota="Pedido chega depois do fim do estoque" />
          <Indicador rotulo="Cobrar fornecedor" valor={numero(r.cobrar)}
            tom={r.cobrar > 0 ? 'alerta' : 'neutro'}
            nota={`${numero(r.entregas_atrasadas)} entrega(s) atrasada(s)`} />
          <Indicador rotulo="Valor sugerido" valor={moeda(r.valor_sugerido)}
            nota={r.sem_preco > 0 ? `${numero(r.sem_preco)} item(ns) sem preco` : 'Itens para comprar'} />
        </div>
      )}

      <Cartao titulo="Produtos" acoes={(
        <button type="button" className="botao botao--pequeno" disabled={exportando}
          onClick={exportar}>
          {exportando ? 'Exportando...' : 'Exportar Excel'}
        </button>
      )}>
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={setBusca}
            placeholder="Codigo ou descricao" />
          <Selecao rotulo="Media de demanda" valor={metodo} vazio={null}
            aoMudar={(v) => trocar(() => setMetodo(v))}
            opcoes={[
              { valor: 'PLANILHA', texto: 'Planilha (7 meses com venda, dia util)' },
              { valor: 'SISTEMA', texto: 'Sistema (ultimos 90 dias)' },
            ]} />
          <Selecao rotulo="Curva" valor={curva} vazio="Todas"
            aoMudar={(v) => trocar(() => setCurva(v))}
            opcoes={[{ valor: 'A', texto: 'A' }, { valor: 'B', texto: 'B' },
              { valor: 'C', texto: 'C' }, { valor: 'SEM', texto: 'Sem curva' }]} />
          <Selecao rotulo="Situacao" valor={situacao} vazio="Todas"
            aoMudar={(v) => trocar(() => setSituacao(v))} opcoes={SITUACOES} />
          <Selecao rotulo="Acompanhamento" valor={acompanhamento} vazio="Todos"
            aoMudar={(v) => trocar(() => setAcompanhamento(v))}
            opcoes={[{ valor: 'COBRAR', texto: 'Cobrar (ate 3 dias uteis)' },
              { valor: 'ATRASADO', texto: 'Entrega atrasada' }]} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-end',
            whiteSpace: 'nowrap', paddingBottom: 8, fontSize: 13 }}>
            <input type="checkbox" checked={somenteComprar}
              onChange={(e) => trocar(() => setSomenteComprar(e.target.checked))} />
            <span>Somente "comprar" (X)</span>
          </label>
        </div>

        <div className="acoes-linha" style={{ flexWrap: 'wrap', margin: '8px 0 12px' }}>
          <button type="button"
            className={`botao botao--pequeno${status === '' ? ' botao--primario' : ' botao--fantasma'}`}
            onClick={() => trocar(() => setStatus(''))}>
            Todos ({numero(r?.produtos ?? 0)})
          </button>
          {Object.keys(STATUS).filter((s) => porStatus[s]).map((s) => (
            <button key={s} type="button" title={STATUS[s]!.ajuda}
              className={`botao botao--pequeno${status === s ? ' botao--primario' : ' botao--fantasma'}`}
              onClick={() => trocar(() => setStatus(s))}>
              {STATUS[s]!.texto} ({numero(porStatus[s])})
            </button>
          ))}
        </div>

        {r && (
          <p className="fraco" style={{ marginTop: 0 }}>
            Vendas ate {data(r.referencia_vendas)}. Calculo com a media
            {metodo === 'PLANILHA' ? ' da planilha' : ' de 90 dias'}; clique em uma linha para
            ver a memoria de calculo.
          </p>
        )}

        {!dados ? <p className="fraco">{carregando ? 'Carregando...' : ''}</p>
          : !dados.linhas.length ? <Vazio>Nenhum produto com esses filtros.</Vazio>
            : (
              <div className="tabela-wrap">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th title="Comprar">X</th>
                      <th>Codigo</th>
                      <th>Descricao</th>
                      <th>Situacao</th>
                      <th>Curva</th>
                      <th className="dir">Estoque</th>
                      <th className="dir" title="Media dos ultimos 7 meses com venda, por dia util">
                        Venda/dia util
                      </th>
                      <th className="dir" title="Media dos ultimos 90 dias corridos">Venda/dia 90d</th>
                      <th className="dir">Cobertura</th>
                      <th className="dir">Shelf life</th>
                      <th className="dir">Est. min</th>
                      <th className="dir">Lead time</th>
                      <th>Inicio compra</th>
                      <th>Estoque ate</th>
                      <th>Status</th>
                      <th>Pedido / chegada</th>
                      <th className="dir">Sugerida</th>
                      <th className="dir">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.linhas.map((l) => (
                      <tr key={l.produto_id} style={{ cursor: 'pointer' }}
                        onClick={() => setDetalhe(l)}>
                        <td>{l.comprar ? <strong>X</strong> : ''}</td>
                        <td className="codigo" style={{ whiteSpace: 'nowrap' }}>{l.codigo}</td>
                        <td style={{ minWidth: 260 }}>
                          {l.descricao}
                          {l.fornecedor && <div className="fraco">{l.fornecedor}</div>}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {pode('compras.planejar') ? (
                            <select value={l.situacao} style={{ maxWidth: 150, fontSize: 12 }}
                              onChange={(e) => void mudarSituacao(l.produto_id, e.target.value)}>
                              {SITUACOES.map((s) => (
                                <option key={s.valor} value={s.valor}>{s.texto}</option>
                              ))}
                            </select>
                          ) : SITUACOES.find((s) => s.valor === l.situacao)?.texto}
                        </td>
                        <td>{l.curva ?? '—'}</td>
                        <td className="dir num">{numero(l.disponivel)}</td>
                        <td className="dir num"
                          style={{ fontWeight: metodo === 'PLANILHA' ? 600 : undefined }}>
                          {l.venda_dia_util_planilha === null ? '—' : numero(l.venda_dia_util_planilha, 2)}
                        </td>
                        <td className="dir num"
                          style={{ fontWeight: metodo === 'SISTEMA' ? 600 : undefined }}>
                          {l.venda_dia_sistema === null ? '—' : numero(l.venda_dia_sistema, 2)}
                        </td>
                        <td className="dir num">
                          {l.cobertura_dias === null ? '—' : `${numero(l.cobertura_dias, 0)} d`}
                        </td>
                        <td className="dir num">{l.dias_validade ? `${numero(l.dias_validade)} d` : '—'}</td>
                        <td className="dir num">{l.estoque_minimo_dias} d</td>
                        <td className="dir num">{l.lead_time_dias} d</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{data(l.data_inicio_compra)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{data(l.data_ruptura)}</td>
                        <td>
                          <Etiqueta texto={STATUS[l.status]?.texto ?? l.status}
                            tom={STATUS[l.status]?.tom ?? 'neutro'} />
                          {l.cotacao && <div className="fraco">cotando {l.cotacao}</div>}
                        </td>
                        <td>
                          {l.pedido ? (
                            <>
                              {l.pedido} · {data(l.chegada)}
                              {l.acompanhamento && (
                                <div><Etiqueta texto={l.acompanhamento}
                                  tom={l.acompanhamento === 'ATRASADO' ? 'perigo' : 'alerta'} /></div>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="dir num">
                          {l.sugerida > 0 ? numero(l.sugerida) : '—'}
                          {l.limitada_validade && <div className="fraco">limitada (shelf life)</div>}
                        </td>
                        <td className="dir num">{l.valor_sugerido ? moeda(l.valor_sugerido) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe && <MemoriaCalculo linha={detalhe} metodo={metodo} aoFechar={() => setDetalhe(null)} />}
    </>
  );
}

const arred = (v: number | null | undefined, casas: number) =>
  (v === null || v === undefined ? '' : Math.round(v * 10 ** casas) / 10 ** casas);

/** Como a linha foi calculada, passo a passo - serve de material de treino. */
function MemoriaCalculo({ linha: l, metodo, aoFechar }: {
  linha: any; metodo: string; aoFechar: () => void;
}) {
  const dias = l.lead_time_dias + l.horizonte_dias + l.estoque_minimo_dias;
  const necessidade = l.demanda_dia * dias - (Math.max(l.disponivel, 0) + l.em_aberto);
  const st = STATUS[l.status];

  return (
    <Modal titulo={`${l.codigo} — ${l.descricao}`} largo aoFechar={aoFechar}>
      <p>
        <Etiqueta texto={st?.texto ?? l.status} tom={st?.tom ?? 'neutro'} />{' '}
        <span className="fraco">{st?.ajuda}</span>
      </p>
      <dl className="definicoes">
        <dt>Estoque disponivel</dt>
        <dd>
          {numero(l.disponivel)} = fisico {numero(l.fisico)} − vendido nao faturado {numero(l.reservado)}
        </dd>

        <dt>Demanda usada</dt>
        <dd>
          {numero(l.demanda_dia, 2)} por dia corrido
          {metodo === 'PLANILHA' ? (
            <div className="fraco">
              Media da planilha: {l.venda_dia_util_planilha === null ? 'sem venda'
                : `${numero(l.venda_dia_util_planilha, 2)} por dia util`} em {l.meses_com_venda} mes(es)
              com venda dos ultimos 7, convertida para dia corrido
            </div>
          ) : (
            <div className="fraco">Media do sistema: vendas dos ultimos 90 dias ÷ 90</div>
          )}
          <div className="fraco">
            Comparacao: planilha {l.venda_dia_planilha === null ? '—' : numero(l.venda_dia_planilha, 2)}/dia ·
            {' '}90 dias {l.venda_dia_sistema === null ? '—' : numero(l.venda_dia_sistema, 2)}/dia
          </div>
        </dd>

        <dt>Cobertura</dt>
        <dd>
          {l.cobertura_dias === null ? 'sem demanda'
            : `${numero(l.disponivel)} ÷ ${numero(l.demanda_dia, 2)} = ${numero(l.cobertura_dias, 1)} dias`}
        </dd>

        <dt>Estoque suficiente ate</dt>
        <dd>{l.data_ruptura ? `hoje + ${numero(l.cobertura_dias ?? 0, 0)} dias = ${data(l.data_ruptura)}` : '—'}</dd>

        <dt>Inicio do processo de compra</dt>
        <dd>
          {l.data_inicio_compra
            ? `${data(l.data_ruptura)} − estoque minimo ${l.estoque_minimo_dias} d (${ORIGEM[l.origem_estoque_minimo]})`
              + ` − lead time ${l.lead_time_dias} d (${ORIGEM[l.origem_lead_time]}) = ${data(l.data_inicio_compra)}`
            : '—'}
          {l.dias_atraso > 0 && <div className="fraco">{l.dias_atraso} dia(s) de atraso</div>}
        </dd>

        <dt>Pedido em aberto</dt>
        <dd>
          {l.pedido
            ? `${numero(l.em_aberto)} un no ${l.pedido}, chegada ${data(l.chegada)}`
              + (l.dias_ruptura ? ` — ${l.dias_ruptura} dia(s) sem estoque, ~${numero(l.unidades_em_ruptura)} un perdidas` : '')
            : 'nenhum'}
          {l.cotacao && <div className="fraco">Em cotacao: {l.cotacao}</div>}
        </dd>

        <dt>Quantidade sugerida</dt>
        <dd>
          {l.demanda_dia > 0 ? (
            <>
              {numero(l.demanda_dia, 2)} × ({l.lead_time_dias} lead time + {l.horizonte_dias} horizonte
              ({ORIGEM[l.origem_horizonte]}) + {l.estoque_minimo_dias} estoque minimo)
              {' '}− ({numero(Math.max(l.disponivel, 0))} estoque + {numero(l.em_aberto)} em aberto)
              {' '}= {numero(necessidade, 1)}
              <div>
                <strong>{numero(l.sugerida)} un</strong>
                {l.multiplo > 1 && <span className="fraco"> · multiplo {numero(l.multiplo)}</span>}
                {l.moq > 1 && <span className="fraco"> · MOQ {numero(l.moq)}</span>}
                {l.limitada_validade && (
                  <span className="fraco"> · limitada para vender antes do shelf life ({l.dias_validade} d)</span>
                )}
              </div>
              {!l.comprar && l.status !== 'COMPRAR_EM_BREVE' && (
                <div className="fraco">So e sugerida quando o item precisa ser comprado.</div>
              )}
            </>
          ) : 'sem demanda'}
        </dd>

        <dt>Fornecedor e valor</dt>
        <dd>
          {l.fornecedor ?? 'sem fornecedor principal'}
          {l.preco !== null ? ` · ${moeda(l.preco)} · total ${moeda(l.valor_sugerido)}` : ' · sem preco'}
        </dd>
      </dl>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Politicas() {
  const { pode } = useAuth();
  const podeEditar = pode('compras.parametrizar');
  const [politicas, setPoliticas] = useState<any[]>([]);
  const [fornecedores, setFornecedores] = useState<any[]>([]);
  const [form, setForm] = useState({
    escopo: 'CURVA', curva: 'A', fornecedor_id: '', produto_codigo: '',
    horizonte_dias: '', estoque_minimo_dias: '', lead_time_dias: '', observacao: '',
  });
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([
        api<any[]>('/compras/politicas'),
        api<any[]>('/fornecedores', { query: { limite: 200, ativo: true } }),
      ]);
      setPoliticas(p.data ?? []);
      setFornecedores(f.data ?? []);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as politicas'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const campo = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });
  const diasOuNulo = (v: string) => (v.trim() === '' ? null : Number(v));

  const salvar = async () => {
    setErro(null); setAviso(null);
    try {
      await api('/compras/politicas', {
        metodo: 'PUT',
        corpo: {
          escopo: form.escopo,
          curva: form.escopo === 'CURVA' ? form.curva : null,
          fornecedor_id: form.escopo === 'FORNECEDOR' ? Number(form.fornecedor_id) || null : null,
          produto_codigo: form.escopo === 'PRODUTO' ? form.produto_codigo : null,
          horizonte_dias: diasOuNulo(form.horizonte_dias),
          estoque_minimo_dias: diasOuNulo(form.estoque_minimo_dias),
          lead_time_dias: diasOuNulo(form.lead_time_dias),
          observacao: form.observacao || null,
        },
      });
      setAviso('Politica salva. O painel ja usa os novos valores.');
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel salvar'));
    }
  };

  const editar = (p: any) => setForm({
    escopo: p.escopo, curva: p.curva ?? 'A', fornecedor_id: p.fornecedor_id ? String(p.fornecedor_id) : '',
    produto_codigo: p.produto_codigo ?? '',
    horizonte_dias: p.horizonte_dias?.toString() ?? '',
    estoque_minimo_dias: p.estoque_minimo_dias?.toString() ?? '',
    lead_time_dias: p.lead_time_dias?.toString() ?? '',
    observacao: p.observacao ?? '',
  });

  const remover = async (id: number) => {
    try {
      await api(`/compras/politicas/${id}`, { metodo: 'DELETE' });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel remover'));
    }
  };

  const alvo = (p: any) => (p.escopo === 'GLOBAL' ? 'Todos os produtos'
    : p.escopo === 'CURVA' ? `Curva ${p.curva}`
      : p.escopo === 'FORNECEDOR' ? p.fornecedor
        : `${p.produto_codigo} — ${p.produto_descricao}`);

  const dias = (v: number | null) => (v === null ? <span className="fraco">herda</span> : `${v} d`);

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <Cartao titulo="Como o valor de cada produto e escolhido">
        <p className="fraco" style={{ margin: 0 }}>
          Horizonte (quantos dias a compra deve cobrir), estoque minimo e lead time sao resolvidos
          campo a campo, do mais especifico ao mais geral: <strong>produto → fornecedor principal →
          curva ABC → padrao</strong>. Deixe um campo em branco para herdar do nivel seguinte.
        </p>
      </Cartao>

      <Cartao titulo="Politicas cadastradas">
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr><th>Nivel</th><th>Aplica-se a</th><th className="dir">Horizonte</th>
                <th className="dir">Estoque minimo</th><th className="dir">Lead time</th>
                <th>Observacao</th><th /></tr>
            </thead>
            <tbody>
              {politicas.map((p) => (
                <tr key={p.id}>
                  <td><Etiqueta texto={p.escopo} tom={p.escopo === 'GLOBAL' ? 'info' : 'neutro'} /></td>
                  <td>{alvo(p)}</td>
                  <td className="dir num">{dias(p.horizonte_dias)}</td>
                  <td className="dir num">{dias(p.estoque_minimo_dias)}</td>
                  <td className="dir num">{dias(p.lead_time_dias)}</td>
                  <td className="fraco">{p.observacao}</td>
                  <td>
                    {podeEditar && (
                      <div className="acoes-linha">
                        <button type="button" className="botao botao--fantasma botao--pequeno"
                          onClick={() => editar(p)}>Editar</button>
                        {p.escopo !== 'GLOBAL' && (
                          <button type="button" className="botao botao--fantasma botao--pequeno"
                            onClick={() => void remover(p.id)}>Remover</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      {podeEditar && (
        <Cartao titulo="Nova politica ou alteracao">
          <div className="filtros" style={{ alignItems: 'flex-end' }}>
            <Selecao rotulo="Nivel" valor={form.escopo} aoMudar={campo('escopo')} vazio={null}
              opcoes={[
                { valor: 'CURVA', texto: 'Curva ABC' },
                { valor: 'FORNECEDOR', texto: 'Fornecedor' },
                { valor: 'PRODUTO', texto: 'Produto' },
                { valor: 'GLOBAL', texto: 'Padrao (todos)' },
              ]} />
            {form.escopo === 'CURVA' && (
              <Selecao rotulo="Curva" valor={form.curva} aoMudar={campo('curva')} vazio={null}
                opcoes={['A', 'B', 'C'].map((c) => ({ valor: c, texto: c }))} />
            )}
            {form.escopo === 'FORNECEDOR' && (
              <Selecao rotulo="Fornecedor" valor={form.fornecedor_id} aoMudar={campo('fornecedor_id')}
                opcoes={fornecedores.map((f) => ({
                  valor: String(f.id), texto: f.nome_fantasia || f.razao_social,
                }))} />
            )}
            {form.escopo === 'PRODUTO' && (
              <Entrada rotulo="Codigo do produto" valor={form.produto_codigo}
                aoMudar={campo('produto_codigo')} placeholder="ex.: 01674" />
            )}
            <Entrada rotulo="Horizonte (dias)" tipo="number" valor={form.horizonte_dias}
              aoMudar={campo('horizonte_dias')} placeholder="herda" />
            <Entrada rotulo="Estoque minimo (dias)" tipo="number" valor={form.estoque_minimo_dias}
              aoMudar={campo('estoque_minimo_dias')} placeholder="herda" />
            <Entrada rotulo="Lead time (dias)" tipo="number" valor={form.lead_time_dias}
              aoMudar={campo('lead_time_dias')} placeholder="herda" />
            <Entrada rotulo="Observacao" valor={form.observacao} aoMudar={campo('observacao')} />
            <button type="button" className="botao botao--primario" onClick={() => void salvar()}>
              Salvar
            </button>
          </div>
        </Cartao>
      )}
    </>
  );
}
