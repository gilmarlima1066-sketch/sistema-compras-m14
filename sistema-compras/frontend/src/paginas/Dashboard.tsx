import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ErroApi } from '../api/client';
import type { Dashboard as DadosDashboard } from '../api/tipos';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { Aviso, Cartao, Etiqueta, Indicador, Vazio, dataHora, moeda, numero } from '../componentes/ui';

export function Dashboard() {
  const [dados, setDados] = useState<DadosDashboard | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    api<DadosDashboard>('/dashboard')
      .then(({ data }) => setDados(data))
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar o painel'))
      .finally(() => setCarregando(false));
  }, []);

  if (carregando) return <div className="carregando">Carregando indicadores…</div>;
  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return null;

  const i = dados.indicadores;

  return (
    <>
      <CabecalhoPagina
        titulo="Painel de suprimentos"
        descricao="Todos os numeros abaixo vem da API, calculados sobre os dados do banco."
      />

      <div className="grade-indicadores">
        <Indicador rotulo="Produtos cadastrados" valor={numero(i.produtos_cadastrados)} nota={`${numero(i.produtos_ativos)} ativos`} tom="acento" />
        <Indicador rotulo="Fornecedores ativos" valor={numero(i.fornecedores_ativos)} tom="acento" />
        <Indicador rotulo="Estoque total" valor={numero(i.estoque_total, 2)} nota="soma da quantidade fisica" />
        <Indicador rotulo="Em ruptura" valor={numero(i.produtos_em_ruptura)} nota="sem estoque disponivel" tom="perigo" />
        <Indicador rotulo="Abaixo do minimo" valor={numero(i.produtos_abaixo_minimo)} tom="alerta" />
        <Indicador rotulo="No ponto de pedido" valor={numero(i.produtos_ponto_pedido)} tom="alerta" />
        <Indicador rotulo="Compras em aberto" valor={numero(i.compras_em_aberto)} nota={moeda(i.valor_em_aberto)} tom="info" />
        <Indicador rotulo="Entregas atrasadas" valor={numero(i.entregas_atrasadas)} tom="perigo" />
        <Indicador rotulo="Alertas criticos" valor={numero(i.alertas_criticos)} nota={`${numero(i.alertas_abertos)} abertos`} tom="perigo" />
        <Indicador rotulo="Lotes vencendo" valor={numero(i.lotes_validade_proxima)} nota="dentro da janela configurada" tom="alerta" />
        <Indicador rotulo="Excesso de estoque" valor={numero(i.produtos_excesso)} tom="info" />
      </div>

      <div className="colunas">
        <Cartao
          titulo="Produtos que exigem atencao"
          acoes={<Link className="botao botao--pequeno" to="/estoque">Ver estoque</Link>}
          semCorpo
        >
          <div className="tabela-wrap">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Produto</th>
                  <th className="dir">Disponivel</th>
                  <th className="dir">Cobertura</th>
                  <th>Situacao</th>
                </tr>
              </thead>
              <tbody>
                {dados.produtos_criticos.map((p) => (
                  <tr key={p.produto_id}>
                    <td className="codigo">{p.codigo}</td>
                    <td>{p.descricao}</td>
                    <td className="dir num">{numero(p.estoque_disponivel, 2)}</td>
                    <td className="dir num">{p.cobertura_dias === null ? '—' : `${numero(p.cobertura_dias, 1)} d`}</td>
                    <td><Etiqueta texto={p.situacao} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dados.produtos_criticos.length === 0 && <Vazio>Nenhum produto fora dos parametros.</Vazio>}
          </div>
        </Cartao>

        <Cartao titulo="Alertas abertos" semCorpo>
          <div className="tabela-wrap">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Severidade</th>
                  <th>Alerta</th>
                  <th>Gerado em</th>
                </tr>
              </thead>
              <tbody>
                {dados.alertas_recentes.map((a) => (
                  <tr key={a.id}>
                    <td><Etiqueta texto={a.severidade} /></td>
                    <td>
                      <div>{a.mensagem}</div>
                      <div style={{ fontSize: 11, color: 'var(--texto-3)' }}>{a.tipo.replace(/_/g, ' ')}</div>
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dataHora(a.data_geracao)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dados.alertas_recentes.length === 0 && <Vazio>Nenhum alerta aberto.</Vazio>}
          </div>
        </Cartao>
      </div>
    </>
  );
}
