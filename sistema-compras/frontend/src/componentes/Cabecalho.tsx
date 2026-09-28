import type { ReactNode } from 'react';

export function CabecalhoPagina({ titulo, descricao, acoes }: {
  titulo: string; descricao?: string; acoes?: ReactNode;
}) {
  return (
    <div className="pagina__cabecalho">
      <div>
        <h2>{titulo}</h2>
        {descricao && <p>{descricao}</p>}
      </div>
      {acoes && <div className="pagina__acoes">{acoes}</div>}
    </div>
  );
}
