import { RouterBroker } from '@api/abstract/abstract.router';
import { LogsController } from '@api/controllers/logs.controller';
import { authGuard } from '@api/guards/auth.guard';
import { Router } from 'express';

export class LogsRouter extends RouterBroker {
  constructor() {
    super();

    const logsController = new LogsController();

    /**
     * GET /logs/snapshot
     * Ottieni snapshot degli ultimi N log
     * Query params:
     *  - lines: number (default: 200)
     *  - level: 'all' | 'error' | 'warn' | 'info' | 'debug'
     *  - instance: string (filtra per istanza)
     *  - search: string (ricerca testo)
     */
    this.router.get('/snapshot', authGuard['apikey'], (req, res) => logsController.getSnapshot(req, res));

    /**
     * GET /logs/stream
     * Server-Sent Events per streaming real-time
     * Query params:
     *  - level: 'all' | 'error' | 'warn' | 'info' | 'debug'
     *  - instance: string (filtra per istanza)
     *  - apikey: string (required - EventSource non supporta headers)
     *
     * NOTA: Non usa authGuard perché EventSource non supporta custom headers.
     * Validazione apikey fatta manualmente nel controller tramite query param.
     */
    this.router.get('/stream', (req, res) => logsController.streamLogs(req, res));

    /**
     * POST /logs/clear
     * Pulisce tutti i log PM2 (richiede autenticazione)
     */
    this.router.post('/clear', authGuard['apikey'], (req, res) => logsController.clearLogs(req, res));
  }

  public readonly router: Router = Router();
}
