/**
 * Implementación de Rate Limiting y Backoff Exponencial con Jitter
 * para manejo robusto de respuestas HTTP 429 (Too Many Requests).
 */

export class RateLimiter {
  private baseDelayMs: number;
  private maxDelayMs: number;
  private maxRetries: number;

  constructor(baseDelayMs = 1000, maxDelayMs = 15000, maxRetries = 4) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;
  }

  /**
   * Pausa la ejecución durante el tiempo especificado en milisegundos.
   */
  public async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Extrae el tiempo de espera del encabezado HTTP 'Retry-After'.
   * Soporta tanto segundos enteros como fechas HTTP (RFC 1123).
   */
  public parseRetryAfterHeader(retryAfterHeader?: string): number | null {
    if (!retryAfterHeader) return null;

    // Caso 1: Entero en segundos
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }

    // Caso 2: Fecha HTTP estándar (ej. "Wed, 21 Oct 2026 07:28:00 GMT")
    const dateMs = Date.parse(retryAfterHeader);
    if (!isNaN(dateMs)) {
      const diffMs = dateMs - Date.now();
      return diffMs > 0 ? diffMs : 1000;
    }

    return null;
  }

  /**
   * Calcula el tiempo de backoff exponencial con Full Jitter.
   * La aleatoriedad (jitter) previene la sincronización y sobrecarga repetida (thundering herd).
   */
  public calculateBackoff(attempt: number, retryAfterHeader?: string): number {
    const explicitWait = this.parseRetryAfterHeader(retryAfterHeader);
    if (explicitWait !== null) {
      // Si el servidor especificó Retry-After, lo respetamos añadiendo un pequeño margen aleatorio (100-300ms)
      return explicitWait + Math.floor(Math.random() * 200) + 100;
    }

    // Exponential Backoff: base * 2^attempt
    const exponential = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, attempt)
    );

    // Full Jitter: variabilidad entre 50% y 100% del tiempo calculado
    const jitterFactor = 0.5 + Math.random() * 0.5;
    return Math.floor(exponential * jitterFactor);
  }

  /**
   * Ejecuta una operación asíncrona con reintentos automáticos ante errores 429 o temporales.
   */
  public async executeWithRetry<T>(
    operationName: string,
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delayMs: number, error: any) => void
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error: any) {
        attempt++;
        const statusCode = error?.response?.status;
        const retryAfter = error?.response?.headers?.['retry-after'];

        const isRateLimited = statusCode === 429;
        const isTransientNetworkError =
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'EAI_AGAIN' ||
          (statusCode && statusCode >= 502 && statusCode <= 504);

        const shouldRetry = (isRateLimited || isTransientNetworkError) && attempt <= this.maxRetries;

        if (!shouldRetry) {
          throw error;
        }

        const delayMs = this.calculateBackoff(attempt, retryAfter);

        if (onRetry) {
          onRetry(attempt, delayMs, error);
        } else {
          console.warn(
            `⚠️  [RateLimiter] ${operationName} falló con HTTP ${statusCode || error.code}. Reintento ${attempt}/${this.maxRetries} en ${delayMs}ms...`
          );
        }

        await this.sleep(delayMs);
      }
    }
  }
}
