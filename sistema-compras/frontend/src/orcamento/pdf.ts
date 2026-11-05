/**
 * PDF do orcamento no layout do pedido do ERP: logo e dados da empresa no
 * topo, fornecedor, itens com impostos, condicoes gerais e totais.
 * Gerado no navegador (jsPDF): o arquivo sai pronto para compartilhar.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface Empresa {
  razao_social?: string; endereco?: string; bairro?: string; cidade?: string; cep?: string;
  cnpj?: string; telefone?: string; site?: string; email?: string; departamento?: string;
}

export interface FornecedorOrcamento {
  codigo_erp?: string; nome?: string; endereco?: string; bairro?: string; cidade?: string;
  estado?: string; cep?: string; cnpj?: string; inscricao?: string; contato?: string;
  email?: string; fones?: string; whatsapp?: string;
}

export interface ItemPdf {
  produto_codigo: string; descricao: string; unidade: string | null;
  quantidade: number; preco_unitario: number; desconto: number; st_valor: number;
  ipi_pct: number; icms_pct: number; pis_pct: number; cofins_pct: number;
}

export interface OrcamentoPdf {
  numero: number | null;
  data_emissao: string;
  tipo_operacao: string;
  fornecedor: FornecedorOrcamento;
  condicao_pagamento: string; data_entrega: string; transportadora: string; observacoes: string;
  desconto: number; frete: number; comprador: string;
  itens: ItemPdf[];
  totais: {
    mercadorias: number; ipi: number; st: number; icms: number; pis: number; cofins: number;
    impostos: number; pedido: number;
  };
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro'];

const br = (v: number, casas = 2) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const pct = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const qtd = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const dataBr = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

async function carregarLogo(): Promise<string | null> {
  try {
    const r = await fetch('/marca/logo-empresa.jpg');
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise((ok) => {
      const leitor = new FileReader();
      leitor.onload = () => ok(String(leitor.result));
      leitor.onerror = () => ok(null);
      leitor.readAsDataURL(b);
    });
  } catch {
    return null;
  }
}

export async function gerarPdf(o: OrcamentoPdf, empresa: Empresa): Promise<Blob> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 12; const R = 198; // margens
  const azul: [number, number, number] = [20, 40, 200];
  const logo = await carregarLogo();

  // ---------------------------------------------------------------- topo
  if (logo) doc.addImage(logo, 'JPEG', L + 4, 9, 52, 19.8);
  doc.setDrawColor(0); doc.setLineWidth(0.2);
  doc.line(105, 6, 105, 42);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const xE = 108;
  doc.text(empresa.razao_social ?? '', xE, 11);
  doc.text(empresa.endereco ?? '', xE, 15.5);
  doc.text(empresa.bairro ?? '', xE, 20);
  doc.text(empresa.cidade ?? '', xE, 24.5);
  doc.text(`CEP: ${empresa.cep ?? ''}`, 152, 24.5);
  doc.text(`CNPJ: ${empresa.cnpj ?? ''}`, xE, 29);
  doc.text(`Fone: ${empresa.telefone ?? ''}`, 152, 29);
  const d = o.data_emissao;
  doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(8.5);
  doc.text(`${(empresa.cidade ?? '').toUpperCase()}, ${d.slice(8, 10)} de ${MESES[Number(d.slice(5, 7)) - 1]} de ${d.slice(0, 4)}`,
    R, 37, { align: 'right' });
  doc.line(L, 42, R, 42);

  // ----------------------------------------------------------- fornecedor
  const f = o.fornecedor;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const rotulo = (t: string, x: number, y: number, v: string, xv: number) => {
    doc.text(t, x, y); doc.text(v ?? '', xv, y);
  };
  rotulo('Nome:', 16, 48, `${f.codigo_erp ? `${f.codigo_erp} - ` : ''}${f.nome ?? ''}`, 29);
  rotulo('End.:', 16, 52.5, f.endereco ?? '', 29);
  rotulo('Bairro:', 16, 57, f.bairro ?? '', 29);
  rotulo('Cidade:', 16, 61.5, f.cidade ?? '', 29);
  rotulo('CNPJ:', 16, 66, f.cnpj ?? '', 29);
  rotulo('CEP:', 105, 57, f.cep ?? '', 118);
  rotulo('Estado:', 105, 61.5, f.estado ?? '', 118);
  rotulo('Inscr.', 105, 66, f.inscricao ?? '', 118);
  doc.setFont('helvetica', 'italic');
  doc.text(`A/C ${f.contato || '.'} / Email: ${f.email ?? ''} / Fones: ${f.fones ?? ''}`, 16, 73);
  doc.line(L, 76, R, 76);
  doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(9);
  doc.text(`Orçamento No. ${o.numero ?? ''}`, 16, 81);
  doc.setTextColor(...azul);
  doc.text(`Tipo Operação: ${o.tipo_operacao}`, R, 81, { align: 'right' });
  doc.setTextColor(0);

  // ---------------------------------------------------------------- itens
  autoTable(doc, {
    startY: 84,
    margin: { left: L, right: 210 - R },
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 0.8, right: 0.8 }, textColor: 0 },
    headStyles: { fontStyle: 'normal', fontSize: 6.8, lineWidth: { bottom: 0.2 }, lineColor: 0, overflow: 'visible' },
    head: [['Código Item', 'Descrição', 'Unid.', 'Qtde', 'Val. Un.', 'Desc.', 'ST', 'IPI%', 'ICMS%', 'PIS%', 'COFINS%', 'Valor Total']],
    body: o.itens.map((i) => [
      i.produto_codigo, i.descricao, i.unidade ?? '', qtd(i.quantidade), br(i.preco_unitario),
      br(i.desconto), br(i.st_valor), pct(i.ipi_pct), pct(i.icms_pct), pct(i.pis_pct), pct(i.cofins_pct),
      br(Math.max(0, i.quantidade * i.preco_unitario - i.desconto)),
    ]),
    columnStyles: {
      0: { cellWidth: 14 }, 1: { cellWidth: 'auto' }, 2: { halign: 'center', cellWidth: 9 },
      3: { halign: 'right', cellWidth: 10 }, 4: { halign: 'right', cellWidth: 14 },
      5: { halign: 'right', cellWidth: 10 }, 6: { halign: 'right', cellWidth: 10 },
      7: { halign: 'center', cellWidth: 8.5 }, 8: { halign: 'center', cellWidth: 10.5 },
      9: { halign: 'center', cellWidth: 8.5 }, 10: { halign: 'center', cellWidth: 12.5 },
      11: { halign: 'right', cellWidth: 17 },
    },
    didParseCell: (c) => {
      if (c.section === 'head' && [3, 4, 5, 6, 11].includes(c.column.index)) c.cell.styles.halign = 'right';
      if (c.section === 'head' && [2, 7, 8, 9, 10].includes(c.column.index)) c.cell.styles.halign = 'center';
    },
  });

  // ---------------------------------------------- condicoes e totais
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 1;
  if (y > 230) { doc.addPage(); y = 15; }
  doc.line(L, y, R, y);
  y += 5;
  const yTopo = y;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('CONDIÇÕES GERAIS:', 16, y);
  doc.line(16, y + 0.8, 16 + doc.getTextWidth('CONDIÇÕES GERAIS:'), y + 0.8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const cond = [
    ['- Condições de Pagamento', o.condicao_pagamento],
    ['- Data Prevista de Entrega', dataBr(o.data_entrega)],
    ['- Transportadora', o.transportadora],
  ];
  cond.forEach(([t, v], k) => {
    doc.text(t!, 16, y + 5 + k * 4.5);
    doc.text(`:  ${v ?? ''}`, 52, y + 5 + k * 4.5);
  });
  let yObs = y + 5 + cond.length * 4.5 + 3;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('OBSERVAÇÕES:', 16, yObs);
  doc.line(16, yObs + 0.8, 16 + doc.getTextWidth('OBSERVAÇÕES:'), yObs + 0.8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const obs = doc.splitTextToSize(o.observacoes || '', 105) as string[];
  doc.text(obs, 16, yObs + 5);
  yObs += 5 + obs.length * 4;

  const t = o.totais;
  const linhasTotal: Array<[string, number]> = [
    ['Total Mercadorias :', t.mercadorias], ['Desconto :', o.desconto], ['Frete :', o.frete],
    ['IPI :', t.ipi], ['ICMS-ST :', t.st], ['ICMS :', t.icms], ['PIS :', t.pis], ['COFINS :', t.cofins],
  ];
  linhasTotal.forEach(([rot, v], k) => {
    doc.text(rot, 168, yTopo + k * 4.6, { align: 'right' });
    doc.text(br(v), R, yTopo + k * 4.6, { align: 'right' });
  });
  let yTot = yTopo + linhasTotal.length * 4.6;
  doc.setFont('helvetica', 'italic');
  doc.text('Total de impostos :', 168, yTot, { align: 'right' });
  doc.text(br(t.impostos), R, yTot, { align: 'right' });
  yTot += 12;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('Total Pedido :', 168, yTot, { align: 'right' });
  doc.text(br(t.pedido), R, yTot, { align: 'right' });

  let yAss = Math.max(yObs, yTot) + 10;
  if (yAss > 270) { doc.addPage(); yAss = 20; }
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8);
  doc.text(['Atenciosamente,', (o.comprador || '').toUpperCase(), empresa.departamento ?? 'Departamento de Compras'], 16, yAss);

  // -------------------------------------------------------------- rodape
  const paginas = doc.getNumberOfPages();
  const hoje = new Date();
  const rel = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5);
    doc.text(`Rel. ${rel}`, 16, 283);
    doc.text(`Pág.${p} de ${paginas}`, R, 283, { align: 'right' });
    doc.line(L, 285, R, 285);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(empresa.site ?? '', 16, 289);
    doc.text(empresa.email ?? '', R, 289, { align: 'right' });
  }
  return doc.output('blob');
}

/** "( 54 )3358-1498" -> "555433581498". Sem DDD nao ha como montar o link. */
export function telefoneWhatsApp(valor: string | undefined): string | null {
  const d = (valor ?? '').split(/[;/]/)[0]!.replace(/\D/g, '');
  if (d.length === 12 || d.length === 13) return d.startsWith('55') ? d : null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return null;
}

/**
 * No celular, abre o compartilhamento do sistema com o PDF anexado (escolha o
 * WhatsApp). No computador o navegador nao anexa arquivo ao WhatsApp: o PDF e
 * baixado e a conversa com o fornecedor e aberta, para arrastar o arquivo.
 */
export async function enviarWhatsApp(pdf: Blob, nomeArquivo: string, telefone: string | null, mensagem: string) {
  const arquivo = new File([pdf], nomeArquivo, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [arquivo] })) {
    try {
      await nav.share({ files: [arquivo], text: mensagem, title: nomeArquivo });
      return 'compartilhado' as const;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelado' as const;
    }
  }
  baixar(pdf, nomeArquivo);
  const url = telefone
    ? `https://wa.me/${telefone}?text=${encodeURIComponent(mensagem)}`
    : `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
  window.open(url, '_blank', 'noopener');
  return 'baixado' as const;
}

export function baixar(pdf: Blob, nomeArquivo: string) {
  const url = URL.createObjectURL(pdf);
  const a = document.createElement('a');
  a.href = url; a.download = nomeArquivo;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
