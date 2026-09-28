import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ErroApi } from '../api/client';
import { Aviso, Entrada } from '../componentes/ui';

export function Login() {
  const { usuario, entrar, carregando } = useAuth();
  const navegar = useNavigate();
  const local = useLocation() as { state?: { de?: string } };
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (carregando) return <div className="carregando">Carregando…</div>;
  if (usuario) return <Navigate to={local.state?.de ?? '/'} replace />;

  async function enviar() {
    setErro(null);
    setEnviando(true);
    try {
      await entrar(email.trim(), senha);
      navegar(local.state?.de ?? '/', { replace: true });
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Nao foi possivel entrar');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <section className="login__arte">
        <div className="sidebar__sigla" style={{ width: 36, height: 36 }}>SC</div>
        <h1>Gestao de compras e estoque</h1>
        <p>
          Plataforma para distribuicao e importacao de graos, cereais, frutas secas e
          ingredientes naturais — do cadastro de fornecedores ao recebimento.
        </p>
        <ul className="login__lista">
          <li>Posicao de estoque e cobertura por SKU</li>
          <li>Fornecedores nacionais e internacionais</li>
          <li>Cotacoes, ordens de compra e recebimento</li>
          <li>Trilha de auditoria de ponta a ponta</li>
        </ul>
      </section>

      <section className="login__painel">
        <div className="login__caixa">
          <h2>Entrar</h2>
          <p className="ajuda">Acesso restrito aos usuarios cadastrados.</p>

          {erro && <Aviso>{erro}</Aviso>}

          <form
            className="login__form"
            onSubmit={(e) => { e.preventDefault(); void enviar(); }}
          >
            <Entrada rotulo="E-mail" tipo="email" valor={email} aoMudar={setEmail} placeholder="voce@empresa.com.br" />
            <Entrada rotulo="Senha" tipo="password" valor={senha} aoMudar={setSenha} placeholder="••••••••" />
            <button type="submit" className="botao botao--primario" disabled={enviando || !email || !senha}>
              {enviando ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <p className="login__dica">
            Ambiente de desenvolvimento: <strong>admin@empresa.com.br</strong> / <strong>Admin@123</strong>
          </p>
        </div>
      </section>
    </div>
  );
}
