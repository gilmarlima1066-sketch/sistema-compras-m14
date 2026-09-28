import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { OpcaoCadastro, Produto } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, EtiquetaAtivo, Modal, Paginacao, Selecao, Vazio, numero,
} from '../componentes/ui';

interface Formulario {
  codigo: string;
  descricao: string;
  ean: string;
  categoria_id: string;
  subcategoria_id: string;
  unidade_estoque_id: string;
  origem: string;
  estoque_minimo: string;
  estoque_seguranca: string;
  ponto_pedido: string;
  lead_time_padrao_dias: string;
  produto_importado: string;
}

const FORM_VAZIO: Formulario = {
  codigo: '', descricao: '', ean: '', categoria_id: '', subcategoria_id: '',
  unidade_estoque_id: '', origem: '', estoque_minimo: '0', estoque_seguranca: '0',
  ponto_pedido: '0', lead_time_padrao_dias: '0', produto_importado: 'false',
};

export function Produtos() {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [categoria, setCategoria] = useState('');
  const [ativo, setAtivo] = useState('true');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro, recarregar } =
    useLista<Produto>('/produtos', { pagina, limite: 25, busca, categoria_id: categoria, ativo });

  const [categorias, setCategorias] = useState<OpcaoCadastro[]>([]);
  const [subcategorias, setSubcategorias] = useState<OpcaoCadastro[]>([]);
  const [unidades, setUnidades] = useState<OpcaoCadastro[]>([]);

  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<Formulario>(FORM_VAZIO);
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Array<{ campo?: string; mensagem: string }>>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    void Promise.all([
      api<OpcaoCadastro[]>('/cadastros/categorias'),
      api<OpcaoCadastro[]>('/cadastros/subcategorias'),
      api<OpcaoCadastro[]>('/cadastros/unidades'),
    ])
      .then(([c, s, u]) => { setCategorias(c.data); setSubcategorias(s.data); setUnidades(u.data); })
      .catch(() => undefined);
  }, []);

  const mudar = (campo: keyof Formulario) => (valor: string) => setForm((f) => ({ ...f, [campo]: valor }));

  async function salvar() {
    setErroForm(null);
    setDetalhes([]);
    setSalvando(true);
    try {
      await api('/produtos', {
        metodo: 'POST',
        corpo: {
          codigo: form.codigo,
          descricao: form.descricao,
          ean: form.ean || null,
          categoria_id: Number(form.categoria_id),
          subcategoria_id: form.subcategoria_id ? Number(form.subcategoria_id) : null,
          unidade_estoque_id: Number(form.unidade_estoque_id),
          origem: form.origem || null,
          estoque_minimo: Number(form.estoque_minimo),
          estoque_seguranca: Number(form.estoque_seguranca),
          ponto_pedido: Number(form.ponto_pedido),
          lead_time_padrao_dias: Number(form.lead_time_padrao_dias),
          produto_importado: form.produto_importado === 'true',
        },
      });
      setAberto(false);
      setForm(FORM_VAZIO);
      await recarregar();
    } catch (e) {
      if (e instanceof ErroApi) { setErroForm(e.message); setDetalhes(e.detalhes); }
      else setErroForm('Nao foi possivel salvar o produto');
    } finally {
      setSalvando(false);
    }
  }

  const subcategoriasDaCategoria = subcategorias.filter(
    (s) => !form.categoria_id || String(s.categoria_id) === form.categoria_id,
  );

  return (
    <>
      <CabecalhoPagina
        titulo="Produtos"
        descricao="Cadastro mestre de SKUs, parametros de estoque e classificacao."
        acoes={pode('produtos.criar') && (
          <button type="button" className="botao botao--primario" onClick={() => setAberto(true)}>
            Novo produto
          </button>
        )}
      />

      <div className="filtros">
        <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
          placeholder="codigo, descricao ou EAN" className="campo--busca" />
        <Selecao rotulo="Categoria" valor={categoria} aoMudar={(v) => { setCategoria(v); setPagina(1); }}
          vazio="Todas" opcoes={categorias.map((c) => ({ valor: String(c.id), texto: c.nome ?? '' }))} />
        <Selecao rotulo="Situacao" valor={ativo} aoMudar={(v) => { setAtivo(v); setPagina(1); }}
          vazio="Todas" opcoes={[{ valor: 'true', texto: 'Ativos' }, { valor: 'false', texto: 'Inativos' }]} />
      </div>

      {erro && <Aviso>{erro}</Aviso>}

      <Cartao semCorpo>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th>
                <th>Descricao</th>
                <th>Categoria</th>
                <th>Un.</th>
                <th className="dir">Est. minimo</th>
                <th className="dir">Ponto pedido</th>
                <th>ABC</th>
                <th>Origem</th>
                <th>Situacao</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((p) => (
                <tr key={p.id}>
                  <td className="codigo">{p.codigo}</td>
                  <td>{p.descricao}</td>
                  <td>
                    {p.categoria_nome}
                    {p.subcategoria_nome && <span style={{ color: 'var(--texto-3)' }}> / {p.subcategoria_nome}</span>}
                  </td>
                  <td>{p.unidade_estoque_codigo}</td>
                  <td className="dir num">{numero(p.estoque_minimo, 2)}</td>
                  <td className="dir num">{numero(p.ponto_pedido, 2)}</td>
                  <td>{p.classificacao_abc ?? '—'}</td>
                  <td>{p.produto_importado ? <Etiqueta texto="IMPORTADO" tom="info" /> : <Etiqueta texto="NACIONAL" />}</td>
                  <td><EtiquetaAtivo ativo={p.ativo} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {carregando && <div className="carregando">Carregando produtos…</div>}
          {!carregando && itens.length === 0 && <Vazio>Nenhum produto encontrado com esses filtros.</Vazio>}
        </div>
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {aberto && (
        <Modal
          titulo="Novo produto"
          aoFechar={() => setAberto(false)}
          rodape={(
            <>
              <button type="button" className="botao" onClick={() => setAberto(false)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={salvando} onClick={() => void salvar()}>
                {salvando ? 'Salvando…' : 'Salvar produto'}
              </button>
            </>
          )}
        >
          {erroForm && (
            <Aviso>
              {erroForm}
              {detalhes.length > 0 && (
                <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  {detalhes.map((d, i) => <li key={i}>{d.campo}: {d.mensagem}</li>)}
                </ul>
              )}
            </Aviso>
          )}
          <div className="formulario-grade">
            <Entrada rotulo="Codigo" valor={form.codigo} aoMudar={mudar('codigo')} placeholder="GR0001" />
            <Entrada rotulo="EAN" valor={form.ean} aoMudar={mudar('ean')} placeholder="7891234567890" />
            <Entrada rotulo="Descricao" valor={form.descricao} aoMudar={mudar('descricao')} className="col-2" />
            <Selecao rotulo="Categoria" valor={form.categoria_id} aoMudar={mudar('categoria_id')}
              opcoes={categorias.map((c) => ({ valor: String(c.id), texto: c.nome ?? '' }))} vazio="Selecione" />
            <Selecao rotulo="Subcategoria" valor={form.subcategoria_id} aoMudar={mudar('subcategoria_id')}
              opcoes={subcategoriasDaCategoria.map((s) => ({ valor: String(s.id), texto: s.nome ?? '' }))} />
            <Selecao rotulo="Unidade de estoque" valor={form.unidade_estoque_id} aoMudar={mudar('unidade_estoque_id')}
              opcoes={unidades.map((u) => ({ valor: String(u.id), texto: `${u.codigo} — ${u.nome}` }))} vazio="Selecione" />
            <Entrada rotulo="Origem" valor={form.origem} aoMudar={mudar('origem')} placeholder="Brasil, Chile, Turquia…" />
            <Entrada rotulo="Estoque minimo" tipo="number" valor={form.estoque_minimo} aoMudar={mudar('estoque_minimo')} />
            <Entrada rotulo="Estoque de seguranca" tipo="number" valor={form.estoque_seguranca} aoMudar={mudar('estoque_seguranca')} />
            <Entrada rotulo="Ponto de pedido" tipo="number" valor={form.ponto_pedido} aoMudar={mudar('ponto_pedido')} />
            <Entrada rotulo="Lead time (dias)" tipo="number" valor={form.lead_time_padrao_dias} aoMudar={mudar('lead_time_padrao_dias')} />
            <Selecao rotulo="Produto importado" valor={form.produto_importado} aoMudar={mudar('produto_importado')}
              vazio={null} opcoes={[{ valor: 'false', texto: 'Nao' }, { valor: 'true', texto: 'Sim' }]} />
          </div>
        </Modal>
      )}
    </>
  );
}
