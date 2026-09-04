import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { HttpClient } from '../client/httpClient';
import { DeadLetterQueue } from '../storage/deadLetterQueue';
import { DocumentoItem } from '../types';

// Descarga de PDFs usando streaming a disco para no saturar memoria RAM
export class PdfDownloader {
  private httpClient: HttpClient;
  private downloadDir: string;
  private dlq: DeadLetterQueue;

  constructor(httpClient: HttpClient, downloadDir: string, dlq: DeadLetterQueue) {
    this.httpClient = httpClient;
    this.downloadDir = downloadDir;
    this.dlq = dlq;

    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  // Genera un nombre limpio: {proceso}_doc_{id}_{titulo}.pdf
  public generateFileName(numeroProcesso: string, documento: DocumentoItem, ext = '.pdf'): string {
    const cleanProcesso = numeroProcesso.replace(/[^a-zA-Z0-9.-]/g, '_');
    const cleanId = documento.idDocumento.replace(/[^a-zA-Z0-9_-]/g, '');

    // Quitamos acentos y caracteres raros del titulo
    const cleanTitle = (documento.titulo || 'Documento')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40);

    return `${cleanProcesso}_doc_${cleanId}_${cleanTitle}${ext}`;
  }

  // Descarga un documento directo a disco con pipeline
  public async downloadDocument(
    numeroProcesso: string,
    documento: DocumentoItem
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const isExplicitHtml = documento.url.includes('HTML') || documento.url.includes('documentoSemLogin');
    const defaultExt = isExplicitHtml ? '.html' : '.pdf';
    const initialFileName = this.generateFileName(numeroProcesso, documento, defaultExt);
    const destinationPath = path.join(this.downloadDir, initialFileName);

    // Si ya existe y no esta vacio, no volvemos a descargar
    if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).size > 0) {
      documento.status = 'downloaded';
      documento.localFilePath = destinationPath;
      this.dlq.remove(numeroProcesso, documento.idDocumento);
      return { success: true, filePath: destinationPath };
    }

    const tempPath = `${destinationPath}.tmp`;

    try {
      console.log(`[download] Descargando: ${initialFileName}`);

      const response = await this.httpClient.getStream(documento.url, {
        headers: {
          'Accept': 'application/pdf,application/octet-stream,*/*'
        }
      });

      const writeStream = fs.createWriteStream(tempPath);

      // Usamos pipeline para que cierre streams limpiamente si hay error
      await pipeline(response.data, writeStream);

      // Revisamos si vino html en vez de pdf (comun en vistas previas de PJe)
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const isActualHtml = contentType.includes('text/html');
      const finalExt = isActualHtml ? '.html' : '.pdf';
      const finalFileName = this.generateFileName(numeroProcesso, documento, finalExt);
      const finalDestinationPath = path.join(this.downloadDir, finalFileName);

      // Renombrar de tmp al final
      fs.renameSync(tempPath, finalDestinationPath);

      documento.status = 'downloaded';
      documento.localFilePath = finalDestinationPath;

      this.dlq.remove(numeroProcesso, documento.idDocumento);

      console.log(`[download] Guardado: ${finalFileName}`);
      return { success: true, filePath: finalDestinationPath };
    } catch (error: any) {
      // Limpiar archivo temporal
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }

      const statusCode = error?.response?.status;
      const errorMessage = error?.message || 'Error desconocido';

      console.error(
        `[download error] Fallo ${initialFileName} (${statusCode ? `HTTP ${statusCode}` : errorMessage}). Enviado a DLQ.`
      );

      documento.status = 'failed';
      documento.downloadError = errorMessage;

      // Guardamos en la DLQ para reintentar despues
      this.dlq.recordFailure({
        numeroProcesso,
        idDocumento: documento.idDocumento,
        titulo: documento.titulo,
        url: documento.url,
        error: errorMessage,
        httpStatus: statusCode,
        attemptCount: 1
      });

      return { success: false, error: errorMessage };
    }
  }
}
