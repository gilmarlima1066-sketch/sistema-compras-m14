import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RotaProtegida } from './auth/RotaProtegida';
import { Layout } from './componentes/Layout';
import { Login } from './paginas/Login';
import { Dashboard } from './paginas/Dashboard';
import { Estoque } from './paginas/Estoque';
import { Produtos } from './paginas/Produtos';
import { Fornecedores } from './paginas/Fornecedores';
import { Usuarios } from './paginas/Usuarios';
import { EmBreve } from './paginas/EmBreve';
import { Demanda } from './paginas/Demanda';
import { Compras } from './paginas/Compras';
import { GestaoCompras } from './paginas/GestaoCompras';
import { Cotacoes } from './paginas/Cotacoes';
import { Negociacoes } from './paginas/Negociacoes';
import { Entregas } from './paginas/Entregas';
import { Recebimento } from './paginas/Recebimento';
import { Avaliacao } from './paginas/Avaliacao';
import { Indicadores } from './paginas/Indicadores';
import { Alertas } from './paginas/Alertas';
import { Ia } from './paginas/Ia';
import { Tarefas } from './paginas/Tarefas';
import { Operacao } from './paginas/Operacao';
import { Integracoes } from './paginas/Integracoes';

/** Modulos ja mapeados na sidebar que entram nas proximas etapas. */
const FUTUROS: Array<{ caminho: string; titulo: string; descricao: string }> = [
  {
    caminho: 'financeiro',
    titulo: 'Financeiro',
    descricao: 'Compromissos de compra, condicoes de pagamento e desembolso previsto.',
  },
  {
    caminho: 'configuracoes',
    titulo: 'Configuracoes',
    descricao: 'Parametros do sistema: limites ABC/XYZ, tolerancias de recebimento e pesos do score.',
  },
];

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={(
              <RotaProtegida>
                <Layout />
              </RotaProtegida>
            )}
          >
            <Route index element={<Dashboard />} />
            <Route path="estoque" element={<Estoque />} />
            <Route path="produtos" element={<Produtos />} />
            <Route path="fornecedores" element={<Fornecedores />} />
            <Route path="demanda" element={<Demanda />} />
            <Route path="gestao-compras" element={<GestaoCompras />} />
            <Route path="compras" element={<Compras />} />
            <Route path="cotacoes" element={<Cotacoes />} />
            <Route path="ordens-compra" element={<Negociacoes />} />
            <Route path="entregas" element={<Entregas />} />
            <Route path="recebimentos" element={<Recebimento />} />
            <Route path="qualidade" element={<Recebimento />} />
            <Route path="avaliacao-fornecedores" element={<Avaliacao />} />
            <Route path="indicadores" element={<Indicadores />} />
            <Route path="alertas" element={<Alertas />} />
            <Route path="assistente-ia" element={<Ia />} />
            <Route path="tarefas" element={<Tarefas />} />
            <Route path="aprovacoes" element={<Tarefas />} />
            <Route path="operacao" element={<Operacao />} />
            <Route path="integracoes" element={<Integracoes />} />
            <Route path="usuarios" element={<Usuarios />} />
            {FUTUROS.map((m) => (
              <Route
                key={m.caminho}
                path={m.caminho}
                element={<EmBreve titulo={m.titulo} descricao={m.descricao} />}
              />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
