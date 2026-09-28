import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

interface Item {
  rotulo: string;
  icone: string;
  caminho: string;
  futuro?: boolean;
}

/** Sidebar completa do sistema. Os modulos ainda nao construidos aparecem
 *  como placeholder para que a navegacao ja reflita o produto final. */
const MENU: Array<{ grupo: string; itens: Item[] }> = [
  {
    grupo: 'Visao geral',
    itens: [{ rotulo: 'Dashboard', icone: '▤', caminho: '/' }],
  },
  {
    grupo: 'Operacao',
    itens: [
      { rotulo: 'Estoque', icone: '▦', caminho: '/estoque' },
      { rotulo: 'Demanda', icone: '◷', caminho: '/demanda' },
      { rotulo: 'Compras', icone: '⇄', caminho: '/compras' },
      { rotulo: 'Cotacoes', icone: '≡', caminho: '/cotacoes' },
      { rotulo: 'Negociacao e Pedidos', icone: '⌸', caminho: '/ordens-compra' },
      { rotulo: 'Entregas', icone: '⇥', caminho: '/entregas' },
      { rotulo: 'Recebimentos', icone: '⇲', caminho: '/recebimentos' },
    ],
  },
  {
    grupo: 'Cadastros',
    itens: [
      { rotulo: 'Produtos', icone: '◧', caminho: '/produtos' },
      { rotulo: 'Fornecedores', icone: '◎', caminho: '/fornecedores' },
    ],
  },
  {
    grupo: 'Gestao',
    itens: [
      { rotulo: 'Avaliacao de fornecedores', icone: '★', caminho: '/avaliacao-fornecedores' },
      { rotulo: 'Qualidade', icone: '✓', caminho: '/qualidade' },
      { rotulo: 'Financeiro', icone: '¤', caminho: '/financeiro', futuro: true },
      { rotulo: 'Indicadores', icone: '◪', caminho: '/indicadores' },
      { rotulo: 'Alertas', icone: '!', caminho: '/alertas' },
      { rotulo: 'Assistente IA', icone: '✧', caminho: '/assistente-ia' },
      { rotulo: 'Tarefas e aprovacoes', icone: '☑', caminho: '/tarefas' },
    ],
  },
  {
    grupo: 'Sistema',
    itens: [
      { rotulo: 'Integracoes', icone: '⇄', caminho: '/integracoes' },
      { rotulo: 'Centro de operacoes', icone: '◬', caminho: '/operacao' },
      { rotulo: 'Usuarios', icone: '☖', caminho: '/usuarios' },
      { rotulo: 'Configuracoes', icone: '⚙', caminho: '/configuracoes', futuro: true },
    ],
  },
];

const TITULOS: Record<string, string> = {
  '/': 'Dashboard',
  '/estoque': 'Estoque',
  '/produtos': 'Produtos',
  '/fornecedores': 'Fornecedores',
  '/avaliacao-fornecedores': 'Avaliacao de fornecedores',
  '/indicadores': 'Indicadores e dashboards',
  '/alertas': 'Central de alertas',
  '/assistente-ia': 'Inteligencia artificial',
  '/usuarios': 'Usuarios',
};

export function Layout() {
  const { usuario, sair } = useAuth();
  const local = useLocation();
  const [menuAberto, setMenuAberto] = useState(false);

  const titulo = TITULOS[local.pathname]
    ?? MENU.flatMap((g) => g.itens).find((i) => i.caminho === local.pathname)?.rotulo
    ?? 'Sistema de Compras';

  return (
    <div className="app">
      <aside className={`sidebar${menuAberto ? ' sidebar--aberta' : ''}`}>
        <div className="sidebar__marca">
          <div className="sidebar__sigla">SC</div>
          <div>
            <div className="sidebar__titulo">Suprimentos</div>
            <div className="sidebar__sub">Compras &amp; Estoque</div>
          </div>
        </div>
        <nav>
          {MENU.map((grupo) => (
            <div key={grupo.grupo}>
              <div className="sidebar__grupo">{grupo.grupo}</div>
              {grupo.itens.map((item) => (
                <NavLink
                  key={item.caminho}
                  to={item.caminho}
                  end={item.caminho === '/'}
                  onClick={() => setMenuAberto(false)}
                  className={({ isActive }) =>
                    `sidebar__item${isActive ? ' sidebar__item--ativo' : ''}${item.futuro ? ' sidebar__item--futuro' : ''}`
                  }
                >
                  <span className="sidebar__icone">{item.icone}</span>
                  {item.rotulo}
                  {item.futuro && <span className="sidebar__tag">EM BREVE</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="conteudo">
        <header className="topbar">
          <button type="button" className="botao botao--pequeno botao--menu" onClick={() => setMenuAberto((v) => !v)}>
            Menu
          </button>
          <h1 className="topbar__titulo">{titulo}</h1>
          <div className="topbar__dir">
            <div className="topbar__usuario">
              <strong>{usuario?.nome}</strong>
              <span>{usuario?.perfil}</span>
            </div>
            <button type="button" className="botao botao--pequeno" onClick={sair}>Sair</button>
          </div>
        </header>
        <main className="pagina">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
