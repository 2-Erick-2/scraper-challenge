import fs from 'fs';
import path from 'path';
import { FailedDownloadItem } from '../types';

/**
 * Dead Letter Queue (DLQ) para registrar de forma persistente
 * los documentos o PDFs cuya descarga falló tras agotar los reintentos.
 * Permite reanudar o reintentar exclusivamente los fallidos posteriormente.
 */
export class DeadLetterQueue {
  private filePath: string;
  private queue: Map<string, FailedDownloadItem> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /**
   * Carga registros previos si el archivo ya existe.
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const items: FailedDownloadItem[] = JSON.parse(raw);
        for (const item of items) {
          const key = `${item.numeroProcesso}_${item.idDocumento}`;
          this.queue.set(key, item);
        }
      }
    } catch (err) {
      console.warn(`[DLQ] No se pudo leer el archivo DLQ previo: ${err}`);
    }
  }

  /**
   * Registra un nuevo fallo o incrementa el conteo de reintentos fallidos.
   */
  public recordFailure(item: Omit<FailedDownloadItem, 'lastAttemptAt'>): void {
    const key = `${item.numeroProcesso}_${item.idDocumento}`;
    const existing = this.queue.get(key);

    const updatedItem: FailedDownloadItem = {
      ...item,
      attemptCount: existing ? existing.attemptCount + item.attemptCount : item.attemptCount,
      lastAttemptAt: new Date().toISOString()
    };

    this.queue.set(key, updatedItem);
    this.save();
  }

  /**
   * Elimina un item de la cola una vez que se descargó exitosamente.
   */
  public remove(numeroProcesso: string, idDocumento: string): void {
    const key = `${numeroProcesso}_${idDocumento}`;
    if (this.queue.delete(key)) {
      this.save();
    }
  }

  /**
   * Retorna todos los items pendientes de reintento.
   */
  public getAll(): FailedDownloadItem[] {
    return Array.from(this.queue.values());
  }

  /**
   * Retorna la cantidad de documentos fallidos registrados.
   */
  public size(): number {
    return this.queue.size;
  }

  /**
   * Guarda la cola en disco de forma atómica.
   */
  public save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const items = Array.from(this.queue.values());
      fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[DLQ] Error guardando registros de fallos en ${this.filePath}:`, err);
    }
  }
}
