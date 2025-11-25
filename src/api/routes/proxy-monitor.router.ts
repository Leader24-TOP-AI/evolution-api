import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { authGuard } from '@api/guards/auth.guard';
import { proxyMonitorController } from '@api/server.module';
import { instanceSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class ProxyMonitorRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      // GET /proxy-monitor/status/:instanceName - Get status for single instance
      .get(this.routerPath('status'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => proxyMonitorController.getStatus(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // GET /proxy-monitor/history/:instanceName - Get history for single instance
      .get(this.routerPath('history'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => proxyMonitorController.getHistory(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // POST /proxy-monitor/refresh/:instanceName - Force refresh status
      .post(this.routerPath('refresh'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => proxyMonitorController.refreshStatus(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // GET /proxy-monitor/dashboard - Get all instances dashboard
      // Note: Uses only authGuard because this endpoint doesn't require instanceName
      .get('/dashboard', authGuard['apikey'], async (req, res) => {
        const response = await proxyMonitorController.getDashboard();
        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
