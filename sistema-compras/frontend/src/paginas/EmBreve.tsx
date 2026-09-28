/**
 * Placeholder dos modulos que serao construidos nas proximas etapas.
 * A rota ja existe para que a navegacao reflita o produto final, mas a tela
 * deixa claro que nao ha funcionalidade por tras dela ainda.
 */
export function EmBreve({ titulo, descricao }: { titulo: string; descricao: string }) {
  return (
    <div className="futuro">
      <div className="futuro__caixa">
        <div className="futuro__selo">PROXIMA ETAPA</div>
        <h2>{titulo}</h2>
        <p>{descricao}</p>
      </div>
    </div>
  );
}
