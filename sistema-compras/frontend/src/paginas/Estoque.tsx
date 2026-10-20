import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { Meta, OpcaoCadastro } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { CONFIG_ESTOQUE, ImportarPlanilha } from '../componentes/ImportarPlanilha';
import {
  Aviso, Cartao, Entrada, Etiqueta, Modal, Paginacao, Selecao, Vazio, data, dataHora, moeda, numero,
} from '../componentes/ui';

type Faixa = 'ZERADO' | 'CRITICO' | 'ATENCAO' | 'ADEQUADO' | 'EXCESSO' | 'SEM_GIRO' | 'SEM_MOVIMENTO';

/** Ordem, nome e regra de cada faixa. A regra usa o lead time e o minimo de cada produto. */
const FAIXAS: Array<{ id: Faixa; nome: string; regra: string; cor: string }> = [
  { id: 'ZERADO', nome: 'Sem estoque', regra: 'tem saida e nao tem saldo', cor: 'var(--faixa-zerado)' },
  { id: 'CRITICO', nome: 'Critico', regra: 'acaba antes de uma compra chegar', cor: 'var(--faixa-critico)' },
  { id: 'ATENCAO', nome: 'Atencao', regra: 'abaixo do estoque minimo', cor: 'var(--faixa-atencao)' },
  { id: 'ADEQUADO', nome: 'Adequado', regra: 'cobre lead time e minimo', cor: 'var(--faixa-adequado)' },
  { id: 'EXCESSO', nome: 'Excesso', regra: 'mais dias do que o limite', cor: 'var(--faixa-excesso)' },
  { id: 'SEM_GIRO', nome: 'Sem giro', regra: 'tem saldo e nao saiu em 90 dias', cor: 'var(--faixa-sem-giro)' },
  { id: 'SEM_MOVIMENTO', nome: 'Sem movimento', regra: 'sem saldo e sem saida', cor: 'var(--faixa-sem-movimento)' },
];
const FAIXA = Object.fromEntries(FAIXAS.map((f) => [f.id, f])) as Record<Faixa, (typeof FAIXAS)[number]>;

const ORDENACOES = [
  { valor: 'urgencia', texto: 'Mais urgentes primeiro' },
  { valor: 'cobertura', texto: 'Menor cobertura' },
  { valor: 'valor', texto: 'Maior valor em estoque' },
  { valor: 'venda', texto: 'Maior venda' },
  { valor: 'codigo', texto: 'Codigo' },
];

interface LinhaCobertura {
  produto_id: number; codigo: string; descricao: string; categoria: string; unidade: string;
  curva: string | null; fisico: number; reservado: number; disponivel: number;
  em_pedido: number; chegada: string | null; venda_dia: number | null; ultima_venda: string | null;
  cobertura_dias: number | null; lead_time_dias: number; estoque_minimo_dias: number;
  excesso_dias: number; custo: number | null; valor: number | null; faixa: Faixa;
}

interface Resumo {
  produtos: number;
  por_faixa: Record<Faixa, { produtos: number; valor: number }>;
  valor_total: number;
  valor_parado: number;
  sem_custo: number;
}

const TIPOS_MOVIMENTACAO = [
  'ENTRADA_COMPRA', 'SAIDA_VENDA', 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'DEVOLUCAO',
  'TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SAIDA', 'PERDA', 'AVARIA', 'INVENTARIO',
];

interface Detalhe {
  consolidado: Record<string, unknown>;
  por_local: Array<Record<string, unknown>>;
  lotes: Array<{ id: number; numero_lote: string; data_validade: string | null; quantidade_atual: number; status: string }>;
  movimentacoes: Array<{ id: number; tipo_movimentacao: string; quantidade: number; created_at: string; local: string; usuario: string | null }>;
}

const milhoes = (v: number) => (v >= 1_000_000
  ? `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  : moeda(v));

/** Todos os produtos numa barra, por faixa. Clicar numa faixa filtra a lista. */
function Silo({ resumo, faixa, aoEscolher }: {
  resumo: Resumo; faixa: Faixa | ''; aoEscolher: (f: Faixa | '') => void;
}) {
  const visiveis = FAIXAS.filter((f) => resumo.por_faixa[f.id].produtos > 0);
  const percentualParado = resumo.valor_total > 0 ? (resumo.valor_parado / resumo.valor_total) * 100 : 0;
  const alternar = (f: Faixa) => aoEscolher(faixa === f ? '' : f);

  return (
    <section className={`silo${faixa ? ' silo--filtrado' : ''}`} aria-label="Cobertura do estoque">
      <div className="silo__cabeca">
        <h2 className="secao-titulo">Quanto tempo o estoque dura</h2>
        <p className="secao-sub">
          {numero(resumo.produtos)} produtos ativos, pela venda dos ultimos 90 dias.
          Clique numa faixa para ver so os produtos dela.
        </p>
      </div>
      <div>
        <div className="silo__barra">
          {visiveis.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`silo__segmento${faixa === f.id ? ' silo__segmento--ativo' : ''}`}
              style={{ flexGrow: resumo.por_faixa[f.id].produtos, background: f.cor }}
              title={`${f.nome}: ${numero(resumo.por_faixa[f.id].produtos)} produtos`}
              aria-label={`${f.nome}: ${numero(resumo.por_faixa[f.id].produtos)} produtos`}
              aria-pressed={faixa === f.id}
              onClick={() => alternar(f.id)}
            />
          ))}
        </div>
        <ul className="silo__legenda">
          {visiveis.map((f) => (
            <li key={f.id}>
              <button type="button" aria-pressed={faixa === f.id}
                className={`silo__item${faixa === f.id ? ' silo__item--ativo' : ''}`}
                onClick={() => alternar(f.id)}>
                <span className="silo__cor" style={{ background: f.cor }} />
                <span className="silo__nome">{f.nome}</span>
                <span className="silo__qtd">{numero(resumo.por_faixa[f.id].produtos)}</span>
                <span className="silo__regra">{f.regra}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <dl className="silo__valores">
        <div>
          <dt>Valor em estoque</dt>
          <dd>{milhoes(resumo.valor_total)}</dd>
          {resumo.sem_custo > 0 && <small>{numero(resumo.sem_custo)} produtos sem custo ficam de fora</small>}
        </div>
        <div>
          <dt>Parado (excesso e sem giro)</dt>
          <dd>{milhoes(resumo.valor_parado)}</dd>
          <small>{numero(percentualParado, 0)}% do valor em estoque</small>
        </div>
      </dl>
    </section>
  );
}

/**
 * Regua da cobertura: o fundo marca as zonas do proprio produto (lead time,
 * minimo, adequado, excesso) e a barra mostra onde o saldo esta.
 */
function Regua({ l }: { l: LinhaCobertura }) {
  const cor = FAIXA[l.faixa].cor;
  if (l.cobertura_dias === null) {
    return <span className="regua"><span className="fraco">{l.disponivel > 0 ? 'sem saida' : '—'}</span></span>;
  }
  const max = Math.max(l.excesso_dias * 1.2, l.lead_time_dias + l.estoque_minimo_dias + 10);
  const pct = (d: number) => `${(Math.min(d, max) / max) * 100}%`;
  const zonas = [
    { ate: l.lead_time_dias, cor: 'var(--faixa-critico)' },
    { ate: l.lead_time_dias + l.estoque_minimo_dias, cor: 'var(--faixa-atencao)' },
    { ate: l.excesso_dias, cor: 'var(--faixa-adequado)' },
    { ate: max, cor: 'var(--faixa-excesso)' },
  ];
  let anterior = 0;
  const dias = l.cobertura_dias;
  return (
    <span className="regua"
      aria-label={`${numero(dias, 0)} dias de cobertura; lead time ${l.lead_time_dias} dias, minimo ${l.estoque_minimo_dias} dias`}>
      <span className="regua__trilho" aria-hidden="true">
        {zonas.map((z, i) => {
          const largura = (Math.max(0, Math.min(z.ate, max) - anterior) / max) * 100;
          anterior = Math.min(z.ate, max);
          return <span key={i} className="regua__zona" style={{ width: `${largura}%`, background: z.cor, opacity: 0.26 }} />;
        })}
        <span className="regua__nivel" style={{ width: pct(dias), background: cor }} />
      </span>
      <span className="regua__dias"
        style={l.faixa === 'ZERADO' || l.faixa === 'CRITICO' ? { color: cor, fontWeight: 600 } : undefined}>
        {dias > 999 ? '999+ d' : `${numero(dias, 0)} d`}
      </span>
    </span>
  );
}

export function Estoque() {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [faixa, setFaixa] = useState<Faixa | ''>('');
  const [curva, setCurva] = useState('');
  const [ordenar, setOrdenar] = useState('urgencia');
  const [pagina, setPagina] = useState(1);
  const [dados, setDados] = useState<{ linhas: LinhaCobertura[]; resumo: Resumo } | null>(null);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  const [detalhe, setDetalhe] = useState<{ produto: LinhaCobertura; dados: Detalhe } | null>(null);
  const [movimentando, setMovimentando] = useState<LinhaCobertura | null>(null);
  const [locais, setLocais] = useState<OpcaoCadastro[]>([]);
  const [mov, setMov] = useState({ local_id: '', tipo_movimentacao: 'ENTRADA_COMPRA', quantidade: '', observacao: '' });
  const [erroMov, setErroMov] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setBuscaAplicada(busca); setPagina(1); }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    setCarregando(true);
    api<{ linhas: LinhaCobertura[]; resumo: Resumo }>('/estoque/cobertura', {
      query: { busca: buscaAplicada, faixa, curva, ordenar, pagina, limite: 50 },
    })
      .then((r) => { setDados(r.data); setMeta(r.meta); setErro(null); })
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel carregar o estoque'))
      .finally(() => setCarregando(false));
  }, [buscaAplicada, faixa, curva, ordenar, pagina, versao]);

  const recarregar = () => setVersao((v) => v + 1);

  useEffect(() => {
    if (!pode('estoque.movimentar')) return;
    api<OpcaoCadastro[]>('/cadastros/locais').then(({ data: d }) => setLocais(d)).catch(() => undefined);
  }, [pode]);

  async function abrirDetalhe(produto: LinhaCobertura) {
    try {
      const { data: d } = await api<Detalhe>(`/estoque/${produto.produto_id}`);
      setDetalhe({ produto, dados: d });
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel abrir o produto');
    }
  }

  async function registrarMovimentacao() {
    if (!movimentando) return;
    setErroMov(null);
    setSalvando(true);
    try {
      await api('/estoque/movimentacoes', {
        metodo: 'POST',
        corpo: {
          produto_id: movimentando.produto_id,
          local_id: Number(mov.local_id),
          tipo_movimentacao: mov.tipo_movimentacao,
          quantidade: Number(mov.quantidade),
          documento_tipo: 'AJUSTE_MANUAL',
          observacao: mov.observacao || null,
        },
      });
      setMovimentando(null);
      setMov({ local_id: '', tipo_movimentacao: 'ENTRADA_COMPRA', quantidade: '', observacao: '' });
      recarregar();
    } catch (e) {
      setErroMov(e instanceof ErroApi ? e.message : 'Nao foi possivel registrar a movimentacao');
    } finally {
      setSalvando(false);
    }
  }

  const escolherFaixa = (f: Faixa | '') => { setFaixa(f); setPagina(1); };
  const linhas = dados?.linhas ?? [];

  return (
    <>
      <CabecalhoPagina
        titulo="Estoque"
        descricao="Quantos dias cada produto dura no consumo real (venda + industrializado), e o que precisa de atencao."
        acoes={pode('estoque.movimentar') || pode('integracao.importar')
          ? <ImportarPlanilha config={CONFIG_ESTOQUE} aoConcluir={recarregar} />
          : undefined}
      />

      {erro && <Aviso>{erro}</Aviso>}

      {dados && <Silo resumo={dados.resumo} faixa={faixa} aoEscolher={escolherFaixa} />}

      <Cartao semCorpo>
        <div className="filtros" style={{ padding: '14px 14px 4px' }}>
          <Entrada rotulo="Buscar" valor={busca} aoMudar={setBusca}
            placeholder="Codigo ou descricao" className="campo--busca" />
          <Selecao rotulo="Curva" valor={curva} vazio="Todas"
            aoMudar={(v) => { setCurva(v); setPagina(1); }}
            opcoes={[{ valor: 'A', texto: 'A' }, { valor: 'B', texto: 'B' }, { valor: 'C', texto: 'C' },
              { valor: 'SEM', texto: 'Sem curva' }]} />
          <Selecao rotulo="Ordenar" valor={ordenar} vazio={null}
            aoMudar={(v) => { setOrdenar(v); setPagina(1); }} opcoes={ORDENACOES} />
          {faixa && (
            <span className="filtro-ativo">
              Mostrando so: <Etiqueta texto={FAIXA[faixa].nome} tom="neutro" />
              <button type="button" className="botao botao--fantasma botao--pequeno"
                onClick={() => escolherFaixa('')}>
                Mostrar todos
              </button>
            </span>
          )}
        </div>

        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th>
                <th>Produto</th>
                <th>Curva</th>
                <th className="dir">Disponivel</th>
                <th className="dir" title="Venda + industrializado, media dos ultimos 90 dias">Saida por dia</th>
                <th>Cobertura</th>
                <th className="dir">Em pedido</th>
                <th className="dir">Valor</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.produto_id} className="linha-clicavel" tabIndex={0}
                  onClick={() => void abrirDetalhe(l)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void abrirDetalhe(l); }}>
                  <td className="codigo">{l.codigo}</td>
                  <td className="celula-produto" title={l.descricao}>
                    <span className="celula-produto__nome">{l.descricao}</span>
                    <span className="celula-produto__meta">{l.categoria}</span>
                  </td>
                  <td>{l.curva ?? '—'}</td>
                  <td className="dir num">
                    {numero(l.disponivel)} <span className="fraco">{l.unidade}</span>
                    {l.reservado > 0 && <div className="fraco" style={{ fontSize: 12 }}>{numero(l.reservado)} reservado</div>}
                  </td>
                  <td className="dir num">{l.venda_dia ? numero(l.venda_dia, 1) : '—'}</td>
                  <td><Regua l={l} /></td>
                  <td className="dir num">
                    {l.em_pedido > 0 ? (
                      <>
                        {numero(l.em_pedido)}
                        {l.chegada && <div className="fraco" style={{ fontSize: 12 }}>chega {data(l.chegada)}</div>}
                      </>
                    ) : '—'}
                  </td>
                  <td className="dir num">{l.valor ? moeda(l.valor) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {carregando && !dados && <div className="carregando">Carregando o estoque…</div>}
          {!carregando && dados && linhas.length === 0 && (
            <Vazio>
              {faixa || buscaAplicada || curva
                ? 'Nenhum produto com esses filtros.'
                : 'Nenhum saldo importado ainda. Use "Importar estoque" com o Rel 9054 do ERP.'}
            </Vazio>
          )}
        </div>
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe && (
        <Modal
          titulo={`${detalhe.produto.codigo} — ${detalhe.produto.descricao}`}
          aoFechar={() => setDetalhe(null)}
          largo
          rodape={pode('estoque.movimentar') ? (
            <button type="button" className="botao botao--primario"
              onClick={() => { setMovimentando(detalhe.produto); setErroMov(null); setDetalhe(null); }}>
              Registrar movimentacao
            </button>
          ) : undefined}
        >
          <p style={{ marginTop: 0 }}>
            <Etiqueta texto={FAIXA[detalhe.produto.faixa].nome}
              tom={detalhe.produto.faixa === 'ADEQUADO' ? 'acento'
                : detalhe.produto.faixa === 'ZERADO' || detalhe.produto.faixa === 'CRITICO' ? 'perigo'
                  : detalhe.produto.faixa === 'ATENCAO' ? 'alerta' : 'neutro'} />{' '}
            <span className="fraco">{FAIXA[detalhe.produto.faixa].regra}.</span>
          </p>
          <dl className="definicoes" style={{ marginBottom: 18 }}>
            <dt>Saldo</dt>
            <dd>
              {numero(detalhe.produto.disponivel)} disponivel de {numero(detalhe.produto.fisico)} fisico
              {detalhe.produto.reservado > 0 && ` (${numero(detalhe.produto.reservado)} vendido e nao faturado)`}
            </dd>
            <dt>Venda</dt>
            <dd>
              {detalhe.produto.venda_dia ? `${numero(detalhe.produto.venda_dia, 1)} por dia nos ultimos 90 dias (venda + industrializado)` : 'sem saida nos ultimos 90 dias'}
              {detalhe.produto.ultima_venda && `; ultima em ${data(detalhe.produto.ultima_venda)}`}
            </dd>
            <dt>Cobertura</dt>
            <dd>
              {detalhe.produto.cobertura_dias === null ? '—' : `${numero(detalhe.produto.cobertura_dias, 0)} dias`}
              {` (lead time ${detalhe.produto.lead_time_dias} d, estoque minimo ${detalhe.produto.estoque_minimo_dias} d, excesso acima de ${detalhe.produto.excesso_dias} d)`}
            </dd>
            {detalhe.produto.em_pedido > 0 && (
              <>
                <dt>Em pedido</dt>
                <dd>{numero(detalhe.produto.em_pedido)}{detalhe.produto.chegada && `, chegada prevista ${data(detalhe.produto.chegada)}`}</dd>
              </>
            )}
          </dl>
          <h4 className="secao-titulo" style={{ fontSize: 14, marginBottom: 6 }}>Lotes em estoque</h4>
          <div className="tabela-wrap" style={{ marginBottom: 18 }}>
            <table className="tabela">
              <thead>
                <tr><th>Lote</th><th>Validade</th><th className="dir">Quantidade</th><th>Status</th></tr>
              </thead>
              <tbody>
                {detalhe.dados.lotes.map((l) => (
                  <tr key={l.id}>
                    <td className="codigo">{l.numero_lote}</td>
                    <td className="num">{data(l.data_validade)}</td>
                    <td className="dir num">{numero(l.quantidade_atual, 2)}</td>
                    <td><Etiqueta texto={l.status} tom={l.status === 'DISPONIVEL' ? 'acento' : 'alerta'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detalhe.dados.lotes.length === 0 && <Vazio>Sem lotes com saldo.</Vazio>}
          </div>

          <h4 className="secao-titulo" style={{ fontSize: 14, marginBottom: 6 }}>Ultimas movimentacoes</h4>
          <div className="tabela-wrap">
            <table className="tabela">
              <thead>
                <tr><th>Data</th><th>Tipo</th><th>Local</th><th className="dir">Quantidade</th><th>Usuario</th></tr>
              </thead>
              <tbody>
                {detalhe.dados.movimentacoes.map((m) => (
                  <tr key={m.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dataHora(m.created_at)}</td>
                    <td>{m.tipo_movimentacao.replace(/_/g, ' ')}</td>
                    <td>{m.local}</td>
                    <td className="dir num">{numero(m.quantidade, 2)}</td>
                    <td>{m.usuario ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detalhe.dados.movimentacoes.length === 0 && <Vazio>Sem movimentacoes registradas.</Vazio>}
          </div>
        </Modal>
      )}

      {movimentando && (
        <Modal
          titulo={`Registrar movimentacao — ${movimentando.codigo}`}
          aoFechar={() => setMovimentando(null)}
          rodape={(
            <>
              <button type="button" className="botao" onClick={() => setMovimentando(null)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={salvando || !mov.local_id || !mov.quantidade}
                onClick={() => void registrarMovimentacao()}>
                {salvando ? 'Registrando…' : 'Registrar movimentacao'}
              </button>
            </>
          )}
        >
          {erroMov && <Aviso>{erroMov}</Aviso>}
          <div className="formulario-grade">
            <Selecao rotulo="Local" valor={mov.local_id} aoMudar={(v) => setMov((m) => ({ ...m, local_id: v }))}
              vazio="Selecione" opcoes={locais.map((l) => ({ valor: String(l.id), texto: `${l.codigo} — ${l.nome}` }))} />
            <Selecao rotulo="Tipo" valor={mov.tipo_movimentacao} vazio={null}
              aoMudar={(v) => setMov((m) => ({ ...m, tipo_movimentacao: v }))}
              opcoes={TIPOS_MOVIMENTACAO.map((t) => ({ valor: t, texto: t.replace(/_/g, ' ') }))} />
            <Entrada rotulo="Quantidade" tipo="number" valor={mov.quantidade}
              aoMudar={(v) => setMov((m) => ({ ...m, quantidade: v }))} />
            <Entrada rotulo="Observacao" valor={mov.observacao}
              aoMudar={(v) => setMov((m) => ({ ...m, observacao: v }))} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--texto-3)', marginTop: 12 }}>
            Informe sempre a quantidade positiva: o tipo da movimentacao define o sinal.
            Saidas maiores que o saldo sao bloqueadas pelo banco.
          </p>
        </Modal>
      )}
    </>
  );
}
