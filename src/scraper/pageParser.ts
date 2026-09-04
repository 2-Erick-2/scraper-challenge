import * as cheerio from 'cheerio';
import { ProcessoItem, DocumentoItem } from '../types';

/**
 * Parser basado en Cheerio para extraer información estructurada
 * de vistas JSF/JBoss Seam de sistemas judiciales PJe.
 */
export class PageParser {
  /**
   * Extrae el token de estado de JSF (javax.faces.ViewState).
   * Esencial para poder enviar peticiones POST válidas (búsqueda y paginación).
   */
  public static extractViewState(html: string): string | null {
    if (!html) return null;

    // Caso 1: Input oculto en formulario HTML estándar
    const $ = cheerio.load(html);
    const viewStateInput = $('input[name="javax.faces.ViewState"]').val();
    if (viewStateInput && typeof viewStateInput === 'string') {
      return viewStateInput;
    }

    // Caso 2: Respuesta parcial AJAX de JSF (<update id="javax.faces.ViewState">...)
    const ajaxMatch = html.match(/<update\s+id=["']javax\.faces\.ViewState["'][^>]*><!\[CDATA\[(.*?)\]\]><\/update>/i);
    if (ajaxMatch && ajaxMatch[1]) {
      return ajaxMatch[1];
    }

    // Caso 3: Búsqueda mediante regex directo como fallback
    const regexMatch = html.match(/name=["']javax\.faces\.ViewState["']\s+value=["']([^"']+)["']/i);
    if (regexMatch && regexMatch[1]) {
      return regexMatch[1];
    }

    return null;
  }

  /**
   * Extrae la lista de procesos y documentos asociados desde la tabla de resultados.
   */
  public static parseProcessList(html: string, baseUrl: string): ProcessoItem[] {
    const $ = cheerio.load(html);
    const processos: ProcessoItem[] = [];

    // Selectores típicos de tablas en PJe / RichFaces / JSF
    const rows = $('table.rich-table tbody tr, table.table-striped tbody tr, table[id*="Processo"] tbody tr, table tbody tr');

    rows.each((_, element) => {
      const row = $(element);
      const cells = row.find('td');

      if (cells.length < 2) return;

      const rowText = row.text().trim();
      // Regex oficial del formato único de proceso judicial en Brasil (CNJ)
      const cnjRegex = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
      const matchCnj = rowText.match(cnjRegex);

      const numeroProcesso = matchCnj
        ? matchCnj[0]
        : cells.first().text().trim().replace(/\s+/g, ' ');

      if (!numeroProcesso || numeroProcesso.length < 5) return;

      // Buscar enlaces a detalles o documentos directos (tanto en href como en onclick)
      const links = row.find('a, button, input[type="button"]');
      const documentos: DocumentoItem[] = [];
      let detalheUrl: string | undefined;

      links.each((__, linkEl) => {
        const link = $(linkEl);
        const href = link.attr('href') || '';
        const onclick = link.attr('onclick') || '';
        const linkText = link.text().trim();

        // Extraer URL objetivo de href o del handler openPopUp(...)
        let targetUrl = '';
        if (href && href !== '#' && !href.startsWith('javascript:void')) {
          targetUrl = href;
        } else if (onclick) {
          const popUpMatch = onclick.match(/openPopUp\([^,]+,\s*['"]([^'"]+)['"]/i);
          if (popUpMatch && popUpMatch[1]) {
            targetUrl = popUpMatch[1];
          } else {
            const urlMatch = onclick.match(/['"](\/[^'"]+|\bhttps?:\/\/[^'"]+)['"]/i);
            if (urlMatch && urlMatch[1]) {
              targetUrl = urlMatch[1];
            }
          }
        }

        if (!targetUrl) return;

        const resolvedUrl = this.resolveUrl(targetUrl, baseUrl);

        // Identificar si es un documento descargable (PDF, documentoHTML o servlet)
        const isDoc =
          targetUrl.includes('documentoHTML') ||
          targetUrl.includes('idProcessoDoc') ||
          targetUrl.includes('idBin') ||
          targetUrl.includes('reportPDF') ||
          targetUrl.includes('reportReciboPDF') ||
          targetUrl.includes('download') ||
          targetUrl.endsWith('.pdf') ||
          linkText.toLowerCase().includes('pdf');

        if (isDoc) {
          const docIdMatch =
            targetUrl.match(/idProcessoDocumento=(\d+)/i) ||
            targetUrl.match(/idProcessoDoc=(\d+)/i) ||
            targetUrl.match(/idBin=(\d+)/i) ||
            targetUrl.match(/idProcessoTrf=(\d+)/i) ||
            targetUrl.match(/id=(\d+)/i);

          const idDocumento = docIdMatch ? docIdMatch[1] : `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

          documentos.push({
            idDocumento,
            titulo: linkText || `Documento_${idDocumento}`,
            tipo: 'PDF/Documento',
            url: resolvedUrl,
            status: 'pending'
          });
        } else if (!detalheUrl && (targetUrl.includes('DetalheProcessoConsultaPublica') || targetUrl.includes('detalhe') || targetUrl.includes('processo'))) {
          detalheUrl = resolvedUrl;
        }
      });

      // Extraer datos de las columnas restantes
      const classeJudicial = cells.eq(1).text().trim().replace(/\s+/g, ' ') || undefined;
      const orgaoJulgador = cells.eq(2).text().trim().replace(/\s+/g, ' ') || undefined;
      const dataDistribuicao = cells.eq(3).text().trim().replace(/\s+/g, ' ') || undefined;

      processos.push({
        numeroProcesso,
        classeJudicial,
        orgaoJulgador,
        dataDistribuicao,
        detalheUrl,
        documentos
      });
    });

    return processos;
  }

  /**
   * Extrae la lista detallada de documentos dentro de la vista de un proceso.
   */
  public static parseDocumentDetails(html: string, baseUrl: string, numeroProcesso: string): DocumentoItem[] {
    const $ = cheerio.load(html);
    const documentos: DocumentoItem[] = [];
    const seenUrls = new Set<string>();

    const candidateElements = $('a, button, input[type="button"]');

    candidateElements.each((_, el) => {
      const element = $(el);
      const href = element.attr('href') || '';
      const onclick = element.attr('onclick') || '';
      const title = element.attr('title') || element.text().trim() || 'Documento';

      let targetUrl = '';
      if (href && href !== '#' && !href.startsWith('javascript:void')) {
        targetUrl = href;
      } else if (onclick) {
        const popUpMatch = onclick.match(/openPopUp\([^,]+,\s*['"]([^'"]+)['"]/i);
        if (popUpMatch && popUpMatch[1]) {
          targetUrl = popUpMatch[1];
        } else {
          const directMatch = onclick.match(/['"](\/[^'"]*report[^'"]*|[^'"]*\.pdf|[^'"]*idProcesso[^'"]*)['"]/i);
          if (directMatch && directMatch[1]) {
            targetUrl = directMatch[1];
          }
        }
      }

      if (!targetUrl) return;

      const isDoc =
        targetUrl.includes('reportPDF') ||
        targetUrl.includes('reportReciboPDF') ||
        targetUrl.includes('idProcessoDocumento') ||
        targetUrl.includes('idProcessoDoc') ||
        targetUrl.includes('idBin') ||
        targetUrl.includes('download') ||
        targetUrl.includes('document.seam') ||
        targetUrl.endsWith('.pdf');

      if (!isDoc) return;

      const resolved = this.resolveUrl(targetUrl, baseUrl);
      if (seenUrls.has(resolved)) return;
      seenUrls.add(resolved);

      const idMatch =
        targetUrl.match(/idProcessoDocumento=(\d+)/i) ||
        targetUrl.match(/idProcessoDoc=(\d+)/i) ||
        targetUrl.match(/idBin=(\d+)/i) ||
        targetUrl.match(/idProcessoTrf=(\d+)/i) ||
        targetUrl.match(/id=(\d+)/i);

      const idDoc = idMatch ? idMatch[1] : `doc_${documentos.length + 1}`;

      documentos.push({
        idDocumento: idDoc,
        titulo: title.replace(/\s+/g, ' ').slice(0, 50),
        url: resolved,
        status: 'pending'
      });
    });

    return documentos;
  }

  /**
   * Analiza los controles de paginación de RichFaces/JSF (ej. rich-datascr).
   */
  public static parsePaginationInfo(html: string): {
    currentPage: number;
    totalPages: number;
    hasNextPage: boolean;
    nextPageControlId?: string;
  } {
    const $ = cheerio.load(html);

    // Contenedores habituales de paginación en RichFaces / JSF
    const datascroller = $('table.rich-datascr, div.rich-datascr, .pagination, [id*="scroller"]');

    if (datascroller.length === 0) {
      return { currentPage: 1, totalPages: 1, hasNextPage: false };
    }

    // Página activa actual
    let currentPage = 1;
    const activePageEl = datascroller.find('.rich-datascr-act, .active, .current');
    if (activePageEl.length > 0) {
      const pageNum = parseInt(activePageEl.text().trim(), 10);
      if (!isNaN(pageNum)) currentPage = pageNum;
    }

    // Buscar total de páginas o botones numéricos
    let maxPage = currentPage;
    datascroller.find('.rich-datascr-inact, a, td').each((_, el) => {
      const txt = $(el).text().trim();
      const num = parseInt(txt, 10);
      if (!isNaN(num) && num > maxPage) {
        maxPage = num;
      }
    });

    // Detectar botón de siguiente página
    const nextBtn = datascroller.find('.rich-datascr-button[id*="next"], td:contains("»"), td:contains(">"), a[title*="Próximo"], a[title*="Next"]');
    const hasNextPage = nextBtn.length > 0 && !nextBtn.hasClass('rich-datascr-button-dsb');
    const nextPageControlId = nextBtn.attr('id');

    return {
      currentPage,
      totalPages: maxPage,
      hasNextPage: hasNextPage || maxPage > currentPage,
      nextPageControlId
    };
  }

  /**
   * Resuelve URLs relativas a absolutas basadas en el endpoint actual.
   */
  public static resolveUrl(relativeOrAbsolute: string, baseUrl: string): string {
    try {
      return new URL(relativeOrAbsolute, baseUrl).toString();
    } catch {
      return relativeOrAbsolute;
    }
  }
}
