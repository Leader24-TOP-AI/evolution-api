import { Auth, configService } from '@config/env.config';
import { exec } from 'child_process';
import { Request, Response } from 'express';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context: string;
  instance: string | null;
  raw: string;
}

export class LogsController {
  private readonly PM2_LOGS_PATH = path.join(process.env.HOME || '/root', '.pm2/logs');
  private readonly OUT_LOG = 'evolution-api-out.log';
  private readonly ERR_LOG = 'evolution-api-error.log';

  /**
   * Helper: Legge log da file con fallback ai file rotati
   * ✅ FIX: Se file corrente vuoto (dopo logrotate), cerca nei file rotati
   */
  private async readLogsWithFallback(logFileName: string, lines: number): Promise<string[]> {
    const primaryPath = path.join(this.PM2_LOGS_PATH, logFileName);

    try {
      // Prova file corrente
      const { stdout } = await execAsync(`tail -n ${lines} "${primaryPath}"`);
      const logs = stdout.split('\n').filter(Boolean);

      // Se file corrente ha log, ritorna
      if (logs.length > 0) {
        return logs;
      }

      // ✅ File corrente vuoto - cerca nei file rotati
      console.warn(`[Logs] File corrente vuoto: ${logFileName}. Cercando nei file rotati...`);

      // Cerca file rotati (formato: evolution-api-out.log-YYYYMMDD)
      const { stdout: lsStdout } = await execAsync(
        `ls -t "${this.PM2_LOGS_PATH}"/${logFileName.replace('.log', '.log-')}* 2>/dev/null || echo ""`,
      );
      const rotatedFiles = lsStdout.split('\n').filter(Boolean);

      if (rotatedFiles.length === 0) {
        console.warn(`[Logs] Nessun file rotato trovato per ${logFileName}`);
        return [];
      }

      // Prendi il file rotato più recente (primo nell'output ls -t)
      const latestRotatedFile = rotatedFiles[0];
      console.log(`[Logs] Leggendo da file rotato: ${latestRotatedFile}`);

      const { stdout: rotatedStdout } = await execAsync(`tail -n ${lines} "${latestRotatedFile}"`);
      return rotatedStdout.split('\n').filter(Boolean);
    } catch (error) {
      console.warn(`[Logs] Error reading ${logFileName}:`, error.message);
      return [];
    }
  }

  /**
   * GET /logs/snapshot
   * Ottieni uno snapshot degli ultimi N log
   * ✅ FIX: Supporta fallback ai file rotati se file corrente vuoto
   */
  public async getSnapshot(req: Request, res: Response) {
    try {
      const lines = parseInt(req.query.lines as string) || 200;
      const level = req.query.level as string; // 'all', 'error', 'warn', 'info', 'debug'
      const instance = req.query.instance as string; // Filtra per istanza specifica
      const search = req.query.search as string; // Ricerca testo

      let logs: string[] = [];

      // ✅ Leggi stdout logs con fallback
      if (level === 'all' || !level || level !== 'error') {
        const outLogs = await this.readLogsWithFallback(this.OUT_LOG, lines);
        logs = [...logs, ...outLogs];
      }

      // ✅ Leggi stderr logs con fallback
      if (level === 'error' || level === 'all' || !level) {
        const errLogs = await this.readLogsWithFallback(this.ERR_LOG, lines);
        logs = [...logs, ...errLogs];
      }

      // Parse e filtra log
      let parsedLogs = logs.map((line) => this.parseLogLine(line));

      // Filtro per level
      if (level && level !== 'all') {
        parsedLogs = parsedLogs.filter((log) => log.level.toLowerCase() === level.toLowerCase());
      }

      // Filtro per instance
      if (instance) {
        parsedLogs = parsedLogs.filter((log) => log.instance === instance);
      }

      // Filtro per search
      if (search) {
        const searchLower = search.toLowerCase();
        parsedLogs = parsedLogs.filter((log) => log.raw.toLowerCase().includes(searchLower));
      }

      // Ordina per timestamp e limita
      const sortedLogs = parsedLogs.sort((a, b) => {
        // Ordine cronologico (più recenti per ultimi)
        return a.timestamp.localeCompare(b.timestamp);
      });

      const limitedLogs = sortedLogs.slice(-lines);

      res.json({
        success: true,
        logs: limitedLogs,
        total: limitedLogs.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in getSnapshot:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch logs',
      });
    }
  }

  /**
   * GET /logs/stream
   * Server-Sent Events per streaming real-time dei log
   */
  public streamLogs(req: Request, res: Response) {
    // Validazione apikey dal query param (EventSource non supporta custom headers)
    const providedKey = req.query.apikey as string;
    const authConfig = configService.get<Auth>('AUTHENTICATION');
    const globalKey = authConfig.API_KEY.KEY;

    if (!providedKey || providedKey !== globalKey) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or missing API key',
      });
    }

    const level = req.query.level as string;
    const instance = req.query.instance as string;
    const outLogPath = path.join(this.PM2_LOGS_PATH, this.OUT_LOG);

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Invia un ping iniziale per confermare connessione
    res.write('data: {"type":"connected"}\n\n');

    // Invia log iniziali (stessi che user vedeva in static mode - default 200)
    // Questo garantisce continuità visiva quando switcha da static a live
    const initialLines = parseInt(req.query.lines as string) || 200;

    execAsync(`tail -n ${initialLines} "${outLogPath}"`)
      .then(({ stdout }) => {
        const lines = stdout.split('\n').filter(Boolean);

        lines.forEach((line) => {
          const parsed = this.parseLogLine(line);

          // Applica gli stessi filtri di tail -f
          if (level && level !== 'all' && parsed.level.toLowerCase() !== level.toLowerCase()) {
            return;
          }

          if (instance && parsed.instance !== instance) {
            return;
          }

          // Invia log via SSE
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        });
      })
      .catch((error) => {
        console.warn('[SSE] Error sending initial logs:', error.message);
      });

    // POI avvia tail -f per seguire nuovi log in real-time
    const tailProcess = exec(`tail -f "${outLogPath}"`);

    tailProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);

      lines.forEach((line) => {
        const parsed = this.parseLogLine(line);

        // Filtri
        if (level && level !== 'all' && parsed.level.toLowerCase() !== level.toLowerCase()) {
          return;
        }

        if (instance && parsed.instance !== instance) {
          return;
        }

        // Invia al client
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      });
    });

    // Gestisci anche stderr se necessario
    if (level === 'error' || level === 'all' || !level) {
      const errLogPath = path.join(this.PM2_LOGS_PATH, this.ERR_LOG);
      const tailErrProcess = exec(`tail -f "${errLogPath}"`);

      tailErrProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);

        lines.forEach((line) => {
          const parsed = this.parseLogLine(line);
          parsed.level = 'ERROR'; // Forza livello ERROR per stderr

          if (instance && parsed.instance !== instance) {
            return;
          }

          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        });
      });

      // Cleanup on connection close
      req.on('close', () => {
        tailErrProcess.kill();
      });
    }

    // Cleanup quando il client chiude la connessione
    req.on('close', () => {
      tailProcess.kill();
      res.end();
    });
  }

  /**
   * POST /logs/clear
   * Pulisce tutti i log PM2
   */
  public async clearLogs(req: Request, res: Response) {
    try {
      // Usa pm2 flush per pulire i log
      await execAsync('pm2 flush');

      res.json({
        success: true,
        message: 'Logs cleared successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in clearLogs:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to clear logs',
      });
    }
  }

  /**
   * Rimuove i codici ANSI (colori) da una stringa di testo
   */
  private removeAnsiCodes(text: string): string {
    // Regex per rimuovere tutti i codici ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Parse una riga di log PM2 in formato strutturato
   * Formato PM2: [Evolution API] [instance] v2.3.6 12411 - 2025-11-21 02:38:00  LOG [Context] message
   */
  private parseLogLine(line: string): LogEntry {
    // Rimuovi codici ANSI prima del parsing per evitare interferenze
    const cleanLine = this.removeAnsiCodes(line);

    // Regex per estrarre timestamp
    const timestampMatch = cleanLine.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);

    // Regex per estrarre level (LOG, INFO, WARN, ERROR, DEBUG, VERBOSE)
    const levelMatch = cleanLine.match(/\s+(LOG|INFO|WARN|ERROR|DEBUG|VERBOSE)\s+/);

    // Regex per estrarre context (tra quadre alla fine prima del message)
    const contextMatch = cleanLine.match(/\[([^\]]+)\](?:\s*\[([^\]]+)\])?\s*$/);

    // Regex per estrarre nome istanza (dopo primo [])
    const instanceMatch = cleanLine.match(/\[Evolution API\]\s+\[([^\]]+)\]/);

    return {
      timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
      level: levelMatch ? levelMatch[1] : 'INFO',
      message: cleanLine,
      context: contextMatch ? contextMatch[1] : 'Unknown',
      instance: instanceMatch ? instanceMatch[1] : null,
      raw: line,
    };
  }
}
