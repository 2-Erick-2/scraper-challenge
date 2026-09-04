import { RateLimiter } from '../client/rateLimiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter(500, 5000, 3);
  });

  describe('parseRetryAfterHeader', () => {
    it('debe parsear segundos enteros del encabezado Retry-After', () => {
      const ms = rateLimiter.parseRetryAfterHeader('5');
      expect(ms).toBe(5000);
    });

    it('debe parsear fechas HTTP estándar del encabezado Retry-After', () => {
      const futureDate = new Date(Date.now() + 10000).toUTCString();
      const ms = rateLimiter.parseRetryAfterHeader(futureDate);
      expect(ms).toBeGreaterThan(8000);
      expect(ms).toBeLessThanOrEqual(10500);
    });

    it('debe retornar null si no hay encabezado Retry-After o es inválido', () => {
      expect(rateLimiter.parseRetryAfterHeader(undefined)).toBeNull();
      expect(rateLimiter.parseRetryAfterHeader('invalido')).toBeNull();
    });
  });

  describe('calculateBackoff', () => {
    it('debe respetar el encabezado Retry-After cuando esté presente', () => {
      const backoff = rateLimiter.calculateBackoff(1, '2');
      // 2000ms + margen jitter (100-300ms)
      expect(backoff).toBeGreaterThanOrEqual(2100);
      expect(backoff).toBeLessThanOrEqual(2350);
    });

    it('debe incrementar exponencialmente con jitter cuando no hay Retry-After', () => {
      const b1 = rateLimiter.calculateBackoff(1);
      const b2 = rateLimiter.calculateBackoff(2);

      expect(b1).toBeGreaterThanOrEqual(250); // 500 * 2^1 * [0.5, 1.0] => [500, 1000]
      expect(b2).toBeGreaterThanOrEqual(500); // 500 * 2^2 * [0.5, 1.0] => [1000, 2000]
    });
  });

  describe('executeWithRetry', () => {
    it('debe reintentar ante errores HTTP 429 y resolver si un reintento tiene éxito', async () => {
      let attempts = 0;
      const operation = jest.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          const error: any = new Error('Rate Limited');
          error.response = { status: 429, headers: { 'retry-after': '0' } };
          throw error;
        }
        return 'SUCCESS';
      });

      const result = await rateLimiter.executeWithRetry('TestOp', operation);
      expect(result).toBe('SUCCESS');
      expect(attempts).toBe(3);
    });
  });
});
