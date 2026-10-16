/**
 * Historico de compras: as entradas do ERP lidas de dois lados.
 *
 * Pesquisar um produto traz todo fornecedor que ja o vendeu, com a ultima
 * compra; pesquisar um fornecedor traz todo produto que ele ja vendeu, com o
 * ultimo preco pago. Sem pesquisa, a tela mostra as ultimas entradas.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ErroApi } from '../api/client';
import type { Meta } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { CONFIG_HISTORICO_COMPRAS, ImportarPlanilha } from '../componentes/ImportarPlanilha';
import { GraficoLinha } from '../componentes/graficos';
import {
  Aviso, Cartao, Etiqueta, Modal, Paginacao, Vazio, data, moeda, numero,
} from '../componentes/ui';

type Selecao = { tipo: 'produto' | 'fornecedor'; codigo: string } | null;

interface Resumo {
  itens: number; pedidos: number; produtos: number; fornecedores: number;
  primeira_data: string | null; ultima_data: string | null;
  sem_fornecedor: number; sem_produto: number;
}

interface Sugestoes {
  produtos: Array<{ codigo: string; descricao: string | null; compras: number; ultima: string }>;
  fornecedores: Array<{ codigo: string; nome: string | null; razao_social: string | null; compras: number; ultima: string }>;
}

interface Ultima {
  ultima_data: string; ultimo_pedido: string; ultima_quantidade: number; ultimo_total_kg: number | null;
  ultimo_preco_caixa: number | null; ultimo_preco_kg: number | null; kg_caixa: number | null;
  aliquota_icms: number | null; aliquota_icms_reduzida: number | null; aliquota_pis_cofins: number | null;
  ultimo_tipo: string | null; preco_anterior_caixa: number | null;
  compras: number; pedidos: number; total_caixas: number;
  menor_preco_caixa: number | null; maior_preco_caixa: number | null; primeira_data: string;
}

interface PorProduto {
  produto: { codigo: string; descricao: string | null; produto_id: number | null; unidade: string | null; curva: string | null };
  fornecedores: Array<Ultima & {
    fornecedor_codigo: string; fornecedor_nome: string | null; razao_social: string | null;
    fornecedor_ativo: boolean | null; fornecedor_id: number | null;
  }>;
}

interface PorFornecedor {
  fornecedor: {
    codigo: string; nome: string | null; razao_social: string | null; cnpj: string | null;
    ativo: boolean | null; contato: string | null; telefone: string | null; email: string | null;
    cidade: string | null; estado: string | null; pedidos: number; produtos: number;
    primeira_data: string; ultima_data: string; valor_total: number;
  };
  produtos: Array<Ultima & { produto_codigo: string; produto_descricao: string | null; curva: string | null }>;
}

interface Entrada {
  id: number; data_entrada: string; pedido: string; produto_codigo: string; produto_descricao: string | null;
  fornecedor_codigo: string; fornecedor_nome: string | null; kg_caixa: number | null;
  quantidade_caixas: number; total_kg: number | null; preco_caixa: number | null; preco_kg: number | null;
  aliquota_icms: number | null; aliquota_icms_reduzida: number | null; aliquota_pis_cofins: number | null;
  tipo: string | null;
}

const erroDe = (e: unknown, padrao: string) => (e instanceof ErroApi ? e.message : padrao);

const qtd = (n: number, um: string, varios: string) => `${numero(n)} ${n === 1 ? um : varios}`;

/** Valor ausente nao e R$ 0,00: e traco. */
const reais = (v: unknown) => (v === null || v === undefined ? '—' : moeda(v));

/** 0,12 -> "12%"; 0,0925 -> "9,25%". */
const pct = (v: number | null) => (v === null || v === undefined ? '—'
  : `${(Number(v) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);

const formatarDoc = (doc: string | null) => {
  if (doc?.length === 14) return doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (doc?.length === 11) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ?? '—';
};

/** Preco que subiu e ruim para quem compra: seta para cima em ambar. */
function VariacaoPreco({ atual, anterior }: { atual: number | null; anterior: number | null }) {
  if (atual === null || anterior === null || !anterior) return null;
  const v = ((Number(atual) - Number(anterior)) / Number(anterior)) * 100;
  if (Math.abs(v) < 0.05) return <span className="delta delta--neutro" title={`Anterior: ${reais(anterior)}`}>= igual</span>;
  return (
    <span className={`delta ${v > 0 ? 'delta--queda' : 'delta--alta'}`} title={`Compra anterior: ${reais(anterior)}`}>
      {v > 0 ? '▲' : '▼'} {Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
    </span>
  );
}

export function HistoricoCompras() {
  const { pode } = useAuth();
  const [selecao, setSelecao] = useState<Selecao>(null);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [versao, setVersao] = useState(0);
  const [par, setPar] = useState<{ produto: string; fornecedor: string; titulo: string } | null>(null);

  useEffect(() => {
    api<Resumo>('/compras/historico/resumo').then((r) => setResumo(r.data)).catch(() => setResumo(null));
  }, [versao]);

  const vazio = resumo !== null && resumo.itens === 0;

  return (
    <div className="historico">
      <div className="historico__topo">
        <div className="historico__resumo">
          {resumo && resumo.itens > 0 ? (
            <p>
              <strong>{numero(resumo.itens)}</strong> entradas de <strong>{numero(resumo.pedidos)}</strong> pedidos,
              {' '}{numero(resumo.produtos)} produtos e {numero(resumo.fornecedores)} fornecedores,
              de {data(resumo.primeira_data)} a {data(resumo.ultima_data)}.
            </p>
          ) : <p className="fraco">Nenhuma compra importada ainda.</p>}
          {resumo && resumo.sem_fornecedor > 0 && (
            <p className="fraco">
              {numero(resumo.sem_fornecedor)} entradas sao de parceiros fora da base de fornecedores:
              importe a base atualizada na aba Fornecedores para liga-las.
            </p>
          )}
        </div>
        {pode('compras.planejar') && (
          <ImportarPlanilha config={CONFIG_HISTORICO_COMPRAS} aoConcluir={() => setVersao((v) => v + 1)} />
        )}
      </div>

      {vazio ? (
        <Cartao>
          <div className="vazio-acao">
            <p>
              O historico mostra, para cada produto, quem ja vendeu e a que preco, e para cada
              fornecedor, tudo o que ele ja vendeu. Ele vem do relatorio de entradas do ERP (custo e imposto).
            </p>
            <p className="fraco">Clique em "Importar compras" e selecione o relatorio.</p>
          </div>
        </Cartao>
      ) : (
        <>
          <BuscaHistorico aoEscolher={setSelecao} selecao={selecao} />
          {selecao === null && <UltimasEntradas key={versao} aoEscolher={setSelecao} />}
          {selecao?.tipo === 'produto' && (
            <VisaoProduto key={`p-${selecao.codigo}-${versao}`} codigo={selecao.codigo}
              aoEscolher={setSelecao} aoAbrir={setPar} />
          )}
          {selecao?.tipo === 'fornecedor' && (
            <VisaoFornecedor key={`f-${selecao.codigo}-${versao}`} codigo={selecao.codigo}
              aoEscolher={setSelecao} aoAbrir={setPar} />
          )}
        </>
      )}

      {par && <ModalPrecos {...par} aoFechar={() => setPar(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ busca */

function BuscaHistorico({ aoEscolher, selecao }: { aoEscolher: (s: Selecao) => void; selecao: Selecao }) {
  const [texto, setTexto] = useState('');
  const [sugestoes, setSugestoes] = useState<Sugestoes | null>(null);
  const [aberta, setAberta] = useState(false);
  const [foco, setFoco] = useState(0);
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const termo = texto.trim();
    if (termo.length < 2) { setSugestoes(null); return undefined; }
    const t = setTimeout(() => {
      api<Sugestoes>('/compras/historico/busca', { query: { q: termo } })
        .then((r) => { setSugestoes(r.data); setFoco(0); })
        .catch(() => setSugestoes({ produtos: [], fornecedores: [] }));
    }, 250);
    return () => clearTimeout(t);
  }, [texto]);

  useEffect(() => {
    const fora = (e: MouseEvent) => { if (!caixa.current?.contains(e.target as Node)) setAberta(false); };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, []);

  const opcoes: Array<{ tipo: 'produto' | 'fornecedor'; codigo: string; titulo: string; detalhe: string }> = [
    ...(sugestoes?.produtos ?? []).map((p) => ({
      tipo: 'produto' as const, codigo: p.codigo, titulo: `${p.codigo} ${p.descricao ?? ''}`,
      detalhe: `${qtd(p.compras, 'entrada', 'entradas')}, ultima em ${data(p.ultima)}`,
    })),
    ...(sugestoes?.fornecedores ?? []).map((f) => ({
      tipo: 'fornecedor' as const, codigo: f.codigo, titulo: f.nome ?? f.razao_social ?? `ID ${f.codigo}`,
      detalhe: `ID ${f.codigo}, ${qtd(f.compras, 'entrada', 'entradas')}, ultima em ${data(f.ultima)}`,
    })),
  ];

  const escolher = (i: number) => {
    const o = opcoes[i];
    if (!o) return;
    aoEscolher({ tipo: o.tipo, codigo: o.codigo });
    setTexto('');
    setAberta(false);
  };
  const teclado = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { setFoco((f) => Math.min(opcoes.length - 1, f + 1)); setAberta(true); }
    else if (e.key === 'ArrowUp') setFoco((f) => Math.max(0, f - 1));
    else if (e.key === 'Enter') escolher(foco);
    else if (e.key === 'Escape') setAberta(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="busca-historico" ref={caixa}>
      <label className="busca-historico__rotulo" htmlFor="busca-historico">Pesquisar produto ou fornecedor</label>
      <div className="busca-historico__linha">
        <input
          id="busca-historico"
          className="busca-historico__campo"
          value={texto}
          placeholder="Codigo ou descricao do produto, nome, CNPJ ou ID do fornecedor"
          autoComplete="off"
          role="combobox"
          aria-expanded={aberta && opcoes.length > 0}
          aria-controls="busca-historico-lista"
          onChange={(e) => { setTexto(e.target.value); setAberta(true); }}
          onFocus={() => setAberta(true)}
          onKeyDown={teclado}
        />
        {selecao && (
          <button type="button" className="botao" onClick={() => aoEscolher(null)}>Ver ultimas entradas</button>
        )}
      </div>
      {aberta && texto.trim().length >= 2 && sugestoes && (
        <ul className="busca-historico__lista" id="busca-historico-lista" role="listbox">
          {opcoes.length === 0 && <li className="busca-historico__vazio">Nada encontrado no historico de compras.</li>}
          {opcoes.map((o, i) => (
            <li key={`${o.tipo}-${o.codigo}`} role="option" aria-selected={i === foco}>
              {(i === 0 || opcoes[i - 1]!.tipo !== o.tipo) && (
                <div className="busca-historico__grupo">{o.tipo === 'produto' ? 'Produtos' : 'Fornecedores'}</div>
              )}
              <button
                type="button"
                className={`busca-historico__opcao${i === foco ? ' ativa' : ''}`}
                onMouseEnter={() => setFoco(i)}
                onClick={() => escolher(i)}
              >
                <span>{o.titulo}</span>
                <span className="fraco">{o.detalhe}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------- ultimas entradas */

function UltimasEntradas({ aoEscolher }: { aoEscolher: (s: Selecao) => void }) {
  const [pagina, setPagina] = useState(1);
  const [itens, setItens] = useState<Entrada[]>([]);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setCarregando(true);
    api<Entrada[]>('/compras/historico/itens', { query: { pagina, limite: 50 } })
      .then((r) => { setItens(r.data); setMeta(r.meta); setErro(null); })
      .catch((e) => setErro(erroDe(e, 'Falha ao carregar as entradas')))
      .finally(() => setCarregando(false));
  }, [pagina]);

  return (
    <Cartao titulo="Ultimas entradas" semCorpo>
      {erro && <Aviso>{erro}</Aviso>}
      <div className="tabela-wrap">
        <table className="tabela">
          <thead>
            <tr>
              <th>Entrada</th><th>PC</th><th>Produto</th><th>Fornecedor</th>
              <th className="dir">Caixas</th><th className="dir">Kg</th>
              <th className="dir">Preco cx</th><th className="dir">Preco kg</th>
              <th className="dir">ICMS</th><th className="dir">PIS/COFINS</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((e) => (
              <tr key={e.id}>
                <td>{data(e.data_entrada)}</td>
                <td className="num">{e.pedido}</td>
                <td className="celula-produto">
                  <button type="button" className="link" onClick={() => aoEscolher({ tipo: 'produto', codigo: e.produto_codigo })}>
                    <span className="num">{e.produto_codigo}</span> {e.produto_descricao}
                  </button>
                </td>
                <td className="celula-produto">
                  <button type="button" className="link" onClick={() => aoEscolher({ tipo: 'fornecedor', codigo: e.fornecedor_codigo })}>
                    {e.fornecedor_nome ?? `ID ${e.fornecedor_codigo}`}
                  </button>
                </td>
                <td className="dir num">{numero(e.quantidade_caixas)}</td>
                <td className="dir num">{numero(e.total_kg)}</td>
                <td className="dir num">{reais(e.preco_caixa)}</td>
                <td className="dir num">{reais(e.preco_kg)}</td>
                <td className="dir num">{pct(e.aliquota_icms)}</td>
                <td className="dir num">{pct(e.aliquota_pis_cofins)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {carregando && <div className="carregando">Carregando entradas…</div>}
        {!carregando && itens.length === 0 && <Vazio>Nenhuma entrada importada.</Vazio>}
      </div>
      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

/* ---------------------------------------------------------- visao produto */

function useDados<T>(caminho: string) {
  const [dados, setDados] = useState<T | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    api<T>(caminho).then((r) => { setDados(r.data); setErro(null); })
      .catch((e) => setErro(erroDe(e, 'Falha ao carregar o historico')));
  }, [caminho]);
  return { dados, erro };
}

function VisaoProduto({ codigo, aoEscolher, aoAbrir }: {
  codigo: string; aoEscolher: (s: Selecao) => void;
  aoAbrir: (p: { produto: string; fornecedor: string; titulo: string }) => void;
}) {
  const { dados, erro } = useDados<PorProduto>(`/compras/historico/produto/${encodeURIComponent(codigo)}`);
  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <div className="carregando">Carregando o produto…</div>;

  const { produto, fornecedores } = dados;
  // O melhor preco compara o ultimo preco por kg: caixas de tamanhos diferentes
  // entre fornecedores tornariam o preco por caixa enganoso.
  const comPreco = fornecedores.filter((f) => f.ultimo_preco_kg !== null);
  const melhor = comPreco.reduce<typeof comPreco[number] | null>(
    (m, f) => (m === null || Number(f.ultimo_preco_kg) < Number(m.ultimo_preco_kg) ? f : m), null);

  return (
    <Cartao semCorpo>
      <header className="visao-cabecalho">
        <div>
          <span className="visao-cabecalho__tipo">Produto</span>
          <h3><span className="num">{produto.codigo}</span> {produto.descricao}</h3>
          <p className="fraco">
            {fornecedores.length === 1 ? 'Um fornecedor ja vendeu este produto.'
              : `${numero(fornecedores.length)} fornecedores ja venderam este produto.`}
            {melhor && fornecedores.length > 1 && (
              <> Menor ultimo preco por kg: <strong>{reais(melhor.ultimo_preco_kg)}</strong>, de {melhor.fornecedor_nome}.</>
            )}
          </p>
        </div>
        {produto.curva && <Etiqueta texto={`Curva ${produto.curva}`} tom="info" />}
      </header>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead>
            <tr>
              <th>Fornecedor</th><th>Ultima compra</th>
              <th className="dir">Caixas</th><th className="dir">Ultimo preco cx</th>
              <th className="dir">Preco kg</th><th className="dir">Faixa de preco cx</th>
              <th className="dir">Compras</th><th className="dir">ICMS</th><th className="dir">PIS/COFINS</th>
            </tr>
          </thead>
          <tbody>
            {fornecedores.map((f) => (
              <tr key={f.fornecedor_codigo} className="linha-clicavel" tabIndex={0}
                onClick={() => aoAbrir({ produto: produto.codigo, fornecedor: f.fornecedor_codigo,
                  titulo: `${produto.codigo} ${produto.descricao ?? ''} — ${f.fornecedor_nome ?? `ID ${f.fornecedor_codigo}`}` })}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}>
                <td className="celula-produto">
                  <button type="button" className="link celula-produto__nome"
                    onClick={(e) => { e.stopPropagation(); aoEscolher({ tipo: 'fornecedor', codigo: f.fornecedor_codigo }); }}>
                    {f.fornecedor_nome ?? `ID ${f.fornecedor_codigo}`}
                  </button>
                  <span className="celula-produto__meta">
                    ID {f.fornecedor_codigo}
                    {f.fornecedor_ativo === false && ' — inativo'}
                    {f.fornecedor_ativo === null && ' — fora da base de fornecedores'}
                  </span>
                </td>
                <td>
                  <div>{data(f.ultima_data)}</div>
                  <div className="celula-produto__meta">PC {f.ultimo_pedido}</div>
                </td>
                <td className="dir num">{numero(f.ultima_quantidade)}</td>
                <td className="dir">
                  <div className="num">{reais(f.ultimo_preco_caixa)}</div>
                  <VariacaoPreco atual={f.ultimo_preco_caixa} anterior={f.preco_anterior_caixa} />
                </td>
                <td className={`dir num${melhor === f && fornecedores.length > 1 ? ' melhor-preco' : ''}`}>
                  {reais(f.ultimo_preco_kg)}
                </td>
                <td className="dir num fraco">
                  {f.compras > 1 ? `${reais(f.menor_preco_caixa)} a ${reais(f.maior_preco_caixa)}` : '—'}
                </td>
                <td className="dir num">{numero(f.compras)}</td>
                <td className="dir num">{pct(f.aliquota_icms)}</td>
                <td className="dir num">{pct(f.aliquota_pis_cofins)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fraco nota-tabela">Clique numa linha para ver todas as compras deste produto com o fornecedor.</p>
    </Cartao>
  );
}

/* ------------------------------------------------------- visao fornecedor */

function VisaoFornecedor({ codigo, aoEscolher, aoAbrir }: {
  codigo: string; aoEscolher: (s: Selecao) => void;
  aoAbrir: (p: { produto: string; fornecedor: string; titulo: string }) => void;
}) {
  const { dados, erro } = useDados<PorFornecedor>(`/compras/historico/fornecedor/${encodeURIComponent(codigo)}`);
  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <div className="carregando">Carregando o fornecedor…</div>;

  const { fornecedor: f, produtos } = dados;
  const contato = [f.contato, f.telefone, f.email].filter(Boolean).join(', ');

  return (
    <Cartao semCorpo>
      <header className="visao-cabecalho">
        <div>
          <span className="visao-cabecalho__tipo">Fornecedor</span>
          <h3>{f.nome ?? `ID ${f.codigo}`}</h3>
          <p className="fraco">
            ID {f.codigo}{f.cnpj ? `, ${formatarDoc(f.cnpj)}` : ''}
            {f.cidade ? `, ${f.cidade}${f.estado ? `/${f.estado}` : ''}` : ''}
            {contato ? `. ${contato}` : ''}
          </p>
          <p className="fraco">
            {qtd(f.produtos, 'produto', 'produtos')} em {qtd(f.pedidos, 'pedido', 'pedidos')}, de {data(f.primeira_data)} a {data(f.ultima_data)},
            {' '}somando {reais(f.valor_total)}.
          </p>
        </div>
        {f.ativo === false && <Etiqueta texto="INATIVO" />}
        {f.ativo === null && <Etiqueta texto="FORA DA BASE" tom="alerta" />}
      </header>
      <div className="tabela-wrap">
        <table className="tabela">
          <thead>
            <tr>
              <th>Produto</th><th>Ultima compra</th>
              <th className="dir">Caixas</th><th className="dir">Ultimo preco cx</th>
              <th className="dir">Preco kg</th><th className="dir">Kg/cx</th>
              <th className="dir">Compras</th><th className="dir">ICMS</th><th className="dir">PIS/COFINS</th>
            </tr>
          </thead>
          <tbody>
            {produtos.map((p) => (
              <tr key={p.produto_codigo} className="linha-clicavel" tabIndex={0}
                onClick={() => aoAbrir({ produto: p.produto_codigo, fornecedor: f.codigo,
                  titulo: `${p.produto_codigo} ${p.produto_descricao ?? ''} — ${f.nome ?? `ID ${f.codigo}`}` })}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}>
                <td className="celula-produto">
                  <button type="button" className="link celula-produto__nome"
                    onClick={(e) => { e.stopPropagation(); aoEscolher({ tipo: 'produto', codigo: p.produto_codigo }); }}>
                    <span className="num">{p.produto_codigo}</span> {p.produto_descricao}
                  </button>
                  {p.curva && <span className="celula-produto__meta">Curva {p.curva}</span>}
                </td>
                <td>
                  <div>{data(p.ultima_data)}</div>
                  <div className="celula-produto__meta">PC {p.ultimo_pedido}</div>
                </td>
                <td className="dir num">{numero(p.ultima_quantidade)}</td>
                <td className="dir">
                  <div className="num">{reais(p.ultimo_preco_caixa)}</div>
                  <VariacaoPreco atual={p.ultimo_preco_caixa} anterior={p.preco_anterior_caixa} />
                </td>
                <td className="dir num">{reais(p.ultimo_preco_kg)}</td>
                <td className="dir num">{numero(p.kg_caixa, 2)}</td>
                <td className="dir num">{numero(p.compras)}</td>
                <td className="dir num">{pct(p.aliquota_icms)}</td>
                <td className="dir num">{pct(p.aliquota_pis_cofins)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fraco nota-tabela">Clique numa linha para ver todas as compras do produto com este fornecedor.</p>
    </Cartao>
  );
}

/* -------------------------------------------- compras de um produto x fornecedor */

function ModalPrecos({ produto, fornecedor, titulo, aoFechar }: {
  produto: string; fornecedor: string; titulo: string; aoFechar: () => void;
}) {
  const [itens, setItens] = useState<Entrada[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<Entrada[]>('/compras/historico/itens', { query: { produto, fornecedor, limite: 200 } })
      .then((r) => setItens(r.data))
      .catch((e) => setErro(erroDe(e, 'Falha ao carregar as compras')));
  }, [produto, fornecedor]);

  const cronologico = [...(itens ?? [])].reverse();

  return (
    <Modal titulo={titulo} aoFechar={aoFechar} largo>
      {erro && <Aviso>{erro}</Aviso>}
      {!itens && !erro && <div className="carregando">Carregando…</div>}
      {itens && (
        <>
          {cronologico.length > 1 && (
            <Cartao titulo="Preco por caixa a cada compra">
              <GraficoLinha
                rotulos={cronologico.map((e) => data(e.data_entrada).slice(0, 5))}
                series={[{ nome: 'Preco por caixa', valores: cronologico.map((e) => Number(e.preco_caixa ?? NaN)) }]}
                formatar={(v) => reais(v)}
              />
            </Cartao>
          )}
          <div className="tabela-wrap" style={{ marginTop: 12 }}>
            <table className="tabela">
              <thead>
                <tr>
                  <th>Entrada</th><th>PC</th><th>Tipo</th><th className="dir">Caixas</th><th className="dir">Kg</th>
                  <th className="dir">Preco cx</th><th className="dir">Preco kg</th>
                  <th className="dir">ICMS</th><th className="dir">ICMS red.</th><th className="dir">PIS/COFINS</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((e) => (
                  <tr key={e.id}>
                    <td>{data(e.data_entrada)}</td>
                    <td className="num">{e.pedido}</td>
                    <td className="fraco">{e.tipo}</td>
                    <td className="dir num">{numero(e.quantidade_caixas)}</td>
                    <td className="dir num">{numero(e.total_kg)}</td>
                    <td className="dir num">{reais(e.preco_caixa)}</td>
                    <td className="dir num">{reais(e.preco_kg)}</td>
                    <td className="dir num">{pct(e.aliquota_icms)}</td>
                    <td className="dir num">{pct(e.aliquota_icms_reduzida)}</td>
                    <td className="dir num">{pct(e.aliquota_pis_cofins)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
