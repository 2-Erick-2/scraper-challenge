import { PageParser } from '../scraper/pageParser';

describe('PageParser', () => {
  describe('extractViewState', () => {
    it('debe extraer ViewState desde un input hidden HTML estándar', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <form id="fdtProcesso" method="post">
              <input type="hidden" name="javax.faces.ViewState" value="state-token-12345" />
            </form>
          </body>
        </html>
      `;
      const result = PageParser.extractViewState(html);
      expect(result).toBe('state-token-12345');
    });

    it('debe extraer ViewState desde una respuesta parcial XML de JSF/RichFaces', () => {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <partial-response>
          <changes>
            <update id="javax.faces.ViewState"><![CDATA[ajax-state-token-67890]]></update>
          </changes>
        </partial-response>
      `;
      const result = PageParser.extractViewState(xml);
      expect(result).toBe('ajax-state-token-67890');
    });

    it('debe retornar null si no existe ViewState en el documento', () => {
      const html = `<html><body><div>Página estática sin estado JSF</div></body></html>`;
      const result = PageParser.extractViewState(html);
      expect(result).toBeNull();
    });
  });

  describe('parseProcessList', () => {
    it('debe extraer correctamente procesos con numeración oficial CNJ y documentos', () => {
      const html = `
        <table class="rich-table">
          <tbody>
            <tr class="rich-table-row">
              <td>0801234-56.2023.4.05.8000</td>
              <td>Procedimento Comum Cível</td>
              <td>1ª Vara Federal</td>
              <td>12/01/2023</td>
              <td>
                <a href="/pjeconsulta/download.seam?idProcessoDoc=101">Petição Inicial (PDF)</a>
              </td>
            </tr>
          </tbody>
        </table>
      `;

      const processos = PageParser.parseProcessList(html, 'https://pjett.trf5.jus.br');
      expect(processos).toHaveLength(1);
      expect(processos[0].numeroProcesso).toBe('0801234-56.2023.4.05.8000');
      expect(processos[0].classeJudicial).toBe('Procedimento Comum Cível');
      expect(processos[0].documentos).toHaveLength(1);
      expect(processos[0].documentos[0].idDocumento).toBe('101');
      expect(processos[0].documentos[0].url).toBe('https://pjett.trf5.jus.br/pjeconsulta/download.seam?idProcessoDoc=101');
    });
  });

  describe('parsePaginationInfo', () => {
    it('debe identificar página actual, páginas totales y botón siguiente', () => {
      const html = `
        <table class="rich-datascr">
          <tr>
            <td class="rich-datascr-act">1</td>
            <td class="rich-datascr-inact"><a href="#">2</a></td>
            <td class="rich-datascr-button" id="fdtProcesso:scroller_next">»</td>
          </tr>
        </table>
      `;

      const pagination = PageParser.parsePaginationInfo(html);
      expect(pagination.currentPage).toBe(1);
      expect(pagination.totalPages).toBe(2);
      expect(pagination.hasNextPage).toBe(true);
      expect(pagination.nextPageControlId).toBe('fdtProcesso:scroller_next');
    });
  });
});
