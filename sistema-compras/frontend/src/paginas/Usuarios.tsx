import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { Perfil, Usuario } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, EtiquetaAtivo, Modal, Paginacao, Selecao, Vazio, dataHora, numero,
} from '../componentes/ui';

const FORM_VAZIO = { nome: '', email: '', senha: '', perfil_id: '', ativo: 'true' };

interface PerfilComContagem extends Perfil {
  usuarios: number;
  permissoes: string[];
}

export function Usuarios() {
  const { pode, usuario: eu } = useAuth();
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro, recarregar } =
    useLista<Usuario>('/usuarios', { pagina, limite: 25, busca });

  const [perfis, setPerfis] = useState<PerfilComContagem[]>([]);
  const [erroPerfis, setErroPerfis] = useState<string | null>(null);

  // Os perfis alimentam tanto o formulario quanto o painel da matriz de acesso.
  useEffect(() => {
    api<PerfilComContagem[]>('/usuarios/perfis')
      .then(({ data }) => setPerfis(data))
      .catch((e) => setErroPerfis(e instanceof ErroApi ? e.message : 'Falha ao carregar os perfis'));
  }, []);

  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState({ ...FORM_VAZIO });
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Array<{ campo?: string; mensagem: string }>>([]);
  const [salvando, setSalvando] = useState(false);
  const [acaoEmCurso, setAcaoEmCurso] = useState<number | null>(null);

  const mudar = (campo: keyof typeof FORM_VAZIO) => (valor: string) => setForm((f) => ({ ...f, [campo]: valor }));

  function abrirNovo() {
    setForm({ ...FORM_VAZIO, perfil_id: String(perfis[0]?.id ?? '') });
    setErroForm(null);
    setDetalhes([]);
    setAberto(true);
  }

  async function salvar() {
    setErroForm(null);
    setDetalhes([]);
    setSalvando(true);
    try {
      await api('/usuarios', {
        metodo: 'POST',
        corpo: {
          nome: form.nome,
          email: form.email,
          senha: form.senha,
          perfil_id: Number(form.perfil_id),
          ativo: form.ativo === 'true',
        },
      });
      setAberto(false);
      setForm({ ...FORM_VAZIO });
      await recarregar();
    } catch (e) {
      if (e instanceof ErroApi) { setErroForm(e.message); setDetalhes(e.detalhes); }
      else setErroForm('Nao foi possivel salvar o usuario');
    } finally {
      setSalvando(false);
    }
  }

  /** Ativar/desativar e a acao mais comum aqui — vale ter na propria linha. */
  async function alternarAtivo(u: Usuario) {
    setAcaoEmCurso(u.id);
    try {
      await api(`/usuarios/${u.id}`, { metodo: 'PUT', corpo: { ativo: !u.ativo } });
      await recarregar();
    } catch {
      // O erro ja aparece na proxima carga da lista; nada a fazer aqui.
    } finally {
      setAcaoEmCurso(null);
    }
  }

  return (
    <>
      <CabecalhoPagina
        titulo="Usuarios"
        descricao="Contas de acesso e perfis de permissao. Quem decide o que cada perfil pode fazer e o backend."
        acoes={pode('usuarios.criar') && (
          <button type="button" className="botao botao--primario" onClick={abrirNovo}>
            Novo usuario
          </button>
        )}
      />

      <div className="filtros">
        <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
          placeholder="nome ou e-mail" className="campo--busca" />
      </div>

      {erro && <Aviso>{erro}</Aviso>}

      <Cartao semCorpo>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Perfil</th>
                <th>Ultimo acesso</th>
                <th>Situacao</th>
                <th className="dir">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.nome}
                    {u.id === eu?.id && <span className="sidebar__tag" style={{ marginLeft: 6 }}>VOCE</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>{u.perfil}</td>
                  <td className="num">{dataHora(u.ultimo_login)}</td>
                  <td><EtiquetaAtivo ativo={u.ativo} /></td>
                  <td className="dir">
                    {pode('usuarios.editar') && u.id !== eu?.id && (
                      <button
                        type="button"
                        className={`botao botao--pequeno${u.ativo ? ' botao--perigo' : ''}`}
                        disabled={acaoEmCurso === u.id}
                        onClick={() => void alternarAtivo(u)}
                      >
                        {u.ativo ? 'Desativar' : 'Reativar'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {carregando && <div className="carregando">Carregando usuarios…</div>}
          {!carregando && itens.length === 0 && <Vazio>Nenhum usuario encontrado.</Vazio>}
        </div>
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      <Cartao titulo="Perfis de acesso" semCorpo>
        {erroPerfis && <div className="cartao__corpo"><Aviso>{erroPerfis}</Aviso></div>}
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Perfil</th>
                <th>Descricao</th>
                <th className="dir">Usuarios</th>
                <th className="dir">Permissoes</th>
              </tr>
            </thead>
            <tbody>
              {perfis.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome}</td>
                  <td>{p.descricao ?? '—'}</td>
                  <td className="dir num">{numero(p.usuarios)}</td>
                  <td className="dir num">{numero(p.permissoes.length)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {perfis.length === 0 && !erroPerfis && <div className="carregando">Carregando perfis…</div>}
        </div>
      </Cartao>

      {aberto && (
        <Modal
          titulo="Novo usuario"
          aoFechar={() => setAberto(false)}
          rodape={(
            <>
              <button type="button" className="botao" onClick={() => setAberto(false)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={salvando} onClick={() => void salvar()}>
                {salvando ? 'Salvando…' : 'Criar usuario'}
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
            <Entrada rotulo="Nome" valor={form.nome} aoMudar={mudar('nome')} className="col-2" />
            <Entrada rotulo="E-mail" tipo="email" valor={form.email} aoMudar={mudar('email')} />
            <Entrada rotulo="Senha" tipo="password" valor={form.senha} aoMudar={mudar('senha')}
              placeholder="minimo 8 caracteres" />
            <Selecao rotulo="Perfil" valor={form.perfil_id} aoMudar={mudar('perfil_id')} vazio={null}
              opcoes={perfis.map((p) => ({ valor: String(p.id), texto: p.nome }))} />
            <Selecao rotulo="Situacao" valor={form.ativo} aoMudar={mudar('ativo')} vazio={null}
              opcoes={[{ valor: 'true', texto: 'Ativo' }, { valor: 'false', texto: 'Inativo' }]} />
          </div>
        </Modal>
      )}
    </>
  );
}
