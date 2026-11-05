/**
 * Orcamento para fornecedor: monta na tela, gera o PDF no layout do pedido
 * do ERP e envia pelo WhatsApp.
 *
 * Escolher o fornecedor (codigo do ERP, nome ou CNPJ) preenche os dados dele;
 * incluir um produto (codigo ou descricao) traz unidade, ultimo preco e os
 * ultimos impostos usados. Tudo continua editavel neste orcamento.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ErroApi } from '../api/client';
import type { Meta } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { Aviso, Cartao, Entrada, Etiqueta, Paginacao, Vazio, data, moeda, numero } from '../componentes/ui';
import {
  baixar, enviarWhatsApp, gerarPdf, telefoneWhatsApp,
  type Empresa, type FornecedorOrcamento, type OrcamentoPdf,
} from '../orcamento/pdf';

/* ------------------------------------------------------------------ tipos */

interface FornecedorBusca {
  id: number; codigo_erp: string | null; razao_social: string; nome_fantasia: string | null;
  cnpj: string | null; inscricao_estadual: string | null; endereco: string | null; numero: string | null;
  bairro: string | null; cidade: string | null; estado: string | null; cep: string | null;
  contato: string | null; telefone: string | null; celular: string | null; email: string | null;
  prazo_medio_pagamento: number | null; ativo: boolean;
}

interface SugestaoProduto {
  produto_id: number; codigo: string; descricao: string; unidade: string | null; ativo: boolean;
  preco_unitario: number | null; origem_preco: string | null; data_preco: string | null;
  icms_pct: number; pis_pct: number; cofins_pct: number; ipi_pct: number; st_valor: number;
  origem_impostos: string | null;
}

/** Campos numericos ficam como texto enquanto se digita ("97,5"). */
interface LinhaItem {
  chave: string;
  produto_id: number | null; produto_codigo: string; descricao: string; unidade: string;
  quantidade: string; preco_unitario: string; desconto: string; st_valor: string;
  ipi_pct: string; icms_pct: string; pis_pct: string; cofins_pct: string;
  origem_preco: string | null; origem_impostos: string | null;
}

interface Cabecalho {
  tipo_operacao: string; condicao_pagamento: string; data_entrega: string;
  transportadora: string; observacoes: string; desconto: string; frete: string; comprador: string;
}

interface OrcamentoSalvo {
  id: number; status: 'RASCUNHO' | 'ENVIADO'; data_emissao: string; tipo_operacao: string;
  fornecedor_id: number | null; fornecedor: FornecedorOrcamento;
  condicao_pagamento: string | null; data_entrega: string | null; transportadora: string | null;
  observacoes: string | null; desconto: number; frete: number; comprador: string | null;
  itens: Array<{
    produto_id: number | null; produto_codigo: string; descricao: string; unidade: string | null;
    quantidade: number; preco_unitario: number; desconto: number; st_valor: number;
    ipi_pct: number; icms_pct: number; pis_pct: number; cofins_pct: number;
  }>;
}

interface LinhaLista {
  id: number; status: string; data_emissao: string; tipo_operacao: string;
  fornecedor_nome: string | null; fornecedor_codigo: string | null; total_pedido: number;
  enviado_em: string | null; itens: number;
}

/* ---------------------------------------------------------------- ajudas */

const erroDe = (e: unknown, padrao: string) => (e instanceof ErroApi ? e.message : padrao);

/** "1.234,5" ou "1234.5" -> 1234.5; vazio -> 0. */
const n = (s: string | number | null | undefined) => {
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  const t = String(s ?? '').trim();
  if (!t) return 0;
  const limpo = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const v = Number(limpo);
  return Number.isFinite(v) ? v : 0;
};
/** Numero para o campo de texto, com virgula. */
const txt = (v: number | null | undefined, casas = 2) =>
  v === null || v === undefined ? '' : v.toLocaleString('pt-BR', { maximumFractionDigits: casas, useGrouping: false });

const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const formatarCnpj = (doc: string | null | undefined) => {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ?? '';
};
const formatarCep = (cep: string | null | undefined) => {
  const d = (cep ?? '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (cep ?? '');
};

const valoresItem = (i: LinhaItem) => {
  const base = Math.max(0, n(i.quantidade) * n(i.preco_unitario) - n(i.desconto));
  const icms = base * n(i.icms_pct) / 100;
  const pis = base * n(i.pis_pct) / 100;
  const cofins = base * n(i.cofins_pct) / 100;
  const ipi = base * n(i.ipi_pct) / 100;
  const st = n(i.st_valor);
  return { base, icms, pis, cofins, ipi, st, impostos: icms + pis + cofins + ipi + st };
};

function totais(itens: LinhaItem[], cab: Cabecalho) {
  const t = { mercadorias: 0, ipi: 0, st: 0, icms: 0, pis: 0, cofins: 0 };
  for (const i of itens) {
    const v = valoresItem(i);
    t.mercadorias += v.base; t.ipi += v.ipi; t.st += v.st; t.icms += v.icms; t.pis += v.pis; t.cofins += v.cofins;
  }
  const impostos = t.icms + t.pis + t.cofins + t.ipi + t.st;
  // Como no pedido do ERP: ICMS/PIS/COFINS estao no preco; IPI e ST somam ao total.
  const pedido = t.mercadorias - n(cab.desconto) + n(cab.frete) + t.ipi + t.st;
  return { ...t, impostos, pedido };
}

const FORNECEDOR_VAZIO: FornecedorOrcamento = {
  codigo_erp: '', nome: '', endereco: '', bairro: '', cidade: '', estado: '', cep: '',
  cnpj: '', inscricao: '', contato: '', email: '', fones: '', whatsapp: '',
};

const novaChave = () => Math.random().toString(36).slice(2);

/* ================================================================ pagina */

export function Orcamentos() {
  const [aberto, setAberto] = useState<number | 'novo' | null>(null);
  const [versao, setVersao] = useState(0);

  return (
    <>
      <CabecalhoPagina
        titulo="Orcamentos"
        descricao="Monte o orcamento do fornecedor, gere o PDF no layout do pedido e envie pelo WhatsApp."
      />
      {aberto === null ? (
        <ListaOrcamentos key={versao} aoAbrir={setAberto} />
      ) : (
        <Editor
          key={String(aberto)}
          id={aberto === 'novo' ? null : aberto}
          aoVoltar={() => { setAberto(null); setVersao((v) => v + 1); }}
        />
      )}
    </>
  );
}

/* ----------------------------------------------------------------- lista */

function ListaOrcamentos({ aoAbrir }: { aoAbrir: (id: number | 'novo') => void }) {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);
  const [itens, setItens] = useState<LinhaLista[]>([]);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setCarregando(true);
    const t = setTimeout(() => {
      api<LinhaLista[]>('/compras/orcamentos', { query: { busca, pagina, limite: 25 } })
        .then((r) => { setItens(r.data); setMeta(r.meta); setErro(null); })
        .catch((e) => setErro(erroDe(e, 'Falha ao carregar os orcamentos')))
        .finally(() => setCarregando(false));
    }, 250);
    return () => clearTimeout(t);
  }, [busca, pagina]);

  return (
    <Cartao
      titulo="Orcamentos enviados e rascunhos"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
            placeholder="fornecedor ou numero" />
          {pode('compras.requisitar') && (
            <button type="button" className="botao botao--primario" onClick={() => aoAbrir('novo')}>
              Novo orcamento
            </button>
          )}
        </div>
      )}
      semCorpo
    >
      {erro && <Aviso>{erro}</Aviso>}
      <div className="tabela-wrap">
        <table className="tabela">
          <thead>
            <tr>
              <th>No.</th><th>Data</th><th>Fornecedor</th><th>Operacao</th>
              <th className="dir">Itens</th><th className="dir">Total</th><th>Situacao</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((o) => (
              <tr key={o.id} className="linha-clicavel" tabIndex={0} onClick={() => aoAbrir(o.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') aoAbrir(o.id); }}>
                <td className="num">{o.id}</td>
                <td>{data(o.data_emissao)}</td>
                <td className="celula-produto">
                  <span className="celula-produto__nome">{o.fornecedor_nome ?? '—'}</span>
                  {o.fornecedor_codigo && <span className="celula-produto__meta">ID {o.fornecedor_codigo}</span>}
                </td>
                <td>{o.tipo_operacao}</td>
                <td className="dir num">{numero(o.itens)}</td>
                <td className="dir num">{moeda(o.total_pedido)}</td>
                <td>
                  <Etiqueta texto={o.status === 'ENVIADO' ? 'ENVIADO' : 'RASCUNHO'}
                    tom={o.status === 'ENVIADO' ? 'acento' : 'neutro'} />
                  {o.enviado_em && <div className="celula-produto__meta">{data(o.enviado_em.slice(0, 10))}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {carregando && <div className="carregando">Carregando…</div>}
        {!carregando && !itens.length && (
          <Vazio>{busca ? 'Nenhum orcamento encontrado.' : 'Nenhum orcamento ainda. Clique em "Novo orcamento".'}</Vazio>
        )}
      </div>
      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

/* ------------------------------------------------- caixa de busca generica */

function Busca<T>({ rotulo, placeholder, buscar, renderizar, aoEscolher, chave, autoFoco }: {
  rotulo: string; placeholder: string;
  buscar: (termo: string) => Promise<T[]>;
  renderizar: (item: T) => ReactNode;
  aoEscolher: (item: T) => void;
  chave: (item: T) => string;
  autoFoco?: boolean;
}) {
  const [texto, setTexto] = useState('');
  const [itens, setItens] = useState<T[]>([]);
  const [aberta, setAberta] = useState(false);
  const [foco, setFoco] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const termo = texto.trim();
    if (!termo) { setItens([]); return undefined; }
    setBuscando(true);
    const t = setTimeout(() => {
      buscar(termo).then((r) => { setItens(r); setFoco(0); }).catch(() => setItens([]))
        .finally(() => setBuscando(false));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto]);

  useEffect(() => {
    const fora = (e: MouseEvent) => { if (!caixa.current?.contains(e.target as Node)) setAberta(false); };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, []);

  const escolher = (i: number) => {
    const item = itens[i];
    if (!item) return;
    aoEscolher(item);
    setTexto(''); setItens([]); setAberta(false);
  };
  const teclado = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { setFoco((f) => Math.min(itens.length - 1, f + 1)); setAberta(true); }
    else if (e.key === 'ArrowUp') setFoco((f) => Math.max(0, f - 1));
    else if (e.key === 'Enter') escolher(foco);
    else if (e.key === 'Escape') setAberta(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="busca-historico" ref={caixa}>
      <label className="busca-historico__rotulo">{rotulo}</label>
      <input
        className="busca-historico__campo"
        value={texto}
        placeholder={placeholder}
        autoComplete="off"
        autoFocus={autoFoco}
        onChange={(e) => { setTexto(e.target.value); setAberta(true); }}
        onFocus={() => setAberta(true)}
        onKeyDown={teclado}
      />
      {aberta && texto.trim() && (
        <ul className="busca-historico__lista" role="listbox">
          {buscando && !itens.length && <li className="busca-historico__vazio">Buscando…</li>}
          {!buscando && !itens.length && <li className="busca-historico__vazio">Nada encontrado.</li>}
          {itens.map((item, i) => (
            <li key={chave(item)} role="option" aria-selected={i === foco}>
              <button type="button" className={`busca-historico__opcao${i === foco ? ' ativa' : ''}`}
                onMouseEnter={() => setFoco(i)} onClick={() => escolher(i)}>
                {renderizar(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- editor */

function Editor({ id, aoVoltar }: { id: number | null; aoVoltar: () => void }) {
  const { usuario, pode } = useAuth();
  // Numero do orcamento: nasce no primeiro salvamento e a tela continua aberta.
  const [idAtual, setIdAtual] = useState<number | null>(id);
  const podeEditar = pode('compras.requisitar');
  const [empresa, setEmpresa] = useState<Empresa>({});
  const [carregando, setCarregando] = useState(id !== null);
  const [status, setStatus] = useState<'RASCUNHO' | 'ENVIADO'>('RASCUNHO');
  const [dataEmissao, setDataEmissao] = useState(hojeIso());
  const [fornecedorId, setFornecedorId] = useState<number | null>(null);
  const [fornecedor, setFornecedor] = useState<FornecedorOrcamento>({ ...FORNECEDOR_VAZIO });
  const [cab, setCab] = useState<Cabecalho>({
    tipo_operacao: 'COMPRAS', condicao_pagamento: '', data_entrega: '', transportadora: '',
    observacoes: '', desconto: '', frete: '', comprador: usuario?.nome ?? '',
  });
  const [itens, setItens] = useState<LinhaItem[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  useEffect(() => {
    api<Empresa>('/compras/orcamentos/empresa').then((r) => setEmpresa(r.data)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (id === null) return;
    api<OrcamentoSalvo>(`/compras/orcamentos/${id}`)
      .then(({ data: o }) => {
        setStatus(o.status); setDataEmissao(o.data_emissao); setFornecedorId(o.fornecedor_id);
        setFornecedor({ ...FORNECEDOR_VAZIO, ...o.fornecedor });
        setCab({
          tipo_operacao: o.tipo_operacao, condicao_pagamento: o.condicao_pagamento ?? '',
          data_entrega: o.data_entrega ?? '', transportadora: o.transportadora ?? '',
          observacoes: o.observacoes ?? '', desconto: txt(Number(o.desconto)), frete: txt(Number(o.frete)),
          comprador: o.comprador ?? '',
        });
        setItens(o.itens.map((i) => ({
          chave: novaChave(), produto_id: i.produto_id, produto_codigo: i.produto_codigo, descricao: i.descricao,
          unidade: i.unidade ?? '', quantidade: txt(Number(i.quantidade), 3), preco_unitario: txt(Number(i.preco_unitario), 4),
          desconto: txt(Number(i.desconto)), st_valor: txt(Number(i.st_valor)), ipi_pct: txt(Number(i.ipi_pct), 4),
          icms_pct: txt(Number(i.icms_pct), 4), pis_pct: txt(Number(i.pis_pct), 4), cofins_pct: txt(Number(i.cofins_pct), 4),
          origem_preco: null, origem_impostos: null,
        })));
      })
      .catch((e) => setErro(erroDe(e, 'Falha ao abrir o orcamento')))
      .finally(() => setCarregando(false));
  }, [id]);

  const mudarF = (campo: keyof FornecedorOrcamento) => (v: string) => setFornecedor((f) => ({ ...f, [campo]: v }));
  const mudarC = (campo: keyof Cabecalho) => (v: string) => setCab((c) => ({ ...c, [campo]: v }));
  const mudarItem = (chave: string, campo: keyof LinhaItem, v: string) =>
    setItens((l) => l.map((i) => (i.chave === chave ? { ...i, [campo]: v } : i)));

  function escolherFornecedor(f: FornecedorBusca) {
    setFornecedorId(f.id);
    setFornecedor({
      codigo_erp: f.codigo_erp ?? '',
      nome: f.razao_social,
      endereco: [f.endereco, f.numero].filter(Boolean).join(', '),
      bairro: f.bairro ?? '', cidade: f.cidade ?? '', estado: f.estado ?? '',
      cep: formatarCep(f.cep), cnpj: formatarCnpj(f.cnpj), inscricao: f.inscricao_estadual ?? '',
      contato: f.contato ?? '', email: f.email ?? '', fones: f.telefone ?? '',
      whatsapp: f.celular ?? f.telefone ?? '',
    });
    if (f.prazo_medio_pagamento !== null && f.prazo_medio_pagamento !== undefined) {
      setCab((c) => ({ ...c, condicao_pagamento: c.condicao_pagamento || String(f.prazo_medio_pagamento) }));
    }
  }

  function incluirProduto(p: SugestaoProduto) {
    if (itens.some((i) => i.produto_id === p.produto_id)) {
      setAviso(`${p.codigo} ja esta no orcamento.`);
      return;
    }
    setAviso(null);
    setItens((l) => [...l, {
      chave: novaChave(), produto_id: p.produto_id, produto_codigo: p.codigo, descricao: p.descricao,
      unidade: p.unidade ?? '', quantidade: '', preco_unitario: txt(p.preco_unitario, 4),
      desconto: '', st_valor: p.st_valor ? txt(p.st_valor) : '', ipi_pct: txt(p.ipi_pct, 4),
      icms_pct: txt(p.icms_pct, 4), pis_pct: txt(p.pis_pct, 4), cofins_pct: txt(p.cofins_pct, 4),
      origem_preco: p.origem_preco ? `${p.origem_preco}${p.data_preco ? `, ${data(p.data_preco)}` : ''}` : null,
      origem_impostos: p.origem_impostos,
    }]);
    // Leva o cursor para a quantidade do item novo.
    setTimeout(() => {
      const campos = document.querySelectorAll<HTMLInputElement>('.orc-itens input[data-campo="quantidade"]');
      campos[campos.length - 1]?.focus();
    }, 50);
  }

  const t = totais(itens, cab);

  function validar(): string | null {
    if (!fornecedor.nome?.trim()) return 'Escolha o fornecedor.';
    if (!itens.length) return 'Inclua ao menos um produto.';
    const semQtd = itens.find((i) => n(i.quantidade) <= 0);
    if (semQtd) return `Informe a quantidade de ${semQtd.produto_codigo}.`;
    return null;
  }

  async function salvar(): Promise<number | null> {
    const problema = validar();
    if (problema) { setErro(problema); return null; }
    setErro(null);
    const corpo = {
      fornecedor_id: fornecedorId, fornecedor, data_emissao: dataEmissao,
      tipo_operacao: cab.tipo_operacao || 'COMPRAS',
      condicao_pagamento: cab.condicao_pagamento || null, data_entrega: cab.data_entrega || null,
      transportadora: cab.transportadora || null, observacoes: cab.observacoes || null,
      desconto: n(cab.desconto), frete: n(cab.frete), comprador: cab.comprador || null,
      itens: itens.map((i) => ({
        produto_id: i.produto_id, produto_codigo: i.produto_codigo, descricao: i.descricao, unidade: i.unidade || null,
        quantidade: n(i.quantidade), preco_unitario: n(i.preco_unitario), desconto: n(i.desconto),
        st_valor: n(i.st_valor), ipi_pct: n(i.ipi_pct), icms_pct: n(i.icms_pct),
        pis_pct: n(i.pis_pct), cofins_pct: n(i.cofins_pct),
      })),
    };
    const r = idAtual === null
      ? await api<OrcamentoSalvo>('/compras/orcamentos', { metodo: 'POST', corpo })
      : await api<OrcamentoSalvo>(`/compras/orcamentos/${idAtual}`, { metodo: 'PUT', corpo });
    setIdAtual(r.data.id);
    return r.data.id;
  }

  async function executar(acao: 'salvar' | 'pdf' | 'whatsapp') {
    setOcupado(acao); setAviso(null);
    try {
      const numeroOrc = await salvar();
      if (numeroOrc === null) return;
      if (acao === 'salvar') {
        setAviso(`Orcamento ${numeroOrc} salvo.`);
        return;
      }
      const pdf = await gerarPdf(montarPdf(numeroOrc), empresa);
      const nomeArquivo = `Orcamento_${numeroOrc}_${(fornecedor.nome ?? 'fornecedor').replace(/[^\w]+/g, '_').slice(0, 40)}.pdf`;
      if (acao === 'pdf') {
        baixar(pdf, nomeArquivo);
        setAviso(`PDF do orcamento ${numeroOrc} baixado.`);
      } else {
        const telefone = telefoneWhatsApp(fornecedor.whatsapp || fornecedor.fones);
        const mensagem = `Olá${fornecedor.contato ? `, ${fornecedor.contato}` : ''}! Segue o orçamento nº ${numeroOrc} `
          + `da ${empresa.razao_social ?? 'nossa empresa'}. Fico no aguardo. ${cab.comprador}`;
        const resultado = await enviarWhatsApp(pdf, nomeArquivo, telefone, mensagem);
        if (resultado === 'cancelado') { setAviso('Envio cancelado.'); return; }
        await api(`/compras/orcamentos/${numeroOrc}/enviado`, { metodo: 'POST' });
        setStatus('ENVIADO');
        setAviso(resultado === 'compartilhado'
          ? `Orcamento ${numeroOrc} compartilhado.`
          : `PDF baixado e WhatsApp aberto${telefone ? ' na conversa do fornecedor' : ''}: anexe o arquivo `
            + `${nomeArquivo} na conversa (arraste o arquivo ou use o clipe).`);
      }
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel concluir'));
    } finally {
      setOcupado(null);
    }
  }

  function montarPdf(numeroOrc: number): OrcamentoPdf {
    return {
      numero: numeroOrc, data_emissao: dataEmissao, tipo_operacao: cab.tipo_operacao || 'COMPRAS',
      fornecedor, condicao_pagamento: cab.condicao_pagamento, data_entrega: cab.data_entrega,
      transportadora: cab.transportadora, observacoes: cab.observacoes,
      desconto: n(cab.desconto), frete: n(cab.frete), comprador: cab.comprador,
      itens: itens.map((i) => ({
        produto_codigo: i.produto_codigo, descricao: i.descricao, unidade: i.unidade || null,
        quantidade: n(i.quantidade), preco_unitario: n(i.preco_unitario), desconto: n(i.desconto),
        st_valor: n(i.st_valor), ipi_pct: n(i.ipi_pct), icms_pct: n(i.icms_pct),
        pis_pct: n(i.pis_pct), cofins_pct: n(i.cofins_pct),
      })),
      totais: t,
    };
  }

  if (carregando) return <div className="carregando">Carregando o orcamento…</div>;

  const numeroCampo = (i: LinhaItem, campo: keyof LinhaItem, titulo?: string, largura = 'curto') => (
    <input
      className={`orc-campo orc-campo--${largura}`}
      inputMode="decimal"
      data-campo={campo}
      title={titulo}
      value={String(i[campo] ?? '')}
      placeholder="0"
      disabled={!podeEditar}
      onChange={(e) => mudarItem(i.chave, campo, e.target.value)}
    />
  );

  return (
    <div className="orc">
      <div className="orc-barra">
        <button type="button" className="botao" onClick={aoVoltar}>← Orcamentos</button>
        <h3>{idAtual === null ? 'Novo orcamento' : `Orcamento No. ${idAtual}`}</h3>
        {idAtual !== null && <Etiqueta texto={status} tom={status === 'ENVIADO' ? 'acento' : 'neutro'} />}
        <div className="orc-barra__acoes">
          {podeEditar && (
            <>
              <button type="button" className="botao" disabled={!!ocupado} onClick={() => void executar('salvar')}>
                {ocupado === 'salvar' ? 'Salvando…' : 'Salvar'}
              </button>
              <button type="button" className="botao" disabled={!!ocupado} onClick={() => void executar('pdf')}>
                {ocupado === 'pdf' ? 'Gerando…' : 'Baixar PDF'}
              </button>
              <button type="button" className="botao botao--primario botao--whatsapp" disabled={!!ocupado}
                onClick={() => void executar('whatsapp')}>
                {ocupado === 'whatsapp' ? 'Preparando…' : 'Enviar pelo WhatsApp'}
              </button>
            </>
          )}
        </div>
      </div>

      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      {/* ------------------------------------------------------ fornecedor */}
      <Cartao titulo="Fornecedor">
        {podeEditar && (
          <Busca<FornecedorBusca>
            rotulo="Buscar fornecedor"
            placeholder="ID do ERP, nome, fantasia ou CNPJ"
            autoFoco={id === null}
            chave={(f) => String(f.id)}
            buscar={async (q) => (await api<FornecedorBusca[]>('/fornecedores', { query: { busca: q, limite: 8, ativo: 'true' } })).data}
            renderizar={(f) => (
              <>
                <span>{f.codigo_erp ? `${f.codigo_erp} - ` : ''}{f.nome_fantasia ?? f.razao_social}</span>
                <span className="fraco">{[f.razao_social, formatarCnpj(f.cnpj), [f.cidade, f.estado].filter(Boolean).join('/')].filter(Boolean).join(', ')}</span>
              </>
            )}
            aoEscolher={escolherFornecedor}
          />
        )}
        <div className="orc-grade">
          <Entrada rotulo="Nome" valor={fornecedor.nome ?? ''} aoMudar={mudarF('nome')} className="orc-col-2" />
          <Entrada rotulo="ID ERP" valor={fornecedor.codigo_erp ?? ''} aoMudar={mudarF('codigo_erp')} />
          <Entrada rotulo="CNPJ" valor={fornecedor.cnpj ?? ''} aoMudar={mudarF('cnpj')} />
          <Entrada rotulo="Endereco" valor={fornecedor.endereco ?? ''} aoMudar={mudarF('endereco')} className="orc-col-2" />
          <Entrada rotulo="Bairro" valor={fornecedor.bairro ?? ''} aoMudar={mudarF('bairro')} />
          <Entrada rotulo="CEP" valor={fornecedor.cep ?? ''} aoMudar={mudarF('cep')} />
          <Entrada rotulo="Cidade" valor={fornecedor.cidade ?? ''} aoMudar={mudarF('cidade')} />
          <Entrada rotulo="Estado" valor={fornecedor.estado ?? ''} aoMudar={mudarF('estado')} />
          <Entrada rotulo="Inscr. estadual" valor={fornecedor.inscricao ?? ''} aoMudar={mudarF('inscricao')} />
          <Entrada rotulo="A/C (contato)" valor={fornecedor.contato ?? ''} aoMudar={mudarF('contato')} />
          <Entrada rotulo="E-mail" valor={fornecedor.email ?? ''} aoMudar={mudarF('email')} className="orc-col-2" />
          <Entrada rotulo="Fones" valor={fornecedor.fones ?? ''} aoMudar={mudarF('fones')} />
          <Entrada rotulo="WhatsApp (com DDD)" valor={fornecedor.whatsapp ?? ''} aoMudar={mudarF('whatsapp')}
            placeholder="ex.: 54 99999-0000" />
        </div>
      </Cartao>

      {/* ---------------------------------------------------------- itens */}
      <Cartao titulo="Produtos">
        {podeEditar && (
          <Busca<SugestaoProduto>
            rotulo="Incluir produto"
            placeholder="Codigo ou descricao do produto"
            chave={(p) => String(p.produto_id)}
            buscar={async (q) => (await api<SugestaoProduto[]>('/compras/orcamentos/produtos', {
              query: { q, fornecedor_id: fornecedorId ?? undefined },
            })).data}
            renderizar={(p) => (
              <>
                <span><span className="num">{p.codigo}</span> {p.descricao}{!p.ativo && ' (inativo)'}</span>
                <span className="fraco">
                  {p.unidade ?? ''}
                  {p.preco_unitario !== null ? `, ${moeda(p.preco_unitario)} (${p.origem_preco})` : ', sem preco anterior'}
                  {p.origem_impostos ? `, ICMS ${numero(p.icms_pct, 2)}%` : ''}
                </span>
              </>
            )}
            aoEscolher={incluirProduto}
          />
        )}
        {itens.length === 0 ? (
          <Vazio>Nenhum produto. Busque pelo codigo ou pela descricao para incluir.</Vazio>
        ) : (
          <div className="tabela-wrap orc-itens">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th><th>Descricao</th><th>Unid.</th>
                  <th className="dir">Qtde</th><th className="dir">Val. Un.</th><th className="dir">Desc. R$</th>
                  <th className="dir" title="ICMS-ST em reais">ST R$</th>
                  <th className="dir">IPI%</th><th className="dir">ICMS%</th><th className="dir">PIS%</th><th className="dir">COFINS%</th>
                  <th className="dir" title="ICMS + PIS + COFINS + IPI + ST do item">Impostos</th>
                  <th className="dir">Valor total</th><th />
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => {
                  const v = valoresItem(i);
                  return (
                    <tr key={i.chave}>
                      <td className="num">{i.produto_codigo}</td>
                      <td>
                        <input className="orc-campo orc-campo--descricao" value={i.descricao} disabled={!podeEditar}
                          onChange={(e) => mudarItem(i.chave, 'descricao', e.target.value)} />
                      </td>
                      <td>
                        <input className="orc-campo orc-campo--unid" value={i.unidade} disabled={!podeEditar}
                          onChange={(e) => mudarItem(i.chave, 'unidade', e.target.value)} />
                      </td>
                      <td className="dir">{numeroCampo(i, 'quantidade')}</td>
                      <td className="dir">{numeroCampo(i, 'preco_unitario', i.origem_preco ? `Sugerido: ${i.origem_preco}` : undefined, 'medio')}</td>
                      <td className="dir">{numeroCampo(i, 'desconto')}</td>
                      <td className="dir">{numeroCampo(i, 'st_valor', i.origem_impostos ? `Sugerido: ${i.origem_impostos}` : undefined)}</td>
                      <td className="dir">{numeroCampo(i, 'ipi_pct', undefined, 'pct')}</td>
                      <td className="dir">{numeroCampo(i, 'icms_pct', i.origem_impostos ? `Sugerido: ${i.origem_impostos}` : undefined, 'pct')}</td>
                      <td className="dir">{numeroCampo(i, 'pis_pct', undefined, 'pct')}</td>
                      <td className="dir">{numeroCampo(i, 'cofins_pct', undefined, 'pct')}</td>
                      <td className="dir num" title={`ICMS ${moeda(v.icms)}, PIS ${moeda(v.pis)}, COFINS ${moeda(v.cofins)}, IPI ${moeda(v.ipi)}, ST ${moeda(v.st)}`}>
                        {moeda(v.impostos)}
                      </td>
                      <td className="dir num"><strong>{moeda(v.base)}</strong></td>
                      <td>
                        {podeEditar && (
                          <button type="button" className="botao botao--fantasma botao--pequeno" title="Remover"
                            onClick={() => setItens((l) => l.filter((x) => x.chave !== i.chave))}>×</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {itens.some((i) => i.origem_impostos || i.origem_preco) && (
          <p className="fraco" style={{ margin: '8px 0 0' }}>
            Preco e impostos vieram do ultimo orcamento ou da ultima compra do produto. Passe o mouse no campo para ver
            a origem; todos podem ser alterados.
          </p>
        )}
      </Cartao>

      {/* ------------------------------------------- condicoes e totais */}
      <div className="orc-rodape">
        <Cartao titulo="Condicoes gerais">
          <div className="orc-grade orc-grade--2">
            <Entrada rotulo="Condicao de pagamento" valor={cab.condicao_pagamento} aoMudar={mudarC('condicao_pagamento')}
              placeholder="ex.: 35 ou 28/35/42 dias" />
            <Entrada rotulo="Data prevista de entrega" tipo="date" valor={cab.data_entrega} aoMudar={mudarC('data_entrega')} />
            <Entrada rotulo="Transportadora" valor={cab.transportadora} aoMudar={mudarC('transportadora')} />
            <Entrada rotulo="Tipo de operacao" valor={cab.tipo_operacao} aoMudar={mudarC('tipo_operacao')} />
            <Entrada rotulo="Data do orcamento" tipo="date" valor={dataEmissao} aoMudar={setDataEmissao} />
            <Entrada rotulo="Comprador (assinatura)" valor={cab.comprador} aoMudar={mudarC('comprador')} />
          </div>
          <div className="campo" style={{ marginTop: 10 }}>
            <label htmlFor="orc-observacoes">Observacoes</label>
            <textarea id="orc-observacoes" className="orc-observacoes" rows={3} value={cab.observacoes}
              onChange={(e) => mudarC('observacoes')(e.target.value)} />
          </div>
        </Cartao>

        <Cartao titulo="Totais">
          <dl className="orc-totais">
            <dt>Total mercadorias</dt><dd>{moeda(t.mercadorias)}</dd>
            <dt>Desconto</dt>
            <dd><input className="orc-campo orc-campo--medio" inputMode="decimal" value={cab.desconto}
              onChange={(e) => mudarC('desconto')(e.target.value)} /></dd>
            <dt>Frete</dt>
            <dd><input className="orc-campo orc-campo--medio" inputMode="decimal" value={cab.frete}
              onChange={(e) => mudarC('frete')(e.target.value)} /></dd>
            <dt>IPI</dt><dd>{moeda(t.ipi)}</dd>
            <dt>ICMS-ST</dt><dd>{moeda(t.st)}</dd>
            <dt>ICMS</dt><dd>{moeda(t.icms)}</dd>
            <dt>PIS</dt><dd>{moeda(t.pis)}</dd>
            <dt>COFINS</dt><dd>{moeda(t.cofins)}</dd>
            <dt className="orc-totais__forte">Total de impostos</dt><dd className="orc-totais__forte">{moeda(t.impostos)}</dd>
            <dt className="orc-totais__pedido">Total pedido</dt><dd className="orc-totais__pedido">{moeda(t.pedido)}</dd>
          </dl>
          <p className="fraco" style={{ margin: '8px 0 0' }}>
            Como no pedido do ERP: ICMS, PIS e COFINS estao no preco; IPI, ST e frete somam ao total.
          </p>
        </Cartao>
      </div>
    </div>
  );
}
