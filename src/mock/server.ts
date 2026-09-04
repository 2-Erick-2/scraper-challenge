import http from 'http';
import url from 'url';

/**
 * Servidor Mock local que simula fielmente la arquitectura de JBoss Seam / JSF
 * del portal PJe (TRF5) para pruebas de concepto y validación técnica.
 *
 * Características simuladas:
 * 1. Manejo de estado con JSESSIONID y javax.faces.ViewState.
 * 2. Tabla de procesos con nomenclatura oficial CNJ.
 * 3. Paginación mediante POST y componente RichFaces.
 * 4. Streaming de PDFs válidos.
 * 5. Inyección programada de errores HTTP 429 con encabezado Retry-After
 *    para demostrar el Exponential Backoff con Jitter y la Dead Letter Queue.
 */

const PORT = Number(process.env.MOCK_PORT) || 3000;
const rateLimitCounters: Record<string, number> = {};

// Generador de un PDF binario mínimo y válido
function generateMinimalPdfBuffer(title: string): Buffer {
  const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 50 >>
stream
BT
/F1 24 Tf
100 700 Td
(${title}) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
trailer
<< /Root 1 0 R /Size 5 >>
startxref
314
%%EOF`;
  return Buffer.from(content, 'utf-8');
}

export function startMockServer(port = PORT): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || '', true);
      const pathname = parsedUrl.pathname || '';

      // Set-Cookie de sesión si no existe
      res.setHeader('Set-Cookie', 'JSESSIONID=MOCK_PJE_SESSION_987654321; Path=/; HttpOnly');

      // Endpoint de descarga de PDFs
      if (pathname.includes('/download') || pathname.includes('documentoHTML')) {
        const docId = String(parsedUrl.query.idProcessoDoc || '1');
        const attempt = (rateLimitCounters[docId] || 0) + 1;
        rateLimitCounters[docId] = attempt;

        // Documento 999: Simula fallo permanente por 429 para validar Dead Letter Queue
        if (docId === '999') {
          res.writeHead(429, {
            'Content-Type': 'text/plain',
            'Retry-After': '2'
          });
          res.end('Too Many Requests - Rate limit exceeded (Simulated Permanent)');
          return;
        }

        // Documento 101: Simula 429 transitorio (falla las primeras 2 veces, triunfa en la 3ra)
        if (docId === '101' && attempt <= 2) {
          console.log(`[MockServer] Inyectando HTTP 429 simulado para doc ${docId} (Intento ${attempt})`);
          res.writeHead(429, {
            'Content-Type': 'text/plain',
            'Retry-After': '1'
          });
          res.end('Too Many Requests - Rate limit exceeded (Simulated Transient)');
          return;
        }

        // Descarga exitosa de PDF
        const pdfData = generateMinimalPdfBuffer(`Documento Judicial PJe #${docId}`);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="documento_${docId}.pdf"`,
          'Content-Length': pdfData.length
        });
        res.end(pdfData);
        return;
      }

      // Vistas HTML de PJe / listView.seam
      if (pathname.includes('listView.seam')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          let page = 1;
          if (req.method === 'POST') {
            const params = new URLSearchParams(body);
            const scroller = params.get('fdtProcesso:scroller');
            if (scroller) {
              page = parseInt(scroller, 10) || 1;
            }
          } else if (parsedUrl.query.page) {
            page = parseInt(String(parsedUrl.query.page), 10) || 1;
          }

          const viewStateId = `mock_state_page_${page}_v1`;

          if (page === 1) {
            // Página 1 de resultados
            res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
            res.end(`<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Consulta Pública - PJe TRF5 (Mock)</title></head>
<body>
  <form id="fdtProcesso" name="fdtProcesso" method="post" action="/pjeconsulta/ConsultaPublica/listView.seam">
    <input type="hidden" name="javax.faces.ViewState" value="${viewStateId}" />
    
    <h2>Processo Judicial Eletrônico - Consulta Pública</h2>
    
    <table id="fdtProcesso:tbProcesso" class="rich-table">
      <thead>
        <tr>
          <th>Número do Processo</th>
          <th>Classe Judicial</th>
          <th>Órgão Julgador</th>
          <th>Data Autuação</th>
          <th>Documentos</th>
        </tr>
      </thead>
      <tbody>
        <tr class="rich-table-row">
          <td>0801234-56.2023.4.05.8000</td>
          <td>Procedimento Comum Cível</td>
          <td>1ª Vara Federal de Pernambuco</td>
          <td>12/01/2023</td>
          <td>
            <a href="/pjeconsulta/download/documento.seam?idProcessoDoc=101">Petição Inicial (PDF)</a> |
            <a href="/pjeconsulta/download/documento.seam?idProcessoDoc=102">Despacho Liminar (PDF)</a>
          </td>
        </tr>
        <tr class="rich-table-row">
          <td>0809876-12.2023.4.05.8000</td>
          <td>Mandado de Segurança Coletivo</td>
          <td>3ª Vara Federal de Pernambuco</td>
          <td>18/02/2023</td>
          <td>
            <a href="/pjeconsulta/download/documento.seam?idProcessoDoc=201">Sentença de Mérito (PDF)</a> |
            <a href="/pjeconsulta/download/documento.seam?idProcessoDoc=999">Documento Bloqueado 429 (PDF)</a>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Controles de paginación simulados de RichFaces -->
    <table class="rich-datascr">
      <tr>
        <td class="rich-datascr-act">1</td>
        <td class="rich-datascr-inact"><a href="#" onclick="return false;">2</a></td>
        <td class="rich-datascr-button" id="fdtProcesso:scroller_next">»</td>
      </tr>
    </table>
  </form>
</body>
</html>`);
            return;
          } else {
            // Página 2 de resultados (última página)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
            res.end(`<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Consulta Pública - PJe TRF5 (Mock) - Página 2</title></head>
<body>
  <form id="fdtProcesso" name="fdtProcesso" method="post" action="/pjeconsulta/ConsultaPublica/listView.seam">
    <input type="hidden" name="javax.faces.ViewState" value="${viewStateId}" />
    
    <h2>Processo Judicial Eletrônico - Consulta Pública (Página 2)</h2>
    
    <table id="fdtProcesso:tbProcesso" class="rich-table">
      <thead>
        <tr>
          <th>Número do Processo</th>
          <th>Classe Judicial</th>
          <th>Órgão Julgador</th>
          <th>Data Autuação</th>
          <th>Documentos</th>
        </tr>
      </thead>
      <tbody>
        <tr class="rich-table-row">
          <td>0805544-33.2024.4.05.8000</td>
          <td>Execução Fiscal</td>
          <td>2ª Vara Federal de Pernambuco</td>
          <td>05/03/2024</td>
          <td>
            <a href="/pjeconsulta/download/documento.seam?idProcessoDoc=301">Certidão da Dívida Ativa (PDF)</a>
          </td>
        </tr>
      </tbody>
    </table>

    <table class="rich-datascr">
      <tr>
        <td class="rich-datascr-inact"><a href="#" onclick="return false;">1</a></td>
        <td class="rich-datascr-act">2</td>
        <td class="rich-datascr-button rich-datascr-button-dsb">»</td>
      </tr>
    </table>
  </form>
</body>
</html>`);
            return;
          }
        });
        return;
      }

      // Default 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(port, () => {
      console.log(`📡 [MockServer] Servidor PJe de simulación escuchando en http://localhost:${port}`);
      resolve(server);
    });
  });
}

// Si se ejecuta directamente como script
if (require.main === module) {
  startMockServer().then(() => {
    console.log(`Servidor mock activo. Presiona Ctrl+C para detener.`);
  });
}
